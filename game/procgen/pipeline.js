/**
 * pipeline.js — run a generated floor plan through the REAL game pipeline and
 * return a list of countable verdicts.
 *
 * WHY THIS IS A MODULE AND NOT PART OF scripts/procgen.mjs. It used to live
 * inside that script, and that was fine while the only way to generate a floor
 * was the command line. It stops being fine the moment a BROWSER does the
 * generating: a page cannot import a script that reads `node:fs`, and the one
 * thing worse than one implementation of "is this layout playable" is two.
 *
 * So the harness moved here, where both callers can reach it:
 *
 *   scripts/procgen.mjs          Node CLI, writes SVG + logs
 *   procgen.html                 the playground, renders into the page
 *
 * Nothing in this file touches the DOM, the filesystem or `process`. It is the
 * SAME sequence of calls the shipped apartment goes through, in the same order:
 *
 *   1. structural  game/core/level.js validateLevel        -> no problems
 *   2. adapter     an opening with no door in it           -> none
 *   3. walkable    game/core/nav.js, player nav            -> ONE region
 *   4. rooms       game/core/regions.js, openings sealed   -> every room resolves,
 *                                                            no two rooms share a region,
 *                                                            no unowned walkable cells
 *   5. reachable   A* from the spawn to every room's seed
 *   6. prizes      game/core/place.js, the shipped policy  -> all six placed
 *   7. boundary    the outer wall stops the walker         -> no leak in the edge strip
 *   8. world       the level carries the layout it was made from -> what you
 *                  see is what you play
 *
 * Check 3 catches the classic failure: six rooms whose walls do not block sight,
 * collapsing into one open floor while the picture still looks fine. Check 4
 * catches the other one: a room sealed by the furniture the generator itself
 * just put in it.
 */
import { buildLevel } from '../arena/fromLayout.js';
import { buildWallOpenings, buildDoorStates } from '../arena/openings.js';
import { buildNav } from '../core/nav.js';
import { resolveRooms, applyRooms } from '../core/regions.js';
import { validateLevel } from '../core/level.js';
import { placePrizes, defaultViewpoints, prizeRng } from '../core/place.js';
import { requiredModels } from './required.js';

export const PRIZE_COUNT = 6;

/**
 * Run one generated layout through the real pipeline.
 *
 * @returns { level, nav, placement, checks, detail } -- checks is a list of
 *          { id, label, pass, detail } and NOTHING is inferred from a picture.
 */
export function validateLayout(gen, sizes, surfaces, passages, seed) {
  const { layout, report: genReport } = gen;
  const checks = [];
  const add = (id, label, pass, detail = '') => checks.push({ id, label, pass: !!pass, detail });

  // The generator's own complaints, surfaced as a CHECK rather than as a note.
  // "asked for 6 rooms, got 5" is a failure of the tool, and a tool that
  // reports its own shortfall only in a footnote has not reported it.
  add('plan', 'the generator honoured its parameters', genReport.problems.length === 0,
    genReport.problems.join(' | '));

  const { wallOpenings, openingTable } = buildWallOpenings(passages, sizes);
  const { doorClosed, doorTable } = buildDoorStates(passages, layout.DOORS);

  const level = buildLevel({
    layout, sizes, surfaces, wallOpenings,
    options: { id: 'procgen', name: '生成户型', source: 'procgen', doorClosed },
  });

  /* 1. structural ------------------------------------------------------- */
  // Answered AFTER check 4, and that ordering is not cosmetic: rooms do not
  // carry a `rect` until `applyRooms` has run, so `validateLevel` called on the
  // raw `buildLevel` output reports "room X: no rect at all" for every room in
  // every layout. A placeholder keeps the report's order sensible.
  const structuralCheck = { id: 'structural', label: 'level.js validateLevel', pass: false, detail: '' };
  checks.push(structuralCheck);

  /* 2. adapter: every measured opening has a door in it ----------------- */
  const orphanOpenings = level.openings.filter((o) => o.source === 'measured'
    && !level.solids.some((s) => s.kind === 'door' && Math.hypot(s.x - o.x, s.z - o.z) <= 0.7));
  add('adapter', 'no hole in a wall without a door', orphanOpenings.length === 0,
    orphanOpenings.slice(0, 3).map((o) => `${o.wall}@${o.x.toFixed(1)},${o.z.toFixed(1)}`).join(' '));

  /* 3. walkable grid ---------------------------------------------------- */
  const nav = buildNav(level, {
    inflate: level.body.playerRadius,
    bodyHeight: level.body.playerHeight,
    step: level.meta.step,
  });
  /**
   * EVERY WALKABLE CELL MUST BE REACHABLE -- with a threshold derived from the
   * walker, not typed in.
   *
   * The first version asserted "exactly one region" and failed a 14 x 10 m flat
   * over a SIX-CELL pocket (0.015 m2) wedged in a corner behind a bookcase. That
   * is not a bug in the flat: one body is pi * 0.12^2 = 0.0452 m2, so a pocket
   * under 0.045 m2 cannot hold the player, the guard or a 红包 -- nothing can be
   * in it, and calling it a failure made the check lie about a good layout.
   *
   * So the bound is the body's own footprint: an unreachable region larger than
   * that is a real defect (somewhere a thing could be, that nothing can reach),
   * and anything smaller is arithmetic dust. The pockets are reported either way
   * so the number can be argued with instead of trusted.
   */
  const spawnComp = nav.componentAt(level.spawn.x, level.spawn.z);
  const bodyArea = Math.PI * level.body.playerRadius ** 2;
  const pockets = nav.components.filter((c) => c.id !== spawnComp);
  const badPockets = pockets.filter((c) => c.area > bodyArea);
  add('walkable', `every walkable cell is reachable (no pocket over ${bodyArea.toFixed(3)} m2)`,
    spawnComp >= 0 && badPockets.length === 0,
    `${nav.walkableCount}/${nav.w * nav.d} cells, ${nav.components.length} region(s); `
    + (pockets.length
      ? pockets.map((c) => `${c.area.toFixed(4)}m2@${c.cx.toFixed(1)},${c.cz.toFixed(1)}`).join(' ')
      : 'no unreachable pocket'));

  /* 4. rooms ------------------------------------------------------------ */
  const regionNav = buildNav(level, {
    inflate: level.body.playerRadius,
    bodyHeight: level.body.playerHeight,
    step: level.meta.step,
    sealOpenings: true,
  });
  // No option: `regions.js` now makes its complaint on the SAME bar as the
  // pocket check two paragraphs up, so this harness reports the same phenomenon
  // about the same cells instead of suppressing one of the two. (It used to pass
  // `unassignedLimit: Infinity` and re-derive the bar here -- which is how one
  // measurement ends up with two thresholds.)
  const resolved = resolveRooms(level, regionNav);
  applyRooms(level, resolved.rooms);

  /* 8. the world travels with the level --------------------------------- */
  //
  // The check that was MISSING, and its absence is what let a generated floor
  // be played inside the shipped apartment. Every other check here asks about
  // the LEVEL -- nav, rooms, prizes, boundary -- and all of them pass on a
  // level whose geometry no renderer has ever been told about. This one asks
  // the only question that crosses the line: does the snapshot say what to
  // build? `play.html` refuses an arena without it, so a layout that fails
  // here is a floor that cannot be walked into at all.
  const ownLayout = level.layout;
  add('world', 'the level carries the layout it was built from (what you see is what you play)',
    !!ownLayout && !!ownLayout.PLAN && Array.isArray(ownLayout.ROOMS)
      && ownLayout.PLAN.w === level.meta.plan.w && ownLayout.PLAN.d === level.meta.plan.d,
    ownLayout
      ? `layout ${ownLayout.PLAN.w}x${ownLayout.PLAN.d} m, ${ownLayout.ROOMS.length} rooms, `
        + `${requiredModels(ownLayout).length} models, ${level.meta.plan.w}x${level.meta.plan.d} m plan`
      : 'level.layout is missing -- play.html would refuse this arena');

  const structural = validateLevel(level);
  structuralCheck.pass = structural.length === 0;
  structuralCheck.detail = structural.slice(0, 3).join(' | ')
    || `${level.solids.length} solids, ${level.rooms.length} rooms, spawn (${level.spawn.x.toFixed(2)}, ${level.spawn.z.toFixed(2)})`;

  const unresolved = level.rooms.filter((r) => r.resolved === false);
  const dust = resolved.orphans.filter((o) => o.area <= bodyArea);
  const tooBig = resolved.orphans.filter((o) => o.area > bodyArea);
  add('rooms', 'every room resolves to its own region, no pocket the walker could use',
    resolved.problems.length === 0 && unresolved.length === 0 && tooBig.length === 0,
    resolved.problems.slice(0, 2).join(' | ')
    || (unresolved.length ? `unresolved: ${unresolved.map((r) => r.id).join(',')}` : '')
    || `${resolved.rooms.length}/${level.rooms.length} rooms`
      + `, ${resolved.orphans.length} unowned region(s)`
      + ` (${dust.length} under the walker's ${bodyArea.toFixed(3)} m2`
      + (tooBig.length
        ? `, ${tooBig.length} OVER it: ` + tooBig.map((o) => `${o.cells}c@${o.cx.toFixed(1)},${o.cz.toFixed(1)}`).join(' ')
        : `, 0 over it`)
      + ')');

  /* 5. reachable from the spawn ----------------------------------------- */
  const spawnCell = nav.componentAt(level.spawn.x, level.spawn.z);
  const unreachable = [];
  if (spawnCell < 0) unreachable.push('spawn');
  for (const r of level.rooms) {
    const p = nav.astar(level.spawn, { x: r.cx, z: r.cz });
    if (!p) unreachable.push(r.id);
  }
  add('reachable', 'A* spawn -> every room centre', unreachable.length === 0,
    unreachable.slice(0, 4).join(' '));

  /* 6. prizes ----------------------------------------------------------- */
  const vantages = defaultViewpoints(level, nav);
  const placement = placePrizes(level, nav, prizeRng(seed), {
    count: PRIZE_COUNT, policy: 'spread', viewpoints: vantages,
  });
  const onFloor = placement.prizes.filter((p) => p.y <= 0.02).length;
  add('prizes', `all ${PRIZE_COUNT} 红包 placed, none on the floor`,
    placement.prizes.length === PRIZE_COUNT && onFloor === 0,
    `${placement.prizes.length}/${PRIZE_COUNT} placed`
    + (onFloor ? `, ${onFloor} on the floor` : '')
    + `, ${placement.report.anchorsScored} anchors scored`
    + `, rooms used ${placement.report.roomsUsed}/${placement.report.roomsTotal}`);

  /* 7. the outer wall is an obstacle ------------------------------------ */
  // Graduated from a footnote to an assertion once `tools/fix_nav_buckets.py`
  // landed; see `edgeLeaks`. Asked of EVERY layout, not of the first one drawn:
  // a note can only describe, a check can refuse.
  const leak = edgeLeaks(level);
  add('boundary', "the outer wall stops the walker (no standable cell in the edge strip)",
    leak.n === 0, `${leak.n}/${leak.total} sampled edge points standable`
    + (leak.n ? `: ${leak.samples.slice(0, 3).map((p) => `(${p.x.toFixed(2)},${p.z.toFixed(2)})`).join(' ')}` : ''));

  return {
    level, nav, placement, checks,
    detail: { openingTable, doorTable, spawn: level.spawn, edgeLeaks: leak },
    genReport,
  };
}

/**
 * How much of the plan's edge strip is standable, in the game's own nav.
 *
 * WAS A REPORT, IS NOW A CHECK, and the history is the point. `buildBuckets`
 * used to index obstacle buckets from a solid's bounding box and silently drop
 * any solid whose index range came out empty; `fromLayout` places every
 * PERIMETER wall body OUTSIDE the plan on purpose ("the body never eats floor"),
 * so the box that should have been the outer wall produced an empty range and
 * the wall was not an obstacle at all. A cell within the walker's own radius of
 * the plan edge therefore read as open floor -- `nav.clear(0.2, 7.90)` was true
 * on the shipped arena, i.e. a walker standing inside the wall.
 *
 * The tool could not make that reading pass, so it printed the number and
 * pointed at a fix it was not allowed to apply. Measured on the shipped arena
 * 2026-09-25: 19 of 84 sampled edge points standable before, 0 after
 * `tools/fix_nav_buckets.py`. With the fix in, a non-zero reading no longer
 * means "nav is broken" -- it means the fix was lost, which is a regression
 * this harness should refuse rather than narrate.
 */
export function edgeLeaks(level) {
  const r = level.body.playerRadius;
  const nav = buildNav(level, {
    inflate: r, bodyHeight: level.body.playerHeight, step: level.meta.step,
  });
  let n = 0;
  let total = 0;
  const samples = [];
  const probe = (x, z) => {
    total += 1;
    if (!nav.clear(x, z)) return;
    n += 1;
    if (samples.length < 8) samples.push({ x, z });   // where it leaks, if it does
  };
  for (let x = 0.2; x < level.meta.plan.w; x += 0.5) {
    probe(x, r - 0.02);
    probe(x, level.meta.plan.d - r + 0.02);
  }
  for (let z = 0.2; z < level.meta.plan.d; z += 0.5) {
    probe(r - 0.02, z);
    probe(level.meta.plan.w - r + 0.02, z);
  }
  return { n, total, samples };
}
