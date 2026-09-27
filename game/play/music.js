/**
 * music.js — 七首配乐，一条总线。
 *
 * 与 `audio.js`（WebAudio 合成的四个音效）分开，是因为这两件事的**生命周期
 * 完全不同**：音效是几十毫秒的瞬时脉冲，音乐是几十秒的循环织体，需要交叉淡入
 * 淡出、需要被 sting 压低、需要在暂停时 duck。把它们塞进同一个对象，只会让
 * `tone()` 里长出 `crossfade()`。
 *
 * 设计书：`game/MUSIC.md`。曲目 prompt 与混音参数：`scripts/gen_music.py`。
 *
 * ── 零 404 ────────────────────────────────────────────────────────────────
 * 音频文件不在仓库里（它们是生成物，且是本目录唯一一批二进制）。所以本模块
 * **只认 `assets/audio/manifest.json`**：manifest 不存在、为空、或解析失败，
 * 音乐就整个关掉，一个 mp3 请求都不会发出去。仓库里没有音乐时，控制台是干净的。
 * 这正是这套工程对待「可选资源」的一贯做法 —— 缺了它，游戏照常跑，只是安静。
 *
 * ── 为什么用 HTMLAudioElement 而不是 WebAudio ────────────────────────────
 * 音乐是 mp3，用 `AudioContext.decodeAudioData` 也能放，但那要求先把整段 mp3
 * 拉进内存并解码，而八个轨道的解码结果（48 kHz 立体声，各 60–90 s）远大于
 * 文件本身。`<audio>` 由浏览器流式解码，还自带 `loop`，对一个只做音量交叉
 * 淡变的混音台来说，它是更小的机器。
 */

import { MUSIC, PROCEDURAL } from './config.js';
import { Procedural } from './procedural.js';

/** 线性逼近，单帧最多走 `step`。用来做可预测的交叉淡变（指数逼近会拖尾）。 */
function approach(cur, target, step) {
  if (target > cur) return Math.min(target, cur + step);
  if (target < cur) return Math.max(target, cur - step);
  return cur;
}

export class Music {
  constructor() {
    this.enabled = false;
    this.manifest = null;
    this.pool = new Map();     // id -> HTMLAudioElement
    this.meta = new Map();     // id -> { loop, gain }
    this.bed = null;           // 当前铺底 id
    this.duck = 1;             // 全局压低系数（sting / 暂停）
    this.muted = false;
    this.stingVoice = null;    // { id, el, age }
    this.stingDuckLeft = 0;
    this.reason = 'not loaded';
    // 程序化回退：没有 mp3 时启用（见 config.js 的 PROCEDURAL 与 procedural.js）。
    this.proc = null;          // Procedural 实例，或 null
    this.source = 'none';      // 'files' | 'procedural' | 'none'
  }

  /**
   * 读 manifest 并建池。**永不抛** —— 没有音乐不是错误，是一种正常状态。
   *
   * 没有 manifest 时不再一律静音：若 `PROCEDURAL.enabled`，就启用浏览器内的
   * 合成乐团（`procedural.js`）。它对素材零依赖，所以零 404 铁律仍然成立——
   * 一条网络请求都不发。mp3 一旦生成出来，这条回退路径就自动让位。
   *
   * @returns {Promise<boolean>} 是否成功启用了音乐
   */
  async load() {
    if (!MUSIC.enabled) { this.reason = 'disabled in config'; return false; }
    let m;
    try {
      const r = await fetch(MUSIC.manifest, { cache: 'no-store' });
      if (!r.ok) { this.reason = 'no manifest (HTTP ' + r.status + ')'; return this._armProcedural(); }
      m = await r.json();
    } catch (e) {
      this.reason = 'manifest unreadable: ' + (e && e.message ? e.message : e);
      return this._armProcedural();
    }
    const tracks = (m && m.tracks) || [];
    if (!tracks.length) { this.reason = 'manifest lists no tracks'; return this._armProcedural(); }

    for (const t of tracks) {
      if (!t || !t.id || !t.file) continue;
      const el = new Audio(MUSIC.dir + t.file);
      el.loop = !!t.loop;
      el.preload = 'auto';
      el.volume = 0;
      // 循环铺底在交叉淡变里会被反复淡出，不 preload 会在第一次切歌时
      // 露出一个"卡一下"的空白；一次性 sting 也 preload，因为它的价值就在
      // 「瞬间响起来」。
      this.pool.set(t.id, el);
      this.meta.set(t.id, { loop: !!t.loop, gain: t.gain != null ? t.gain : 0.5 });
    }
    if (!this.pool.size) { this.reason = 'manifest had no usable tracks'; return this._armProcedural(); }

    this.manifest = m;
    this.enabled = true;
    this.source = 'files';
    this.reason = 'ok (' + this.pool.size + ' tracks)';
    return true;
  }

  /**
   * 启用程序化回退。**它需要上游先调 `attach()` 给出 AudioContext**，
   * 因为 AudioContext 必须由用户手势创建（在 `audio.js` 里）、不能在这里 new。
   *
   * 若上游尚未 attach，就只标记 `enabled`——真正的声音在 `attach()` 时接上。
   * 这样「`load()` 还没等到手势就返回」也不会丢掉音乐。
   */
  _armProcedural() {
    if (!PROCEDURAL.enabled) { this.reason += ' (procedural off)'; return false; }
    this.enabled = true;
    this.source = 'procedural';
    this.reason += ' → procedural fallback';
    if (this.ctx && !this.proc) this._buildProc();
    return true;
  }

  /**
   * 接上 AudioContext（由 play.js 在 `audio.unlock()` 之后调用）。
   *
   * 这是唯一允许程序化引擎拿到 ctx 的入口，也是「全仓仅一个 AudioContext」
   * 这条纪律的落点：ctx 从 `audio.js` 来，本模块和 `procedural.js` 都只是
   * 借用者，绝不自己 new。
   */
  attach(ctx, dest) {
    if (!ctx || this.ctx === ctx) return this.proc != null;
    this.ctx = ctx;
    this.dest = dest || ctx.destination;
    if (this.source === 'procedural') {
      this._buildProc();
      // 已经决定了该放哪一首（update 早就在跑），补排上。
      if (this.bed) this.proc.setBed(this.bed);
      if (this.muted) this.proc.setMuted(true);
      return true;
    }
    return false;
  }

  _buildProc() {
    if (this.proc) return;
    try {
      this.proc = new Procedural(this.ctx, this.dest, { muted: this.muted });
      // 程序化总线自带一个 master 系数，乘进 MUSIC.master。
      this.proc.bus.gain.value = this.muted ? 0 : PROCEDURAL.master;
    } catch (e) {
      this.proc = null;
      this.reason = 'procedural build failed: ' + (e && e.message ? e.message : e);
    }
  }

  has(id) {
    if (this.source === 'files') return this.pool.has(id);
    if (this.source === 'procedural') return !!(PROCEDURAL.enabled && Procedural.track(id));
    return false;
  }

  /**
   * 一次性 sting：被抓 / 胜利 / 失败。会顺带把铺底压低一小段。
   * 同一时刻只留一个 sting —— 两条 sting 叠在一起只会糊成噪音。
   */
  sting(id) {
    if (!this.enabled) return;
    if (this.source === 'procedural') {
      if (!this.proc) return;                 // 还没 attach（没有手势）
      if (!Procedural.track(id)) return;
      this.proc.sting(id);
      this.stingDuckLeft = MUSIC.stingDuckS;
      return;
    }
    const el = this.pool.get(id);
    if (!el) return;
    if (this.stingVoice && this.stingVoice.el !== el) {
      this.stingVoice.el.pause();
      this.stingVoice.el.currentTime = 0;
    }
    try { el.currentTime = 0; } catch { /* 尚未 loadedmetadata */ }
    el.volume = 0;
    const p = el.play();
    if (p && p.catch) p.catch(() => {});   // 自动播放被拦是常态，不是错误
    this.stingVoice = { id, el, age: 0 };
    this.stingDuckLeft = MUSIC.stingDuckS;
  }

  setMuted(v) {
    this.muted = !!v;
    if (this.proc) this.proc.setMuted(this.muted);
  }

  /** 切换铺底。真正的交叉淡变发生在 `update()` 里，这里只负责起播。 */
  setBed(id) {
    if (id === this.bed) return;
    this.bed = this.enabled ? id : null;
    if (this.proc) {
      // 程序化引擎自己处理换歌（停旧起新），不需要交叉淡变。
      this.proc.setBed(this.bed);
      return;
    }
    if (this.bed) {
      const el = this.pool.get(this.bed);
      if (el && el.paused && !this.muted) {
        try { el.currentTime = 0; } catch { /* 同上 */ }
        const p = el.play();
        if (p && p.catch) p.catch(() => {});
      }
    }
  }

  /**
   * 每帧一次。**这是唯一的决策点** —— 铺底放哪一首、压多低、sting 淡到几，
   * 全在这里算完；其余方法只改状态。所以「音乐为什么换了」永远只有一个答案，
   * 不会散落在五个调用点里。
   *
   * @param dt    秒
   * @param s     { phase, danger, low }  —— phase 用 play.js 的 S.phase
   */
  update(dt, s) {
    if (!this.enabled) return;
    const master = this.muted ? 0 : MUSIC.master;
    const phase = s && s.phase;

    /* ---- 1. 这一步该放哪一首铺底 ------------------------------------- */
    // 优先级：独占态(结算/菜单) > lastcall > danger > explore。
    // won / lost 故意为 null：结算页只留 sting，铺底让位给那一下重音，
    // 玩家点「换难度」回到 ready 时，menu 才会接上。
    let want = null;
    if (phase === 'ready') {
      want = 'menu';
    } else if (phase === 'playing' || phase === 'paused') {
      if (s.low && this.has('lastcall')) want = 'lastcall';
      else if (s.danger && this.has('danger')) want = 'danger';
      else want = 'explore';
    }
    if (want && !this.has(want)) want = this.has('explore') ? 'explore' : null;
    this.setBed(want);

    /* ---- 2. 压低（sting / 暂停）-------------------------------------- */
    if (this.stingDuckLeft > 0) this.stingDuckLeft = Math.max(0, this.stingDuckLeft - dt);
    const duckWant = (this.stingDuckLeft > 0 ? MUSIC.stingDuck : 1)
      * (phase === 'paused' ? MUSIC.pauseDuck : 1);
    this.duck = approach(this.duck, duckWant, dt / MUSIC.duckS);

    /* ---- 3. sting 的包络 --------------------------------------------- */
    if (this.stingVoice) this._stepSting(dt, master);

    /* ---- 3b. 程序化引擎的每帧推进 ------------------------------------ */
    // 程序化路径下 mp3 池是空的，下面的交叉淡变循环无事可做——直接在这里
    // 结束本帧。`proc` 可能还没 attach（AudioContext 要等用户手势），那时
    // 只是安静地不发声，状态机照常决定 bed，等 attach 补排。
    if (this.source === 'procedural') {
      if (this.proc) {
        this.proc.update(dt, s);
        // 铺底压低在程序化路径上作用在引擎总线上（mp3 路径是逐元素 volume）。
        try { this.proc.bus.gain.value = this.muted ? 0 : PROCEDURAL.master * this.duck; }
        catch { /* */ }
      }
      this.playingBeds = !!this.bed && !!this.proc;
      return;
    }

    /* ---- 4. 铺底的交叉淡变 ------------------------------------------- */
    const step = dt / MUSIC.crossfadeS;
    let anyBedPlaying = false;
    for (const [id, el] of this.pool) {
      const m = this.meta.get(id);
      if (!m.loop) continue;
      const isBed = id === this.bed;
      const target = isBed ? m.gain * master * this.duck : 0;
      el.volume = approach(el.volume, target, step);
      if (isBed) {
        anyBedPlaying = true;
        if (el.paused && !this.muted && target > 0) {
          const p = el.play();
          if (p && p.catch) p.catch(() => {});
        }
      } else if (el.volume <= 0.0005 && !el.paused) {
        // 淡到听不见了就停掉，别让七个循环在后台一起空转。
        el.pause();
      }
    }
    this.playingBeds = anyBedPlaying;
  }

  _stepSting(dt, master) {
    const v = this.stingVoice;
    v.age += dt;
    const dur = (isFinite(v.el.duration) && v.el.duration > 0) ? v.el.duration : 6;
    const attack = MUSIC.stingAttack;
    const release = MUSIC.stingRelease;
    let a = 1;
    if (v.age < attack) a = v.age / attack;
    else if (v.age > dur - release) a = Math.max(0, (dur - v.age) / release);
    const g = (this.meta.get(v.id) || {}).gain || 0.55;
    v.el.volume = Math.max(0, Math.min(1, g * master * a));
    if (v.age > dur + 0.05) {
      v.el.pause();
      try { v.el.currentTime = 0; } catch { /* */ }
      this.stingVoice = null;
    }
  }

  /** 诊断读数（verify 脚本与 `__play.info()` 用）。 */
  state() {
    return {
      enabled: this.enabled,
      source: this.source,
      reason: this.reason,
      bed: this.bed,
      duck: Math.round(this.duck * 1000) / 1000,
      muted: this.muted,
      sting: this.stingVoice ? this.stingVoice.id
        : (this.proc && this.proc.state().sting) || null,
      tracks: this.source === 'files' ? this.pool.size : 0,
      proc: this.proc ? this.proc.state() : null,
      volumes: Object.fromEntries(
        [...this.pool].map(([id, el]) => [id, Math.round(el.volume * 1000) / 1000])),
    };
  }
}
