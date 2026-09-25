/**
 * rng.js — seeded randomness, no dependencies.
 *
 * The design calls for a 每日种子 ("daily seed") so a layout can be compared,
 * shared and raced. That only works if every random decision in the game is
 * driven by this one object, and if the stream is stable across runs, machines
 * and Node/browser. `Math.random` cannot be validated; this can.
 *
 * Algorithm: FNV-1a to turn a human seed ("2026-09-25", "hongbao-7") into a
 * uint32, then mulberry32 to stream from it. Both are tiny, well-known and
 * bit-exact everywhere.
 */

/** FNV-1a over a string -> uint32. */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: one uint32 of state, one float out. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) {
    this.seed = typeof seed === 'string' ? hashString(seed) : (seed >>> 0);
    this.label = typeof seed === 'string' ? seed : String(seed);
    this.stream = mulberry32(this.seed);
    this.draws = 0;
  }

  /** Uniform float in [0, 1). */
  next() {
    this.draws += 1;
    return this.stream();
  }

  /** Uniform float in [lo, hi). */
  range(lo, hi) {
    return lo + (hi - lo) * this.next();
  }

  /** Uniform integer in [0, n). */
  int(n) {
    return Math.min(n - 1, Math.floor(this.next() * n));
  }

  /** True with probability p. */
  chance(p) {
    return this.next() < p;
  }

  pick(list) {
    if (!list.length) return undefined;
    return list[this.int(list.length)];
  }

  /** Fisher-Yates on a copy; the input is never touched. */
  shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /** Pick from [{w: number, ...}] by weight. Weights must be > 0. */
  weighted(entries, weightOf = (e) => e.w) {
    let total = 0;
    for (const e of entries) total += weightOf(e);
    if (!(total > 0)) return undefined;
    let r = this.next() * total;
    for (const e of entries) {
      r -= weightOf(e);
      if (r <= 0) return e;
    }
    return entries[entries.length - 1];
  }

  /**
   * An independent stream derived from this one's label.
   *
   * Sub-streams are derived by NAME, not by consuming draws, so adding a new
   * consumer (say, guard jitter) cannot shift the stream that placement
   * already used. That is what keeps "same seed -> same layout" true as the
   * code grows, which a counter-based fork would quietly break.
   */
  fork(label) {
    return new Rng(hashString(this.label + '/' + label));
  }
}
