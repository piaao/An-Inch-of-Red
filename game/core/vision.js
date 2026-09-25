/**
 * vision.js — who can see what.
 *
 * Two jobs:
 *   1. Line of sight for the guard (blocked by walls and by anything taller
 *      than a pair of eyes).
 *   2. The RED CENSUS: from where a player stands, which red things are
 *      visible, and how many of them are actually 红包. That census is what
 *      turns "the near-colour gamble feels good" into a number.
 *
 * The world is 2.5D on purpose. Sight is tested on a horizontal plane at eye
 * height, because in this apartment every decision that matters is exactly
 * that: the player's eye (0.36) sits below a sofa back (0.46) and above a
 * coffee table (0.23), so "can I see past this" is decided by a horizontal
 * slice. Verticality is handled by a separate reach rule (can the player get
 * close enough and high enough to grab it).
 *
 * That is a stated limitation, not an oversight. An arena with balconies or
 * half-height railings would need a 3D ray here; everything else would
 * carry over unchanged.
 */
import { rayBox, rayBox3, toLocal } from './level.js';
import { climbPlan, standSpots } from './climb.js';

/**
 * How far short of the target a sight line stops. See `sightLine`.
 *
 * 2 cm: larger than the numerical noise of the slab tests (1e-12) by twelve
 * orders of magnitude, and smaller than anything in the kit -- the thinnest
 * solid here is a doorway frame at 9 cm, and the shortest sight line a player
 * cares about is the half metre between an eye and a packet. It is a
 * VISIBILITY epsilon, not a tolerance: it decides "is this thing between us",
 * never "is this number close enough".
 */
const TARGET_EPS = 0.02;

/**
 * Is the ray's entry into `s` passing through `s`'s glass patch?
 *
 * A fridge is one solid box: its shell, its door and its interior. Modelling
 * the interior as "behind a wall" would make a 红包 inside it unfindable. So
 * the arena records the model's glass sub-box (measured from the GLB), and a
 * sight line whose entry point lands inside that patch is treated as looking
 * THROUGH the pane: attenuated, not blocked.
 */
export function glassPatchAt(s, x, z, y) {
  if (!s.glass) return false;
  const l = toLocal(s, x, z);
  if (l.x < s.glass.min[0] || l.x > s.glass.max[0]) return false;
  if (l.z < s.glass.min[2] || l.z > s.glass.max[2]) return false;
  const gy0 = s.y0 + s.glass.min[1];
  const gy1 = s.y0 + s.glass.max[1];
  return y >= gy0 && y <= gy1;
}

/**
 * Trace a sight line from `a` to `b`, from an eye at `eyeY` to a thing at
 * `targetY`. Returns `{ clear, glass, blockedBy, at }`.
 *   glass     how many panes the line passed through (each attenuates colour)
 *
 * `targetY` DEFAULTS TO `eyeY` AND THAT IS THE COMPATIBILITY CONTRACT, not a
 * convenience. Two equal heights make the sloped test identical to the flat
 * one (`rayBox3`'s y slab is then unbounded, so only x and z constrain it), and
 * the flat test is the 2.5D model this whole file was measured on. So a caller
 * that says nothing gets yesterday's answer to the bit, and the guard's vision
 * -- which was measured flat and is not part of the climbing change -- keeps
 * being flat without being touched.
 *
 * Passing a different `targetY` opts ONE call site into the sloped test. The
 * sites that do are the two that reason about where a packet is: the player's
 * red census, and the placement's exposure measurement. Both were previously
 * forced to pretend that a thing on a 0.45 m counter was sitting at 0.36 m,
 * which is how a packet on a table came back as buried inside the table.
 */
export function sightLine(level, a, b, eyeY, targetY) {
  const ty = targetY != null ? targetY : eyeY;
  const flat = ty === eyeY;
  const from = flat ? null : { x: a.x, y: eyeY, z: a.z };
  // THE FAR END IS PULLED BACK BY `TARGET_EPS`. Without it a packet sitting ON
  // something is "hidden behind" that thing: the segment terminates exactly on
  // the host's top face, `rayBox3` returns an intersection at t = 1.0, and the
  // host -- whose `blocksSight` is true because it is taller than an eye --
  // reports itself as the blocker. Measured over the arena's 72 top anchors,
  // that is 27 anchors that could not be seen even from standing on top of
  // them, which is the whole point of climbing. A blocker the segment only
  // reaches AT its target is not between the eye and the target.
  //
  // The flat path does not build a segment at all, so this cannot touch the
  // guard's vision or the `(a, b, y) === (a, b, y, y)` equivalence.
  const span = flat ? 0 : Math.hypot(b.x - a.x, ty - eyeY, b.z - a.z);
  const k = (flat || span <= TARGET_EPS) ? 1 : (span - TARGET_EPS) / span;
  const to = flat ? null : {
    x: a.x + (b.x - a.x) * k,
    y: eyeY + (ty - eyeY) * k,
    z: a.z + (b.z - a.z) * k,
  };

  const hits = [];
  for (const s of level.solids) {
    const h = flat ? rayBox(s, a.x, a.z, b.x, b.z, eyeY) : rayBox3(s, from, to);
    if (h && h.tmin <= 1 && h.tmax >= 0) hits.push(h);
  }
  hits.sort((p, q) => p.tmin - q.tmin);

  let t = 0;
  let glass = 0;
  for (const h of hits) {
    if (h.tmax <= t) continue;                 // already passed
    if (h.tmin > 1) break;
    // Where the line ENTERS the box, not where the eye is: a sloped line meets
    // a fridge door lower down than it started, and the glass patch has a
    // height range. `tminPoint.y` is only set on the sloped path, and its
    // absence is exactly the flat case.
    const ey = h.tminPoint.y != null ? h.tminPoint.y : eyeY;
    const through = glassPatchAt(h.solid, h.tminPoint.x, h.tminPoint.z, ey);
    if (!h.solid.blocksSight || through) {
      if (through) glass += 1;
      t = Math.max(t, h.tmax);
      continue;
    }
    return { clear: false, glass, blockedBy: h.solid.id, at: h.tmin };
  }
  return { clear: true, glass, blockedBy: null, at: 1 };
}

/** Colour confidence after passing through `n` panes (the design's 0.55/step). */
export function colourConfidence(glassHits) {
  return Math.pow(0.55, glassHits);
}

/**
 * How much of the view a red thing of `area` m2 takes up from `d` metres.
 *
 * The ONE salience formula. It has to be the same for the 红包 and for the
 * decoration, because the entire creative claim of the design is that the
 * player cannot tell them apart -- and a formula that treats them
 * differently makes the claim true by construction instead of by play.
 */
export function salienceOf(area, d) {
  return area / (1 + d * d * 0.06);
}

/**
 * How far away something of `area` m2 is still a smudge rather than
 * nothing at all.
 *
 * MIN_ANGLE is the modelled visual acuity, in "fraction of the view the
 * thing has to cover". At 0.0008 a 0.016 m2 红包 (16 x 10 cm) is noticed
 * out to 4.5 m and a 6 m2 rug out to 87 m, i.e. from anywhere in the flat.
 * It is an assumption and it is the number to argue with -- but it is
 * applied identically to prize and decoy, so the blind-vs-oracle gap does
 * not depend on it in the way the absolute ranges do.
 */
export const MIN_ANGLE = 0.0008;

export function noticeRange(area, minAngle = MIN_ANGLE) {
  return Math.sqrt(area / minAngle);
}

/* --------------------------------------------------------------- red census */

let subCounter = 0;

/**
 * A solid's `red` patch promoted to a first-class box, so "is the RED visible"
 * can be asked separately from "is the sofa visible". A sofa is mostly beige;
 * using its bounding box would badly overstate how obvious the prize is.
 */
export function redBoxOf(s) {
  const box = s.red;
  if (!box) return null;
  const cx = (box.min[0] + box.max[0]) / 2;
  const cz = (box.min[2] + box.max[2]) / 2;
  const a = (s.rot * Math.PI) / 180;
  return {
    id: `${s.id}#red`,
    model: s.model,
    kind: 'red',
    room: s.room,
    x: s.x + cx * Math.cos(a) - cz * Math.sin(a),
    z: s.z + cx * Math.sin(a) + cz * Math.cos(a),
    rot: s.rot,
    hx: Math.max(0.01, (box.max[0] - box.min[0]) / 2),
    hz: Math.max(0.01, (box.max[2] - box.min[2]) / 2),
    y0: s.y0 + box.min[1],
    y1: s.y0 + box.max[1],
    blocksMove: true,
    blocksSight: false,          // the patch itself never blocks; its host does
    host: s,
    _sub: ++subCounter,
  };
}

/**
 * Everything red that a viewer at `viewer` can see, and everything about the
 * view a player would have to act on.
 *
 * @param viewer    {x, z}
 * @param opts.eyeY       sight plane height
 * @param opts.range      beyond this, a patch is too small to notice
 * @param opts.prizes     [{id, x, z}] the actual 红包
 * @param opts.minPatch   ignore red patches smaller than this (m^2). A 2 cm
 *                        red fleck on a radio is not a lure, it is noise.
 */
export function redCensus(level, viewer, opts = {}) {
  const eyeY = opts.eyeY != null ? opts.eyeY : level.body.eyeHeight;
  const range = opts.range != null ? opts.range : 9;
  const minPatch = opts.minPatch != null ? opts.minPatch : 0.03;
  const minAngle = opts.minAngle != null ? opts.minAngle : MIN_ANGLE;
  const prizeArea = opts.prizeArea != null ? opts.prizeArea
    : (level.collectible ? level.collectible.size[0] * level.collectible.size[2] : 0.02);
  const prizes = opts.prizes || [];
  const skip = opts.skip || null;

  const reds = [];
  for (const s of level.solids) {
    if (!s.red) continue;
    if (skip && skip.has(s.id)) continue;
    const patch = redBoxOf(s);
    const area = (patch.hx * 2) * (patch.hz * 2);
    if (area < minPatch) continue;
    const d = Math.hypot(patch.x - viewer.x, patch.z - viewer.z);
    if (d > range) continue;
    // Noticing is a size-and-distance question, not just "is it red and
    // in front of me": a 6 m2 rug is a landmark from across the flat, a
    // 0.016 m2 红包 is a smudge past four metres.
    if (d > noticeRange(area, minAngle)) continue;
    // At the patch's own height: a rug at 0.01 m and a cushion at 0.52 m are
    // not the same sight problem, and the flat model could not tell them apart.
    const los = sightLine(level, viewer, patch, eyeY, (patch.y0 + patch.y1) / 2);
    if (!los.clear) continue;
    reds.push({
      id: patch.id, model: patch.model, room: s.room,
      x: patch.x, z: patch.z, dist: d,
      glass: los.glass, confidence: colourConfidence(los.glass),
      area,
      salience: salienceOf(area, d),
    });
  }

  const found = [];
  for (const p of prizes) {
    const d = Math.hypot(p.x - viewer.x, p.z - viewer.z);
    if (d > range) continue;
    // The prize gets the SAME gate and the SAME salience as a decoy, at its
    // own real size. Giving it a special number is what makes "blind"
    // collude with the answer.
    if (d > noticeRange(prizeArea, minAngle)) continue;
    // At the PACKET's own height. This is the line the player's eye actually
    // takes to it, and the reason a packet on the counter is findable from the
    // counter and not from across the room.
    const los = sightLine(level, viewer, p, eyeY, p.y != null ? p.y : eyeY);
    if (!los.clear) continue;
    // x/z travel with the sighting: the sim has to be able to ask WHERE a
    // prize was noticed in order to decide whether the sweep arc covered it.
    found.push({ id: p.id, x: p.x, z: p.z, dist: d, glass: los.glass,
      confidence: colourConfidence(los.glass),
      area: prizeArea, salience: salienceOf(prizeArea, d) });
  }

  reds.sort((a, b) => b.salience - a.salience);
  return { reds, prizes: found, eyeY, range, prizeArea, minAngle };
}

/**
 * Can a player actually pick this up?
 *
 * Hiding something where nobody can reach it is not difficulty, it is a bug --
 * and the design's whole 内部/全遮 idea depends on every placement being
 * genuinely obtainable. So: is there a standable spot within arm's reach, and
 * is the prize within reach of a hand at that spot?
 */
export function reachable(level, nav, anchor, opts = {}) {
  // The two families of standpoint, and the reason both are kept, live in
  // game/core/climb.js. The floor scan there is this function's old scan over
  // the same cells with the same support rule -- those cells are what the
  // verified pickup budget was measured against -- and the climbed tops are a
  // second family ADDED to it, never a replacement.
  const plan = opts.plan || climbPlan(level, nav, opts);
  const spots = standSpots(level, nav, plan, anchor, opts);
  const best = spots.length ? spots[0] : null;
  return {
    ok: !!best,
    stand: best ? { x: best.x, z: best.z, y: best.y } : null,
    // Where the route into this standpoint starts (`pad`) and how far up it has
    // to scramble (`climb`). The blind AI needs both: `pad` is a place it can
    // path to, `climb` is time it must spend once it is there.
    pad: best ? best.pad : null,
    climb: best ? best.climb : 0,
    kind: best ? best.kind : null,
    spots: spots.length,
    gap: best ? anchor.y - best.y : null,
  };
}
