/**
 * audio.js — four synthesised sounds, no files.
 *
 * The scene ships zero audio assets and adding some would mean shipping
 * binaries, licences and a decode step for what is, at most, four cues. An
 * oscillator and two gain envelopes cost less code than the loader would.
 *
 * The AudioContext is created lazily on the first user gesture, because every
 * browser refuses to start one before that and a console full of
 * "AudioContext was not allowed to start" is exactly the kind of noise that
 * hides a real error during verification.
 */

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
  }

  /** Call from a click handler. Safe to call repeatedly. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.35;
      this.master.connect(this.ctx.destination);
      return true;
    } catch {
      this.ctx = null;
      return false;
    }
  }

  setMuted(v) {
    this.muted = !!v;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.35;
  }

  /** One oscillator with an attack-decay envelope, optionally gliding. */
  tone({ type = 'sine', from = 440, to = null, dur = 0.12, gain = 0.5, at = 0, curve = 'exp' }) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + at;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    if (to != null) {
      if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
      else osc.frequency.linearRampToValueAtTime(to, t0 + dur);
    }
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** Filtered noise, for the "caught" buzz. */
  noise({ dur = 0.3, gain = 0.25, at = 0, freq = 900 }) {
    if (!this.ctx || this.muted) return;
    const n = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 0.9;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(this.ctx.currentTime + at);
  }

  pickup(n) {
    // Rising with the count, so the sixth 红包 sounds like the sixth.
    const base = 660 * Math.pow(2, Math.min(6, n) / 12);
    this.tone({ type: 'triangle', from: base, to: base * 1.5, dur: 0.11, gain: 0.5 });
    this.tone({ type: 'sine', from: base * 2, to: base * 2.02, dur: 0.16, gain: 0.22, at: 0.05 });
  }

  dismiss() {
    this.tone({ type: 'sine', from: 240, to: 170, dur: 0.09, gain: 0.16 });
  }

  caught() {
    this.tone({ type: 'sawtooth', from: 300, to: 70, dur: 0.34, gain: 0.4 });
    this.noise({ dur: 0.26, gain: 0.16, freq: 700, at: 0.02 });
  }

  win() {
    const seq = [523.25, 659.25, 783.99, 1046.5];
    seq.forEach((f, i) => {
      this.tone({ type: 'triangle', from: f, to: f * 1.002, dur: 0.20, gain: 0.42, at: i * 0.13 });
    });
  }

  lose() {
    this.tone({ type: 'triangle', from: 392, to: 392, dur: 0.26, gain: 0.34 });
    this.tone({ type: 'triangle', from: 311, to: 300, dur: 0.5, gain: 0.34, at: 0.24 });
  }

  tick() {
    this.tone({ type: 'square', from: 1100, to: 1100, dur: 0.045, gain: 0.12 });
  }
}
