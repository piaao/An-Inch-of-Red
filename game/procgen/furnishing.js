/**
 * furnishing.js — the geometry of "these pieces belong together".
 *
 * WHY THIS MODULE EXISTS, and the number that made it. A room reads as
 * furnished when its pieces CHAIN: a bed with a table at its head, a sofa with
 * a lamp at its arm, a desk with a chair tucked in. Placed one at a time, at a
 * random legal spot, the very same pieces read as a scatter, and that is
 * measurable rather than a matter of taste -- on twelve seeds at 10 x 8 m with
 * 60 items, the generated flats measured **1.29 pieces per group, 64 % of
 * pieces standing entirely alone, and 10.8 pieces per flat on open floor
 * touching nothing** (the designed flat: 3.61 / 13 % / 1).
 *
 * ------------------------------------------------------------ ONE DEFINITION
 *
 * The ruler already knew how to answer "is this piece part of something" --
 * `arrangement.js` clustered groups by `boxGap <= JOIN` and called a lone piece
 * further than `AGAINST_WALL` from every wall FLOATING. The placer needs the
 * SAME two answers to aim at. Written twice, they would be two facts, and the
 * failure is silent and flattering: the placer aims at 0.28, the ruler judges
 * at 0.30, and every room comes back "almost grouped" while the report says the
 * generator nearly worked.
 *
 * So the two functions moved HERE, and both hands call them: the ruler to judge
 * (`arrangement.js`) and the placer to aim (`floorplan.js`). The thresholds are
 * not ours to choose -- they are `JOIN` and `AGAINST_WALL`, imported from
 * `./siting.js` with their derivations, exactly as before.
 *
 * PORTABILITY CONTRACT (same as game/core/ and game/procgen/): no three.js, no
 * DOM, no file IO, no `process`. Pure arithmetic on boxes.
 */

import { JOIN, AGAINST_WALL } from './siting.js';

const DEG = Math.PI / 180;

/**
 * World-frame half extents of a rotated footprint.
 *
 * The absolute cosine/sine is the whole trick: a box does not care which way a
 * sofa faces, only how much floor it covers, so a 90-degree turn is the same
 * box as a 0-degree turn with the axes swapped. `arrangement.js` and
 * `floorplan.js` each had their own copy of this before; a footprint measured
 * two ways is a group judged on one answer and placed on another.
 */
export function halfExtents(size, deg, scale) {
  const s = scale || 1;
  const hx = (size[0] * s) / 2;
  const hz = (size[2] * s) / 2;
  const c = Math.abs(Math.cos(deg * DEG));
  const n = Math.abs(Math.sin(deg * DEG));
  return { ex: hx * c + hz * n, ez: hx * n + hz * c };
}

/** The AABB of a footprint centred on (x, z). */
export const boxAt = (x, z, ex, ez) => ({ x0: x - ex, z0: z - ez, x1: x + ex, z1: z + ez });

/** The world-frame AABB of one placed item, or null when the model is unmeasured. */
export function itemBox(it, size) {
  if (!size) return null;
  const { ex, ez } = halfExtents(size, it.r || 0, it.s && it.s !== 1 ? it.s : 1);
  return boxAt(it.x, it.z, ex, ez);
}

/**
 * Straight-line gap between two boxes on whichever axis separates them.
 *
 * Zero when they share floor, which is what makes "the television stands on the
 * cabinet" a JOINED pair rather than a coincidence of coordinates.
 */
export const boxGap = (a, b) => {
  const dx = Math.max(0, Math.max(a.x0 - b.x1, b.x0 - a.x1));
  const dz = Math.max(0, Math.max(a.z0 - b.z1, b.z0 - a.z1));
  return Math.hypot(dx, dz);
};

/** Distance from a box to the nearest edge of a rectangle. */
export const distToRectEdge = (b, rect) => Math.min(
  Math.abs(b.x0 - rect.x0), Math.abs(rect.x1 - b.x1),
  Math.abs(b.z0 - rect.z0), Math.abs(rect.z1 - b.z1));

/** Is this piece against a wall, as the ruler counts walls? */
export const againstWall = (b, rect) => distToRectEdge(b, rect) <= AGAINST_WALL;

/** Does this piece touch any piece already on the floor? */
export const joined = (b, boxes) => boxes.some((o) => boxGap(b, o) <= JOIN);

/**
 * The four positions at which a companion BUTTS against a host's footprint.
 *
 * Flush by construction -- the gap is the placer's own `p.gap`, which is two
 * orders of magnitude under `JOIN`, so a companion placed here is a member of
 * the host's group by arithmetic and not by luck. That is the whole difference
 * between this and a lattice search that happens to land nearby.
 *
 * Returned in a fixed order (along the host's two ends first, then its two
 * faces) so the caller can express a preference -- a bedside table continues
 * the wall run the bed started, it does not sit out in front of it -- without
 * this module having to know what a bed is.
 */
export function buttedSpots(box, size, r, scale, gap) {
  const { ex, ez } = halfExtents(size, r, scale);
  const cx = (box.x0 + box.x1) / 2;
  const cz = (box.z0 + box.z1) / 2;
  return [
    { at: 'end-lo', x: box.x0 - ex - gap, z: cz },
    { at: 'end-hi', x: box.x1 + ex + gap, z: cz },
    { at: 'face-lo', x: cx, z: box.z0 - ez - gap },
    { at: 'face-hi', x: cx, z: box.z1 + ez + gap },
  ];
}
