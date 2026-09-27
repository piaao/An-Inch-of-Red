/**
 * verify_touch.mjs — 手机上能玩，而且**手机不是另一个游戏**。
 *
 * THE CLAIM, IN TWO HALVES, AND THE SECOND IS THE ONE THAT MATTERS
 * ---------------------------------------------------------------
 *
 *   1. 一根手指能玩：左半屏摇杆走路、右半屏拖动转视角、三个按钮。
 *   2. **触屏是第三个输入源，不是第三个物理。** 它空闲时对
 *      `stepSim` 没有任何影响（桌面与手机 600 帧的状态逐位相同），
 *      它推满摇杆时送出的数与按住 W 送出的数**逐位相同**。
 *
 * 第 2 条是全部意义所在：`game/VERDICT.md` 的胜率全是在"键盘 + 鼠标"这套输入
 * 上量的。如果手机上手感"更好"（比如摇杆能给出 >1 的模长），那手机上量到的
 * 胜率与桌面上量到的就不是同一个数字，而两张卡片会继续引用同一份 VERDICT。
 *
 * 所以这里没有任何一条断言是"看着挺顺"：全部是可数的 —— 逐位相同的状态、
 * 逐位相同的 input 向量、精确到 1e-9 的位移差、点在屏幕上的矩形。
 *
 * 三个"量具的坑"，写在这里免得下一个人重踩：
 *
 *   ① **rAF 会插进来。** 页面活着的时候 `loop()` 每帧都在推进模拟，所以
 *      "按住摇杆再读状态"这种跨 `await` 的测量必然不等。修法是**原子测量**：
 *      把 `teleport -> step -> 读状态` 放进**同一个** `evalAsync` 体里，
 *      中间一个 `await` 都没有；微任务续行先于下一个 rAF 回调，于是这 30 步
 *      之间没有别人碰过状态。
 *   ② **`look` 累加器每帧被清零**，只看瞬时值的话"拖了 150 px"和"拖了 3 px"
 *      在下一帧长得一模一样。所以触屏层自己记**单调计数** `totalLook`，
 *      验收读那个。
 *   ③ **探不到手指就等于全绿。** 一个"永远显示摇杆"的实现会通过所有几何断言，
 *      所以桌面那一轮必须断言 `supported === false` 且 `#touch` 不可见。
 *
 * Usage:  node scripts/verify_touch.mjs
 *         node scripts/verify_touch.mjs 2026-09-25
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cdp from './cdp.js';
import { MOVE, TOUCH } from '../game/play/config.js';

const { serve, launch, attach, killStrayChrome, sleep } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORK = path.join(ROOT, 'work');
const SHOTS = path.join(ROOT, 'renders', 'play');
const PORT = 8783;
const DEBUG = 9228;
const SEED = process.argv[2] || '2026-09-25';
const PRESET = 'patrol';              // 有守卫的那档，用来验"没守卫也照跑"
const QUIET = 'solo';                 // 无守卫档：量测期间不许有人把我抓走

const PHONE = { w: 390, h: 844, dpr: 2 };
const DESKTOP = { w: 1440, h: 900, dpr: 1 };

const log = [];
const say = (s = '') => { log.push(s); console.log(s); };
const num = (v, d = 4) => (Number.isFinite(v) ? v.toFixed(d) : String(v));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  say(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  return !!ok;
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* --------------------------------------------------------- 触摸事件投递 */

const P = (x, y, id = 1) => ({ x, y, id, radiusX: 12, radiusY: 12, force: 1 });

/** 投递一次**受信的**触摸事件（浏览器层面，不是页面里合成的）。 */
async function tEvent(sess, type, points) {
  await sess.send('Input.dispatchTouchEvent', { type, touchPoints: points });
}

/** 按住在 (x, y)，然后拖到 (x2, y2)。 */
async function drag(sess, x, y, x2, y2) {
  await tEvent(sess, 'touchStart', [P(x, y)]);
  await tEvent(sess, 'touchMove', [P((x + x2) / 2, (y + y2) / 2)]);
  await tEvent(sess, 'touchMove', [P(x2, y2)]);
}

/** 一次轻点：落指、抬指。 */
async function tap(sess, x, y) {
  await tEvent(sess, 'touchStart', [P(x, y)]);
  await sleep(30);
  await tEvent(sess, 'touchEnd', []);
}

/** 某个元素的中心点，CSS px。找不到返回 null。 */
async function centre(sess, id) {
  return sess.evalJs(
    `(() => { const e = document.getElementById(${JSON.stringify(id)});
      if (!e) return null; const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`,
  );
}

/* ==================================================================== main */

let server = null, chrome = null, sess = null;
let exitCode = 0;

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });

  /* ------------------------------------------------------- 0. 静态接线 */
  say('-- 0. 接线：id 在 HTML、lookup 在 touch.js、样式在 play.css ---------');
  const html = read('play.html');
  const css = read('css/play.css');
  const tjs = read('game/play/touch.js');
  const pjs = read('game/play/play.js');
  const cfg = read('game/play/config.js');

  // 触屏层自己要用的 9 个 id，加上它接管文案的两个既有元素。
  const IDS = ['touch', 'touch-move', 'touch-look', 'stick', 'stick-knob', 'touch-btns',
               't-jump', 't-use', 't-pause', 'hint', 'prop-prompt'];
  const missingHtml = IDS.filter((i) => !html.includes(`id="${i}"`));
  check('play.html 声明了触屏层的全部 9 个 id', missingHtml.length === 0,
    missingHtml.length ? '缺: ' + missingHtml.join(', ') : IDS.join(' '));

  // "一个没人填的槽"是这仓库记过账的老毛病（verify_menus 的头注）：
  // HTML 里有 id、代码里没人查，界面就是一块死的。两个方向都查。
  const lookups = [...tjs.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  const loopIds = (tjs.match(/for \(const id of \[([^\]]*)\]/) || [])[1];
  const looped = loopIds ? [...loopIds.matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  const wanted = new Set([...lookups, ...looped]);
  const absent = [...wanted].filter((i) => !IDS.includes(i));
  check('touch.js 查的 id 全都在 play.html 里（没有查空的）', absent.length === 0,
    absent.length ? '查了不存在的: ' + absent.join(', ') : [...wanted].join(' '));
  check('touch.js 把三个按钮都接上了', looped.length === 3 && looped.includes('t-jump'),
    looped.join(' '));

  const cssNeed = ['#touch.on', '#touch-move', '#touch-look', '#stick-knob', '.tbtn'];
  const cssMiss = cssNeed.filter((s) => !css.includes(s));
  check('css/play.css 给了触屏层样式', cssMiss.length === 0,
    cssMiss.length ? '缺: ' + cssMiss.join(', ') : cssNeed.join(' '));
  check('#touch 上写了 touch-action:none（否则拖拽会把页面拽走）',
    /#touch\s*\{[^}]*touch-action:\s*none/.test(css), 'touch-action: none');
  check('config.js 导出了 TOUCH 那一块', /export const TOUCH = \{/.test(cfg), 'export const TOUCH');
  check('play.js 里 input 只组装一次（assembleInput 本体 + 无第二份）',
    (pjs.match(/function assembleInput\(\)/g) || []).length === 1
      && (pjs.match(/const input = assembleInput\(\);/g) || []).length === 1,
    'assembleInput x1 / 调用 x1');

  /* ------------------------------------------------------- 起浏览器 */
  await killStrayChrome();
  server = await serve(ROOT, PORT);
  chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_touch' });
  sess = await attach({ port: DEBUG });
  say(`   GL ${await sess.glRenderer()}`);

  const errorsSince = (mark) => {
    const d = sess.diagnostics();
    return [].concat(
      d.exceptions.slice(mark.e), d.consoleErrors.slice(mark.c),
      d.logErrors.slice(mark.l),
    );
  };
  const mark = () => {
    const d = sess.diagnostics();
    return { e: d.exceptions.length, c: d.consoleErrors.length, l: d.logErrors.length };
  };

  /* ===================================================== 1. 桌面那一轮 */
  say('');
  say('-- 1. 桌面（对照）：触屏层必须整层不出现 -----------------------------');
  await sess.viewport(DESKTOP.w, DESKTOP.h);
  await sess.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 0 });
  await sess.goto(`http://127.0.0.1:${PORT}/play.html?play=1`, { settle: 1200 });

  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await sess.evalJs('!!window.__ready');
    if (!ready) await sleep(500);
  }
  if (!ready) throw new Error('页面没起来: ' + JSON.stringify(await sess.evalJs('window.__playError || null')));

  await sess.evalAsync('__play.renderOnce(); return 1;');
  const desk = JSON.parse(await sess.evalJs(`JSON.stringify({
    touch: __play.touchInfo(),
    cls: document.getElementById('touch').classList.contains('on'),
    display: getComputedStyle(document.getElementById('touch')).display,
    hint: (document.getElementById('hint')||{}).textContent || '',
    mapToggle: getComputedStyle(document.getElementById('map-toggle')).display,
    agents: navigator.maxTouchPoints || 0,
  })`));
  check('桌面: 探不到手指（supported=false）', desk.touch.supported === false,
    `supported=${desk.touch.supported} · maxTouchPoints=${desk.agents}`);
  check('桌面: 触屏层整层不显示', desk.cls === false && desk.display === 'none',
    `class.on=${desk.cls} display=${desk.display}`);
  check('桌面: 底部提示还是键盘那一份', desk.hint.includes('WASD') && !desk.hint.includes('左半屏'),
    desk.hint.slice(0, 40) + '…');
  check('桌面: 小地图开关不出现（地图本来就在那儿）', desk.mapToggle === 'none', desk.mapToggle);
  check('桌面: 触屏读数恒为空闲', desk.touch.fwd === 0 && desk.touch.side === 0 && desk.touch.jump === 0,
    JSON.stringify({ fwd: desk.touch.fwd, side: desk.touch.side, jump: desk.touch.jump }));

  // 桌面这一轮的 600 帧轨迹，等下和手机那一轮比。
  const trace = await sess.evalAsync(`
    const snap = () => {
      const s = __play.info();
      const p = s.player;
      return [p.x, p.z, p.y, p.yaw, s.elapsed, s.collected,
        s.guards.map((g) => g.pos.x + ',' + g.pos.z + ',' + g.mode + ',' + g.suspicion).join('|')].join(';');
    };
    __play.release();
    await __play.begin(${JSON.stringify(PRESET)}, { seed: ${JSON.stringify(SEED)} });
    __play.input({ fwd: 1, turn: 0.37 });
    const rows = [];
    for (let i = 0; i < 600; i++) { __play.tick(1 / 60, 1); if (i % 60 === 59) rows.push(snap()); }
    return JSON.stringify({ rows });
  `);
  const deskTrace = JSON.parse(trace).rows;
  const deskErrors = errorsSince(mark());

  /* ====================================================== 2. 手机那一轮 */
  say('');
  say('-- 2. 手机（390 × 844 @dpr2，真触摸模拟）------------------------------');
  await sess.send('Emulation.setDeviceMetricsOverride', {
    width: PHONE.w, height: PHONE.h, deviceScaleFactor: PHONE.dpr, mobile: true,
    screenWidth: PHONE.w, screenHeight: PHONE.h,
  });
  await sess.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sess.goto(`http://127.0.0.1:${PORT}/play.html?play=1`, { settle: 1200 });
  for (let i = 0; i < 60; i++) {
    if (await sess.evalJs('!!window.__ready')) break;
    await sleep(500);
  }
  await sess.evalAsync('__play.renderOnce(); return 1;');

  const phone = JSON.parse(await sess.evalJs(`JSON.stringify({
    touch: __play.touchInfo(),
    cls: document.getElementById('touch').classList.contains('on'),
    display: getComputedStyle(document.getElementById('touch')).display,
    hint: (document.getElementById('hint')||{}).textContent || '',
    promptCls: document.getElementById('prop-prompt').classList.contains('touch'),
    vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
    zones: (() => { const r = {}; for (const id of ['touch-move','touch-look']) {
      const b = document.getElementById(id).getBoundingClientRect();
      r[id] = { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; }
      return r; })(),
  })`));
  check('手机: 探到了手指（supported=true）', phone.touch.supported === true,
    `supported=${phone.touch.supported} dpr=${phone.dpr} ${phone.vw}×${phone.vh}`);
  check('手机: 玩的时候触屏层是开着的', phone.cls === true && phone.display === 'block',
    `class.on=${phone.cls} display=${phone.display}`);
  check('手机: 底部提示换成了触屏那一份',
    phone.hint.includes('左半屏') && !phone.hint.includes('WASD'), phone.hint.slice(0, 44) + '…');
  check('手机: 准星提示摘掉了 E 键帽', phone.promptCls === true, 'prop-prompt.touch');
  const zm = phone.zones['touch-move'], zl = phone.zones['touch-look'];
  check('两个站区把屏幕下半部分分掉了，上面 38% 留给顶栏',
    zm.l === 0 && zl.l + zl.w === PHONE.w && zm.t === zl.t && zm.t > PHONE.h * 0.3,
    `move ${zm.l},${zm.t} ${zm.w}×${zm.h} · look ${zl.l},${zl.t} ${zl.w}×${zl.h}`);

  /* ------------------------------------------- 2a. 触屏空闲 = 桌面（逐位） */
  say('');
  say('-- 2a. 触屏空闲时，600 帧的状态必须与桌面逐位相同 --------------------');
  const phoneTrace = JSON.parse(await sess.evalAsync(`
    const snap = () => {
      const s = __play.info();
      const p = s.player;
      return [p.x, p.z, p.y, p.yaw, s.elapsed, s.collected,
        s.guards.map((g) => g.pos.x + ',' + g.pos.z + ',' + g.mode + ',' + g.suspicion).join('|')].join(';');
    };
    __play.release();
    await __play.begin(${JSON.stringify(PRESET)}, { seed: ${JSON.stringify(SEED)} });
    __play.input({ fwd: 1, turn: 0.37 });
    const rows = [];
    for (let i = 0; i < 600; i++) { __play.tick(1 / 60, 1); if (i % 60 === 59) rows.push(snap()); }
    return JSON.stringify({ rows });
  `)).rows;

  const same = deskTrace.length === phoneTrace.length
    && deskTrace.every((r, i) => r === phoneTrace[i]);
  const firstDiff = deskTrace.findIndex((r, i) => r !== phoneTrace[i]);
  check('桌面 600 帧 == 手机 600 帧（逐位相同）', same,
    same ? `${deskTrace.length} 个采样点全部一致` : `第 ${Math.floor(firstDiff / 1)} 个采样点开始不同`);
  check('这条轨迹确实在动（不是两边都僵着，才会有"相同"的假象）',
    deskTrace.length === 10 && deskTrace[0] !== deskTrace[9],
    deskTrace.length ? `首 ${deskTrace[0].slice(0, 34)}…` : '(空)');
  check('桌面那条路径上确实没有意外（零异常）', deskErrors.length === 0,
    deskErrors.slice(0, 2).join(' | ') || 'clean');

  /* --------------------------------------- 2b. 摇杆几何（真触摸事件驱动） */
  say('');
  say('-- 2b. 摇杆：满行程 = 1，模长不超过 1，死区归零，松手归零 ------------');
  const R = phone.touch.stickR;
  const OX = 80, OY = 700;                       // 左半屏里的一点
  const g = (expr) => sess.evalJs(`JSON.stringify(${expr})`).then(JSON.parse);

  await tEvent(sess, 'touchStart', [P(OX, OY)]);
  let p0 = await g('({...__play.touchInfo()})');
  check('落指即出现摇杆，但还没推（fwd=side=0）',
    p0.moveId !== null && p0.fwd === 0 && p0.side === 0 && p0.stick.x === 0 && p0.stick.y === 0,
    `moveId=${p0.moveId} stick=${JSON.stringify(p0.stick)}`);
  const stickVis = await sess.evalJs("JSON.stringify({hidden: document.getElementById('stick').hidden, pos: (()=>{const s=document.getElementById('stick');return s.style.left+','+s.style.top;})()})");
  check('圆环画在手指落下的地方（浮动原点）', JSON.parse(stickVis).hidden === false,
    JSON.parse(stickVis).pos);

  await tEvent(sess, 'touchMove', [P(OX, OY - R)]);
  let p1 = await g('({...__play.touchInfo()})');
  check('推满向前 = fwd 恰好 1、side 恰好 0（和按满 W 同一个数）',
    p1.fwd === 1 && p1.side === 0, `fwd=${p1.fwd} side=${p1.side}`);

  await tEvent(sess, 'touchMove', [P(OX - R, OY)]);
  let p2 = await g('({...__play.touchInfo()})');
  check('推满向左 = side 恰好 -1', p2.side === -1 && p2.fwd === 0, `fwd=${p2.fwd} side=${p2.side}`);

  const diag = Math.SQRT1_2 * R;
  await tEvent(sess, 'touchMove', [P(OX + diag, OY - diag)]);
  let p3 = await g('({...__play.touchInfo()})');
  const mag3 = Math.hypot(p3.fwd, p3.side);
  // 容差不是"大概齐"：`state()` 把读数压到 6 位小数（日志要能读），
  // 于是 hypot(0.707107, 0.707107) = 1.0000003 ——**量化误差，不是超速**。
  // 真正未经量化的上界由下一条（键盘斜向的 A/B）从行为上钉住。
  check('斜向的模长不超过 1（触屏跑不过键盘）', mag3 <= 1 + 1e-6,
    `|v| = ${num(mag3, 9)}（报告值 6 位小数，量化误差 ≤ 1e-6）`);
  check('斜向落在 45° 上（读数就是 √½）',
    Math.abs(p3.fwd - Math.SQRT1_2) < 1e-6 && Math.abs(p3.side - Math.SQRT1_2) < 1e-6,
    `fwd=${num(p3.fwd, 6)} side=${num(p3.side, 6)} vs √½=${num(Math.SQRT1_2, 6)}`);

  await tEvent(sess, 'touchMove', [P(OX, OY - 6 * R)]);
  let p4 = await g('({...__play.touchInfo()})');
  check('拖出圆环之外仍然被夹到满行程（不会 >1）', p4.fwd === 1 && p4.side === 0,
    `fwd=${p4.fwd} side=${p4.side}（手指在 ${6 * R}px 外）`);

  await tEvent(sess, 'touchMove', [P(OX + 2, OY)]);
  let p5 = await g('({...__play.touchInfo()})');
  check(`死区内的抖动归零（2px < ${TOUCH.dead * 100}% × ${R}px）`,
    p5.fwd === 0 && p5.side === 0, `fwd=${p5.fwd} side=${p5.side}`);

  await tEvent(sess, 'touchEnd', []);
  let p6 = await g('({...__play.touchInfo()})');
  check('松手：读数归零、摇杆收起、moveId 释放',
    p6.moveId === null && p6.fwd === 0 && p6.side === 0
      && (await sess.evalJs("document.getElementById('stick').hidden")) === true,
    `moveId=${p6.moveId} fwd=${p6.fwd}`);

  /* ------------------------------------ 2c. 满行程摇杆 == 按住 W（逐位） */
  say('');
  say('-- 2c. 摇杆推满送出的 input，与按住 W 送出的 input 逐位相同 ----------');
  const start = JSON.parse(await sess.evalAsync(`
    __play.release();
    await __play.begin(${JSON.stringify(QUIET)}, { guards: 0 });
    __play.renderOnce();
    const a = __play.avatar.state();
    return JSON.stringify({ x: a.x, z: a.z, yaw: a.yaw, on: __play.touchInfo().on });
  `));
  check('无守卫档下触屏层仍然开着（相位驱动，不是"有没有人"驱动）', start.on === true, `on=${start.on}`);

  const atomicRun = (setup) => sess.evalAsync(`
    ${setup}
    // 原子：teleport -> 30 步 -> 读状态，中间一个 await 都没有。
    // 微任务续行先于下一个 rAF 回调，所以这 30 步之间没有别人碰过状态。
    __play.teleport(${start.x}, ${start.z}, ${start.yaw});
    const a = __play.avatar.state();
    __play.step(1 / 60, 30);
    const b = __play.avatar.state();
    return JSON.stringify({
      a: { x: a.x, z: a.z, yaw: a.yaw },
      b: { x: b.x, z: b.z, yaw: b.yaw },
      input: __play.inputNow(),
    });
  `);

  await tEvent(sess, 'touchStart', [P(OX, OY)]);
  await tEvent(sess, 'touchMove', [P(OX, OY - R)]);
  const viaStick = JSON.parse(await atomicRun('__play.release();'));
  await tEvent(sess, 'touchEnd', []);
  const viaKey = JSON.parse(await atomicRun('__play.input({ fwd: 1 });'));

  const walked = Math.hypot(viaStick.b.x - viaStick.a.x, viaStick.b.z - viaStick.a.z);
  check('摇杆推满时 assembleInput 给出 fwd=1（读的是模拟用的那个函数）',
    viaStick.input.fwd === 1 && viaStick.input.side === 0,
    `fwd=${viaStick.input.fwd} side=${viaStick.input.side}`);
  check('两种通道 30 步后位置与朝向逐位相同',
    JSON.stringify(viaStick.b) === JSON.stringify(viaKey.b),
    JSON.stringify(viaStick.b) === JSON.stringify(viaKey.b)
      ? `走了 ${num(walked, 3)} m，两边同一个点`
      : `摇杆 ${JSON.stringify(viaStick.b)} vs 键盘 ${JSON.stringify(viaKey.b)}`);
  check('这 30 步确实走了路（不是两边都卡在墙里）', walked > 0.2,
    `${num(walked, 3)} m / 0.5 s = ${num(walked / 0.5, 3)} m/s（MOVE.speed=${MOVE.speed}）`);

  // 斜向那一路**不是**逐位相同，而且原因值得写下来：满行程落在 45° 时，
  // `hypot(√½, √½)` 是 0.9999999999999999 而不是 1，于是死区重标定把它再乘
  // 0.9999999999999998 —— 键盘那条走的是 `mag>1 -> /=mag`，落在 1 上。
  // 差的是最后一个 ULP，所以断言写成"同一条路"（毫米以下），并把差值印出来。
  await tEvent(sess, 'touchStart', [P(OX, OY)]);
  await tEvent(sess, 'touchMove', [P(OX + diag, OY - diag)]);
  const diagStick = JSON.parse(await atomicRun('__play.release();'));
  await tEvent(sess, 'touchEnd', []);
  const diagKey = JSON.parse(await atomicRun('__play.input({ fwd: 1, side: 1 });'));
  const dd = Math.hypot(diagStick.b.x - diagKey.b.x, diagStick.b.z - diagKey.b.z);
  const rel = walked > 0 ? dd / walked : dd;
  check('斜向：摇杆 45° 与键盘 W+D 走同一条路（走完 0.75 m 差 < 1 µm）', dd < 1e-6,
    `终点差 ${dd.toExponential(2)} m = 走了 ${num(walked, 3)} m 的 ${rel.toExponential(1)}`
    + `（相对误差 ${num(rel * 100, 8)}%）`);

  /* ---------------------------------------------- 2d. 转视角走同一个通道 */
  say('');
  say('-- 2d. 右半屏拖动 == __play.look（同一个 look 累加器，没有第二条换算链）--');
  const LX0 = 210, LY = 560, DX = 150;
  const before = JSON.parse(await sess.evalJs('JSON.stringify(__play.avatar.state())'));
  const lookBefore = (await g('({...__play.touchInfo()})')).totalLook.dx;

  await drag(sess, LX0, LY, LX0 + DX, LY);
  await tEvent(sess, 'touchEnd', []);
  await sleep(300);                                  // 让某一帧把它消费掉
  const after = JSON.parse(await sess.evalJs('JSON.stringify(__play.avatar.state())'));
  const yawBefore = before.yaw, yawAfter = after.yaw;
  const lookAfter = (await g('({...__play.touchInfo()})')).totalLook.dx;

  const expected = DX * TOUCH.turnGain;
  check(`横拖 ${DX} px 累加进 look 的量 = ${DX} × turnGain（${expected}）`,
    Math.abs((lookAfter - lookBefore) - expected) < 1e-9,
    `${num(lookAfter - lookBefore, 6)} vs 期望 ${num(expected, 6)}`);

  const dyawTouch = yawAfter - yawBefore;
  const yawMid = yawAfter;
  await sess.evalAsync(`__play.look(${expected}, 0); return 1;`);
  await sleep(300);
  const dyawApi = (await sess.evalJs('__play.avatar.state().yaw')) - yawMid;
  check('右拖与 __play.look 让视角转过的角度逐位相同',
    Math.abs(dyawTouch - dyawApi) < 1e-9,
    `触屏 ${num(dyawTouch, 9)} vs look() ${num(dyawApi, 9)} rad`);
  check('向右拖 = 视角向右（与鼠标同一符号）', dyawTouch < 0,
    `${num(dyawTouch, 6)} rad ≈ ${num((dyawTouch * 180) / Math.PI, 2)}°`);
  check('横拖不改变俯仰（pitch 只吃 dy）', Math.abs(after.pitch - before.pitch) < 1e-12,
    `pitch ${num(before.pitch, 9)} -> ${num(after.pitch, 9)}`);

  /* ------------------------------------------------------ 2e. 三个按钮 */
  say('');
  say('-- 2e. 跳 / 开门 / 暂停：三个按钮走的是真事件 ------------------------');
  const jumpBtn = await centre(sess, 't-jump');
  check('「跳」按钮在屏幕里且够大（≥ 44×44 CSS px）',
    !!jumpBtn && jumpBtn.x > 0 && jumpBtn.x < PHONE.w && jumpBtn.y > 0 && jumpBtn.y < PHONE.h
      && jumpBtn.w >= 44 && jumpBtn.h >= 44,
    jumpBtn ? `${Math.round(jumpBtn.w)}×${Math.round(jumpBtn.h)} @ ${Math.round(jumpBtn.x)},${Math.round(jumpBtn.y)}` : '找不到');

  const jumpIdle = JSON.parse(await sess.evalAsync(`
    __play.teleport(${start.x}, ${start.z}, ${start.yaw});
    __play.step(1 / 60, 6);
    const a = __play.avatar.state();
    return JSON.stringify({ y: a.y, airborne: !!a.airborne, jump: __play.inputNow().jump });
  `));
  check('没按「跳」时人在地上', Math.abs(jumpIdle.y) < 1e-9 && jumpIdle.jump === 0,
    `y=${jumpIdle.y} jump=${jumpIdle.jump}`);

  await tEvent(sess, 'touchStart', [P(jumpBtn.x, jumpBtn.y)]);
  const jumpHeld = JSON.parse(await sess.evalAsync(`
    __play.teleport(${start.x}, ${start.z}, ${start.yaw});
    __play.step(1 / 60, 6);
    const a = __play.avatar.state();
    return JSON.stringify({ y: a.y, airborne: !!a.airborne, jump: __play.inputNow().jump,
                            taps: __play.touchInfo().taps.jump });
  `));
  await tEvent(sess, 'touchEnd', []);
  check('按住「跳」= input.jump 为 1（与 Space 同义）', jumpHeld.jump === 1, `jump=${jumpHeld.jump}`);
  check('按住「跳」6 帧后人真的离地了', jumpHeld.y > 0.01 && jumpHeld.airborne === true,
    `y=${num(jumpHeld.y, 4)} m airborne=${jumpHeld.airborne}`);
  const jumpLoose = JSON.parse(await sess.evalAsync(`return JSON.stringify({ jump: __play.inputNow().jump })`));
  check('松开「跳」立刻归零（不会一直蹦）', jumpLoose.jump === 0, `jump=${jumpLoose.jump}`);

  // 开门：先找一个真的能开的东西，并且站到 legal 的地方（道具是实体，
  // 它正前方那一格常常不可走 —— 见 verify_play 的同一段注记）。
  const prop = JSON.parse(await sess.evalAsync(`
    __play.release();
    await __play.begin(${JSON.stringify(QUIET)}, { guards: 0 });
    const list = __play.props ? __play.props.heroes : [];
    if (!list.length) return JSON.stringify({ none: true });
    const target = list.find((h) => h.userData.prop.kind === 'slide')
      || list.find((h) => !h.userData.prop.model.startsWith('doorway')) || list[0];
    const p = target.userData.prop;
    const radii = [0.6, 0.8, 0.9, 1.0];
    const angles = [0, 0.5, -0.5, 1.0, -1.0, Math.PI / 2, -Math.PI / 2, Math.PI];
    let ok = false;
    for (const r of radii) {
      for (const a of angles) {
        const th = p.baseYaw + a;
        const tp = __play.teleport(p.x - Math.sin(th) * r, p.z - Math.cos(th) * r);
        const av = __play.avatar.state();
        if (tp && Math.hypot(av.x - p.x, av.z - p.z) <= 1.1) { ok = true; break; }
      }
      if (ok) break;
    }
    if (!ok) return JSON.stringify({ none: true, why: 'no legal stand' });
    const focus = __play.aimAt(p.x, p.basePos.y + 0.3, p.z);
    __play.renderOnce();
    return JSON.stringify({ model: p.model, kind: p.kind, open: !!p.open,
                            focus: focus, index: __play.props.heroes.indexOf(target) });
  `));
  const useBtn = await centre(sess, 't-use');
  check('「开门」按钮在屏幕里且够大', !!useBtn && useBtn.w >= 44 && useBtn.h >= 44,
    useBtn ? `${Math.round(useBtn.w)}×${Math.round(useBtn.h)}` : '找不到');
  if (!prop.none) {
    await tap(sess, useBtn.x, useBtn.y);
    await sleep(120);
    const after = JSON.parse(await sess.evalJs(`
      JSON.stringify({ open: !!__play.props.heroes[${prop.index}].userData.prop.open,
                       taps: __play.touchInfo().taps.use,
                       phase: __play.info().phase })`));
    check('点「开门」真的开了柜门/抽屉（走的是 interact() 同一条路）',
      after.open !== prop.open && after.taps >= 1,
      `${prop.kind} ${prop.model}: open ${prop.open} -> ${after.open}（focus=${prop.focus}）`);
  } else {
    check('点「开门」真的开了柜门/抽屉（走的是 interact() 同一条路）', false,
      '找不到可用的道具: ' + JSON.stringify(prop));
  }

  const pauseBtn = await centre(sess, 't-pause');
  check('「暂停」按钮在屏幕里且够大', !!pauseBtn && pauseBtn.w >= 44 && pauseBtn.h >= 44,
    pauseBtn ? `${Math.round(pauseBtn.w)}×${Math.round(pauseBtn.h)}` : '找不到');
  await sess.evalAsync(`await __play.begin(${JSON.stringify(QUIET)}, { guards: 0 }); __play.renderOnce(); return 1;`);
  await tap(sess, pauseBtn.x, pauseBtn.y);
  await sleep(80);
  const paused = JSON.parse(await sess.evalJs(`JSON.stringify({
    phase: __play.info().phase,
    overlay: !document.getElementById('ov-pause').classList.contains('hidden'),
    touchOn: __play.touchInfo().on })`));
  check('点「暂停」= 相位变 paused + 暂停面板弹出来',
    paused.phase === 'paused' && paused.overlay === true,
    `phase=${paused.phase} overlay=${paused.overlay}`);
  check('暂停后触屏层收起（免得手指继续驱动一个停住的局）', paused.touchOn === false,
    `touch.on=${paused.touchOn}`);
  const resumed = JSON.parse(await sess.evalAsync(`
    document.getElementById('pause-resume').click();
    __play.renderOnce();
    return JSON.stringify({ phase: __play.info().phase, touchOn: __play.touchInfo().on });`));
  check('暂停面板的「继续」能把局接回来、触屏层也回来',
    resumed.phase === 'playing' && resumed.touchOn === true,
    `phase=${resumed.phase} touch.on=${resumed.touchOn}`);

  /* -------------------------------------------------------- 2f. 像素取证 */
  say('');
  say('-- 2f. 截图：摇杆与按钮真的画在手机上 --------------------------------');
  await sess.evalAsync(`__play.renderOnce(); return 1;`);
  await tEvent(sess, 'touchStart', [P(OX, OY)]);
  await tEvent(sess, 'touchMove', [P(OX + 26, OY - 34)]);
  await sess.evalAsync(`__play.renderOnce(); return 1;`);
  const s1 = await sess.shot(path.join(SHOTS, '20-touch-stick.png'));
  await tEvent(sess, 'touchEnd', []);
  await tap(sess, pauseBtn.x, pauseBtn.y);
  await sleep(200);
  const s2 = await sess.shot(path.join(SHOTS, '21-touch-pause.png'));
  check('两张手机截图都写出来了', s1.ok && s1.bytes > 10000 && s2.ok && s2.bytes > 10000,
    `${s1.bytes || 0} B / ${s2.bytes || 0} B`);
  check('两张截图不一样（不是同一帧拍了两遍）', s1.bytes !== s2.bytes,
    `${s1.bytes} vs ${s2.bytes}`);

  /* ------------------------------------------------------------ 收尾 */
  const fin = sess.diagnostics();
  const late = [...fin.exceptions, ...fin.consoleErrors, ...fin.logErrors]
    .filter((e) => !String(e).includes('manifest.json'));
  check('整个会话零异常、零控制台错误（音频 manifest 的 404 除外）', late.length === 0,
    late.slice(0, 2).join(' | ') || 'clean');

  fs.writeFileSync(path.join(WORK, 'touch_eval.json'), JSON.stringify({
    seed: SEED, tune: { stickR: R, dead: TOUCH.dead, turnGain: TOUCH.turnGain },
    desktop: { ...desk, traceRows: deskTrace.length },
    phone: { ...phone, traceRows: phoneTrace.length },
    traceSame: same,
    stick: { full: p1, left: p2, diag: p3, clamp: p4, dead: p5, released: p6 },
    atomic: { viaStick, viaKey, walked },
    look: { dyawTouch, dyawApi, dx: lookAfter - lookBefore, expected },
    jump: { idle: jumpIdle, held: jumpHeld, loose: jumpLoose },
    prop, paused, resumed,
    shots: [{ name: '20-touch-stick.png', bytes: s1.bytes || 0 },
            { name: '21-touch-pause.png', bytes: s2.bytes || 0 }],
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
    fs.writeFileSync(path.join(WORK, 'verify_touch.log'), log.join('\n') + '\n');
    try { if (sess) sess.close(); } catch { /* */ }
    try { if (chrome) chrome.kill(); } catch { /* */ }
    try { if (server) await server.close(); } catch { /* */ }
    await killStrayChrome();
    if (!verdict) exitCode = 1;
    process.exit(exitCode);
  });
