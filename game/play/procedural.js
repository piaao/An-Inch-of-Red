/**
 * procedural.js — 用振荡器现场合成七段配乐，一个文件都不加载。
 *
 * 为什么是它？`fun-music-v1` / `fun-music-preview` 都没开通（game/MUSIC.md §8），
 * 生成的 mp3 拿不到。与其让游戏安静的像一台坏了的收音机，不如让 `music.js`
 * 自己合成——反正 `audio.js` 早就有一个 AudioContext 在那儿等着被复用。
 *
 * ── 它到底是什么 ───────────────────────────────────────────────────────────
 * 不是「一段采样循环」，而是一个**调度乐团**。每一段铺底由 `config.js` 的
 * `PROCEDURAL_TRACKS` 写成一张和弦表；调度器在 `ctx.currentTime` 往前
 * `lookahead` 秒处排好下一小节，三支振荡器（saw 铺底 / triangle 铃 / sine 低音）
 * 按和弦表发声。
 *
 * **为什么用前视调度而不是每帧触发**：帧率会被守卫相遇、红包拾取这些事件挤扁，
 * 一个跟着 rAF 走的节拍会一抖一抖。把音符提前钉在**音频时钟**上，游戏再卡，
 * 拍子都是准的。这和 Web Audio 社区所谓 "A Tale of Two Clocks" 是同一课。
 *
 * ── 一条铁律 ───────────────────────────────────────────────────────────────
 * **绝不 new AudioContext()**。全仓库只有 `audio.js` 里那一个（这是既定纪律，
 * 两个 context 会各自跑各自的时钟、各自吃资源）。本模块的所有振荡器都接在
 * 调用方传进来的 `ctx` / `dest` 上。
 */

import { PROCEDURAL, PROCEDURAL_TRACKS, midiHz, chordTones } from './config.js';

/** cue id -> 曲目表项。模块加载时建一次。 */
const TRACKS = new Map(PROCEDURAL_TRACKS.map((t) => [t.id, t]));

/** 线性逼近，单帧最多走 `step`。和 music.js 的同名函数一样，用于可预测淡变。 */
function approach(cur, target, step) {
  if (target > cur) return Math.min(target, cur + step);
  if (target < cur) return Math.max(target, cur - step);
  return cur;
}

/**
 * 一个正在发声的「声音」。它自己记着什么时候该停，到点了由 `stop(fade)` 收尾。
 * 之所以把它做成对象而不是一堆散落的节点，是因为一次调度会同时起好几支振荡器，
 * 需要一个把手把它们一起掐掉（换和弦、切歌、静音都要）。
 */
class Voice {
  constructor(nodes, gain, endAt, ctx) {
    this.nodes = nodes;       // [osc, ...]
    this.gain = gain;         // 总包络 (GainNode)
    this.endAt = endAt;       // 计划收尾的 ctx 时间
    this.ctx = ctx;
    this.stopped = false;
  }

  /** 在 `at` 时刻开始淡出，`fade` 秒后静音并断开。可重复调用，幂等。 */
  stop(at, fade = PROCEDURAL.release) {
    if (this.stopped) return;
    this.stopped = true;
    const t = Math.max(at, this.ctx.currentTime);
    const g = this.gain.gain;
    try {
      g.cancelScheduledValues(t);
      g.setValueAtTime(Math.max(0.0001, g.value), t);
      g.exponentialRampToValueAtTime(0.0001, t + fade);
    } catch { /* 参数竞争时容忍 */ }
    for (const n of this.nodes) {
      try { n.stop(t + fade + 0.02); } catch { /* 已停 */ }
    }
  }

  /** 硬收（切歌时用，不给尾音留时间）。 */
  kill() {
    if (this.stopped) return;
    this.stopped = true;
    for (const n of this.nodes) { try { n.stop(this.ctx.currentTime); } catch { /* */ } }
    try { this.gain.disconnect(); } catch { /* */ }
  }
}

/**
 * 程序化配乐引擎。
 *
 * 它**不自己决定该放哪一首**——那是 `music.js` 的 `update()` 干的，全仓库唯一
 * 的决策点。这里只负责：给我一个 cue id，我就把它排出来；现在放的是谁，
 * 我就让它淡出。
 */
export class Procedural {
  constructor(ctx, dest, { muted = false } = {}) {
    this.ctx = ctx;
    this.dest = dest;              // 上游的总线（music.js 的 bus），不是 destination
    this.muted = muted;
    this.bus = ctx.createGain();   // 本引擎的总音量
    this.bus.gain.value = muted ? 0 : 1;
    // NO direct bus -> dest here. Signal leaves through the filter below, and
    // only through it; a second path would double the level AND bypass the
    // lowpass. (This line used to exist. Deleting it is half the loudness fix.)

    this.playing = null;           // 当前 bed id
    this.stingId = null;           // 当前一次性 sting 的 id
    this.voice = null;             // 当前 bed 的声音（每次换和弦会换新 Voice）
    this.stingVoice = null;
    this.chordIx = 0;
    this.nextAt = 0;               // 下一小节该在 ctx 时间的哪一刻发生
    this.tickAcc = 0;              // 距离上次补队列过了多久
    this.interval = 0.75;          // 小节长度（秒），随 bpm 更新
    this.age = 0;                  // sting 已存活多久（秒，游戏时钟）

    // 一个低通，让合成声别那么"电子蜂鸣"。整条链只有这一个滤波器，
    // 便宜且有效：danger 时稍微开亮一点，menu 时收闷一点。
    //
    // 路径只有一条：bus -> filter -> dest。**不要**再加一条 bus -> dest 的
    // 直连——那不但让信号在 dest 上叠加两次（音量莫名翻倍），还让低通被
    // 旁路：saw 的全部刺耳高频从直连那根漏出去，滤波器就白装了。
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 2600;
    this.filter.Q.value = 0.6;
    this.bus.connect(this.filter);
    this.filter.connect(dest);
  }

  /** 当前 cue 的元数据（从 config 的表里查）。 */
  static track(id) {
    return TRACKS.get(id) || null;
  }

  setMuted(v) {
    this.muted = !!v;
    const t = this.ctx.currentTime;
    try {
      this.bus.gain.cancelScheduledValues(t);
      // Un-muting restores THIS ENGINE'S ceiling, not 1.0: `music.js` owns the
      // duck, and a hard 1.0 here would jump the bed to full scale every time
      // M was pressed twice.
      this.bus.gain.linearRampToValueAtTime(
        this.muted ? 0 : PROCEDURAL.master, t + 0.08);
    } catch { /* */ }
  }

  /**
   * 切铺底。与 mp3 路径不同，这里没有"交叉淡变"的必要——因为和弦是连续排的，
   * 切歌就是一个和弦到另一个和弦的自然过渡。所以实现很朴素：停旧的、起新的。
   */
  setBed(id) {
    if (id === this.playing) return;
    const old = this.voice;
    const wasPlaying = this.playing;
    this.playing = id;
    // 旧的先在现在这一刻淡出，别突然一刀切（那会 "啪" 一声）。
    if (old) old.stop(this.ctx.currentTime, PROCEDURAL.release);

    if (!id) { this.voice = null; this.nextAt = 0; return; }
    const tr = Procedural.track(id);
    if (!tr || !tr.loop) { this.playing = null; this.voice = null; return; }

    // 换歌时把和弦指针归零，并从"现在"重新起拍。`nextAt = 0` 让第一次 tick
    // 立刻排一小节，不会因为上一首歌的进度而空等。
    if (wasPlaying !== id) { this.chordIx = 0; this.nextAt = 0; }
    this.interval = 60 / (tr.bpm || 90) * 4;   // 4 拍一小节
    this._schedule(false);
  }

  /** 一次性 sting：被抓 / 胜利 / 失败。它压过铺底，铺底由 music.js 负责压低。 */
  sting(id) {
    const tr = Procedural.track(id);
    if (!tr || tr.loop) return;
    const t0 = this.ctx.currentTime + 0.01;
    // 同刻只留一个 sting（两条叠在一起只会糊成噪音）。
    if (this.stingVoice) this.stingVoice.kill();
    this.stingVoice = this._spell(tr, t0, tr.gain * PROCEDURAL.bellGain * 2.2);
    this.stingId = id;
    this.age = 0;
  }

  /**
   * 每帧一次。做两件事：给床补排未来 `lookahead` 秒内的音符；让 sting 到点收尾。
   *
   * @param dt   秒（游戏时钟，只用于 sting 的存活判定）
   * @param s    { phase, danger, low } —— 与 music.js 收到的是同一份
   */
  update(dt, s) {
    this.age += dt;

    // ---- sting 收尾：超过它的 dur 就淡出 ---------------------------------
    if (this.stingVoice) {
      const tr = Procedural.track(this.stingId);
      const dur = (tr && tr.dur) || 1.2;
      if (this.age > dur) {
        this.stingVoice.stop(this.ctx.currentTime);
        this.stingVoice = null;
        this.stingId = null;
      }
    }

    if (!this.playing) return;

    // ---- 补排床 ----------------------------------------------------------
    // 30 Hz 的补排足够了（小节是 0.6~0.8 秒），不必每帧算。
    this.tickAcc += dt;
    if (this.tickAcc < 1 / PROCEDURAL.tickHz) return;
    this.tickAcc = 0;

    // danger / lastcall 让滤波器亮一点，menu 收闷。1 个旋钮，3 档。
    const want = s && s.danger ? 3400 : (this.playing === 'menu' ? 2100 : 2600);
    this.filter.frequency.value = approach(this.filter.frequency.value, want, 400 * dt);
    this._schedule(true);
  }

  /** 把声音从 ctx 里掐掉（切难度、离开游戏时用）。 */
  silence() {
    if (this.voice) this.voice.kill();
    if (this.stingVoice) this.stingVoice.kill();
    this.voice = null;
    this.stingVoice = null;
    this.playing = null;
    this.stingId = null;
    this.nextAt = 0;
  }

  /* ------------------------------------------------------------ 内部 */

  /**
   * 排下一小节（或补排若干，如果落后了）。
   * @param advance 是否推进和弦指针（首排和补排都要）。
   */
  _schedule(advance) {
    const tr = Procedural.track(this.playing);
    if (!tr) return;
    if (!this.nextAt) this.nextAt = this.ctx.currentTime + 0.05;
    // 往前补，直到队列盖住 lookahead；一次 tick 最多补 2 小节，避免长时间
    // 挂起后一次性倒灌（那会是一坨噪音）。
    let budget = 2;
    const tempo = this.playing === 'lastcall' ? PROCEDURAL.lowTempo : 1;
    while (this.nextAt < this.ctx.currentTime + PROCEDURAL.lookahead && budget-- > 0) {
      const [semi, quality] = tr.chords[this.chordIx % tr.chords.length];
      const at = this.nextAt;
      // 张力只给 danger / lastcall：整段偏一点音分，听感上"紧"。不是变调，
      // 是一层薄薄的心跳加速——`tensionDepth` 只有几个半音的量级里取小数。
      const tension = (this.playing === 'danger' || this.playing === 'lastcall')
        ? Math.round(PROCEDURAL.tensionDepth * 0.5) : 0;
      this.voice = this._spell(tr, at, tr.gain, { semi, quality, tension });
      this.chordIx += 1;
      this.nextAt += this.interval / tempo;
    }
  }

  /**
   * 把一个小节（或一个 sting）具体化为几支振荡器。返回 Voice 供收尾。
   *
   * @param tr     cue 表项
   * @param at     起始的 ctx 时间
   * @param level  这一声的总电平（已含 track.gain）
   * @param chord  { semi, quality, tension }；sting 传 null，就会依次奏完整张和弦表
   */
  _spell(tr, at, level, chord = null) {
    const ctx = this.ctx;
    const oscs = [];
    const env = ctx.createGain();          // 本节的总包络
    env.gain.value = 0;
    env.connect(this.bus);

    const A = PROCEDURAL.attack;
    const R = PROCEDURAL.release;
    const bar = chord ? this.interval : 0.9;   // 一小节 vs sting 的音长
    const end = at + bar;

    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), at + A);
    env.gain.setValueAtTime(Math.max(0.0002, level), at + Math.max(A + 0.01, bar - R));
    env.gain.exponentialRampToValueAtTime(0.0001, end);

    /**
     * 一支振荡器，在自己该响的那一刻 `t` 起、`dur` 秒后落。
     * 包络是**每支振荡器各自的**——一节里各声部起落不同，共用一条包络会让
     * 铃还没响、铺底就已经跟着一起淡出了。
     */
    const play = (type, midi, semis, gain, { t = at, dur = bar, detune = 0 } = {}) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(midiHz(midi, semis), t);
      if (detune) osc.detune.setValueAtTime(detune, t);
      // 每支自己的起落：8 ms 起、`dur - 0.12` 保、然后 0.12 s 落。
      const hold = Math.max(0.02, dur - 0.12);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.008);
      g.gain.setValueAtTime(Math.max(0.0002, gain), t + Math.max(0.01, hold));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g); g.connect(env);
      osc.start(t); osc.stop(t + dur + 0.03);
      oscs.push(osc);
    };

    if (chord) {
      // 铺底：两根 saw 微微失谐，做一个"合唱"，比单根厚得多。
      for (const t of chordTones(chord.quality).slice(0, 3)) {
        play('sawtooth', tr.root, t + chord.semi + (chord.tension || 0),
          PROCEDURAL.padGain / 3, { detune: +PROCEDURAL.padDetune });
        play('sawtooth', tr.root, t + chord.semi + (chord.tension || 0),
          PROCEDURAL.padGain / 3, { detune: -PROCEDURAL.padDetune });
      }
      // 铃：最高一音，一个八度上，triangle，轻，稍微晚一点进（像余音）。
      const top = chordTones(chord.quality).slice(-1)[0] + chord.semi;
      play('triangle', tr.root + 12, top, PROCEDURAL.bellGain,
        { t: at + Math.min(0.12, bar * 0.25), dur: bar * 0.75 });
      // 低音：根音下一八度，sine，整节踩着。
      play('sine', tr.root - 12, chord.semi + (chord.tension || 0), PROCEDURAL.bassGain);
    } else {
      // sting：整张和弦表依次奏出，每格 `beat` 秒，像一次和声的冲刺/叹息。
      const beat = bar / Math.max(1, tr.chords.length);
      tr.chords.forEach(([semi, quality], i) => {
        const t = at + i * beat;
        const ts = chordTones(quality);
        play('triangle', tr.root, semi + ts[ts.length - 1], PROCEDURAL.bellGain * 1.5,
          { t, dur: beat * 1.15 });
        play('sawtooth', tr.root, semi + (ts[2] != null ? ts[2] : ts[0]), PROCEDURAL.padGain / 2,
          { t, dur: beat * 1.15 });
        play('sine', tr.root - 12, semi, PROCEDURAL.bassGain, { t, dur: beat * 1.15 });
      });
    }

    return new Voice(oscs, env, end, ctx);
  }

  /** 诊断读数。 */
  state() {
    return {
      playing: this.playing,
      sting: this.stingId,
      chordIx: this.chordIx,
      interval: Math.round(this.interval * 1000) / 1000,
      voices: (this.voice ? 1 : 0) + (this.stingVoice ? 1 : 0),
      muted: this.muted,
    };
  }
}
