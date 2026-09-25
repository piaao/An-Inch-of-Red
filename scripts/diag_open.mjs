/**
 * diag_open.mjs -- answer "why is the workbench blank?" by opening it BOTH ways
 * and counting what happened.
 *
 * A page that renders its shell, prints its own title, shows an EMPTY parameter
 * panel and the words 准备中… forever is not a page with a bug in it. It is a
 * page whose module never executed a single line. `boot()` builds the controls
 * on its first statement, so an empty panel means boot() never ran -- and the
 * only thing between "never ran" and "ran" is the SCHEME the page was opened
 * with: `type="module"` and `fetch` are both refused for `file://` documents.
 *
 * So this opens the same file from disk and from the local server and reports
 * the facts that separate "did not boot" from "booted and complained":
 *
 *   controls   how many <input> the panel built. boot() builds them first, so
 *              zero is not a style problem, it is proof of non-execution.
 *   status     the page's own words. 准备中… is the STATIC text in procgen.html;
 *              seeing it means nothing ever overwrote it.
 *   plan       whether an <svg> floor plan was drawn.
 *   checks     how many verdict rows exist.
 *   __procgen  whether the page's own harness surface exists at all.
 *   console    the errors the BROWSER reported. Under file:// this is the whole
 *              answer in the browser's own words, not a guess about them.
 *
 * Usage:
 *   node scripts/diag_open.mjs
 *   node scripts/diag_open.mjs --url http://127.0.0.1:8777
 *   node scripts/diag_open.mjs --file-only
 */
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import cdp from './cdp.js';

const { launch, attach, killStrayChrome, sleep } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PAGE = 'procgen.html';
const DEBUG = 9341;
const SHOTS = path.join(ROOT, 'work', 'diag');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const HTTP_BASE = argOf('--url', 'http://127.0.0.1:8777').replace(/\/+$/, '');
const FILE_ONLY = argv.includes('--file-only');

/* ---------------------------------------------------------------- measuring */

const MEASURE = `
  const q = (s) => document.querySelectorAll(s).length;
  const st = document.getElementById('status');
  return {
    controls: q('#primary .field') + q('#advanced-fields .field') + q('#seed-field .field'),
    status: st ? st.textContent : null,
    statusKind: st ? (st.dataset.kind || '') : '',
    advancedLabel: (document.querySelector('#adv summary') || {}).textContent || null,
    planSVG: q('#plan svg'),
    checks: q('#checks li'),
    readings: q('#readings .rd'),
    verdict: (document.getElementById('verdict') || {}).textContent || null,
    procgen: typeof globalThis.__procgen,
    ready: !!(globalThis.__procgen && globalThis.__procgen.ready),
  };
`;

/**
 * Navigate the session to `url` and read the page back.
 *
 * Deliberately NOT `sess.goto`: that appends a cache-buster query, which is
 * harmless over http but turns a file:// URL into one Chrome may treat as a
 * different resource than the one a human double-clicked. This diagnostic is
 * about reproducing a DOUBLE-CLICK, so it navigates to the byte-exact URL.
 */
async function probe(sess, url, label, shotName) {
  const before = sess.diagnostics();
  await sess.send('Page.navigate', { url });
  await sleep(3500);
  const m = await sess.evalAsync(MEASURE);
  const after = sess.diagnostics();
  const fresh = {
    exceptions: after.exceptions.slice(before.exceptions.length),
    consoleErrors: after.consoleErrors.slice(before.consoleErrors.length),
    logErrors: after.logErrors.slice(before.logErrors.length),
    failedRequests: after.failedRequests.slice(before.failedRequests.length),
  };
  if (shotName) {
    await fsp.mkdir(SHOTS, { recursive: true });
    await sess.shot(path.join(SHOTS, shotName));
  }
  return { label, url, ...m, diag: fresh };
}

/* ------------------------------------------------------------------ output */

function report(r) {
  const line = (k, v) => console.log('    ' + k.padEnd(12) + v);
  console.log('\n  ' + r.label);
  console.log('  ' + r.url);
  console.log('  ' + '-'.repeat(72));
  line('控件', r.controls + (r.controls ? '' : '   <-- boot() 一次都没跑'));
  line('状态', JSON.stringify(r.status) + (r.statusKind ? '  kind=' + r.statusKind : ''));
  line('高级标签', JSON.stringify(r.advancedLabel));
  line('平面图', r.planSVG + ' 个 <svg>');
  line('判决', JSON.stringify(r.verdict));
  line('检查行', r.checks + ' 行 · 读数 ' + r.readings + ' 格');
  line('__procgen', r.procgen + (r.ready ? ' (ready)' : ''));
  const d = r.diag;
  const all = [].concat(
    d.exceptions.map((s) => 'EXC  ' + s),
    d.consoleErrors.map((s) => 'CONS ' + s),
    d.logErrors.map((s) => 'LOG  ' + s),
    d.failedRequests.map((s) => 'NET  ' + s),
  );
  line('浏览器报错', all.length ? '' : '无');
  for (const s of all.slice(0, 6)) console.log('      ' + s.slice(0, 200));
  if (all.length > 6) console.log('      … 另有 ' + (all.length - 6) + ' 条');
}

/* -------------------------------------------------------------------- main */

let chrome = null;
try {
  await killStrayChrome();
  chrome = await launch({ port: DEBUG, gl: 'sw', userDataDir: 'C:/Users/Public/cdpprofile_diagopen' });
  const sess = await attach({ port: DEBUG });
  await sess.send('Runtime.enable');
  await sess.send('Log.enable');
  await sess.send('Network.enable');
  await sess.viewport(1600, 1000);

  const results = [];
  results.push(await probe(sess, pathToFileURL(path.join(ROOT, PAGE)).href,
    'A. 双击文件打开（file://）—— 用户看到的那个画面', 'open-fileurl.png'));
  report(results[0]);
  if (!FILE_ONLY) {
    results.push(await probe(sess, HTTP_BASE + '/' + PAGE,
      'B. 通过本地服务打开（http://）', 'open-http.png'));
    report(results[1]);
  }

  /* ------------------------------------------------------------- verdict */
  const a = results[0];
  const b = results[1];
  console.log('\n  ' + '='.repeat(72));
  const fileBroken = a.controls === 0 && a.planSVG === 0;
  console.log('  file://   控件 ' + a.controls + ' · 平面图 ' + a.planSVG + ' · 报错 ' +
    (a.diag.consoleErrors.length + a.diag.logErrors.length + a.diag.exceptions.length) + ' 条');
  if (b) {
    console.log('  http://   控件 ' + b.controls + ' · 平面图 ' + b.planSVG + ' · 报错 ' +
      (b.diag.consoleErrors.length + b.diag.logErrors.length + b.diag.exceptions.length) + ' 条');
    console.log('  ' + (fileBroken && b.controls > 0 && b.planSVG > 0
      ? '结论：同一个文件，换个 scheme 就从「空白」变成「正常」—— 病根在打开方式，不在页面。'
      : '结论：两条路都能跑，或两条都不行 —— 需要另外查。'));
  } else {
    console.log('  ' + (fileBroken ? '结论：file:// 下模块没有执行。' : '结论：file:// 下居然跑起来了。'));
  }
  console.log('  截图（日志用）：work/diag/open-fileurl.png' + (b ? ' · work/diag/open-http.png' : ''));
  console.log('');

  sess.close();
  process.exit(0);
} catch (err) {
  console.error('diag_open failed:', err && err.stack || err);
  process.exit(1);
} finally {
  if (chrome) chrome.kill();
  await killStrayChrome();
}
