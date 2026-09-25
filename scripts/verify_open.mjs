/**
 * verify_open.mjs — CAN EACH PAGE TELL YOU HOW IT WAS OPENED?
 *
 *     node scripts/verify_open.mjs
 *     node scripts/verify_open.mjs --url http://127.0.0.1:8777   # a live server
 *
 * THE BUG THIS FILE EXISTS FOR. The workbench was opened by double-clicking
 * procgen.html. Browsers refuse ES modules and fetch for file:// documents, so
 * NO LINE of the page executed — and what a person saw was a pristine-looking
 * shell: title, subtitle, buttons, and a status pill reading 准备中…, which is
 * the literal text in the HTML that nothing had overwritten. Measured:
 *
 *   file:// .../procgen.html     controls 0   plan <svg> 0   status 准备中…
 *   http://127.0.0.1:8777/...    controls 14  plan <svg> 1   status 生成完成
 *
 * `play.html` and `index.html` had each learned this lesson and shipped an
 * inline guard. `procgen.html` was written later, and did not. So there are two
 * claims to hold now, and the second is the one that keeps the first honest:
 *
 *   1. every page EXPLAINS a file:// open, names the .bat to double-click, and
 *      shows NO real content;
 *   2. every page is SILENT about it over http, and DOES show real content.
 *
 * Without (2), a guard that is simply always visible would pass — which is the
 * same species of lie as a page that is silently blank.
 *
 * The guard is one shared classic script (js/open-guard.js) rather than three
 * copies, because the failure it prevents was exactly "the newest page did not
 * get the copy". This suite therefore also holds the three .bat wrappers to the
 * hygiene the repo requires of them: CRLF and pure ASCII, or cmd.exe misreads
 * them and the window closes before anyone can read it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import cdp from './cdp.js';

const { serve, launch, attach, killStrayChrome, sleep } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 8796;
const DEBUG = 9232;
const SHOTS = path.join(ROOT, 'renders', 'open');
const REPORT = path.join(ROOT, 'reports', 'open.txt');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LIVE = argOf('--url', null);
const BASE = LIVE ? LIVE.replace(/\/+$/, '') : `http://127.0.0.1:${PORT}`;

const log = [];
const say = (s = '') => { log.push(s); console.log(s); };

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++; else failed++;
  say(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

/* ============================================================ what to measure */

/**
 * One entry per page. `content` is the page's own "I really ran" evidence, and
 * it is a COUNT on purpose: "did it run" is not a feeling, it is 0 controls
 * versus 14, 0 canvases versus 1.
 */
const PAGES = [
  {
    file: 'procgen.html',
    label: '工作台',
    bat: 'start-workbench.bat',
    cmd: 'serve.py --workbench',
    visible: "(()=>{const b=document.getElementById('openhelp');return !!b&&!b.classList.contains('hidden');})()",
    heading: "((document.getElementById('oh-title')||{}).textContent||'')",
    body: "((document.getElementById('oh-msg')||{}).textContent||'')",
    // The WHOLE box, not just the message paragraph: a page is allowed to give
    // the command its own line, and the reader sees all of it either way.
    text: "((document.getElementById('openhelp')||{}).textContent||'')",
    booted: '!!(globalThis.__procgen&&globalThis.__procgen.ready)',
    content: "document.querySelectorAll('#primary .field').length"
      + "+document.querySelectorAll('#advanced-fields .field').length"
      + "+document.querySelectorAll('#seed-field .field').length"
      + "+document.querySelectorAll('#plan svg').length",
    contentName: '控件+平面图',
    want: 15,          // 4 primary + 9 advanced + 1 seed = 14, plus 1 <svg>
  },
  {
    file: 'play.html',
    label: '游戏',
    bat: 'start.bat',
    cmd: 'serve.py',
    visible: "(()=>{const b=document.getElementById('ov-load');return !!b&&b.classList.contains('failed');})()",
    heading: "((document.getElementById('load-title')||{}).textContent||'')",
    body: "((document.getElementById('load-msg')||{}).textContent||'')",
    text: "((document.getElementById('ov-load')||{}).textContent||'')",
    booted: 'window.__playBooted===true',
    // NOT a canvas count. This page's two <canvas> elements are STATIC markup,
    // so counting them reports 2 even when nothing has executed -- measured,
    // and it made this very check fail on a correct page. Whether the apartment
    // then builds is a different question, asked by verify_play.mjs and
    // probe_guard_render.mjs; this suite only claims "the module ran".
    content: '(window.__playBooted===true?1:0)',
    contentName: '启动标志',
    want: 1,
  },
  {
    file: 'index.html',
    label: '场景查看器',
    bat: 'start-viewer.bat',
    cmd: 'serve.py --viewer',
    visible: "(()=>{const b=document.getElementById('loading');return !!b&&b.classList.contains('failed');})()",
    heading: "((document.getElementById('load-title')||{}).textContent||'')",
    body: "((document.getElementById('load-msg')||{}).textContent||'')",
    text: "((document.getElementById('loading')||{}).textContent||'')",
    booted: 'window.__viewerBooted===true',
    content: '(window.__viewerBooted===true?1:0)',
    contentName: '启动标志',
    want: 1,
  },
];

const measure = (page) => `(() => ({
  visible: ${page.visible},
  heading: ${page.heading},
  body: ${page.body},
  text: ${page.text},
  booted: ${page.booted},
  content: ${page.content},
  protocol: location.protocol,
  href: location.href,
}))()`;

/* =============================================================== harness bits */

let server = null, chrome = null, sess = null;

/** Navigate the way a NAVIGATION HAPPENED, and read back the countable facts. */
async function openAs(url, settle, { buster = false } = {}) {
  const before = sess.diagnostics();
  if (buster) await sess.goto(url, { settle });
  else { await sess.send('Page.navigate', { url }); await sleep(settle); }
  const after = sess.diagnostics();
  return {
    errors: [].concat(
      after.exceptions.slice(before.exceptions.length),
      after.consoleErrors.slice(before.consoleErrors.length),
      after.logErrors.slice(before.logErrors.length),
    ),
  };
}

/* ==================================================================== main */

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });

  /* ------------------------------------------------- 1. the double-click doors */
  say('-- 1. the double-click doors (start*.bat hygiene) -----------------------');
  for (const b of ['start.bat', 'start-workbench.bat', 'start-viewer.bat']) {
    const p = path.join(ROOT, b);
    if (!fs.existsSync(p)) { check(`${b} exists`, false, 'missing'); continue; }
    const raw = fs.readFileSync(p);
    const latin = raw.toString('latin1');
    const nCrlf = (latin.match(/\r\n/g) || []).length;
    const nLf = (latin.match(/\n/g) || []).length;
    // Every newline must be a CRLF pair. A single bare LF anywhere is enough to
    // make cmd.exe mis-parse the file -- and nothing in an editor shows it.
    const isCrlf = nCrlf > 0 && nCrlf === nLf;
    const isAscii = raw.every((x) => x < 128);
    check(`${b}: CRLF and pure ASCII`, isCrlf && isAscii,
      `${raw.length} B · CRLF ${nCrlf}/${nLf} · ASCII ${isAscii}`);
  }
  const wrap = fs.readFileSync(path.join(ROOT, 'start-workbench.bat'), 'utf8');
  check('start-workbench.bat actually passes the workbench keyword',
    /start\.bat"?\s+workbench/.test(wrap), wrap.trim().split(/\r?\n/).pop());
  const wrapV = fs.readFileSync(path.join(ROOT, 'start-viewer.bat'), 'utf8');
  check('start-viewer.bat actually passes the viewer keyword',
    /start\.bat"?\s+viewer/.test(wrapV), wrapV.trim().split(/\r?\n/).pop());

  /* ------------------------------------------------------------ 2. the pages */
  await killStrayChrome();
  if (!LIVE) server = await serve(ROOT, PORT);
  chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_open' });
  sess = await attach({ port: DEBUG });
  await sess.viewport(1500, 950);
  say('');
  say(`   http base: ${BASE}${LIVE ? '  (live, not started by this suite)' : '  (started by this suite)'}`);
  say(`   GL ${await sess.glRenderer()}`);

  const fileUrl = (f) => pathToFileURL(path.join(ROOT, f)).href;
  const fileErrors = [];
  let shots = 0;

  for (const page of PAGES) {
    say('');
    say(`-- 2.${PAGES.indexOf(page) + 1} ${page.label}  ${page.file} ------------------------`);

    /* ---- A. the route a person takes by double-clicking the HTML ---- */
    const fa = await openAs(fileUrl(page.file), 3200);
    const fm = await sess.evalJs(measure(page));
    fileErrors.push(...fa.errors);
    const s1 = await sess.shot(path.join(SHOTS, page.file + '-fileurl.png'));
    if (s1.ok) shots++;

    say(`   file://  ${fm.protocol}  说明框 ${fm.visible ? '显示' : '不显示'} · `
      + `内容(${page.contentName}) ${fm.content} · booted ${fm.booted}`);
    check(`${page.file} file:// — 屏幕上说明了打开方式`, fm.visible === true,
      `heading ${JSON.stringify(fm.heading)}`);
    check(`${page.file} file:// — 标题就是「需要通过本地服务器打开」`,
      String(fm.heading).indexOf('需要通过本地服务器打开') >= 0, JSON.stringify(fm.heading));
    check(`${page.file} file:// — 点名了该双击的 ${page.bat}`,
      String(fm.text).indexOf(page.bat) >= 0, String(fm.text).slice(0, 90));
    check(`${page.file} file:// — 给了命令行等价物`, String(fm.text).indexOf(page.cmd) >= 0,
      page.cmd);
    check(`${page.file} file:// — 说清了「代码一行都没执行」，不是「加载慢」`,
      String(fm.text).indexOf('一行都没执行') >= 0,
      String(fm.body).slice(0, 60));
    check(`${page.file} file:// — 真实内容确实是 0（空壳）`,
      fm.content === 0 && fm.booted === false,
      `${page.contentName} ${fm.content} · booted ${fm.booted}`);

    /* ---- B. the same file, served. The negative control. ---- */
    const ha = await openAs(BASE + '/' + page.file, 7000, { buster: !LIVE });
    const hm = await sess.evalJs(measure(page));
    const s2 = await sess.shot(path.join(SHOTS, page.file + '-http.png'));
    if (s2.ok) shots++;
    say(`   http://  ${hm.protocol}  说明框 ${hm.visible ? '显示' : '不显示'} · `
      + `内容(${page.contentName}) ${hm.content} · booted ${hm.booted}`);
    check(`${page.file} http:// — 说明框必须消失（否则「永远显示警告」也会全绿）`,
      hm.visible === false, `visible=${hm.visible}`);
    check(`${page.file} http:// — 页面真的跑起来了`,
      hm.content >= page.want && hm.booted === true,
      `${page.contentName} ${hm.content} >= ${page.want} · booted ${hm.booted}`);
  }

  /* ------------------------------------------------------- 3. session-wide */
  say('');
  say('-- 3. session-wide ------------------------------------------------------');

  // The file:// claims above are only worth anything if the browser really did
  // refuse the module graph. This asserts the reproduction, not my memory of it.
  const refused = fileErrors.filter((e) => /CORS|ERR_FAILED|blocked|Failed to load/i.test(e));
  check('file:// 下浏览器确实拒绝加载模块（复现，不是猜测）', refused.length >= 3,
    `${refused.length} 条 / 3 页：` + refused.slice(0, 2).map((s) => s.slice(0, 70)).join(' | '));

  // The http route must be CLEAN: a guard that fixes a blank page by breaking
  // the served one would pass every per-page check above and fail this one.
  // Only counts what belongs to the http runs: file:// errors were just counted.
  const diag = sess.diagnostics();
  const cleanish = (s) => !/file:\/\//.test(s);
  const badExc = diag.exceptions.filter(cleanish);
  const bad4xx = (diag.failedDetail || [])
    .filter((f) => !f.canceled && !(f.status >= 200 && f.status < 400) && cleanish(f.url));
  check('served route: 零异常、零非 2xx/3xx 请求',
    badExc.length === 0 && bad4xx.length === 0,
    (badExc.slice(0, 2).join(' | ') || bad4xx.slice(0, 2).map((f) => `${f.errorText} ${f.url}`).join(' | ')
      || 'clean'));

  check('6 张日志截图都写出来了', shots === 6, `${shots}/6 -> renders/open/`);
}

main()
  .catch((e) => { say(`\n   harness threw: ${e && e.stack || e}`); failed += 1; })
  .finally(async () => {
    try { if (sess) sess.close(); } catch { /* ignore */ }
    try { if (chrome) chrome.kill(); } catch { /* ignore */ }
    try { if (server) await server.close(); } catch { /* ignore */ }

    say('');
    say('='.repeat(78));
    say(`  ${passed}/${passed + failed} checks passed`);
    if (failed) say(`  FAILED: ${failed}`);
    say('='.repeat(78));
    say(`  VERDICT: ${failed === 0 ? 'PASS' : 'FAIL'}`);
    fs.writeFileSync(REPORT, log.join('\n') + '\n', 'utf8');
    process.exit(failed === 0 ? 0 : 1);
  });
