/**
 * _author.js — authoring sugar for the hand-made maps, and NOTHING else.
 *
 * The five maps under this directory are HAND-DESIGNED: a person chose every
 * wall and every chair. This file exists so that the repetitive part of that
 * -- "eight 43 cm cabinets along the north wall, starting at x 3.2" -- can be
 * said once instead of eight times.
 *
 * It deliberately does NOT know the layout schema. It returns plain item
 * objects (`{ m, x, z, r, y, s }`) in exactly the shape `js/layout.js` uses,
 * so a map that uses `row()` and a map that writes its items out by hand are
 * the same kind of file, and `game/arena/fromLayout.js` cannot tell them
 * apart. A helper that names rooms, or walls, or decides where a door goes,
 * would be a second implementation of the floor plan; stepping along a line
 * is not.
 */

/** Four decimal places: the id `fromLayout` mints rounds to two anyway, and
 *  a shorter literal is a shorter diff. */
const q = (v) => Math.round(v * 1e4) / 1e4;

/**
 * `n` copies of model `m`, starting at (x, z), stepping by (dx, dz) each time.
 *
 *     row('kitchenCabinetDrawer', 3.2, 0.225, 6, 0.43, 0)
 *
 * is six cabinets in a line along X. `extra` carries `r`, `y` and `s` and is
 * shared by every copy -- a run of cabinets all face the same way.
 */
export function row(m, x, z, n, dx, dz, extra = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ m, x: q(x + dx * i), z: q(z + dz * i), ...extra });
  }
  return out;
}

/** `row`, but every copy at the SAME height offset instead of the floor. */
export function rowAt(m, y, x, z, n, dx, dz, extra = {}) {
  return row(m, x, z, n, dx, dz, { y, ...extra });
}
