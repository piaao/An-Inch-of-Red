/**
 * openings.js — turn the raycast table into the two things an adapter needs.
 *
 * `data/passages.json` is the ONLY source that can answer "where is the hole in
 * this wall", because it was measured by raycasting the RENDERED scene rather
 * than by reading the model file. This module turns that raw table into:
 *
 *   wallOpenings[kind] = { body: [[a,b],...], eye: [[a,b],...] }
 *       the solid intervals of that wall model along its own 1 m run, at body
 *       height (0.42) and at eye height (0.36). A gap between two intervals is
 *       a hole you can walk through.
 *
 *   doorClosed[model] = bool
 *       whether a door leaf actually seals its opening, decided by COVERAGE:
 *       a leaf covering more than 90 % of its own width at body height is shut.
 *       That rule reproduces the expected answer from geometry alone --
 *       `doorwayOpen` measures 8 % (an empty frame), `doorway` 99 % -- and it
 *       keeps working if the kit ever swaps which model is the shut one.
 *
 * WHY IT IS A MODULE AND NOT A BLOCK INSIDE snapshot_arena.mjs. There is now a
 * second producer of arenas (scripts/procgen.mjs). Two copies of this table
 * would be two chances to disagree about how wide a doorway is, and the one
 * thing that must never differ between two arenas is the measured width of a
 * door. Extracted so there is exactly one definition; snapshot_arena.mjs was
 * re-run afterwards and its output is byte-identical, which is what makes the
 * extraction a refactor rather than a rewrite.
 *
 * Pure: takes parsed JSON, returns plain objects. No file IO, no project paths.
 */

/**
 * The wall family the kit ships. `wallDoorwayWide` is in the list but is
 * unmeasured in this kit (`passages.kinds[kind].error`), and the unmeasured
 * branch below treats it as a solid of its own width -- which is what
 * snapshot_arena did before, and is why nothing may use it: a wall you cannot
 * measure is a wall you cannot put a door in.
 */
export const WALL_KINDS = ['wall', 'wallHalf', 'wallWindow', 'wallWindowSlide',
                           'wallDoorway', 'wallDoorwayWide', 'wallCorner', 'wallCornerRond'];

/** Body height and eye height, the two heights a wall is asked about. */
export const BODY_Y = 0.42;
export const EYE_Y = 0.36;

/** A measured run that stops within this of the model's edge is flush with it. */
export const FLUSH = 0.02;

/**
 * Measured solid intervals for a wall model, at one height.
 *
 * A run that ends flush with the model edge is stretched back out to it.
 * Without this the ray sweep leaves a 1 cm sliver at each end of every
 * segment, and a sliver is a sight line: two neighbouring wall pieces would
 * pass a guard's gaze through the 1 cm seam between them.
 */
export function intervalsAt(rec, y, halfWidth) {
  const rows = rec.rows.filter((r) => !r.above);
  if (!rows.length) return [[-halfWidth, halfWidth]];
  let best = rows[0];
  let bestD = Infinity;
  for (const r of rows) {
    const d = Math.abs(r.y - y);
    if (d < bestD) { bestD = d; best = r; }
  }
  return best.solid.map(([a, b]) => [
    a <= -halfWidth + FLUSH ? -halfWidth : a,
    b >= halfWidth - FLUSH ? halfWidth : b,
  ]);
}

/**
 * Build the wall-opening table.
 *
 * @param passages  parsed data/passages.json
 * @param sizes     parsed data/kit_three.json ({ models: { name: { size } } })
 * @returns { wallOpenings, openingTable }
 */
export function buildWallOpenings(passages, sizes) {
  const wallOpenings = {};
  const openingTable = [];
  for (const kind of WALL_KINDS) {
    const rec = passages.kinds[kind];
    const w = (sizes.models[kind] && sizes.models[kind].size[0]) || 1;
    if (!rec || rec.error) {
      // Unmeasured (this layout does not use it): treat as a solid of its own
      // measured width. Recording it explicitly keeps the table complete.
      wallOpenings[kind] = { body: [[-w / 2, w / 2]], eye: [[-w / 2, w / 2]] };
      openingTable.push({ kind, source: 'unmeasured, assumed solid', width: w, body: [[-w / 2, w / 2]], eye: [[-w / 2, w / 2]] });
      continue;
    }
    const half = rec.size[0] / 2;
    const body = intervalsAt(rec, BODY_Y, half);
    const eye = intervalsAt(rec, EYE_Y, half);
    wallOpenings[kind] = { body, eye };
    const gaps = [];
    for (let i = 0; i + 1 < body.length; i++) gaps.push([body[i][1], body[i + 1][0]]);
    openingTable.push({ kind, source: 'measured (raycast, rendered scene)', width: rec.size[0], body, eye, gaps });
  }
  return { wallOpenings, openingTable };
}

/**
 * Decide, per door model, whether the leaf is shut.
 *
 * @param passages  parsed data/passages.json
 * @param doors     the layout's DOORS list
 * @returns { doorClosed, doorTable }
 */
export function buildDoorStates(passages, doors) {
  const doorClosed = {};
  const doorTable = [];
  for (const d of doors) {
    const rec = passages.kinds[d.m];
    let closed = d.m !== 'doorwayOpen';
    let coverage = null;
    if (rec && !rec.error) {
      const rows = rec.rows.filter((r) => !r.above);
      let best = rows[0];
      let bd = Infinity;
      for (const r of rows) { const dd = Math.abs(r.y - BODY_Y); if (dd < bd) { bd = dd; best = r; } }
      coverage = best.solidWidth / rec.size[0];
      closed = coverage > 0.9;
    }
    doorClosed[d.m] = closed;
    doorTable.push({
      model: d.m, x: d.x, z: d.z,
      covered: coverage == null ? null : Math.round(coverage * 1000) / 1000,
      shut: closed, note: d.note || '',
    });
  }
  return { doorClosed, doorTable };
}
