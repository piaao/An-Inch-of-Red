/**
 * regions.js — turn "a seed per room" into "a rectangle per room".
 *
 * The arena adapter refuses to hand-draw room rectangles, because a hand-drawn
 * rectangle and the walls will drift apart the first time anyone moves a wall,
 * and nothing will say so. Instead each room carries a point that is inside it,
 * and this module flood-fills the walkable grid and asks which region that
 * point landed in.
 *
 * The payoff is not tidiness, it is that a broken floor plan FAILS LOUDLY:
 *
 *   - two room seeds in the same region  -> a wall is missing, and the rooms
 *     have merged into one open floor. This is the exact failure the design
 *     doc calls out ("wall 1.29 < eye 1.60, six rooms collapse into one, and
 *     the picture still looks fine").
 *   - a seed in no region at all         -> the room is walled off, or its
 *     furniture has sealed the doorway.
 *   - walkable cells owned by nobody     -> a corridor nobody planned, or a
 *     room the design forgot to name. Judged against the WALKER'S OWN FOOTPRINT
 *     rather than against zero: see the note where the orphans are counted, and
 *     `opts.unassignedMinArea` to move the bar.
 *
 * It imports nothing, so any arena can use it. It takes a nav because the
 * caller already had to build one; it does not build its own.
 */
export function resolveRooms(level, nav, opts = {}) {
  const problems = [];
  // A REGION SMALLER THAN THE WALKER IS NOT A REGION. The bar is derived from
  // `nav.inflate` rather than typed in, and there is exactly one of it.
  const unassignedMinArea = opts.unassignedMinArea != null
    ? opts.unassignedMinArea
    : Math.PI * nav.inflate * nav.inflate;

  const claimed = new Map();      // component index -> room id
  const resolved = [];

  for (const room of level.rooms) {
    let comp = nav.componentAt(room.seed[0], room.seed[1]);
    let snapped = null;
    if (comp < 0) {
      // 1.5 m. A seed can legitimately sit inside the furniture it was
      // typed to describe -- the dining room's seed is the middle of the
      // dining table -- so the snap has to be able to reach the floor
      // around it.
      snapped = nav.nearestWalkable(room.seed[0], room.seed[1], 1.5);
      if (snapped) comp = nav.componentAt(snapped.x, snapped.z);
    }
    if (comp < 0) {
      problems.push(`room "${room.id}": seed (${room.seed[0]}, ${room.seed[1]}) is not in any walkable region`);
      continue;
    }
    if (claimed.has(comp)) {
      const other = claimed.get(comp);
      problems.push(
        `room "${room.id}" and room "${other}" share one open region -- `
        + `a wall between them is missing or has no thickness, so the two rooms have merged`);
      continue;
    }
    claimed.set(comp, room.id);

    const cells = nav.components[comp].cells;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const c of cells) {
      x0 = Math.min(x0, c.x - nav.cell / 2); x1 = Math.max(x1, c.x + nav.cell / 2);
      z0 = Math.min(z0, c.z - nav.cell / 2); z1 = Math.max(z1, c.z + nav.cell / 2);
    }
    resolved.push({
      id: room.id,
      name: room.name,
      seed: room.seed,
      snapped: !!snapped,
      rect: { x0, z0, x1, z1 },
      cx: nav.components[comp].cx,
      cz: nav.components[comp].cz,
      cells: cells.length,
      area: cells.length * nav.cell * nav.cell,
      component: comp,
    });
  }

  // Walkable cells nobody owns: corridors, or a room with no seed.
  const owned = new Set(resolved.map((r) => r.component));
  const orphans = [];
  for (const c of nav.components) {
    if (owned.has(c.id)) continue;
    orphans.push({ component: c.id, cells: c.cells.length, cx: c.cx, cz: c.cz, area: c.area });
  }
  // ONE PHENOMENON, ONE THRESHOLD, IN ONE PLACE. This used to complain about any
  // unowned component at all, which meant the same measurement was judged by two
  // different bars in two different files: this module called a stray 1-cell nook
  // (0.0025 m2) a problem, whilescripts/procgen.mjs judged pockets against the
  // body's own footprint (pi * 0.12^2 = 0.0452 m2). Two checks with two
  // thresholds is how a tool ends up failing a good level over arithmetic dust --
  // and the smaller bar here did exactly that on the shipped apartment, whose
  // only unowned region is ONE CELL, 0.0025 m2, in the study.
  //
  // The bar is the walker: a region that cannot hold the body cannot hold the
  // player, the guard or a 红包, so nothing can be in it and calling it a problem
  // says nothing about the level. Anything over it is a real defect -- floor a
  // thing could occupy that nothing can reach.
  const bigOrphans = orphans.filter((o) => o.area > unassignedMinArea);
  if (bigOrphans.length) {
    problems.push(`${bigOrphans.length} walkable region(s) belong to no room `
      + `(${bigOrphans.map((o) => o.cells + ' cells @ ' + o.cx.toFixed(1) + ',' + o.cz.toFixed(1)).join('; ')}; `
      + `${orphans.length - bigOrphans.length} of ${orphans.length} under the walker's `
      + `${unassignedMinArea.toFixed(4)} m2)`);
  }

  return { problems, rooms: resolved, orphans, ok: problems.length === 0 };
}

/** Write the resolved rectangles back onto the level, in place. */
export function applyRooms(level, resolved) {
  const byId = new Map(resolved.map((r) => [r.id, r]));
  level.rooms = level.rooms.map((r) => {
    const got = byId.get(r.id);
    if (got) {
      return { ...r, resolved: true, rect: got.rect, cx: got.cx, cz: got.cz, area: got.area };
    }
    // A room that never resolved still gets a box, because every reader
    // (placement, patrol, the sim) indexes `rect` unconditionally and a
    // crash two hundred lines later says nothing about the missing wall.
    // The stand-in is a 0.5 m square on the seed: nothing sensible fits in
    // it, and `resolved: false` plus the problem list are what report it.
    const [sx, sz] = r.seed;
    return {
      ...r,
      resolved: false,
      rect: { x0: sx - 0.25, z0: sz - 0.25, x1: sx + 0.25, z1: sz + 0.25 },
      cx: sx, cz: sz, area: 0.25,
    };
  });
  return level;
}
