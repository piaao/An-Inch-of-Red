/**
 * verify_dist.mjs — 将要发出去的那一份**真的能跑**，而且是同一个游戏。
 *
 * WHY THIS IS NOT verify_play. `verify_play` 量的是**仓库**里的游戏：
 * 它从仓库根起服务，所以一个"运行时其实要去读 work/ 里的东西"的分支在那里
 * 永远不会暴露。发布出去的是 `dist/` —— 一份**白名单剪出来的子集** ——
 * 而子集最容易的失败方式就是少了一层：页面白屏、模型 404、或者更糟，
 * 起得来但少了东西（于是它是个"能玩的、但少了两间房"的游戏）。
 *
 * 所以这一份只从 `dist/` 起服务，然后问四个问题：
 *
 *   1. 起得来吗          `__ready`（不是"HTML 到了"，是"公寓搭好了"）
 *   2. 一个都不缺吗      **零 HTTP 失败 + 每个请求过的文件都拿到过响应** —— 除音乐 manifest。
 *                        音乐那一条是有意的降级链（见 game/MUSIC.md）：
 *                        没有 manifest 就退回浏览器内合成，所以它 404 不是缺陷。
 *                        除此之外任何 404 都意味着 dist 少带了一个文件。
 *   3. 是同一个人吗      男女主人从 dist 里的 .glb 加载成功（`source:'files'`），
 *                        —— 素材没带上的话它会静默退回程序化机器人，
 *                        而那正是"看着能玩、其实不是这个游戏"。
 *   4. 是这一版吗        P0 触屏层与 P1 折叠地图都在包里
 *
 * 顺带把**首屏字节 / 请求数 / 绘制调用**印出来：DEPLOY.md 引用的就是这一份
 * 数字，而不是仓库根那一份 —— 发出去的是 dist，量的就该是 dist。
 *
 * ---
 *
 * 判据为什么不数 `Network.loadingFailed`（2026-09-27 修正，证据在
 * `scripts/probe/diag_dist_net.mjs`）：
 *
 *   原来第 2 条是"零失败请求"，直接数 CDP 的 `loadingFailed` 事件。它会把两种
 *   完全不同的东西印成同一个样子 —— 而 `cdp.js:235-238` 的注释早就点明了这件事。
 *   实测（探针，手机视口 + 桌面视口各一轮）：
 *
 *     · `net::ERR_ABORTED  canceled=true  type=Fetch`，**status=200**，
 *       对象是 `assets/actors/host_male.glb` / `host_female.glb`；
 *     · 同一个文档里**每个 URL 只请求了一次**（不是重复请求）；
 *     · `host_male.glb` 的 `loadingFinished` 收到 **453,708 B**，磁盘上是
 *       453,496 B —— 字节**完整送达**（多出的是分块编码开销）；
 *     · 且那两轮里"被取消的是哪一条"每次都不一样（时序相关）；
 *     · 而同一轮里 `hosts.source === 'files' && cast = male,female`
 *       —— 两个主人**真的解析成了骨架**，字节没到是不可能解析成功的。
 *
 *   结论：这是**渲染器放掉了一条已经送达的流**（收尾动作），不是"服务器拒绝"。
 *   所以判据换成直接问那个真正的问题：**有没有哪个文件从来没拿到过 2xx**。
 *   这条比原来更严 —— 它还顺手证明了"81 个家具 + 2 个主人一个都不缺"，
 *   而原来的代理指标从来没有验证过这一点。
 *
 * Usage:  python scripts/build_dist.py && node scripts/verify_dist.mjs
 *         node scripts/verify_dist.mjs --dist dist   （换个目录）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cdp from './cdp.js';

const { serve, launch, attach, killStrayChrome, sleep } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORK = path.join(ROOT, 'work');
const PORT = 8785;
const DEBUG = 9230;
const PROFILE = 'C:/Users/Public/cdpprofile_dist';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DIST = path.resolve(ROOT, argOf('--dist', 'dist'));

const PHONE = { w: 390, h: 844, dpr: 2 };
const DESKTOP = { w: 1440, h: 900, dpr: 1 };
const TOLERATED = '/assets/audio/manifest.json';

const log = [];
const say = (s = '') => { log.push(s); console.log(s); };
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  say(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  return !!ok;
}

let server = null, chrome = null, sess = null;
let exitCode = 0;

async function waitFor(expr, ms, every = 700) {
  const end = Date.now() + ms;
  for (;;) {
    if (await sess.evalJs(expr) === true) return true;
    if (Date.now() > end) return false;
    await sleep(every);
  }
}

/** 从 dist/ 里读一次，顺便回答"这个文件到底在不在包里"。 */
function inDist(rel) {
  return fs.existsSync(path.join(DIST, rel));
}

/** 抹掉 origin，留下 `/assets/...` 这种形状 —— 和 `TOLERATED` 同一套写法。 */
const shortUrl = (u) => String(u).replace(/^https?:\/\/[^/]+/, '');
const tolerated = (u) => String(u).endsWith(TOLERATED);

/**
 * 复盘一个时间窗里的**网络事实**，而不是事件计数。
 *
 * 三个量，只有前两个判失败：
 *   · `bad`      —— HTTP ≥ 400 的响应（除音乐 manifest）。这是"服务器拒绝"。
 *   · `neverOk`  —— 请求过、却从头到尾没拿到任何 2xx 的 URL。**这才是"缺文件"**。
 *   · `aborted`  —— 被渲染器放掉的流（ERR_ABORTED + canceled）。已送达，
 *                   属于收尾动作，只印出来供人看，不判失败（理由见文件头）。
 */
function netReport(from) {
  const ev = sess.events;
  const urlOf = new Map();          // requestId -> url
  const asked = new Set(), ok = new Set(), bad = [], aborted = [];
  for (let i = from; i < ev.length; i++) {
    const e = ev[i];
    const p = e.params || {};
    if (e.method === 'Network.requestWillBeSent' && p.request) {
      urlOf.set(p.requestId, p.request.url);
      asked.add(shortUrl(p.request.url));
    } else if (e.method === 'Network.responseReceived' && p.response) {
      const u = shortUrl(p.response.url);
      const s = p.response.status;
      if (s >= 200 && s < 300) ok.add(u);
      else if (s >= 400) bad.push(`${s} ${u}`);
    } else if (e.method === 'Network.loadingFailed') {
      aborted.push({
        url: shortUrl(urlOf.get(p.requestId) || '(unknown)'),
        err: p.errorText, canceled: !!p.canceled,
      });
    }
  }
  return {
    asked: asked.size,
    gotOk: ok.size,
    bad: bad.filter((s) => !tolerated(s.replace(/^\d+ /, ''))),
    neverOk: [...asked].filter((u) => !ok.has(u) && !tolerated(u)),
    aborted: aborted.filter((a) => !tolerated(a.url)),
  };
}

async function main() {
  /* ------------------------------------------------- dist 本身长什么样 */
  say('-- 0. dist/ 是白名单剪出来的那一片 --------------------------------');
  if (!fs.existsSync(DIST)) {
    check(`发布目录存在（${DIST}）`, false, '先跑 python scripts/build_dist.py');
    throw new Error('dist missing');
  }
  /**
   * 递归列出 dist 里的**每一个**文件。
   *
   * 🔴 这里原来只走了一层（base + 直接子目录），于是 228 个文件被数成 33 个，
   * 而漏掉的恰好是 `assets/models/*.glb`（81 个）和 `assets/actors/*.glb` ——
   * 也就是**最该被检查的那几个目录**。
   *
   * 症状是自相矛盾的报账：`dist 体积 1859.7 KB` 却印出 `首屏 3807.3 KB`（比整包还大）。
   * 更要紧的是"禁运路径一个都不在 dist 里"这条**安全检查**只扫了 33 个文件 ——
   * 往里层塞一个 `配置.yaml` 是扫不出来的。量具漏一层，检查就漏一层。
   */
  const walk = (base) => {
    const out = [];
    const rec = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) rec(p);
        else if (e.isFile()) out.push(path.relative(base, p).replace(/\\/g, '/'));
      }
    };
    rec(base);
    return out;
  };
  const files = walk(DIST);
  const bytes = files.reduce((a, f) => a + fs.statSync(path.join(DIST, f)).size, 0);
  const pages = files.filter((f) => /\.html?$/i.test(f));
  check('dist 里只有一个页面（发布工具在多页目录里会认错人）', pages.length === 1, pages.join(', '));
  check('入口就是 play.html', pages[0] === 'play.html', String(pages[0]));
  check('禁运的四个路径一个都不在 dist 里',
    !files.some((f) => /(^|\/)(work|renders|scripts|tools|reports|\.workbuddy)(\/|$)/.test(f)
      || /配置\.yaml$/.test(f) || /\.(pem|key)$/i.test(f)),
    `${files.length} 个文件`);
  check('素材与数据都跟着包走了',
    inDist('assets/actors/host_male.glb') && inDist('assets/actors/host_female.glb')
      && inDist('data/actors.json') && inDist('vendor/three.module.js')
      && inDist('game/maps/manifest.json'),
    `${files.length} 个文件 · ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  say(`   dist 体积 ${kb(bytes)} —— 这就是整包要传的字节，首屏只下其中一部分（见 §3）`);

  /**
   * dist 是不是**当前源码**剪出来的？
   *
   * 不查这一条，一份**过期的 dist 也能全绿** —— 后面的每一条断言都在它身上量，
   * 而发出去的偏偏就是它。改了源码忘了重跑 `build_dist.py`，是这类流水线最安静
   * 的失败方式：所有检查都通过，线上跑的是上一版。
   */
  const stale = [], drifted = [];
  for (const f of files) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) { stale.push(f); continue; }
    if (fs.readFileSync(src).compare(fs.readFileSync(path.join(DIST, f))) !== 0) drifted.push(f);
  }
  check('dist 与当前源码逐字节一致（不是一份旧的剪影）',
    stale.length === 0 && drifted.length === 0,
    stale.length || drifted.length
      ? `${stale.length} 个源里没有: ${stale.slice(0, 3).join(', ')}`
        + ` · ${drifted.length} 个内容不符: ${drifted.slice(0, 3).join(', ')}`
        + ' —— 先跑 python scripts/build_dist.py'
      : `${files.length} 个文件全部一致`);

  /* ------------------------------------------------------------- 跑起来 */
  await killStrayChrome();
  server = await serve(DIST, PORT);
  chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: PROFILE });
  sess = await attach({ port: DEBUG });
  say(`   GL ${await sess.glRenderer()}`);

  /** 记下"这一刻"在两条流里的位置：异常列表，与协议事件流。 */
  const mark = () => ({
    e: sess.diagnostics().exceptions.length,
    ev: sess.events.length,
  });

  /**
   * 跑一轮。
   *
   * 🔴 `touch` 参数是必需的，而且**顺序也有讲究**：`Emulation.setTouchEmulationEnabled`
   * 在这个 Chrome target 上是**单向闩锁** —— 先开过触屏模拟，再 `enabled:false` +
   * `maxTouchPoints:0`，`navigator.maxTouchPoints` 还是 5、`ontouchstart` 还在
   * （`scripts/probe/diag_dist_net.mjs` 实测：两个字段都没被还原）。
   * 所以**桌面那一轮必须跑在手机那一轮之前**，否则"桌面上触屏层不出现"这条会
   * 因为量具漏气而失败 —— 而那不是包的错，是量具的错。
   * `scripts/verify_touch.mjs` 是同样的顺序，不是巧合。
   */
  async function run(vp, label, query, { touch = false } = {}) {
    await sess.send('Emulation.setDeviceMetricsOverride', {
      width: vp.w, height: vp.h, deviceScaleFactor: vp.dpr, mobile: vp.dpr > 1,
      screenWidth: vp.w, screenHeight: vp.h,
    });
    await sess.send('Emulation.setTouchEmulationEnabled',
      { enabled: touch, maxTouchPoints: touch ? 5 : 0 });
    const from = mark();
    await sess.goto(`http://127.0.0.1:${PORT}/play.html${query}`, { settle: 1500 });
    if (!await waitFor('!!window.__playBooted', 30000)) {
      return { booted: false, err: await sess.evalJs('window.__playError || null') };
    }
    if (!await waitFor('window.__ready === true', 180000)) {
      return { booted: true, ready: false,
               err: await sess.evalJs('window.__playError || null'),
               msg: await sess.evalJs("(document.getElementById('load-msg')||{}).textContent||''") };
    }
    await sleep(2500);
    const info = await sess.evalJs(`JSON.stringify((() => {
      const r = __play.renderer.info, c = __play.renderer.getContext();
      const h = __play.hosts;
      return {
        calls: r.render.calls, tris: r.render.triangles,
        geometries: r.memory.geometries, textures: r.memory.textures,
        drawW: c.drawingBufferWidth, drawH: c.drawingBufferHeight,
        hosts: { source: h.source, cast: h.cast },
        prizes: __play.prizes.length,
        preset: __play.info().preset,
        touch: __play.touchInfo(),
        minimap: getComputedStyle(document.getElementById('minimap')).display,
        mapToggle: getComputedStyle(document.getElementById('map-toggle')).display,
        dash: !!window.__playBooted,
      };
    })())`);
    const res = await sess.evalJs(`JSON.stringify((() => {
      let total = 0, n = 0;
      const by = {};
      const urls = [];
      for (const e of performance.getEntriesByType('resource')) {
        const p = new URL(e.name).pathname.replace(/^\\//, '');
        const g = p.startsWith('assets/models/') ? '家具 .glb'
          : p.startsWith('assets/actors/') ? '主人 .glb'
          : p.startsWith('vendor/') ? 'three.js'
          : p.startsWith('game/') ? 'game/'
          : p.startsWith('js/') ? 'js/' : p.startsWith('css/') ? 'css/' : '根页面';
        (by[g] = by[g] || { n: 0, b: 0 });
        by[g].n++; by[g].b += e.decodedBodySize || 0;
        total += e.decodedBodySize || 0; n++;
        /* 逐 URL 留档：线上首屏压缩后是多少字节，只能拿这份清单去对
           （见 scripts/probe/live_payload.py）。不带 URL 的清单只能算本机数字。 */
        urls.push([p, e.decodedBodySize || 0]);
      }
      urls.sort((a, b) => a[0].localeCompare(b[0]));
      return { total, n, by, urls };
    })())`);
    const d = sess.diagnostics();
    const exc = d.exceptions.slice(from.e);
    return { booted: true, ready: true, label, info: JSON.parse(info), res: JSON.parse(res),
             net: netReport(from.ev), exc };
  }

  /* 报账用的两条断言（谁跑在前面不影响）。 */
  const netChecks = (tag, leg) => {
    check(`${tag}零 HTTP 失败请求（音乐 manifest 的 404 是有意降级，不算）`,
      leg.net.bad.length === 0,
      leg.net.bad.length ? leg.net.bad.slice(0, 3).join(' | ') : 'clean');
    check(`${tag}每个请求过的文件都拿到了响应 —— dist 一个都不缺`,
      leg.net.neverOk.length === 0,
      leg.net.neverOk.length ? '从未拿到 2xx: ' + leg.net.neverOk.slice(0, 3).join(' | ')
        : `${leg.net.asked} 个 URL · ${leg.net.gotOk} 个 2xx`);
    say(`   （渲染器放掉的已送达流 ${leg.net.aborted.length} 条：`
      + (leg.net.aborted.length
        ? leg.net.aborted.map((a) => `${a.err} ${a.url}`).join(' | ') + ' —— 200 已回、不是缺文件'
        : '无') + '）');
  };

  /* 🔴 桌面先跑：触屏模拟是单向闩锁，先开过就关不掉了（见 run() 的注释）。 */
  say('');
  say('-- 1. 桌面：同一份 dist，先确认它在没有手指的设备上也正常 --------------');
  const desk = await run(DESKTOP, 'desktop', '', { touch: false });
  check('桌面上从 dist 起得来（__ready + 开始菜单）', desk.ready === true,
    desk.ready ? `preset=${desk.info.preset} · 触屏 supported=${desk.info.touch.supported}`
      : JSON.stringify(desk).slice(0, 120));
  check('桌面上触屏层不出现（同一份包，两种设备）',
    desk.ready && desk.info.touch.supported === false
      && await sess.evalJs("!document.getElementById('touch').classList.contains('on')") === true,
    `supported=${desk.info.touch.supported}`);
  check('桌面上触屏层整层不显示（display:none，不是只藏了个类名）',
    await sess.evalJs("getComputedStyle(document.getElementById('touch')).display") === 'none',
    await sess.evalJs("getComputedStyle(document.getElementById('touch')).display"));
  netChecks('桌面上', desk);

  say('');
  say('-- 2. 手机：真触屏模拟（390×844 @dpr2），dist 上真的能起 --------------');
  const phone = await run(PHONE, 'phone', '?play=1', { touch: true });
  if (!phone.ready) {
    check('手机上从 dist 起得来', false, JSON.stringify(phone));
    throw new Error('dist did not boot on phone');
  }
  check('手机上从 dist 起得来（__ready）', true, `${phone.info.prizes} 个红包 · ${phone.info.preset}`);
  netChecks('手机上', phone);
  check('男女主人是从 dist 里的 .glb 加载的（不是静默退回机器人）',
    phone.info.hosts.source === 'files' && phone.info.hosts.cast.length >= 1,
    `source=${phone.info.hosts.source} cast=${phone.info.hosts.cast.join(',')}`);
  check('P0 触屏层随包发出去了（手机视口下 supported=true）',
    phone.info.touch.supported === true,
    `supported=${phone.info.touch.supported} · 探测输入 maxTouchPoints=${await sess.evalJs('navigator.maxTouchPoints||0')}`
      + ` · touch.js ${inDist('game/play/touch.js') ? '在包里' : '**不在包里**'}`);
  check('P1 折叠地图随包发出去了（窄屏默认收起 + 有开关）',
    phone.info.minimap === 'none' && phone.info.mapToggle !== 'none',
    `minimap=${phone.info.minimap} map-toggle=${phone.info.mapToggle}`);
  check('手机上零异常', phone.exc.length === 0, phone.exc.slice(0, 2).join(' | ') || 'clean');

  /* ------------------------------------------------------------ 报账 */
  say('');
  say('');
  say('-- 3. 报账：DEPLOY.md 引用的就是这一份（发的就是 dist）---------------');
  const r = phone.res;
  const groups = Object.entries(r.by).sort((a, b) => b[1].b - a[1].b);
  check(`dist 首屏：${r.n} 个请求 / ${kb(r.total)}`,
    r.n > 100 && r.total > 3e6, `${r.n} 个 · ${kb(r.total)}`);
  check(`dist 渲染负载：${phone.info.calls} 次绘制调用 / ${phone.info.tris.toLocaleString()} 个三角形`,
    phone.info.calls < 60 && phone.info.tris < 200000,
    `几何体 ${phone.info.geometries} · 纹理 ${phone.info.textures}`);
  /* 自洽性：首屏不可能比整包还大。这条就是为了钉死上面那个"只走一层"的量具漏洞
     —— 当年它把 228 个文件数成 33 个，而报账里两行数字互相打脸却没人发现。 */
  check('报账自洽：首屏字节 ≤ 整包字节',
    r.total <= bytes, `首屏 ${kb(r.total)} vs 整包 ${kb(bytes)}（${files.length} 个文件）`);
  say('   首屏按来源：');
  for (const [g, v] of groups) {
    say(`     ${g.padEnd(12)} ${String(v.n).padStart(4)} 个 ${kb(v.b).padStart(11)}` +
        `  ${(100 * v.b / r.total).toFixed(1)}%`);
  }

  const fin = sess.diagnostics();
  const late = [...fin.exceptions, ...fin.consoleErrors, ...fin.logErrors]
    .filter((e) => !String(e).includes('manifest.json'));
  check('整个会话零异常、零控制台错误', late.length === 0, late.slice(0, 2).join(' | ') || 'clean');

  fs.writeFileSync(path.join(WORK, 'dist_eval.json'), JSON.stringify({
    dist: DIST, files: files.length, bytes,
    phone: { info: phone.info, res: phone.res, net: phone.net },
    desktop: { info: desk.info, net: desk.net },
    results,
  }, null, 2));
}

main()
  .catch((err) => {
    say('');
    say('HARNESS ERROR: ' + (err && err.stack ? err.stack : err));
    exitCode = 2;
  })
  .finally(async () => {
    const passed = results.filter((r) => r.ok).length;
    say('');
    say('='.repeat(74));
    say(`  ${passed}/${results.length} checks passed`);
    for (const r of results) if (!r.ok) say(`   FAILED: ${r.name} — ${r.detail || ''}`);
    say('='.repeat(74));
    const verdict = results.length > 0 && passed === results.length && exitCode === 0;
    say(verdict ? '  VERDICT: PASS' : '  VERDICT: FAIL');
    fs.writeFileSync(path.join(WORK, 'verify_dist.log'), log.join('\n') + '\n');
    try { if (sess) sess.close(); } catch { /* */ }
    try { if (chrome) chrome.kill(); } catch { /* */ }
    try { if (server) await server.close(); } catch { /* */ }
    await killStrayChrome();
    if (!verdict) exitCode = 1;
    process.exit(exitCode);
  });
