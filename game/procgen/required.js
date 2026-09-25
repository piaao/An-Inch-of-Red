/**
 * required.js — the one place that answers "which models does this layout need".
 *
 * WHY THIS IS NOT JUST COPIED FROM js/layout.js. The viewer's `requiredModels`
 * closes over that module's own constants, which is fine for one hand-written
 * apartment and useless for a generated one: the game has to load the models a
 * layout asks for, whichever layout it was handed. So the logic takes the layout
 * as an argument here.
 *
 * That leaves two implementations of the same rule, which is a smell -- so it is
 * CHECKED rather than trusted. scripts/procgen.mjs calls both this function and
 * js/layout.js's own closure on the shipped apartment and asserts they agree
 * model for model. A divergence is a loud failure, not a missing wardrobe.
 *
 * Pure: no imports, no IO, no project knowledge beyond the layout schema.
 */

/** Every unique kit model a layout asks for, sorted. */
export function requiredModels(layout) {
  const { ROOMS = [], DOORS = [], CORNERS = [], WALLS = [] } = layout || {};
  const out = new Set();
  for (const z of ROOMS) for (const it of z.items) if (!it.skip) out.add(it.m);
  for (const d of DOORS) out.add(d.m);
  for (const c of CORNERS) out.add(c.m);
  for (const w of WALLS) {
    const len = w.to - w.from;
    const whole = Math.floor(len + 1e-9);
    for (let k = 0; k < whole; k++) {
      const i = w.from + k;
      const kind = w.kinds && Object.prototype.hasOwnProperty.call(w.kinds, i) ? w.kinds[i] : undefined;
      if (kind === null) continue;
      out.add(kind || 'wall');
    }
    if (len - whole > 0.01) out.add('wallHalf');
  }
  out.add('floorFull');
  return [...out].sort();
}
