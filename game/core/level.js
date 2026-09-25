/**
 * level.js — the Level schema, its validator, and the box geometry everything
 * else is built on.
 *
 * PORTABILITY CONTRACT
 * --------------------
 * A "Level" is a plain JSON object. Nothing in `game/core/` may import three.js,
 * touch the DOM, or know the name of a single furniture model. Anything that
 * does lives in `game/arena/` (data adapters) or `game/play/` (renderers).
 * Swap the arena and the identical core drives a different building.
 *
 * The whole world is ONE primitive: an oriented box in the XZ plane with a
 * vertical span.
 *
 *     { id, model, kind, x, z, rot, hx, hz, y0, y1, room, tags }
 *
 * Walls, door leaves and sofas are all the same thing. That is what keeps
 * collision, pathfinding and line-of-sight to one implementation each instead
 * of three, and it is why "walls block sight but a doorway does not" needs no
 * special case: an opening is simply the absence of a box.
 *
 * Behaviour is not declared per model, it is DERIVED from the box:
 *
 *   blocksMove   y1 > stepHeight            (you cannot walk through it)
 *   climbable    y1 <= jumpHeight           (you can stand on top of it)
 *   blocksSight  y1 > eyeHeight             (you cannot see over it)
 *
 * Coherence comes for free. A coffee table is 0.23 high, the player's eye is
 * 0.36, so you see over it and cannot hide behind it — and it renders at the
 * right size without anyone typing a number twice.
 */

/** Visibility tiers, easiest first. These are the real difficulty dial. */
export const TIERS = ['open', 'partial', 'concealed', 'inside'];

/**
 * Family: how the player must invest to find a collectible of this tier.
 * `open`   — spotted from across the room while walking past.
 * `partial`— needs a second angle, or stepping closer.
 * `concealed`— must be almost on top of it; you only find it by sweeping.
 * `inside` — behind glass: visible, but colour-attenuated so it must be
 *            confirmed rather than assumed.
 */
export const TIER_INFO = {
  open: { label: '明放', family: 'spot', colourConfidence: 1.0 },
  partial: { label: '半遮', family: 'approach', colourConfidence: 1.0 },
  concealed: { label: '全遮', family: 'sweep', colourConfidence: 1.0 },
  inside: { label: '内部', family: 'inspect', colourConfidence: 0.55 },
};

/**
 * The design's default mix (20 / 35 / 30 / 15 %). Small N cannot hit a ratio
 * exactly, so placement apportions INTEGER counts by largest remainder. At
 * N = 20 the counts land exactly (4 / 7 / 6 / 3); the shipped game uses N = 6,
 * where it is (1 / 2 / 2 / 1).
 */
export const DEFAULT_TIER_TARGET = { open: 0.20, partial: 0.35, concealed: 0.30, inside: 0.15 };

/**
 * Split `n` items across tiers to match `target` as closely as integers allow.
 * Largest-remainder method, ties broken by TIERS order so it is deterministic.
 */
export function tierCounts(n, target = DEFAULT_TIER_TARGET) {
  const exact = TIERS.map((t) => ({ tier: t, want: n * (target[t] || 0) }));
  const out = {};
  let used = 0;
  for (const e of exact) {
    e.base = Math.floor(e.want);
    e.rem = e.want - e.base;
    out[e.tier] = e.base;
    used += e.base;
  }
  let left = n - used;
  const order = exact.slice().sort((a, b) => (b.rem - a.rem) || (TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier)));
  for (let i = 0; i < left; i++) out[order[i % order.length].tier] += 1;
  return out;
}

/* ------------------------------------------------------------------ geometry */

const DEG = Math.PI / 180;

/** A solid's footprint as an axis-aligned rect (conservative for rotated boxes). */
export function aabbOf(s) {
  const c = Math.abs(Math.cos(s.rot * DEG));
  const n = Math.abs(Math.sin(s.rot * DEG));
  const ex = s.hx * c + s.hz * n;
  const ez = s.hx * n + s.hz * c;
  return { x0: s.x - ex, z0: s.z - ez, x1: s.x + ex, z1: s.z + ez };
}

/** Is (x, z) inside the solid's footprint, expanded by `pad`? */
export function containsXZ(s, x, z, pad = 0) {
  const a = -(s.rot * DEG);
  const dx = x - s.x;
  const dz = z - s.z;
  const lx = dx * Math.cos(a) - dz * Math.sin(a);
  const lz = dx * Math.sin(a) + dz * Math.cos(a);
  return Math.abs(lx) <= s.hx + pad && Math.abs(lz) <= s.hz + pad;
}

/** World point -> the solid's local frame (rotation removed). */
export function toLocal(s, x, z) {
  const a = -(s.rot * DEG);
  const dx = x - s.x;
  const dz = z - s.z;
  return {
    x: dx * Math.cos(a) - dz * Math.sin(a),
    z: dx * Math.sin(a) + dz * Math.cos(a),
  };
}

/** Local point -> world. */
export function toWorld(s, lx, lz) {
  const a = s.rot * DEG;
  return {
    x: s.x + lx * Math.cos(a) - lz * Math.sin(a),
    z: s.z + lx * Math.sin(a) + lz * Math.cos(a),
  };
}

/**
 * Ray vs one box, in 2D, restricted to a horizontal slice at height `y`.
 *
 * Returns null, or `{ tmin, tmax, tminPoint, tmaxPoint }` with parameters in
 * [0, 1] along a->b. `tmaxPoint` matters: a glass pane does not stop a sight
 * line, it only attenuates it, so the caller needs the far side to resume from.
 */
export function rayBox(s, ax, az, bx, bz, y, pad = 0) {
  if (y < s.y0 || y > s.y1) return null;

  const p0 = toLocal(s, ax, az);
  const p1 = toLocal(s, bx, bz);
  const dx = p1.x - p0.x;
  const dz = p1.z - p0.z;

  const hx = s.hx + pad;
  const hz = s.hz + pad;
  let tmin = 0;
  let tmax = 1;

  for (const [p, d, h] of [[p0.x, dx, hx], [p0.z, dz, hz]]) {
    if (Math.abs(d) < 1e-12) {
      if (p < -h || p > h) return null;          // parallel and outside
      continue;
    }
    let t1 = (-h - p) / d;
    let t2 = (h - p) / d;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  const at = (t) => ({ x: ax + (bx - ax) * t, z: az + (bz - az) * t });
  return { tmin, tmax, tminPoint: at(tmin), tmaxPoint: at(tmax), solid: s };
}

/* ------------------------------------------------------------------ geometry */

/**
 * Ray vs one box, in 3D. Same return shape as `rayBox`, but the segment may
 * change height.
 *
 * WHY IT EXISTS. `rayBox` answers "does this box straddle the horizontal plane
 * at y = eyeY", which is the right question while every sight line is flat: a
 * standing eye, a standing guard. It stops being the right question the moment
 * a packet sits on a 0.92 m shelf, because the line from an eye at 0.36 to a
 * thing at 0.92 is genuinely sloped and judging it in a plane answers a
 * question nobody asked -- it reported such a prize as buried in the shelf.
 *
 * WHY IT IS SAFE TO INTRODUCE. When `a.y === b.y` the y slab is unbounded and
 * this reduces to the x/z slabs of `rayBox` term for term, so a caller that
 * passes two equal heights gets the old answer bit for bit. That is what lets
 * the sight model be upgraded one call site at a time instead of globally --
 * the guard's own vision can stay exactly as measured while the player's finds
 * things it could not previously reason about.
 */
export function rayBox3(s, a, b) {
  const p0 = toLocal(s, a.x, a.z);
  const p1 = toLocal(s, b.x, b.z);
  const dx = p1.x - p0.x;
  const dz = p1.z - p0.z;
  const dy = b.y - a.y;

  let tmin = 0;
  let tmax = 1;
  // One slab per axis. `false` means the segment misses the slab entirely,
  // which is a miss for the box as well -- slabs are intersected, not unioned.
  const slab = (p, d, lo, hi) => {
    if (Math.abs(d) < 1e-12) return p >= lo && p <= hi;   // parallel: inside or not
    let t1 = (lo - p) / d;
    let t2 = (hi - p) / d;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    return tmin <= tmax;
  };
  if (!slab(p0.x, dx, -s.hx, s.hx)) return null;
  if (!slab(p0.z, dz, -s.hz, s.hz)) return null;
  if (!slab(a.y, dy, s.y0, s.y1)) return null;

  const at = (t) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + dy * t,
    z: a.z + (b.z - a.z) * t,
  });
  return { tmin, tmax, tminPoint: at(tmin), tmaxPoint: at(tmax), solid: s };
}

/* ------------------------------------------------------------------ queries */

/** Which room owns this plan position? Null when outside the plan. */
export function roomOfPoint(level, x, z) {
  for (const r of level.rooms) {
    const b = r.rect;
    if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return r.id;
  }
  return null;
}

export function roomById(level, id) {
  return level.rooms.find((r) => r.id === id) || null;
}

/** Every solid whose vertical span overlaps [y0, y1). */
export function solidsAtHeight(level, y0, y1) {
  return level.solids.filter((s) => s.y1 > y0 && s.y0 < y1);
}

/**
 * The highest surface the player may stand on, DERIVED from the one thing that
 * must not break: the eye has to stay below the wall top.
 *
 *     climbCeil = wallH - eyeHeight        (1.29 - 0.36 = 0.93 m here)
 *
 * Walls are 1.29 and the upper kitchen cabinets 1.17, so neither is a surface:
 * standing on the tallest legal thing still leaves the sight line under the
 * wall, and six rooms stay six rooms. The comparisons that use this are
 * STRICTLY below it, because the equality case is the eye exactly level with
 * the wall top, and the camera's own bob would push it a few millimetres over.
 * A guard band is not needed; a strict inequality is, and it is the honest one.
 *
 * One definition, three readers: the avatar's ground query, the placement's
 * reach test, and scripts/verify_play.mjs.
 */
export function climbCeilOf(level) {
  return level.meta.wallH - level.body.eyeHeight;
}

/**
 * The highest supporting surface under (x, z) that a walker at `feetY` can
 * stand on, given they can climb at most `step` above their feet.
 *
 * `ceil` caps what counts as a surface at all (see `climbCeilOf`). It defaults
 * to Infinity so every pre-climbing caller gets the old answer unchanged; only
 * the player's own ground query passes it, because only the player climbs.
 */
export function supportY(level, x, z, feetY, step, ceil = Infinity) {
  let top = 0;
  for (const s of level.solids) {
    if (s.y1 > feetY + step) continue;             // too tall to get onto
    if (s.y1 >= ceil) continue;                    // above the climb ceiling
    if (s.y1 <= top) continue;
    if (containsXZ(s, x, z)) top = s.y1;
  }
  return top;
}

/* ---------------------------------------------------------------- validation */

/**
 * Structural checks. Anything that fails here means the arena adapter is wrong,
 * not the game, so it must be loud and specific.
 */
export function validateLevel(level) {
  const bad = [];
  const need = ['meta', 'floors', 'solids', 'rooms', 'spawn', 'collectible', 'body'];
  for (const k of need) if (!(k in level)) bad.push(`missing key: ${k}`);
  if (bad.length) return bad;

  if (!level.floors.length) bad.push('no floor tiles');
  if (!level.rooms.length) bad.push('no rooms');
  if (!level.solids.length) bad.push('no solids');

  const ids = new Set();
  for (const s of level.solids) {
    if (ids.has(s.id)) bad.push(`duplicate solid id: ${s.id}`);
    ids.add(s.id);
    if (!(s.hx > 0) || !(s.hz > 0)) bad.push(`${s.id}: non-positive half extent`);
    if (!(s.y1 > s.y0)) bad.push(`${s.id}: y1 <= y0`);
    if (!Number.isFinite(s.x) || !Number.isFinite(s.z)) bad.push(`${s.id}: bad position`);
  }

  const { x, z } = level.spawn;
  if (roomOfPoint(level, x, z) === null) bad.push(`spawn (${x}, ${z}) is not inside any room`);
  if (level.solids.some((s) => containsXZ(s, x, z) && s.y0 < 0.4 && s.y1 > 0.1)) {
    bad.push(`spawn (${x}, ${z}) is inside a solid`);
  }

  for (const r of level.rooms) {
    // A room that never resolved to a rectangle is a FLOOR PLAN bug, and
    // the one thing that must not happen here is a throw: the caller is
    // mid-diagnosis, and `undefined.rect` says nothing about the missing
    // wall. Report it, and let every reader still find a usable box.
    if (r.resolved === false) {
      bad.push(`room ${r.id}: never resolved to a rectangle (seed ${r.seed[0]}, ${r.seed[1]})`
        + ' -- walled off, or merged into another room\'s open floor');
    }
    if (!r.rect) {
      bad.push(`room ${r.id}: no rect at all`);
      continue;
    }
    if (!(r.rect.x1 > r.rect.x0) || !(r.rect.z1 > r.rect.z0)) {
      bad.push(`room ${r.id}: degenerate rect ${JSON.stringify(r.rect)}`);
    }
  }

  const b = level.body;
  for (const k of ['playerRadius', 'playerHeight', 'eyeHeight', 'guardRadius']) {
    if (!(b[k] > 0)) bad.push(`body.${k} not positive`);
  }
  if (b.eyeHeight >= level.meta.wallH) {
    bad.push(`body.eyeHeight (${b.eyeHeight}) is at or above wall height `
      + `(${level.meta.wallH}) -- every room would see into every other room`);
  }
  return bad;
}
