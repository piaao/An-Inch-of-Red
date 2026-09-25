/**
 * climb.js — the vertical half of the world.
 *
 * WHICH SURFACES EXIST, WHICH OF THEM A BODY CAN ACTUALLY GET TO, AND WHAT
 * THAT COSTS. Three questions, and they have to be answered together, because
 * a surface you cannot reach is not a standpoint and a prize placed on one is a
 * prize nobody can take -- the design's one unforgivable bug, in a new suit.
 *
 * THE DESIGN IT SERVES. A 0.42 m creature with 0.36 m eyes, in a flat whose
 * interesting furniture is 0.23-0.49 m tall. From the floor a counter top is
 * above the eye line, so a packet on it is genuinely invisible and genuinely
 * out of reach; from ON the counter it is neither. Climbing is therefore not a
 * convenience, it is the second half of the search, and the player asked for it
 * in exactly those terms -- 跳到桌子上面, 浴缸里面.
 *
 * WHAT KEEPS IT FROM BREAKING THE GAME. `climbCeilOf` (level.js) caps surfaces
 * at `wallH - eyeHeight`, so the eye never rises to the wall top and six rooms
 * stay six rooms. Nothing here can override that: the ceiling is applied before
 * any other test, so the walls (1.29 m) and the upper kitchen cabinets (1.17 m)
 * are not surfaces at all and no stack of furniture can become a mezzanine.
 *
 * WHY REACHABILITY IS A GRAPH AND NOT A HEIGHT TEST. The ladder has rungs, and
 * ONE of them is all this body can climb. The floor reaches `CLIMB.step`
 * (0.70 m), which covers this flat: the tallest standable thing in it is a
 * 0.63 m lounge chair. A SECOND rung was modelled -- floor, plus a 0.60 m
 * chair, reaching 1.30 -- and MEASURED, the body cannot make that hop; see the
 * note on `reached` below for the numbers and for why a height budget is not
 * enough to decide it.
 *
 * The graph is still a graph, and still needed: "is it below the ceiling"
 * alone would call the 0.77 m coat rack standable, and a surface with no
 * launch pad within `edge` is not a place anybody can stand. So the route is
 * computed once from the spawn and every caller -- the placement, the blind
 * AI, the verifier -- only ever sees the survivors.
 *
 * EVERYTHING IS A PLAIN LEVEL QUERY. No three.js, no DOM, no model names: the
 * surfaces come from the same oriented boxes (`solids`) that collision and
 * line-of-sight use, so a different arena gets a different ladder for free.
 */
import { climbCeilOf, toWorld } from './level.js';

/**
 * The climbing model's own numbers. They are MODELLED, like the harness's
 * `sweepCost` and `confirmCost`, and they are named here rather than buried so
 * that they can be argued with:
 *
 *   edge   how close a launch pad must be to the surface you are climbing onto.
 *          Measured against this body: the 0.63 m lounge chair is reachable,
 *          the 0.77 m coat rack is not (nothing to launch from within `edge`),
 *          and `scripts/probe_ladder.mjs` took all 67 standpoints the placement
 *          trusted. Re-run that probe if this number moves.
 *   step   how high ONE jump-and-scramble gets you, from where you stand
 *   rate   metres of vertical progress per second once you are scrambling
 */
export const CLIMB = {
  edge: 0.60,
  step: 0.70,
  rate: 0.90,
};

/**
 * How high one jump-and-scramble reaches, above the feet.
 *
 * 0.70 = the play layer's jump peak (`v^2 / 2g` at 2.30 / 6.00, i.e. 0.441 m)
 * plus `level.meta.step` (0.26 m of footing) rounded down. It is a duplicate of
 * a number that lives in `game/play/config.js`, which is exactly the kind of
 * duplicate that rots -- so it is not trusted: `scripts/verify_play.mjs`
 * re-derives the play layer's own peak from its own `jumpVel`/`gravity` and
 * asserts that `step >= peak + level.meta.step`. If someone lowers the jump,
 * that assertion fails instead of the game quietly losing a rung.
 */
export function climbStepOf(level, jumpPeak) {
  return jumpPeak != null ? jumpPeak + level.meta.step : CLIMB.step;
}

/**
 * Every point on top of a piece of furniture where a body actually fits.
 *
 * "The top of a solid" is not the same as "somewhere you can stand": a body
 * needs `playerRadius` of clearance and `playerHeight` of headroom, and the
 * question "does a body with its feet at `y1` fit here" is precisely the
 * collision test the mover already uses. So it is asked, not re-implemented --
 * `nav.clear(x, z, r, y1)` skips the host itself (a solid never blocks standing
 * on its own top) and blocks on anything that would be in the way at head
 * height, which is how the counter top under the upper cabinets correctly
 * comes back as "you can stand at the front of it, not at the back".
 *
 * Sampled at the centre plus the four inner corners when the top is big enough
 * for them to be distinct: a single centre sample would call a table with a
 * lamp on its middle un-standable, which is exactly backwards -- a table with
 * something in the middle of it is the most interesting table in the flat.
 */
export function standableSurfaces(level, nav, opts = {}) {
  const ceil = opts.ceil != null ? opts.ceil : climbCeilOf(level);
  const radius = opts.radius != null ? opts.radius : level.body.playerRadius;
  const out = [];
  for (const s of level.solids) {
    if (s.kind !== 'furniture') continue;
    // ABOVE `step`, NOT ABOVE ZERO. A rug (0.01 m) and a coffee table (0.23 m)
    // are things you walk onto, not things you climb: the floor family in
    // `standSpots` already knows about them (`support` counts every solid up to
    // `nav.step`), and listing them here as well would put fourteen
    // rungs on the ladder that are not rungs. What belongs here is exactly what
    // you cannot reach by walking.
    if (!(s.y1 > nav.step)) continue;
    if (!(s.y1 < ceil)) continue;           // wall, upper cabinet: not a surface
    if (s.hx * 2 < radius * 2.2 || s.hz * 2 < radius * 2.2) continue;

    const ox = Math.min(s.hx * 0.55, 0.22);
    const oz = Math.min(s.hz * 0.55, 0.22);
    const pts = [[0, 0]];
    if (s.hx > ox * 1.7 && s.hz > oz * 1.7) {
      pts.push([-ox, -oz], [ox, -oz], [-ox, oz], [ox, oz]);
    }
    for (const [lx, lz] of pts) {
      const p = toWorld(s, lx, lz);
      if (!nav.clear(p.x, p.z, radius, s.y1)) continue;
      out.push({
        id: `${s.id}@${p.x.toFixed(2)},${p.z.toFixed(2)}`,
        host: s.id, model: s.model, room: s.room,
        x: p.x, z: p.z, y: s.y1,
      });
    }
  }
  return out;
}

/**
 * The whole vertical plan, computed once and shared.
 *
 * Returns the surfaces that are reachable from the spawn's floor, each with the
 * launch pad its route starts from, plus the two constants the caller needs to
 * price the climb. `reached` is a Map keyed by surface id; a surface that is
 * not in it does not exist as far as the game is concerned.
 */
export function climbPlan(level, nav, opts = {}) {
  const ceiling = opts.ceil != null ? opts.ceil : climbCeilOf(level);
  const radius = opts.radius != null ? opts.radius : level.body.playerRadius;
  const edge = opts.edge != null ? opts.edge : CLIMB.edge;
  const step = opts.step != null ? opts.step : CLIMB.step;

  const surfaces = standableSurfaces(level, nav, { ceil: ceiling, radius });
  const home = nav.componentAt(level.spawn.x, level.spawn.z);

  /** Standing on the floor, in the room the player starts in. */
  const grounded = (x, z) => nav.clear(x, z, radius, 0)
    && nav.componentAt(x, z) === home;

  /**
   * A launch pad for a surface: a floor cell next to it, connected to the
   * spawn. `nearestWalkable` rather than a ring sample, because the nearest
   * walkable cell to a shelf's centre is on the side of it you would actually
   * stand, and the search radius has to escape the shelf's own footprint.
   */
  const padOf = (s) => {
    const near = nav.nearestWalkable(s.x, s.z, Math.max(s.hx || 0, s.hz || 0) + edge);
    if (near && grounded(near.x, near.z)) return { x: near.x, z: near.z, y: 0 };
    return null;
  };

  // ONE LEVEL DEEP, AND THAT IS A MEASUREMENT, NOT A SIMPLIFICATION.
  //
  // This used to be a fixpoint, so a surface could be reached "via" another
  // rung -- floor, then chair, then bookcase. MEASURED, this body cannot make a
  // rung-from-a-rung hop. scripts/probe_ladder.mjs drove the real Avatar up
  // every ladder the placement trusted, over 20 seeds and 120 packets: all 113
  // one-rung standpoints were taken, and all 7 that needed a second rung failed
  // -- every one of them the same surface, the 0.92 m fridge top reached from
  // the 0.45 m drawer. scripts/diag_ladder_plan.mjs then listed the whole
  // surface table for this arena and showed what the chained branch was worth:
  // 72 of 82 surfaces reached, 67 from a floor pad, and the 5 that came from
  // another rung are 5 sample points OF THE FRIDGE.
  //
  // WHY HEIGHTS ARE NOT ENOUGH. `climbStepOf` is a HEIGHT budget -- jump peak
  // plus one foot of footing (0.70 m). A rung-from-a-rung hop is also a
  // HORIZONTAL problem: the target's side blocks the body until its feet come
  // within `step` of the top, so the body must cross the gap inside that band,
  // and from a 0.45 m launch the band is a fraction of a second long. p57
  // tightened the rung-to-rung limit from `edge + 0.25` to `edge` and the route
  // still passed at 0.561 m -- so `edge` is not the missing number and guessing
  // at one would only move the failure. A horizontal budget would have to be
  // derived from the jump model and measured; until it is, the graph is one
  // level deep.
  //
  // What the graph still does, and must: it is what excludes the 0.77 m coat
  // rack (no pad within `edge`) and anything above `CLIMB.step`, so no caller is
  // ever handed a surface a body cannot stand on.
  const reached = new Map();
  for (const s of surfaces) {
    if (!(s.y <= step)) continue;              // above one jump-and-scramble
    const pad = padOf(s);
    if (pad) reached.set(s.id, { pad, via: null });
  }

  return { surfaces, reached, ceiling, radius, edge, step, home, padOf };
}

/**
 * Standpoints from which `anchor` is within arm's reach, nearest first.
 *
 * Two families, and the reason both are needed:
 *
 *   floor  the old rule, unchanged -- a walkable cell within `reach`, standing
 *          on whatever low thing is under it (these are the cells that decided
 *          the verified pickup budget, so they must keep deciding it)
 *   top    the new rule -- a climbed surface within `reach`. This is what makes
 *          a packet on a 0.88 m shelf obtainable at all.
 *
 * `lift` is how high a hand goes above the feet and `drop` how far below them;
 * both are the same constant by default, because a creature that can reach up
 * 0.55 m can reach down 0.55 m.
 */
export function standSpots(level, nav, plan, anchor, opts = {}) {
  const reach = opts.reach != null ? opts.reach : 0.55;
  const lift = opts.lift != null ? opts.lift : 0.50;
  const drop = opts.drop != null ? opts.drop : lift;
  const ok = (ay, sy) => (ay - sy) <= lift && (sy - ay) <= drop;

  const out = [];

  // ---- floor, exactly the scan the pickup budget was verified against ----
  const r = opts.radius != null ? opts.radius : 0.5;
  const j0 = Math.max(0, Math.floor((anchor.z - r) / nav.cell));
  const j1 = Math.min(nav.d - 1, Math.ceil((anchor.z + r) / nav.cell));
  const i0 = Math.max(0, Math.floor((anchor.x - r) / nav.cell));
  const i1 = Math.min(nav.w - 1, Math.ceil((anchor.x + r) / nav.cell));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (!nav.walkable[j * nav.w + i]) continue;
      const c = nav.centreOf(i, j);
      const dx = c.x - anchor.x;
      const dz = c.z - anchor.z;
      const d = Math.hypot(dx, dz);
      if (d > reach) continue;
      let support = 0;
      for (const s of level.solids) {
        if (s.y1 > nav.step) continue;
        if (s.y1 <= support) continue;
        if (nav.contains(s, c.x, c.z, 0)) support = s.y1;
      }
      if (!ok(anchor.y, support)) continue;
      out.push({
        kind: 'floor', x: c.x, z: c.z, y: support, d,
        pad: { x: c.x, z: c.z }, climb: 0,
      });
    }
  }

  // ---- tops you can climb to ----
  for (const s of plan.surfaces) {
    const acc = plan.reached.get(s.id);
    if (!acc) continue;                       // no route from the spawn: not a place
    const d = Math.hypot(s.x - anchor.x, s.z - anchor.z);
    if (d > reach) continue;
    if (!ok(anchor.y, s.y)) continue;
    out.push({
      kind: 'top', x: s.x, z: s.z, y: s.y, d,
      host: s.host, model: s.model,
      pad: acc.pad, climb: s.y, via: acc.via,
    });
  }

  out.sort((a, b) => (a.d - b.d) || (a.climb - b.climb));
  return out;
}

/** Seconds to scramble from `fromY` up to `toY`. Modelled, one constant. */
export function climbCost(fromY, toY, rate = CLIMB.rate) {
  const rise = toY - fromY;
  return rise > 0 ? rise / rate : 0;
}
