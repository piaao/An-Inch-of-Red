/**
 * touch.js — 手机上的手：左半屏摇杆走路，右半屏拖动转视角，三个按钮。
 *
 * 这一层刻意做得很薄，因为它要做的事只有一件：
 *
 *     把手指变成 `{fwd, side, jump, look}`，交给 `stepSim` 已经在读的那几个字段。
 *
 * 它不是第三个物理。它不读 `level`、不碰 `nav`、不认识 `Guard`，也从不修改
 * 任何仿真状态 —— 和 `props.js` / `actors.js` 是同一条纪律。空闲时每个字段都是
 * 0，所以 `stepSim` 组装出的 input 与桌面**逐位相同**：`scripts/verify_touch.mjs`
 * 用同种子 600 步的状态哈希把这一条钉死，而不是靠"看着没问题"。
 *
 * 三个刻意的选择，每一个都是为了"手机不是另一个游戏"：
 *
 *   1. **视角走鼠标那一个累加器。** `onLook(dx, dy)` 直接加进 `play.js` 模块级的
 *      `look`，也就是指针锁定 `movementX` 的去处。所以手机上转视角用的还是
 *      `MOVE.mouseSens`，这里只多一个"手指比鼠标抖"的倍率 `TOUCH.turnGain`。
 *      第二条换算链会漂，而这一条不会：它根本不存在。
 *   2. **摇杆模长 ≤ 1。** `avatar.update` 里 `if (mag > 1)` 才归一化，也就是说
 *      键盘斜向不会加速。让摇杆的输出天然落在单位圆内，意味着**触屏永远跑不过
 *      键盘** —— 而不是"手机上顺手所以更快"，那会让手机上量到的胜率和桌面量到的
 *      不是同一个数字。
 *   3. **相位由外部一问即答。** 构造函数拿到的是 `phase: () => S.phase`，
 *      而不是五处地方各自记得调 `setPlaying()`。同一件事有五个写入点，就是
 *      五个会漂的地方。
 *
 * 能力探测放在这里，而不是 CSS 里：`@media (hover:none)` 在带触屏的笔记本上
 * 是假阳性，而"桌面浏览器一进来就多出一层摇杆"比"手机上没有摇杆"更糟。
 */

import { TOUCH } from './config.js';

/** 空闲读数。**同一个对象复用**：`move()` 每帧都被叫，不该每帧 new。 */
const IDLE = { fwd: 0, side: 0 };

/**
 * 触屏版操作提示。桌面那一份留在 `play.html` 里，这里只在切换时替换 ——
 * 换来换去的是"当前生效的那一份"，不是两句话各存一份。
 */
const HINT_TOUCH = '<b>左半屏拖动</b> 移动 · <b>右半屏拖动</b> 转向 · '
  + '<b>跳</b> 上桌/浴缸/台面 · <b>开门</b> 开柜推门 · <b>暂停</b>';

/**
 * 这台设备有没有手指？
 *
 * `?touch=1` / `?touch=0` 是给"带触屏的笔记本"和验收脚本留的显式开关：
 * 探测本身只能回答"有没有"，回答不了"这一次想不想用"。
 */
function detect() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  let q = null;
  try { q = new URLSearchParams(window.location.search).get('touch'); } catch { /* */ }
  if (q === '1') return true;
  if (q === '0') return false;
  if (!TOUCH.enabled) return false;
  return ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
}

/** 在 TouchList 里按 identifier 找一根手指。找不到返回 null（它抬起来了）。 */
function findById(list, id) {
  if (!list || id === null) return null;
  for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
  return null;
}

/** 这批"变化的触摸"里有没有 id 这根。touchend/touchcancel 用它。 */
function hasId(list, id) {
  return !!findById(list, id);
}

export class TouchLayer {
  constructor() {
    this.root = document.getElementById('touch');
    this.moveZone = document.getElementById('touch-move');
    this.lookZone = document.getElementById('touch-look');
    this.stick = document.getElementById('stick');
    this.knob = document.getElementById('stick-knob');
    this.hintEl = document.getElementById('hint');
    this.promptEl = document.getElementById('prop-prompt');

    this.supported = detect();
    this.on = false;
    this._applied = null;          // 上一次真正写进 DOM 的状态，避免每帧刷 DOM
    this._cb = null;
    this._bound = false;

    this._moveId = null;
    this._lookId = null;
    this._origin = { x: 0, y: 0 };
    this._v = { x: 0, y: 0 };      // 摇杆位移，CSS px，已 clamp 到 stickR
    this._lookLast = { x: 0, y: 0 };
    this._jump = 0;

    // 自开机以来这一层一共吐出去多少 look，以及点了几次按钮。
    // **单调计数**，因为验收要断言的是"拖了 300 px 就该有 300×gain"，
    // 而累积器每帧会被 `stepSim` 清零 —— 只看得见瞬时值的话，量具就没有了。
    this.totalLook = { dx: 0, dy: 0 };
    this.taps = { use: 0, pause: 0, jump: 0 };

    // 桌面提示的原样快照。切回来时用它还原，而不是在这里再抄一份。
    this._keyHint = this.hintEl ? this.hintEl.innerHTML : '';
  }

  /**
   * 接线。回调全部由 `play.js` 提供，因为只有它认识 `look` / `interact()` /
   * `togglePause()` / `unlockAudio()` —— 这一层不认识其中任何一个。
   */
  bind(cb) {
    this._cb = cb || {};
    if (!this.supported || !this.root || !this.moveZone || !this.lookZone || this._bound) {
      return this._bound;
    }
    this._bound = true;

    const zone = (el, kind) => {
      // passive:false 是必需的，不是优化：iOS/Android 上 `touchmove` 的默认行为
      // 是滚动，不 preventDefault 就会边走路边把页面拽走。
      el.addEventListener('touchstart', (e) => this._start(e, kind), { passive: false });
      el.addEventListener('touchmove', (e) => this._move(e, kind), { passive: false });
      el.addEventListener('touchend', (e) => this._end(e, kind), { passive: false });
      el.addEventListener('touchcancel', (e) => this._end(e, kind), { passive: false });
    };
    zone(this.moveZone, 'move');
    zone(this.lookZone, 'look');

    // 按钮是 zone 的**兄弟**而不是子节点，所以按在按钮上的手指不会同时被
    // 右半屏的拖动接管 —— 父节点的监听器收不到兄弟节点的事件，这是 DOM 的
    // 规矩，不是靠判断 target 躲开的。
    for (const id of ['t-jump', 't-use', 't-pause']) {
      const el = document.getElementById(id);
      if (!el) continue;
      const act = id.slice(2);          // jump / use / pause
      el.addEventListener('touchstart', (e) => { e.preventDefault(); this._btn(act, 1); }, { passive: false });
      el.addEventListener('touchend', (e) => { e.preventDefault(); this._btn(act, 0); }, { passive: false });
      el.addEventListener('touchcancel', (e) => { e.preventDefault(); this._btn(act, 0); }, { passive: false });
      // 桌面浏览器上点按钮（验收脚本用 Input.dispatchMouseEvent 时会走到这里）。
      el.addEventListener('click', (e) => { e.preventDefault(); this._btn(act, 1); this._btn(act, 0); });
    }
    return true;
  }

  /* ------------------------------------------------------------ 帧循环 */

  /**
   * 每一帧同步"这一层现在该不该在屏幕上"。**挂在 `render()` 上**，和
   * `GuardActor.update()` 同一个位置、同一个理由：相位一变就有人管它，
   * 而不用在 `beginRun` / `togglePause` / `finish` / `openMenu` / `resetRun`
   * 五处各写一遍。
   */
  frame(phase) {
    const on = this.supported && phase === 'playing';
    if (on !== this.on) {
      this.on = on;
      // 关掉时把手指状态一起丢掉。不丢的话：手指按着摇杆时被主人抓住 →
      // 相位不再是 playing → 再开一局，人还在往前走。
      if (!on) this._clear();
    }
    if (on === this._applied) return on;
    this._applied = on;

    if (this.root) this.root.classList.toggle('on', on);
    if (this.hintEl) this.hintEl.innerHTML = on ? HINT_TOUCH : this._keyHint;
    // 准星下面那个"E 打开"在触屏上没有 E 键。CSS 只把那个键帽藏掉，
    // 动词照旧 —— 提示说的是"会做什么"，不是"按哪个键"。
    if (this.promptEl) this.promptEl.classList.toggle('touch', on);
    return on;
  }

  /* -------------------------------------------------------------- 读数 */

  /**
   * 摇杆 -> `{fwd, side}`。**模长恒 ≤ 1**，见文件头第 2 条。
   *
   * 屏幕坐标系里 +y 朝下，而"往前走"是 -y，所以 `fwd = -uy`。
   */
  move() {
    if (!this.on || this._moveId === null) return IDLE;
    const R = TOUCH.stickR;
    const ux = this._v.x / R;
    const uy = this._v.y / R;
    const mag = Math.hypot(ux, uy);
    if (mag <= TOUCH.dead || mag === 0) return IDLE;
    // 死区外重新归一化到 [0,1]：过了死区就是从 0 开始推，不是从 dead 开始。
    const s = Math.min(1, (mag - TOUCH.dead) / (1 - TOUCH.dead));
    return { fwd: (-uy / mag) * s, side: (ux / mag) * s };
  }

  /** 跳跃键：按住 = 1。和 `Space` 的语义一致（着地才起跳）。 */
  jump() {
    return this.on && this._jump ? 1 : 0;
  }

  state() {
    const m = this.move();
    return {
      supported: this.supported,
      on: this.on,
      bound: this._bound,
      moveId: this._moveId,
      lookId: this._lookId,
      stick: { x: r4(this._v.x), y: r4(this._v.y) },
      fwd: r6(m.fwd),
      side: r6(m.side),
      jump: this.jump(),
      totalLook: { dx: r4(this.totalLook.dx), dy: r4(this.totalLook.dy) },
      taps: { ...this.taps },
      stickR: TOUCH.stickR,
      dead: TOUCH.dead,
      turnGain: TOUCH.turnGain,
      pitchGain: TOUCH.pitchGain,
    };
  }

  /* -------------------------------------------------------- 触摸事件 */

  _start(e, kind) {
    e.preventDefault();
    if (!this.on) return;
    this._unlock();
    const t = this._pick(e.changedTouches, kind);
    if (!t) return;
    if (kind === 'move') {
      // 一根手指管一根手指：第二根按住不放不会把摇杆原点搬走。
      if (this._moveId !== null) return;
      this._moveId = t.identifier;
      this._origin = { x: t.clientX, y: t.clientY };
      this._v = { x: 0, y: 0 };
      this._showStick(true);
    } else {
      if (this._lookId !== null) return;
      this._lookId = t.identifier;
      this._lookLast = { x: t.clientX, y: t.clientY };
    }
  }

  _move(e, kind) {
    e.preventDefault();
    if (!this.on) return;
    if (kind === 'move') {
      const t = findById(e.touches, this._moveId);
      if (!t) return;
      let dx = t.clientX - this._origin.x;
      let dy = t.clientY - this._origin.y;
      const R = TOUCH.stickR;
      const len = Math.hypot(dx, dy);
      if (len > R) { dx = (dx * R) / len; dy = (dy * R) / len; }
      this._v = { x: dx, y: dy };
      this._placeStick();
    } else {
      const t = findById(e.touches, this._lookId);
      if (!t) return;
      const dx = (t.clientX - this._lookLast.x) * TOUCH.turnGain;
      const dy = (t.clientY - this._lookLast.y) * TOUCH.pitchGain;
      this._lookLast = { x: t.clientX, y: t.clientY };
      if (!dx && !dy) return;
      this.totalLook.dx += dx;
      this.totalLook.dy += dy;
      if (this._cb && this._cb.onLook) this._cb.onLook(dx, dy);
    }
  }

  _end(e, kind) {
    e.preventDefault();
    if (kind === 'move') {
      if (!hasId(e.changedTouches, this._moveId)) return;
      this._moveId = null;
      this._v = { x: 0, y: 0 };
      this._showStick(false);
    } else {
      if (!hasId(e.changedTouches, this._lookId)) return;
      this._lookId = null;
    }
  }

  _btn(act, down) {
    if (down) this._unlock();
    if (act === 'jump') {
      // 抬手指必须归零：`avatar` 里读的是"按住就跳"，卡在 1 会一直蹦。
      this._jump = down ? 1 : 0;
      if (down) this.taps.jump += 1;
      return;
    }
    if (!down || !this.on) return;
    if (act === 'use') { this.taps.use += 1; if (this._cb && this._cb.onUse) this._cb.onUse(); }
    if (act === 'pause') { this.taps.pause += 1; if (this._cb && this._cb.onPause) this._cb.onPause(); }
  }

  /** 挑出真正落在本站区里的那根手指，顺带挡住"两指同时落下"的串台。 */
  _pick(list, kind) {
    const zoneEl = kind === 'move' ? this.moveZone : this.lookZone;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!zoneEl.contains(c.target)) continue;
      return c;
    }
    return null;
  }

  _unlock() {
    if (this._cb && this._cb.onUnlock) this._cb.onUnlock();
  }

  _clear() {
    this._moveId = null;
    this._lookId = null;
    this._v = { x: 0, y: 0 };
    this._jump = 0;
    this._showStick(false);
  }

  /* ---------------------------------------------------------- 摇杆图形 */

  _showStick(visible) {
    if (!this.stick) return;
    this.stick.hidden = !visible;
    if (!visible) return;
    // 原点就是手指落下的地方（浮动原点）。固定的圆盘会让人先找圆心再推，
    // 而拇指落点只有它自己知道。
    this.stick.style.left = this._origin.x + 'px';
    this.stick.style.top = this._origin.y + 'px';
    this._placeStick();
  }

  _placeStick() {
    if (this.knob) this.knob.style.transform = 'translate(' + r4(this._v.x) + 'px,' + r4(this._v.y) + 'px)';
  }
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r6 = (v) => Math.round(v * 1e6) / 1e6;
