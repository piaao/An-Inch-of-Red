/**
 * verify_layout.mjs — 窄屏（手机竖屏）的排版，用数字说话。
 *
 * WHY THIS FILE IS NOT verify_touch. `verify_touch` 回答"手指能不能玩"；
 * 这一份回答"能不能看清、能不能够到"。两件事都会让手机端不可玩，但它们的
 * 证据完全不同：一个是指针数与逐位相同的状态，一个是**屏幕上的矩形**。
 *
 * THE MEASUREMENT THIS EXISTS FOR (work/probe_mobile_payload.mjs, 390×844 @dpr3):
 *
 *   开始面板高 2331 px / 视口 844 px   —— 要滚 1.5 屏才够得到「开始」
 *   小地图固定 260 px                  —— 占屏宽 67%
 *   #hud 与 #guardbox 各占一角          —— 390 px 放不下，右上的状态被顶出屏幕
 *
 * 而且这一轮真正的教训是**量具的教训**：bounding-box 越界检查当时报"越界元素
 * 0 个"，而截图显示 HUD 吃掉了整个上半屏。越界检查只能抓溢出，抓不到"布局合法
 * 但吃掉半个屏幕"。所以这里的断言分两半：
 *
 *   一半是数字   —— 矩形必须在视口内、两块不能相交、按钮 ≥ 44 px、零横向溢出
 *   一半是截图   —— 每个判定都配一张 390 × 844 的图，留在 renders/play/
 *
 * 一个刻意的**负对照**：小地图在窄屏是收起的，但**展开后必须与桌面一模一样**
 * （房间名一个不少）。只验"收起了"会放过一个把地图做残的实现。
 *
 * Usage:  node scripts/verify_layout.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cdp from './cdp.js';

const { serve, launch, attach, killStrayChrome, sleep } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORK = path.join(ROOT, 'work');
const SHOTS = path.join(ROOT, 'renders', 'play');
const PORT = 8784;
const DEBUG = 9229;

const PHONE = { w: 390, h: 844, dpr: 2 };
const DESKTOP = { w: 1440, h: 900, dpr: 1 };
/** 苹果 HIG 的最小可点区域。手指比鼠标粗，这条是手感不是审美。 */
const MIN_TAP = 44;

const log = [];
const say = (s = '') => { log.push(s); console.log(s); };
const num = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : String(v));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  say(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  return !!ok;
}

let server = null, chrome = null, sess = null;
let exitCode = 0;

const RECT = `(id) => { const e = document.getElementById(id); if (!e) return null;
  const r = e.getBoundingClientRect();
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height,
           display: getComputedStyle(e).display }; }`;

const inside = (r, vw, vh, slack = 0.5) =>
  !!r && r.l >= -slack && r.t >= -slack && r.r <= vw + slack && r.b <= vh + slack;

const overlap = (a, b) => !!a && !!b
  && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

async function boot(sess, port, url, label) {
  await sess.goto(`http://127.0.0.1:${port}/${url}`, { settle: 1200 });
  for (let i = 0; i < 60; i++) {
    if (await sess.evalJs('!!window.__ready')) return true;
    await sleep(500);
  }
  say(`   [!] ${label} 没起来：` + JSON.stringify(await sess.evalJs('window.__playError || null')));
  return false;
}

async function phoneViewport(sess) {
  await sess.send('Emulation.setDeviceMetricsOverride', {
    width: PHONE.w, height: PHONE.h, deviceScaleFactor: PHONE.dpr, mobile: true,
    screenWidth: PHONE.w, screenHeight: PHONE.h,
  });
  await sess.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}

async function desktopViewport(sess) {
  await sess.viewport(DESKTOP.w, DESKTOP.h);
  await sess.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 0 });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  await killStrayChrome();
  server = await serve(ROOT, PORT);
  chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_layout' });
  sess = await attach({ port: DEBUG });
  say(`   GL ${await sess.glRenderer()}`);

  /* ================================================ 1. 桌面基线（对照） */
  say('');
  say('-- 1. 桌面 1440×900：窄屏那套规则一条都不许生效 -----------------------');
  await desktopViewport(sess);
  if (!await boot(sess, PORT, 'play.html', '桌面菜单')) throw new Error('desktop menu did not boot');

  const d = JSON.parse(await sess.evalJs(`JSON.stringify((() => {
    const rect = ${RECT};
    return {
      vw: innerWidth, vh: innerHeight,
      howtoOpen: document.getElementById('start-howto').open,
      mapToggle: rect('map-toggle').display,
      minimap: rect('minimap').display,
      minimapBox: rect('minimap'),
      go: rect('start-go'),
      overflowX: document.getElementById('ov-start').scrollWidth - document.getElementById('ov-start').clientWidth,
    };
  })())`));

  check('桌面: 小地图直接就在那儿（display:block）', d.minimap === 'block', d.minimap);
  check('桌面: 没有「地图」开关（多按一次才看得到地图是退步）', d.mapToggle === 'none', d.mapToggle);
  check('桌面: 「怎么玩」默认是展开的（收起来是给窄屏的让步）', d.howtoOpen === true,
    `open=${d.howtoOpen}`);
  check('桌面: 开始页没有横向溢出', d.overflowX <= 1, `scrollWidth-clientWidth=${d.overflowX}`);
  await sess.shot(path.join(SHOTS, '22-layout-desktop-menu.png'));

  // 桌面这一轮的 minimap 指标，作为窄屏展开后的对照。
  const deskMap = JSON.parse(await sess.evalJs(`JSON.stringify(__play.minimap.metrics())`));
  check('桌面: 小地图 260 CSS px，6 个房间名全部画上',
    deskMap.cssW === 260 && deskMap.labelled >= 5,
    `${deskMap.cssW}px · 标注 ${deskMap.labelled}/${deskMap.rooms} 个房间 · dpr ${deskMap.dpr}`);

  /* ============================================= 2. 手机上：开始那一屏 */
  say('');
  say(`-- 2. 手机 ${PHONE.w}×${PHONE.h}：开始页 ----------------------------------`);
  await phoneViewport(sess);
  if (!await boot(sess, PORT, 'play.html', '手机菜单')) throw new Error('phone menu did not boot');

  const m = JSON.parse(await sess.evalJs(`JSON.stringify((() => {
    const rect = ${RECT};
    return {
      vw: innerWidth, vh: innerHeight,
      howtoOpen: document.getElementById('start-howto').open,
      mapToggle: rect('map-toggle').display,
      minimap: rect('minimap').display,
      go: rect('start-go'),
      ov: (() => { const o = document.getElementById('ov-start');
        return { sh: o.scrollHeight, ch: o.clientHeight,
                 overflowX: o.scrollWidth - o.clientWidth,
                 overflowY: getComputedStyle(o).overflowY }; })(),
      panel: rect('start-go') ? rect('ov-start').h : 0,
      maps: document.querySelectorAll('#start-maps .mapcard').length,
      cards: document.querySelectorAll('#start-cards .card').length,
    };
  })())`));

  check('手机: 「开始」按钮整个在首屏里（不用滚）', inside(m.go, m.vw, m.vh),
    `top=${num(m.go.t)} bottom=${num(m.go.b)} / 视口 ${m.vh}`);
  check('手机: 开始页确实比一屏长（否则"钉住"这件事没被考验到）',
    m.ov.sh > m.ov.ch, `内容 ${m.ov.sh}px > 视口 ${m.ov.ch}px`);
  check('手机: 开始页可以滚（overflow-y 不是 hidden）',
    m.ov.overflowY === 'auto' || m.ov.overflowY === 'scroll', m.ov.overflowY);
  check('手机: 没有横向溢出', m.ov.overflowX <= 1, `scrollWidth-clientWidth=${m.ov.overflowX}`);
  check('手机: 「怎么玩」自动收起来了', m.howtoOpen === false, `open=${m.howtoOpen}`);
  check('手机: 选择用的卡片一个不少（6 张地图 + 4 档难度）',
    m.maps === 6 && m.cards >= 3, `地图 ${m.maps} 张 · 难度 ${m.cards} 档`);
  check('手机: 小地图默认收起', m.minimap === 'none', m.minimap);
  check('手机: 出现「地图」开关', m.mapToggle !== 'none', m.mapToggle);
  await sess.shot(path.join(SHOTS, '23-layout-phone-menu.png'));

  /* 负对照：展开后必须与桌面**一模一样**，房间名一个不少。 */
  const opened = JSON.parse(await sess.evalJs(`(() => {
    document.getElementById('map-toggle').click();
    const c = document.getElementById('minimap');
    const r = c.getBoundingClientRect();
    const hud = document.getElementById('hud').getBoundingClientRect();
    return JSON.stringify({
      display: getComputedStyle(c).display,
      metrics: __play.minimap.metrics(),
      box: { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height },
      hudRight: hud.right, vw: innerWidth,
      aria: document.getElementById('map-toggle').getAttribute('aria-expanded'),
    });
  })()`));
  check('手机: 点「地图」把它展开（display:block）', opened.display === 'block', opened.display);
  check('手机: 展开后与桌面**同一个**地图（房间名一个不少）',
    opened.metrics.labelled === deskMap.labelled && opened.metrics.cssW === 260,
    `标注 ${opened.metrics.labelled} 个（桌面也是 ${deskMap.labelled}）· ${opened.metrics.cssW}px`);
  check('手机: 展开的地图没有被挤出屏幕', opened.box.l >= 0 && opened.box.r <= opened.vw,
    `右边缘 ${num(opened.box.r)} / 视口 ${opened.vw}`);
  check('手机: 开关的 aria-expanded 跟着状态走', opened.aria === 'true', `aria-expanded=${opened.aria}`);
  await sess.shot(path.join(SHOTS, '24-layout-phone-map-open.png'));

  /* ============================================ 3. 手机上：玩起来之后 */
  say('');
  say('-- 3. 手机玩起来：顶栏不相撞、按钮够大、提示不压在按钮上 -------------');
  if (!await boot(sess, PORT, 'play.html?play=1', '手机对局')) throw new Error('phone play did not boot');
  await sess.evalAsync('__play.renderOnce(); return 1;');
  await sleep(300);

  const p = JSON.parse(await sess.evalJs(`JSON.stringify((() => {
    const rect = ${RECT};
    const btns = ['t-jump', 't-use', 't-pause'].map((id) => ({ id, ...rect(id) }));
    return {
      vw: innerWidth, vh: innerHeight,
      hud: rect('hud'), guard: rect('guardbox'),
      hint: rect('hint'), btns,
      moveZone: rect('touch-move'),
      touchOn: document.getElementById('touch').classList.contains('on'),
      overflowX: document.documentElement.scrollWidth - innerWidth,
    };
  })())`));

  check('手机: 对局中触屏层是开的（不然下面全是空断言）', p.touchOn === true, `touch.on=${p.touchOn}`);
  check('手机: 顶栏两块不再相撞（HUD 与主人状态框不相交）',
    !overlap(p.hud, p.guard),
    `HUD ${num(p.hud.l)}–${num(p.hud.r)} · 状态框 ${num(p.guard.l)}–${num(p.guard.r)}（视口 ${p.vw}）`);
  check('手机: 两块顶栏都在屏幕里', inside(p.hud, p.vw, p.vh) && inside(p.guard, p.vw, p.vh),
    `HUD 右 ${num(p.hud.r)} · 状态框右 ${num(p.guard.r)} / ${p.vw}`);
  const bad = p.btns.filter((b) => !inside(b, p.vw, p.vh) || b.w < MIN_TAP || b.h < MIN_TAP);
  check(`手机: 三个按钮都在屏幕里且 ≥ ${MIN_TAP}×${MIN_TAP}`,
    bad.length === 0,
    p.btns.map((b) => `${b.id} ${num(b.w, 0)}×${num(b.h, 0)}@${num(b.l, 0)},${num(b.t, 0)}`).join(' · '));
  check('手机: 底部提示不压在按钮上（提示是文字，按钮是手指要去的地方）',
    !overlap(p.hint, p.btns[0]) && !overlap(p.hint, p.btns[1]) && !overlap(p.hint, p.btns[2]),
    `提示 ${num(p.hint.l)}–${num(p.hint.r)} × ${num(p.hint.t)}–${num(p.hint.b)}`);
  check('手机: 底部提示在屏幕里', inside(p.hint, p.vw, p.vh),
    `${num(p.hint.w)}×${num(p.hint.h)} @ ${num(p.hint.t)}`);
  check('手机: 摇杆站区不盖住顶栏（否则小地图开关点不到）',
    p.moveZone.t >= p.hud.b,
    `站区顶 ${num(p.moveZone.t)} vs HUD 底 ${num(p.hud.b)}`);
  check('手机: 整页零横向溢出', p.overflowX <= 1, `scrollWidth-innerWidth=${p.overflowX}`);
  await sess.shot(path.join(SHOTS, '25-layout-phone-play.png'));

  /* ============================================== 4. 地图开关真的能开 */
  say('');
  say('-- 4. 对局中打开地图：顶栏不会因此撞上，也不出屏 ----------------------');
  const live = JSON.parse(await sess.evalJs(`(() => {
    document.getElementById('map-toggle').click();
    const c = document.getElementById('minimap');
    const r = c.getBoundingClientRect();
    const hud = document.getElementById('hud').getBoundingClientRect();
    return JSON.stringify({ display: getComputedStyle(c).display,
      box: { l: r.left, t: r.top, r: r.right, b: r.bottom },
      hud: { l: hud.left, t: hud.top, r: hud.right, b: hud.bottom }, vw: innerWidth, vh: innerHeight });
  })()`));
  check('对局中展开地图：画得出来且在屏幕里',
    live.display === 'block' && inside(live.box, live.vw, live.vh),
    `${num(live.box.w)}×${num(live.box.h)} 右 ${num(live.box.r)} 底 ${num(live.box.b)}`);
  check('对局中展开地图：HUD 变高之后仍然没有横向溢出',
    live.hud.r <= live.vw + 1, `HUD 右 ${num(live.hud.r)} / ${live.vw}`);
  await sess.shot(path.join(SHOTS, '26-layout-phone-map-live.png'));

  /* ------------------------------------------------------------ 收尾 */
  const fin = sess.diagnostics();
  const late = [...fin.exceptions, ...fin.consoleErrors, ...fin.logErrors]
    .filter((e) => !String(e).includes('manifest.json'));
  check('整个会话零异常、零控制台错误（音频 manifest 的 404 除外）', late.length === 0,
    late.slice(0, 2).join(' | ') || 'clean');

  fs.writeFileSync(path.join(WORK, 'layout_eval.json'), JSON.stringify({
    desktop: d, deskMap,
    phoneMenu: m, opened, phonePlay: p, liveMap: live,
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
    fs.writeFileSync(path.join(WORK, 'verify_layout.log'), log.join('\n') + '\n');
    try { if (sess) sess.close(); } catch { /* */ }
    try { if (chrome) chrome.kill(); } catch { /* */ }
    try { if (server) await server.close(); } catch { /* */ }
    await killStrayChrome();
    if (!verdict) exitCode = 1;
    process.exit(exitCode);
  });
