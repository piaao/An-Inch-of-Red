/**
 * arrangement.js — does a layout read as a PLACE, not merely as a maze?
 *
 * WHY THIS IS A SECOND AXIS AND NOT FOUR MORE CHECKS IN `pipeline.js`.
 *
 * `pipeline.js` answers "can this floor be played": nav, rooms, prizes,
 * boundary. Twelve of twelve generated layouts pass every one of those, and the
 * floors still do not look like the hand-made apartment. That is not a
 * contradiction -- a floor can be perfectly connected, fully reachable and
 * prize-complete while opening its front door into a bathroom.
 *
 * The obvious move is to append the arrangement questions to that same list.
 * It is the wrong move, and the reason is measurable rather than aesthetic:
 * `procgen.mjs` derives its exit code from that list, and four acceptance
 * suites (`verify_playground`, `verify_live`, `verify_gen_play`,
 * `verify_world`) all hang on `1/1 PASS`. Putting arrangement in the same list
 * would turn every one of them red for a reason none of them is about -- "does
 * the workbench work" would start failing because a wardrobe is 8 cm off a
 * wall. Worse, it would permanently fuse two independent facts into one
 * boolean, and a floor that is playable and badly arranged would become
 * indistinguishable from a floor that is neither.
 *
 * So: ONE implementation, TWO verdicts. `validateLayout` returns the unchanged
 * `checks` and, alongside it, `arrangement`. Both are equally countable; both
 * are printed; the CLI grows an explicit `--strict-arrangement` flag for the
 * day the second axis is allowed to gate a build.
 *
 * ------------------------------------------------------------------ the ruler
 *
 * Same ruler for both hands. `js/layout.js` (designed) and
 * `floorplan.js` (generated) go through this one function and the numbers land
 * side by side. A metric that only flatters the design is not a metric.
 *
 * ----------------------------------------------------------------- the doors
 *
 * Door adjacency is read from the resolved RECTANGLES, not from the layout text
 * and not from a nav probe, and that history is worth keeping. The first ruler
 * put a probe 0.35 m either side of every door and asked `nav.componentAt()`,
 * which is how a player would answer it. That ruler lied in the direction that
 * flatters nobody: the shipped apartment's bathroom door has a 0.31 m trashcan
 * 0.29 m inside it, the probe landed on furniture, `componentAt` returned -1,
 * and the audit reported the DESIGNED bathroom as having no door at all -- while
 * reporting `maxDepth 1` for a flat that plainly has three. A rect edge does
 * not care what furniture is in the way.
 *
 * PORTABILITY CONTRACT (same as game/core/ and game/procgen/): no three.js, no
 * DOM, no file IO, no `process`. Measured sizes arrive through `opts.sizes`.
 */

import { buildLevel } from '../arena/fromLayout.js';
import { buildWallOpenings, buildDoorStates } from '../arena/openings.js';
import { buildNav } from '../core/nav.js';
import { resolveRooms, applyRooms } from '../core/regions.js';

import { JOIN, AGAINST_WALL, MAX_DOOR_HOPS } from './siting.js';

const DEG = Math.PI / 180;

/**
 * Build a level and resolve its rooms -- the level `auditArrangement` needs.
 *
 * EXPORTED SO THE SEQUENCE EXISTS ONCE. `pipeline.js` cannot use it (it
 * interleaves its own nine checks between these same calls), so this is the
 * copy for tools whose only job is to look at a layout: the CLI's diagram
 * script and the acceptance harness. `scripts/verify_arrangement.mjs` holds the
 * two against each other for the same layout -- if this helper and
 * `validateLayout` ever stop agreeing, the arrangement verdict stops being one
 * fact, and that is a thing a test has to refuse rather than a thing a comment
 * has to promise.
 *
 * @param layout                  js/layout.js schema
 * @param opts.sizes/surfaces/passages  the parsed data/ JSON, same as pipeline's
 */
export function toResolvedLevel(layout, opts = {}) {
  const { wallOpenings } = buildWallOpenings(opts.passages, opts.sizes);
  const { doorClosed } = buildDoorStates(opts.passages, layout.DOORS);
  const tag = opts.tag || 'audit';
  const level = buildLevel({
    layout, sizes: opts.sizes, surfaces: opts.surfaces || {}, wallOpenings,
    options: { id: tag, name: tag, source: tag, doorClosed },
  });
  const nav = buildNav(level, {
    inflate: level.body.playerRadius, bodyHeight: level.body.playerHeight,
    step: level.meta.step, sealOpenings: true,
  });
  applyRooms(level, resolveRooms(level, nav).rooms);
  return level;
}
/** How near the plan boundary a room counts as having an outside wall. */
const EXTERIOR_TOL = 0.12;

/** A door is "on" a room's face when its centre is within this of the span. */
const ON_FACE_TOL = 0.30;

/**
 * Roles a stranger does not arrive into.
 *
 * A bedroom and a bathroom are the two rooms a person closes a door on. A
 * kitchen is included nowhere: entering through a kitchen is unusual, not
 * wrong, and a bound that fails an unusual-but-legal flat is a bound that
 * teaches the generator nothing.
 */
const PRIVATE_ROLES = new Set(['bedroom', 'bath']);

/** `bedroom2` -> `bedroom`. The generator suffixes repeated roles. */
export const baseRole = (id) => String(id == null ? '' : id).replace(/[0-9]+$/, '');

/** The six question ids this module answers, in report order. */
export const ARRANGEMENT_IDS = [
  'entry-public', 'entry-hub', 'door-hops', 'bath', 'kitchen-dining', 'bedroom-window',
];

/* ============================================================ measurements */

const sizeOfIn = (sizes, m) => {
  if (!sizes) return null;
  const e = sizes.models ? sizes.models[m] : sizes[m];
  return e && e.size ? e.size : null;
};

/**
 * World-frame AABB of one placed item, or null when the model is unmeasured.
 *
 * Mirrors `level.js aabbOf` and `floorplan.js halfExtents`: the rotation's
 * absolute cosine/sine gives the world extent of the rotated footprint. An
 * unmeasured model returns null rather than a zero box, because a zero box
 * would silently join whatever it stands next to and make a group look composed
 * when nothing is known about it.
 */
function itemBox(it, sizes) {
  const size = sizeOfIn(sizes, it.m);
  if (!size) return null;
  const s = it.s && it.s !== 1 ? it.s : 1;
  const hx = (size[0] * s) / 2;
  const hz = (size[2] * s) / 2;
  const c = Math.abs(Math.cos((it.r || 0) * DEG));
  const n = Math.abs(Math.sin((it.r || 0) * DEG));
  const ex = hx * c + hz * n;
  const ez = hx * n + hz * c;
  return { x0: it.x - ex, x1: it.x + ex, z0: it.z - ez, z1: it.z + ez };
}

/** Straight-line gap between two boxes on whichever axis separates them. */
const boxGap = (a, b) => {
  const dx = Math.max(0, Math.max(a.x0 - b.x1, b.x0 - a.x1));
  const dz = Math.max(0, Math.max(a.z0 - b.z1, b.z0 - a.z1));
  return Math.hypot(dx, dz);
};

const distToRectEdge = (b, rect) => Math.min(
  Math.abs(b.x0 - rect.x0), Math.abs(rect.x1 - b.x1),
  Math.abs(b.z0 - rect.z0), Math.abs(rect.z1 - b.z1));

/**
 * Furniture composition inside one room.
 *
 * Two pieces belong to the same group when their footprints are within `JOIN`.
 * Single-linkage over all pairs: a bed, its two tables and a rug become ONE
 * group, which is what a person sees. `singletons` counts groups of exactly one
 * -- a piece standing on its own -- and `floating` is the stricter subset that
 * is also away from every wall: an object on open floor, touching nothing. That
 * is the single loudest "this was generated" tell, and it is countable.
 */
function compose(items, rect, sizes) {
  const boxes = items.map((it) => itemBox(it, sizes));
  const live = [];
  for (let i = 0; i < boxes.length; i++) if (boxes[i]) live.push({ b: boxes[i], i });
  const parent = live.map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) if (boxGap(live[i].b, live[j].b) <= JOIN) union(i, j);
  }
  const byRoot = new Map();
  for (let i = 0; i < live.length; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(live[i]);
  }
  const groups = [...byRoot.values()];
  let floating = 0;
  for (const g of groups) {
    if (g.length !== 1) continue;
    if (distToRectEdge(g[0].b, rect) <= AGAINST_WALL) continue;
    floating += 1;
  }
  return {
    measured: live.length,
    unmeasured: items.length - live.length,
    groups: groups.length,
    singletons: groups.filter((g) => g.length === 1).length,
    biggest: groups.reduce((a, g) => Math.max(a, g.length), 0),
    floating,
  };
}

/* ================================================================== the audit */

/**
 * Run the six arrangement questions over one layout.
 *
 * @param layout  js/layout.js schema: { PLAN, WALLS, DOORS, ROOMS }
 * @param level   a BUILT level whose rooms carry resolved `rect`s (i.e. after
 *                `applyRooms`). Rects are required, not optional: deriving them
 *                here from the nominal partition would make this a second
 *                notion of where a room is, and the first divergence would be
 *                invisible.
 * @param opts.sizes parsed data/kit_three.json, for furniture footprints
 *
 * @returns { ready, checks, readings }. Never throws: a layout it cannot read
 *          comes back as `ready: false` with one failing check, so a caller's
 *          verdict stays a list of judgements rather than an exception.
 */
export function auditArrangement(layout, level, opts = {}) {
  const sizes = opts.sizes || null;
  const checks = [];
  const add = (id, label, pass, detail = '', applicable = true) => {
    checks.push({ id, label, pass: !!pass, detail, applicable });
  };

  const rooms = (level && level.rooms) || [];
  const rectless = rooms.filter((r) => !r.rect);
  if (!rooms.length || rectless.length) {
    add('arrangement-input', 'the layout can be read as a plan (every room has a resolved rect)',
      false,
      rooms.length
        ? `${rectless.length} room(s) with no rect: ${rectless.map((r) => r.id).join(', ')} `
          + '-- arrangement cannot be judged on a floor whose rooms did not resolve'
        : 'no rooms at all');
    return { ready: false, checks, readings: null };
  }

  const plan = (level.meta && level.meta.plan) || { w: 0, d: 0 };
  const doors = layout.DOORS || [];

  /* --- which room sits on each side of a doorway ------------------------- */
  const alongZ = (r) => Math.abs(Math.sin((r || 0) * DEG)) > 0.5;

  /**
   * The room whose edge is this line, on the requested side of it.
   *
   * The match is on the resolved rect: the door must fall inside the room's
   * SPAN along the wall, and the room's own face must sit within 0.55 m of the
   * door line (walls are 5 cm and a doorway frame reaches ~7 cm, so anything
   * beyond that is not this door's wall). `gap` may be slightly negative -- a
   * wall body falls just off the nominal line -- hence the -0.30 floor.
   */
  const sideOf = (d, which) => {
    const vert = alongZ(d.r);                    // wall runs along Z -> rooms sit in X
    let best = null;
    for (const r of rooms) {
      const rect = r.rect;
      const [lo, hi] = vert ? [rect.z0, rect.z1] : [rect.x0, rect.x1];
      const at = vert ? d.z : d.x;
      if (at < lo - ON_FACE_TOL || at > hi + ON_FACE_TOL) continue;
      const edge = which === 'lo' ? (vert ? rect.x0 : rect.z0) : (vert ? rect.x1 : rect.z1);
      const line = vert ? d.x : d.z;
      const gap = which === 'lo' ? edge - line : line - edge;   // negative = wrong side
      if (gap < -ON_FACE_TOL || gap > 0.55) continue;
      if (!best || gap < best.gap) best = { id: r.id, gap };
    }
    return best ? best.id : null;
  };
  const probe = (d) => [sideOf(d, 'lo'), sideOf(d, 'hi')];

  // The entry is walked INTO: the side that has a room on it at all. The far
  // side of a perimeter door is the outdoors, and there is no rect there.
  const front = doors.find((d) => d.m === 'doorwayFront') || null;
  let entry = null;
  if (front) {
    const [a, b] = probe(front);
    entry = a !== null ? a : b;
  }
  const entryRole = entry ? baseRole(entry) : null;

  /* --- the door graph, and the graph of ways through --------------------- */
  const doorGraph = new Map(rooms.map((r) => [r.id, new Set()]));
  for (const d of doors) {
    if (d.m === 'doorwayFront') continue;
    const [a, b] = probe(d);
    if (!a || !b || a === b) continue;
    doorGraph.get(a)?.add(b);
    doorGraph.get(b)?.add(a);
  }

  /**
   * Wall segments left OPEN, which are not doors.
   *
   * `kinds: { 7: null }` is a hole in the wall, and the designed flat reaches
   * its study through exactly one of these -- the 1 m bay the `dine|study` run
   * leaves at x 7.5. Reading only `DOORS` therefore reported the REFERENCE flat
   * as having a room no doorway reaches, and a ruler that misjudges the
   * reference is in no position to judge anything else. Measured before the
   * fix: designed `door-hops` FAIL, `unreached 1`, while the flat is plainly
   * walkable end to end.
   *
   * A gap is passable, so it belongs in the circulation graph. It is NOT a
   * door, so it must not count towards "the bathroom has exactly one door" --
   * hence two graphs from one measurement pass rather than one blurred one.
   */
  const bayGraph = new Map(rooms.map((r) => [r.id, new Set()]));
  for (const w of layout.WALLS || []) {
    if (!w.kinds) continue;
    if (w.id === 'north' || w.id === 'south' || w.id === 'west' || w.id === 'east') continue;
    for (const [k, kind] of Object.entries(w.kinds)) {
      if (kind !== null) continue;
      // `k` is an ABSOLUTE coordinate index along the wall's own axis, not an
      // offset from `from` -- see js/layout.js's `living|east` note. The
      // doorway it argues for sits at k+0.5.
      const at = Number(k) + 0.5;
      const [a, b] = probe(w.axis === 'x' ? { x: at, z: w.at, r: 0 } : { x: w.at, z: at, r: 90 });
      if (!a || !b || a === b) continue;
      bayGraph.get(a)?.add(b);
      bayGraph.get(b)?.add(a);
    }
  }

  /** Ways through: a door or an open bay. What circulation actually sees. */
  const graph = new Map(rooms.map((r) => [r.id, new Set([
    ...(doorGraph.get(r.id) || []), ...(bayGraph.get(r.id) || []),
  ])]));

  const degree = (id) => (graph.get(id) ? graph.get(id).size : 0);
  const doorCount = (id) => (doorGraph.get(id) ? doorGraph.get(id).size : 0);
  const maxDeg = rooms.reduce((a, r) => Math.max(a, degree(r.id)), 0);
  const hubIds = rooms.filter((r) => degree(r.id) === maxDeg).map((r) => r.id);
  const entryIsHub = !!entry && hubIds.includes(entry);

  /* --- depth from the entry --------------------------------------------- */
  const depth = {};
  if (entry && graph.has(entry)) {
    const q = [[entry, 0]];
    const seen = new Set([entry]);
    while (q.length) {
      const [id, dd] = q.shift();
      depth[id] = dd;
      for (const n of graph.get(id) || []) if (!seen.has(n)) { seen.add(n); q.push([n, dd + 1]); }
    }
  }
  const depths = Object.values(depth);
  const maxDepth = depths.length ? Math.max(...depths) : -1;
  const unreached = rooms.length - depths.length;

  /* --- windows ---------------------------------------------------------- */
  // Read off the perimeter wall runs: `kinds` is keyed by the 1 m segment a
  // window sits in, so the room owning that segment is the room with a window.
  // Nothing is inferred from the picture.
  const windowed = new Set();
  for (const w of layout.WALLS || []) {
    if (!w.kinds) continue;
    if (!(w.id === 'north' || w.id === 'south' || w.id === 'west' || w.id === 'east')) continue;
    for (const [k, kind] of Object.entries(w.kinds)) {
      if (kind !== 'wallWindow') continue;
      const at = Number(k) + 0.5;
      const inside = w.axis === 'x'
        ? { x: at, z: w.at === 0 ? 0.5 : plan.d - 0.5 }
        : { x: w.at === 0 ? 0.5 : plan.w - 0.5, z: at };
      const hit = rooms.find((r) => inRect(r.rect, inside.x, inside.z, 0.45));
      if (hit) windowed.add(hit.id);
    }
  }

  /* --- reachability of the bath without crossing a bedroom -------------- */
  // THE PRECISE FORM OF "the bathroom is not off a bedroom". An ensuite is a
  // normal room; a SHARED flat whose only bathroom is inside a bedroom is not,
  // and the difference is exactly this: can you get there from the front door
  // without walking through somewhere someone sleeps. Bedrooms are therefore
  // reached but never expanded.
  const seenFromPublic = new Set();
  const q = [];
  if (entry) { seenFromPublic.add(entry); q.push(entry); }
  let bathReachable = false;
  while (q.length) {
    const id = q.shift();
    for (const n of graph.get(id) || []) {
      if (baseRole(n) === 'bath') bathReachable = true;
      if (seenFromPublic.has(n)) continue;
      seenFromPublic.add(n);
      if (baseRole(n) === 'bedroom') continue;      // arrive, never pass through
      q.push(n);
    }
  }

  /* --- per-room readings ------------------------------------------------ */
  const perRoom = [];
  for (const room of rooms) {
    const src = (layout.ROOMS || []).find((r) => r.id === room.id);
    const items = (src && src.items) || [];
    const rect = room.rect;
    const exterior = rect.x0 <= EXTERIOR_TOL || rect.z0 <= EXTERIOR_TOL
      || rect.x1 >= plan.w - EXTERIOR_TOL || rect.z1 >= plan.d - EXTERIOR_TOL;
    perRoom.push({
      id: room.id,
      role: baseRole(room.id),
      area: +((rect.x1 - rect.x0) * (rect.z1 - rect.z0)).toFixed(3),
      exterior,
      window: windowed.has(room.id),
      doors: doorCount(room.id),
      through: degree(room.id),
      hops: depth[room.id] == null ? -1 : depth[room.id],
      items: items.length,
      ...compose(items, rect, sizes),
    });
  }
  const sum = (f) => perRoom.reduce((a, r) => a + f(r), 0);
  const byRole = (role) => perRoom.filter((r) => r.role === role);

  const measured = sum((r) => r.measured);
  const groups = sum((r) => r.groups);
  const singletons = sum((r) => r.singletons);
  const areas = perRoom.map((r) => r.area);
  const smallest = areas.length ? Math.min(...areas) : 0;
  const biggest = areas.length ? Math.max(...areas) : 0;

  const readings = {
    plan,
    rooms: perRoom.length,
    perRoom,
    entry,
    entryRole,
    entryDegree: entry ? degree(entry) : -1,
    // The busiest room's degree, stated as a NUMBER as well as a name list.
    // `floorplan.js` publishes its own `maxDegree` in `report.circulation`, and
    // two numbers can be compared; two formatted strings cannot.
    maxDegree: maxDeg,
    entryIsHub,
    hub: hubIds.map(baseRole).join('/'),
    maxDepth,
    unreached,
    bathEnteredFrom: byRole('bath').flatMap((r) => [...(doorGraph.get(r.id) || [])].map(baseRole)),
    bathDoors: byRole('bath').map((r) => doorCount(r.id)),
    bathReachable,
    kitchenDining: adjacent(byRole('kitchen'), byRole('dining'), graph),
    windowlessRooms: perRoom.filter((r) => !r.window).map((r) => r.id),
    exteriorRooms: perRoom.filter((r) => r.exterior).map((r) => r.id),
    totals: {
      items: sum((r) => r.items),
      measured,
      unmeasured: sum((r) => r.unmeasured),
      groups,
      singletons,
      floating: sum((r) => r.floating),
      biggestGroup: perRoom.reduce((a, r) => Math.max(a, r.biggest), 0),
      // The headline composition number: how many pieces it takes to make one
      // arranged group. High = the room reads as a few arrangements; low = a
      // scatter of singles.
      piecesPerGroup: groups ? +(measured / groups).toFixed(2) : 0,
      loneShare: measured ? +(singletons / measured).toFixed(3) : 0,
      smallest: +smallest.toFixed(2),
      biggest: +biggest.toFixed(2),
      sizeRatio: smallest ? +(biggest / smallest).toFixed(2) : 0,
      closets: perRoom.filter((r) => r.area < 1.6).length,
    },
  };

  /* ============================================================== the six */

  /* 1. the entry opens into a shared room -------------------------------- */
  {
    const pass = !!entry && !!entryRole && !PRIVATE_ROLES.has(entryRole);
    add('entry-public', 'the front door opens into a shared room, not a bedroom or a bath', pass,
      entry
        ? `entered into ${entryRole} (${entry})`
        : 'no `doorwayFront` in this layout, so there is no entry to judge');
  }

  /* 2. the entry room is the hub ----------------------------------------- */
  // A legible flat is hall-first: the space you arrive in is the space
  // everything else hangs off. If it is not, circulation runs
  // bedroom -> hall -> bedroom through a room nobody arrives in.
  add('entry-hub', 'the room you enter is a most-connected room (a hall, not a dead end)',
    entryIsHub,
    entry
      ? `entry "${entry}" is a way through to ${readings.entryDegree} room(s); `
        + `the busiest room(s) reach ${maxDeg} (${readings.hub})`
      : 'no entry to judge');

  /* 3. depth ------------------------------------------------------------- */
  {
    const okDepth = maxDepth >= 0 && maxDepth <= MAX_DOOR_HOPS;
    add('door-hops', `every room is within ${MAX_DOOR_HOPS} doorways of the front door`,
      okDepth && unreached === 0,
      `${maxDepth < 0 ? 'entry not on the door graph' : `furthest room is ${maxDepth} hop(s) away`}`
      + (unreached ? `; ${unreached} room(s) not reachable through doors at all` : ''));
  }

  /* 4. the bathroom ------------------------------------------------------ */
  {
    const baths = byRole('bath');
    if (!baths.length) {
      add('bath', 'the bathroom is one private room, reached without crossing a bedroom',
        true, 'no bathroom in this plan (a small flat does not have one)', false);
    } else {
      // A DOOR, not a gap: an open bay into a bathroom is a hole, not a door.
      const bad = baths.filter((r) => doorCount(r.id) !== 1);
      const pass = bad.length === 0 && bathReachable;
      add('bath', 'the bathroom is one private room, reached without crossing a bedroom', pass,
        `${baths.map((r) => `${r.id}: ${doorCount(r.id)} door(s) from `
          + `${[...(doorGraph.get(r.id) || [])].map(baseRole).join('+') || 'nothing'}`).join('; ')}`
        + `; reachable from the entry without passing a bedroom: ${bathReachable ? 'yes' : 'NO'}`);
    }
  }

  /* 5. kitchen and dining share a door ----------------------------------- */
  {
    const kitchens = byRole('kitchen');
    const dinings = byRole('dining');
    if (!kitchens.length || !dinings.length) {
      add('kitchen-dining', 'the kitchen opens onto the dining room', true,
        `not applicable: ${kitchens.length ? 'no dining room' : 'no kitchen'} in this plan`, false);
    } else {
      add('kitchen-dining', 'the kitchen opens onto the dining room',
        readings.kitchenDining,
        `kitchen ${kitchens.map((r) => `${r.id}->[${[...(graph.get(r.id) || [])].map(baseRole).join(',')}]`).join(' ')}`);
    }
  }

  /* 6. bedrooms with an outside wall have a window ------------------------ */
  // The bound is on rooms that CAN have one. A room in the middle of a 24 x 16 m
  // plan has no perimeter to cut, and failing it for that would be failing
  // arithmetic, not design -- so the check names its population out loud and a
  // green reading says how many rooms it was about.
  {
    const beds = byRole('bedroom');
    const outer = beds.filter((r) => r.exterior);
    const dim = outer.filter((r) => !r.window);
    add('bedroom-window', 'every bedroom with an outside wall has a window',
      dim.length === 0,
      `${outer.length} of ${beds.length} bedroom(s) have an outside wall; `
      + (dim.length ? `${dim.length} without a window: ${dim.map((r) => r.id).join(', ')}` : 'all of them have one'));
  }

  return { ready: true, checks, readings };
}

/** Is any room in `as` adjacent through a door to any room in `bs`? */
function adjacent(as, bs, graph) {
  for (const a of as) for (const b of bs) if (graph.get(a.id)?.has(b.id)) return true;
  return false;
}

const inRect = (rect, x, z, pad = 0) => x >= rect.x0 - pad && x <= rect.x1 + pad
                                        && z >= rect.z0 - pad && z <= rect.z1 + pad;
