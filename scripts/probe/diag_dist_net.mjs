/**
 * diag_dist_net.mjs — 一次性的取证脚本：`verify_dist` 报的那几个"失败请求"
 * 到底是什么？
 *
 * 症状：`零真实失败请求` 挂了，但详情里印出来的是 **200** —— 也就是
 * `Network.loadingFailed` 事件、而它对应的 HTTP 响应早就回来了 200。
 * 这类事件有两种截然不同的来源，必须分开：
 *
 *   a) **服务器真的拒绝了**（404/500）→ dist 少带了文件，是真缺陷；
 *   b) **渲染器自己把已拿到 200 的那条流放了**（`net::ERR_ABORTED`）——
 *      最常见的原因是**页面被导航走了**，前一页在飞的请求被取消。
 *      这就是量具在骗人：事件在**新页面**的时间窗里落地，锅却属于**旧页面**。
 *
 * 光看 URL 分不出来（两页请求的是同一批文件），所以这一份把
 * `Network.requestWillBeSent` 的 `documentURL` / `loaderId` 一起记下来，
 * 按**文档**归属每一次 loadingFailed。判据不是"有没有 ABORTED"，
 * 而是"这条 URL 在它自己的文档里最终有没有成功"。
 *
 * Usage:  node scripts/probe/diag_dist_net.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cdp from '../cdp.js';

const { serve, launch, attach, killStrayChrome, sleep } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DIST = path.join(ROOT, 'dist');
const PORT = 8786;
const DEBUG = 9234;
const PROFILE = 'C:/Users/Public/cdpprofile_distdiag';

const PHONE = { w: 390, h: 844, dpr: 2 };
const DESKTOP = { w: 1440, h: 900, dpr: 1 };

let server = null, chrome = null, sess = null;

async function waitFor(expr, ms, every = 700) {
  const end = Date.now() + ms;
  for (;;) {
    if (await sess.evalJs(expr) === true) return true;
    if (Date.now() > end) return false;
    await sleep(every);
  }
}

/** 打开页面，并记下"这一刻事件流有多长"，好把窗口切开。 */
async function leg(vp, label, query, touch) {
  await sess.send('Emulation.setDeviceMetricsOverride', {
    width: vp.w, height: vp.h, deviceScaleFactor: vp.dpr, mobile: vp.dpr > 1,
    screenWidth: vp.w, screenHeight: vp.h,
  });
  // verify_layout / verify_touch 都开了这一条，verify_dist 漏了 —— 而
  // `mobile:true` 并不会让 `navigator.maxTouchPoints > 0`。
  await sess.send('Emulation.setTouchEmulationEnabled',
    { enabled: touch, maxTouchPoints: touch ? 5 : 0 });

  return { label, from: sess.events.length };
}

async function open(sess2, query) {
  await sess2.goto(`http://127.0.0.1:${PORT}/play.html${query}`, { settle: 1500 });
  const booted = await waitFor('!!window.__playBooted', 30000);
  const ready = booted ? await waitFor('window.__ready === true', 180000) : false;
  await sleep(2500);
  return { booted, ready };
}

/**
 * `detect()` 读的那三个原始输入，逐个印出来。
 * 不然"supported=true/false"只能告诉我们结论，说不出**是哪一条**判的 ——
 * 而模拟器最容易出问题的地方恰恰是"我只改了视口大小"。
 */
async function senses() {
  return JSON.parse(await sess.evalJs(`JSON.stringify({
    ontouchstart: ('ontouchstart' in window),
    maxTouchPoints: navigator.maxTouchPoints || 0,
    coarse: window.matchMedia('(pointer: coarse)').matches,
    hoverNone: window.matchMedia('(hover: none)').matches,
  })`));
}

async function main() {
  await killStrayChrome();
  server = await serve(DIST, PORT);
  chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: PROFILE });
  sess = await attach({ port: DEBUG });
  console.log('GL', await sess.glRenderer());

  /* 第一次：手机视口 + 触屏模拟（补上 verify_dist 漏掉的那一条） */
  const w1 = await leg(PHONE, 'phone', '?play=1', true);
  const p = await open(sess, '?play=1');
  console.log(`phone: booted=${p.booted} ready=${p.ready}`
    + `  触屏 supported=${await sess.evalJs('__play.touchInfo().supported')}`
    + `  原始输入=${JSON.stringify(await senses())}`);

  /* 第二次：桌面视口，触屏关掉 */
  const w2 = await leg(DESKTOP, 'desktop', '', false);
  const d = await open(sess, '');
  console.log(`desktop: booted=${d.booted} ready=${d.ready}`
    + `  触屏 supported=${await sess.evalJs('__play.touchInfo().supported')}`
    + `  原始输入=${JSON.stringify(await senses())}`);

  /* -------------------------------------------------- 按文档归属地复盘 */
  const ev = sess.events;
  const req = new Map();          // requestId -> {url, doc, loader, type}
  const navAt = [];               // 每次 Page.navigate 在事件流里的位置
  ev.forEach((e, i) => {
    const m = e.method;
    if (m === 'Network.requestWillBeSent' && e.params) {
      req.set(e.params.requestId, {
        url: e.params.request?.url || '',
        doc: e.params.documentURL || '',
        loader: e.params.loaderId || '',
        type: e.params.type || '?',
        at: i,
      });
    } else if (m === 'Page.frameNavigated' && e.params?.frame?.url) {
      navAt.push({ i, url: e.params.frame.url });
    }
  });

  const windows = [[w1, w2.from], [w2, ev.length]];
  const short = (u) => String(u).replace(/^https?:\/\/127\.0\.0\.1:\d+\//, '');

  console.log('\n======== 每个页面窗口里的失败请求（按 requestWillBeSent.documentURL 归属）========');
  for (const [a, b] of windows) {
    const label = a.label;
    const fails = [];
    for (let i = a.from; i < b; i++) {
      const e = ev[i];
      if (e.method !== 'Network.loadingFailed') continue;
      const info = req.get(e.params.requestId);
      fails.push({
        i,
        url: short(info ? info.url : '(unknown)'),
        doc: info ? short(info.doc) : '(unknown)',
        type: info ? info.type : '?',
        sentAt: info ? info.at : -1,
        err: e.params.errorText,
        canceled: !!e.params.canceled,
      });
    }
    console.log(`\n-- ${label} 窗口 [${a.from}..${b}) 事件数 ${b - a.from}，失败 ${fails.length} 条`);
    for (const f of fails) {
      console.log(`   ${f.err}  canceled=${f.canceled}  type=${f.type}`);
      console.log(`      url=${f.url}`);
      console.log(`      归属文档=${f.doc}   （该请求在事件流 #${f.sentAt} 发出，失败在 #${f.i}）`);
      console.log(`      -> ${f.sentAt < a.from ? '**属于上一个文档**（旧页面在飞的请求被导航取消）'
        : '属于本文档（需要进一步解释）'}`);
    }
  }

  /* 被取消的那两条是不是**重复请求**？按"文档 + URL"数一遍 requestId 就看得出来。 */
  console.log('\n======== 同一文档内同一 URL 被发了几次（>1 才是重复请求的来源）========');
  const perUrl = new Map();
  for (const info of req.values()) {
    const key = short(info.doc) + ' || ' + short(info.url);
    if (!perUrl.has(key)) perUrl.set(key, []);
    perUrl.get(key).push(info);
  }
  const dup = [...perUrl.entries()].filter(([, v]) => v.length > 1);
  if (!dup.length) console.log('   （同一文档里每个 URL 都只发了一次 —— 那 ABORTED 不是重复请求）');
  for (const [u, v] of dup) {
    console.log(`   ${v.length}×  ${u}   发出于事件 #${v.map((x) => x.at).join(', #')}`);
  }

  /* 决定性一问：那两条被取消的请求，**字节到底有没有到达**？
     `Network.loadingFinished.encodedDataLength` 是响应体真实交付的字节数，
     拿它跟磁盘上的文件大小比 —— 对上了就是"完整送达后才被放掉的流"，纯良性。 */
  console.log('\n======== 交付字节 vs 磁盘大小（证明"送达了"而不是"没收到"）========');
  const done = new Map();          // requestId -> encodedDataLength
  for (const e of ev) {
    if (e.method === 'Network.loadingFinished' && e.params) {
      done.set(e.params.requestId, e.params.encodedDataLength);
    }
  }
  const fsMod = await import('node:fs');
  for (const rel of ['assets/actors/host_male.glb', 'assets/actors/host_female.glb']) {
    const onDisk = fsMod.statSync(path.join(DIST, rel)).size;
    const rows = [];
    for (const [id, info] of req) {
      if (short(info.url) !== rel) continue;
      rows.push({ at: info.at, received: done.has(id) ? done.get(id) : null, doc: short(info.doc) });
    }
    console.log(`   ${rel}  磁盘 ${onDisk} B`);
    for (const r of rows) {
      const pct = r.received === null ? null : (100 * r.received / onDisk);
      console.log(`      #${r.at}  ${r.doc}  收到 `
        + (r.received === null ? '(无 loadingFinished —— 流被中途放掉)'
          : `${r.received} B（${pct.toFixed(1)}% 于磁盘大小）`));
    }
  }

  console.log('\n======== 状态码 >= 400 的响应（真正的"缺文件"只会出现在这里）========');  let bad = 0;
  for (const e of ev) {
    if (e.method !== 'Network.responseReceived') continue;
    const s = e.params?.response?.status ?? 0;
    if (s < 400) continue;
    bad++;
    console.log(`   ${s}  ${short(e.params.response.url)}`);
  }
  console.log(bad ? `   共 ${bad} 条` : '   （零条）');

  console.log('\n======== 最终结论 ========');
  const realFail = ev.filter((e) => e.method === 'Network.responseReceived'
    && (e.params?.response?.status ?? 0) >= 400)
    .filter((e) => !String(e.params.response.url).endsWith('/assets/audio/manifest.json'));
  console.log(`   真正的 HTTP 失败（除音乐 manifest）：${realFail.length} 条`);
  console.log(`   总数：${req.size} 个请求被发出，${ev.length} 条协议事件`);
}

main()
  .then(() => { try { sess?.close(); } catch {} process.exit(0); })
  .catch((e) => { console.error('探针失败:', e); process.exit(1); });
