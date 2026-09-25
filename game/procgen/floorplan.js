/**
 * floorplan.js — a parameterised apartment generator.
 *
 *     in : params { w, d, rooms, items, seed, ... } + ctx { sizes }
 *    out : a LAYOUT, in exactly the schema js/layout.js exports
 *          { WALL_H, PLAN, ZONES, WALLS, CORNERS, DOORS, ROOMS }
 *
 * Nothing here is a new format. The generator is a second *author* of the same
 * document the hand-made apartment is, which is the whole design: everything
 * downstream -- game/arena/fromLayout.js, game/core/nav.js, the viewer, the
 * playable game -- already knows how to read a layout, and none of it has to
 * learn about procedural generation.
 *
 * PORTABILITY CONTRACT (same as game/core/): no three.js, no DOM, no file IO.
 * Measured sizes come in through `ctx`. The only import is the seeded RNG,
 * because "same seed -> same flat" has to hold here as much as anywhere else.
 *
 * ------------------------------------------------------------------ the shape
 *
 * Five stages, each of which can say no:
 *
 *   1. PARTITION  the envelope is split into N rectangles by recursive binary
 *                 splits, always on the 1 m grid, because the kit's wall is a
 *                 1 m segment and a wall at x = 4.37 would need a model that
 *                 does not exist.
 *   2. WALLS      wall runs are DERIVED from the partition, not authored. Two
 *                 rectangles that touch along a line differ on both sides of
 *                 it, and that difference IS the wall. Nothing can drift.
 *   3. DOORS      a spanning tree of the room-adjacency graph -- N-1 doorways
 *                 for N rooms, which is exactly connected and has no cycles.
 *                 Extra doors are then added at a chosen probability, because a
 *                 real flat is not a tree, and a tree means one door seals a
 *                 wing.
 *   4. FURNITURE  the palette is a wish-list; the placer keeps what fits.
 *   5. SEEDS      each room's label/camera seed is chosen from the FREE floor
 *                 left after furniture, not typed in. This is the difference
 *                 between a room that resolves and a room whose seed landed
 *                 inside a wardrobe.
 *
 * ------------------------------------------------------------------ the rule
 *
 * The one thing that must not happen is a room sealed by its own furniture.
 * game/core/regions.js reports that as a loud failure, but a generator that
 * waits to be told is a generator that produces garbage at some seeds and
 * nothing at others. So every placement is checked against a LOCAL free-space
 * flood fill BEFORE it is accepted: an item that would cut a room in two, or
 * wall off a doorway, is rejected on the spot. The global nav is then run at
 * the end as verification, not as the mechanism.
 *
 * The local grid is deliberately STRICTER than nav, not merely similar. It
 * refuses a cell within the walker's radius of the room's usable edge, because
 * nav's own `clear()` does -- so every cell this generator believes is walkable
 * is a cell nav will agree about. A local check that were merely *equivalent*
 * would accept a 5 cm ring around a wall-to-wall wardrobe, and nav would then
 * disagree with it at exactly the seeds where the wardrobe was 1 cm too short.
 */

import { Rng } from '../core/rng.js';
import {
  ROLE_INFO, ROLE_LADDER, COMPACT_MAX_AREA, PALETTES, CLIMB_TOPS, FILLERS, FILLER_HOSTS,
} from './palette.js';

const DEG = Math.PI / 180;

/**
 * How far a wall body may stick into a room.
 *
 * NOT the kit's 0.05 wall thickness. One wall run can carry a plain `wall`
 * (0.05 thick), a `wallWindow` or a `wallDoorway` (0.0891 thick), and every box
 * is centred at `at + side * 0.025`. The thickest therefore reaches
 * 0.025 + 0.0891/2 = 0.0696 past the nominal line, and furniture placed against
 * the nominal line would be inside a door frame. 0.07 is that number rounded up
 * -- one constant instead of a per-segment lookup, because being 0.4 mm loose
 * costs nothing and being 1 mm tight puts a wardrobe inside a wall.
 */
const WALL_INSET = 0.07;

/** The walker whose clearance the local flood fill reserves. */
const PLAYER_RADIUS = 0.12;

/** Nav's own thresholds, mirrored so the local grid agrees with the global one. */
const STEP = 0.26;
const BODY_H = 0.42;

/** Local flood-fill resolution. Finer than nav's 0.05 lattice would be waste. */
const GRID = 0.05;

/**
 * The narrowest slot a walker can use, and the narrowest slot worth having.
 *
 * DERIVED FROM THE WALKER, NOT TUNED. A slot exactly DISC wide is passable in
 * principle and almost never in practice: `nav` asks whether a disc fits at a
 * *cell centre*, so a slot of 2 * 0.12 m offers one exact line through it, and
 * whether a lattice point lands on that line is luck. DISC + two grid steps
 * offers a band of legal centres two cells wide, which is the difference
 * between a channel and a coincidence.
 *
 * Both ends of the interval matter, and the sweep is what established it: 8 of
 * the first 12 generated flats came back with 3..36 walkable cells belonging to
 * no room, every one of them 0.10..0.20 m from the plan edge, and every one a
 * slot of exactly this width -- narrow enough that nothing could get out of it,
 * wide enough that `nav` put a cell in it anyway.
 */
const DISC = 2 * PLAYER_RADIUS;
const SLOT = DISC + 2 * GRID;

/** The climb ceiling: wallH - eyeHeight. Tops above this can hold no packet. */
const CLIMB_CEIL = 1.29 - 0.36;

export const DEFAULTS = {
  w: 10,
  d: 8,
  rooms: 6,
  items: 60,
  seed: 'procgen',
  minRoom: 2.4,        // smallest room edge (m) -- enforced on both sides of a split
  lane: 0.62,          // clear floor reserved in front of each doorway
  gap: 0.02,           // padding between two footprints
  doorMargin: 1,       // keep doorways this far from a room corner, when possible
  loopDoor: 0.28,      // chance of an extra doorway beyond the spanning tree
  maxLoopDoors: 2,
  windowChance: 0.20,
  roomCap: 26,         // hard ceiling on one room's item count
  floorTries: 26,      // rejection-sampling budget for a free-standing item
};

/* ================================================================ geometry */

const rectArea = (r) => (r.x1 - r.x0) * (r.z1 - r.z0);

function sizeOf(sizes, m) {
  if (!sizes) return null;
  const e = sizes.models ? sizes.models[m] : sizes[m];
  return e && e.size ? e.size : null;
}

/** World-frame half extents of a rotated footprint. Mirrors level.js aabbOf. */
function halfExtents(size, deg, scale) {
  const s = scale || 1;
  const hx = (size[0] * s) / 2;
  const hz = (size[2] * s) / 2;
  const c = Math.abs(Math.cos(deg * DEG));
  const n = Math.abs(Math.sin(deg * DEG));
  return { ex: hx * c + hz * n, ez: hx * n + hz * c };
}

const boxAt = (x, z, ex, ez) => ({ x0: x - ex, z0: z - ez, x1: x + ex, z1: z + ez });

const overlapXZ = (a, b, gap) => !(a.x1 + gap <= b.x0 || b.x1 + gap <= a.x0
                                || a.z1 + gap <= b.z0 || b.z1 + gap <= a.z0);

const insideBox = (inner, outer, gap) => inner.x0 >= outer.x0 - gap && inner.x1 <= outer.x1 + gap
                                       && inner.z0 >= outer.z0 - gap && inner.z1 <= outer.z1 + gap;

/**
 * The straight-line gap between two boxes on whichever axis separates them,
 * with the length of the facing edge. `null` when they overlap on both axes.
 *
 * Only the two boxes' nearest faces are measured, so a pair that faces each
 * other over 3 m is reported as a 3 m slot and a pair that merely passes at a
 * diagonal reports no facing span at all -- which is right: a diagonal pair
 * with no shared span is not a corridor, it is two things near a corner.
 */
function slotWidth(a, b) {
  if (a.x1 <= b.x0) return { axis: 'x', gap: b.x0 - a.x1, overlap: Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) };
  if (b.x1 <= a.x0) return { axis: 'x', gap: a.x0 - b.x1, overlap: Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) };
  if (a.z1 <= b.z0) return { axis: 'z', gap: b.z0 - a.z1, overlap: Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) };
  if (b.z1 <= a.z0) return { axis: 'z', gap: a.z0 - b.z1, overlap: Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) };
  return null;
}

/* ============================================================= 1. partition */

/**
 * Where a rectangle may be cut, weighted toward its middle.
 *
 * Every candidate is on an INTEGER line: the kit's wall is a 1 m segment plus a
 * 0.5 m `wallHalf`, so integer cuts keep every generated run free of partial
 * segments -- a whole class of placement bug removed by rounding in the right
 * place. The triangular weight is what stops "recursive bisection" from meaning
 * "a grid of equal boxes": a cut at the centre is most likely, one 2 m off-
 * centre is possible, and the result is a flat of noticeably different room
 * sizes rather than a spreadsheet.
 */
function cutCandidates(leaf, p) {
  const out = [];
  for (const axis of ['x', 'z']) {
    const lo = axis === 'x' ? leaf.x0 : leaf.z0;
    const hi = axis === 'x' ? leaf.x1 : leaf.z1;
    const len = hi - lo;
    if (len < 2 * p.minRoom) continue;
    const centre = (lo + hi) / 2;
    const spread = Math.max(1, (len - 2 * p.minRoom) / 2);
    for (let at = Math.ceil(lo + p.minRoom); at <= Math.floor(hi - p.minRoom); at++) {
      out.push({ axis, at, w: 1 / (0.5 + Math.abs(at - centre) / spread) });
    }
  }
  return out;
}

const applyCut = (leaf, cut) => (cut.axis === 'x'
  ? [{ ...leaf, x1: cut.at }, { ...leaf, x0: cut.at }]
  : [{ ...leaf, z1: cut.at }, { ...leaf, z0: cut.at }]);

/**
 * Split the envelope into N rectangles.
 *
 * RETRIES RATHER THAN BACKTRACKS. Greedy largest-first splitting can paint
 * itself into a corner: at 10 x 8 m with a 2.4 m minimum, some sequences leave
 * only 2.4 x 2.4 m leaves, which cannot be cut again, and the flat comes out
 * with five rooms when six were asked for -- measured, seed "procgen". Back-
 * tracking would fix it and cost a page; re-rolling the PARTITION is cheap
 * (microseconds), bounded (24 tries), and keeps the worst case honest, because
 * the caller still reports "asked for 6, got 5" if every try stalls.
 *
 * The attempts draw from FORKED sub-streams, so how many tries it took cannot
 * shift the draws that furniture placement later spends -- the same isolation
 * rng.js documents for `fork`. Otherwise a one-line change to this loop would
 * silently reshape every wardrobe in every existing seed.
 */
function partition(p, rng) {
  let best = partitionOnce(p, rng.fork('part0'));
  for (let attempt = 1; attempt < 24 && best.length < p.rooms; attempt++) {
    const leaves = partitionOnce(p, rng.fork(`part${attempt}`));
    if (leaves.length > best.length) best = leaves;
  }
  return best;
}

function partitionOnce(p, rng) {
  let leaves = [{ x0: 0, z0: 0, x1: p.w, z1: p.d }];
  let guard = p.rooms * 8;
  while (leaves.length < p.rooms && guard-- > 0) {
    const order = rng.shuffle(leaves).sort((a, b) => rectArea(b) - rectArea(a));
    let split = false;
    for (const leaf of order) {
      const cuts = cutCandidates(leaf, p);
      if (!cuts.length) continue;
      const [a, b] = applyCut(leaf, rng.weighted(cuts));
      leaves = leaves.filter((l) => l !== leaf);
      leaves.push(a, b);
      split = true;
      break;
    }
    if (!split) break;                     // nothing left that can be cut
  }
  return leaves;
}

/* ================================================================= 2. walls */

/**
 * Derive every wall run from the partition.
 *
 * A line is walked one 1 m cell at a time -- the unit of a wall segment. Where
 * the room on one side of the line differs from the room on the other, a wall is
 * needed; contiguous cells needing the same pair become ONE run, so a
 * three-room stack along a line is two runs of exactly the right length rather
 * than one run with holes in it.
 *
 * `side` is fixed at -1 for interior walls: the body falls on the
 * lower-coordinate side. That is a choice, not a fact -- but it is the SAME
 * choice every time, which is what lets the usable-rectangle solver be a
 * four-line rule instead of a per-wall special case.
 */
function deriveWalls(rects, p) {
  const walls = [];
  const edges = [];

  const findAt = (x, z) => rects.findIndex((r) => x >= r.x0 && x < r.x1 && z >= r.z0 && z < r.z1);

  const finish = (run) => {
    const w = {
      id: `${run.a}|${run.b}#${run.axis}${run.at}`,
      axis: run.axis, at: run.at, from: run.from, to: run.to,
      side: -1, kinds: {},
    };
    edges.push({ a: run.a, b: run.b, wall: w, lo: run.from, hi: run.to, len: run.to - run.from });
    return w;
  };

  const walk = (axis, at) => {
    // How far the run extends ALONG its own direction. A run on axis 'x' lies
    // along X, so it spans the plan's WIDTH; a run on axis 'z' spans its DEPTH.
    // Getting this the other way round leaves every wall past x = d unwalled,
    // which reads as "two rooms merged" and looks like a missing-wall bug in the
    // adapter rather than an off-by-one-axis here.
    const along = axis === 'x' ? p.w : p.d;
    let run = null;
    for (let c = 0; c < along; c++) {
      const mid = c + 0.5;
      const a0 = axis === 'x' ? findAt(mid, at - 0.5) : findAt(at - 0.5, mid);
      const b0 = axis === 'x' ? findAt(mid, at + 0.5) : findAt(at + 0.5, mid);
      const need = a0 >= 0 && b0 >= 0 && a0 !== b0;
      const lo = Math.min(a0, b0);
      const hi = Math.max(a0, b0);
      if (run && need && run.a === lo && run.b === hi) { run.to = c + 1; continue; }
      if (run) walls.push(finish(run));
      run = need ? { axis, at, a: lo, b: hi, from: c, to: c + 1 } : null;
    }
    if (run) walls.push(finish(run));
  };

  for (let x = 1; x < p.w; x++) walk('z', x);
  for (let z = 1; z < p.d; z++) walk('x', z);

  // Perimeter. `side` points OUTWARD here, so the body never eats floor.
  const perimeter = {
    north: { id: 'north', axis: 'x', at: 0, from: 0, to: p.w, side: -1, kinds: {} },
    south: { id: 'south', axis: 'x', at: p.d, from: 0, to: p.w, side: 1, kinds: {} },
    west: { id: 'west', axis: 'z', at: 0, from: 0, to: p.d, side: -1, kinds: {} },
    east: { id: 'east', axis: 'z', at: p.w, from: 0, to: p.d, side: 1, kinds: {} },
  };
  walls.push(perimeter.north, perimeter.south, perimeter.west, perimeter.east);
  return { walls, edges, perimeter };
}

/** Does a wall body fall on this room's side of its own edge? */
function bodyFacesIn(walls, axis, at, along, room) {
  for (const w of walls) {
    if (w.axis !== axis || w.at !== at) continue;
    if (along < w.from || along > w.to) continue;
    const inward = axis === 'z' ? (room.x0 === at ? 1 : -1) : (room.z0 === at ? 1 : -1);
    if (w.side === inward) return true;
  }
  return false;
}

/**
 * The rectangle a room's furniture may actually use: the nominal rectangle minus
 * any wall body that pokes into it. Derived, never typed -- which is why moving
 * a wall moves the furniture's allowed area with it, and why a generated layout
 * needs none of the "remember to offset by 0.05 below the spine wall" comments
 * the hand-made one carries.
 */
function usableRect(room, walls) {
  const U = { ...room };
  if (bodyFacesIn(walls, 'z', room.x0, (room.z0 + room.z1) / 2, room)) U.x0 += WALL_INSET;
  if (bodyFacesIn(walls, 'z', room.x1, (room.z0 + room.z1) / 2, room)) U.x1 -= WALL_INSET;
  if (bodyFacesIn(walls, 'x', room.z0, (room.x0 + room.x1) / 2, room)) U.z0 += WALL_INSET;
  if (bodyFacesIn(walls, 'x', room.z1, (room.x0 + room.x1) / 2, room)) U.z1 -= WALL_INSET;
  return U;
}

/* ================================================================= 3. doors */

class UnionFind {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(a) { while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]]; a = this.p[a]; } return a; }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    this.p[ra] = rb;
    return true;
  }
}

const wallRot = (side) => (side === 'north' ? 0 : side === 'south' ? 180 : side === 'west' ? -90 : 90);

/**
 * Cut a doorway into a wall run, and return the leaf that sits in it.
 *
 * The leaf's rotation is fixed by the run's axis and nothing else: a run along X
 * needs the leaf's width across X (r = 0), a run along Z needs it across Z
 * (r = 90). The frame is placed from the same arithmetic that cut the hole,
 * which is why the hand-made layout's own warning -- a doorway "argued for at
 * z 6.5, which is a plain solid wall" -- cannot happen here.
 */
function makeDoor(run, roomIdx, k, model, note) {
  run.kinds[k] = 'wallDoorway';
  const face = run.at + run.side * 0.025;
  const door = run.axis === 'x'
    ? { m: model, x: k + 0.5, z: face, r: 0 }
    : { m: model, x: face, z: k + 0.5, r: 90 };
  if (note) door.note = note;
  return { door, meta: { axis: run.axis, at: run.at, k, rooms: roomIdx } };
}

/**
 * Which doorways exist: a spanning tree first, then a few loops.
 *
 * Strongest-adjacency-first, which is the building equivalent of a sensible
 * floor plan: rooms connect through their WIDEST shared wall, so circulation
 * runs between the rooms that actually touch a lot, and the 0.5 m sliver where
 * two rooms merely graze becomes a solid wall.
 */
function chooseDoors(rects, roles, edges, perimeter, p, rng, trace) {
  const list = [];
  const meta = [];

  const sorted = rng.shuffle(edges.slice()).sort((a, b) => b.len - a.len);
  const uf = new UnionFind(rects.length);
  const tree = [];
  const loops = [];
  for (const e of sorted) (uf.union(e.a, e.b) ? tree : loops).push(e);

  const pickSeg = (e) => {
    let lo = e.lo;
    let hi = e.hi - 1;
    if (hi - lo >= 2 * p.doorMargin) { lo += p.doorMargin; hi -= p.doorMargin; }
    if (hi < lo) { lo = e.lo; hi = e.hi - 1; }
    return lo + rng.int(hi - lo + 1);
  };

  for (const e of tree) {
    const made = makeDoor(e.wall, [e.a, e.b], pickSeg(e), 'doorwayOpen', `${roles[e.a]}-${roles[e.b]}`);
    list.push(made.door);
    meta.push(made.meta);
  }

  let extra = 0;
  for (const e of loops) {
    if (extra >= p.maxLoopDoors) break;
    if (!rng.chance(p.loopDoor)) continue;
    const made = makeDoor(e.wall, [e.a, e.b], pickSeg(e), 'doorwayOpen', `${roles[e.a]}=${roles[e.b]}`);
    list.push(made.door);
    meta.push(made.meta);
    extra += 1;
  }

  // The way in: the south perimeter, so the spawn is derivable from geometry
  // rather than from a remembered coordinate. Kept off the corners.
  const k = 1 + rng.int(Math.max(1, p.w - 2));
  const host = rects.findIndex((r) => r.z1 === p.d && k + 0.5 >= r.x0 && k + 0.5 < r.x1);
  const entry = makeDoor(perimeter.south, host >= 0 ? [host] : [], k, 'doorwayFront', '入户门');
  list.push(entry.door);
  meta.push(entry.meta);
  trace.push(`front door on the south wall at x ${k}..${k + 1}`);

  // Windows: perimeter segments with no doorway, never beside the entrance.
  for (const run of Object.values(perimeter)) {
    for (let i = run.from; i < run.to; i++) {
      if (Object.prototype.hasOwnProperty.call(run.kinds, i)) continue;
      if (run === perimeter.south && Math.abs(i - k) < 2) continue;
      if (rng.chance(p.windowChance)) run.kinds[i] = 'wallWindow';
    }
  }

  return { doors: list, meta, trees: tree.length, loops: extra };
}

/**
 * The no-place zone a room needs for one of its doors: a rectangle just inside.
 *
 * `deep` is the corridor the player crosses on the way in. Keeping it empty is
 * what stops a wardrobe being placed two centimetres behind a doorway and
 * turning a 0.44 m opening into an unreachable one.
 */
function doorLane(door, meta, roomIndex, U, deep) {
  if (!meta.rooms.includes(roomIndex)) return null;
  const lo = meta.k;
  const hi = meta.k + 1;
  if (meta.axis === 'z') {
    if (Math.abs(U.x0 - meta.at) < 0.25) return { x0: U.x0, x1: U.x0 + deep, z0: lo, z1: hi };
    if (Math.abs(U.x1 - meta.at) < 0.25) return { x0: U.x1 - deep, x1: U.x1, z0: lo, z1: hi };
  } else {
    if (Math.abs(U.z0 - meta.at) < 0.25) return { x0: lo, x1: hi, z0: U.z0, z1: U.z0 + deep };
    if (Math.abs(U.z1 - meta.at) < 0.25) return { x0: lo, x1: hi, z0: U.z1 - deep, z1: U.z1 };
  }
  return null;
}

/* ================================================================= 4. roles */

/**
 * Hand out roles: the big rooms take the big roles, the small ones the bath.
 *
 * The bath exception matters more than it looks. A 4 m2 room is the only room a
 * bath fits, and it is also the only role that stops the flat being five
 * bedrooms and a corridor. Without it, six rooms on a 10 x 8 envelope produced
 * six bedrooms, every time.
 */
function assignRoles(rects, p, rng) {
  const order = rects.map((r, i) => ({ i, area: rectArea(r) })).sort((a, b) => b.area - a.area);
  const used = new Set();
  const roles = new Array(rects.length);
  const counts = {};
  let extra = 0;

  for (const { i, area } of order) {
    let role = null;
    if (area <= COMPACT_MAX_AREA && !used.has('bath') && rects.length >= 3) role = 'bath';
    if (!role) role = ROLE_LADDER.find((c) => !used.has(c));
    if (!role) {
      // More rooms than roles. Repeat the residential ones -- a big building
      // does -- but never living or kitchen: two kitchens in one flat is a bug
      // a player would notice.
      const repeats = ['bedroom', 'study', 'dining'];
      role = repeats[extra++ % repeats.length];
    }
    used.add(role);
    counts[role] = (counts[role] || 0) + 1;
    roles[i] = role;
  }
  return { roles, counts };
}

/* ====================================================== local free-space grid */

/**
 * A room's free floor on a 0.05 m lattice, with the walker's radius reserved.
 *
 * This answers exactly one question, cheaply and before the fact: "if I put this
 * here, can you still get from the doorway to the rest of the room?" Answering
 * it afterwards with game/core/nav.js would work and would be the wrong shape --
 * the generator would place an item, discover the room is sealed, and have to
 * guess which item to take back out.
 *
 * THE FREE SET IS A SUPERSET OF NAV'S, AND THE CHECK IS THE STRICT HALF.
 *
 * This class used to refuse a border band -- cells within 0.15 m of the usable
 * rect edge were marked permanently blocked -- and the reasoning looked sound:
 * "a 5 cm strip along a wall is not real floor, so refusing it makes this grid
 * STRICTER than nav, and strictness is safe."
 *
 * It is safe about STANDABILITY and exactly backwards about CONNECTIVITY. A
 * cell `blocked()` rejects is never flooded and never asked about, so a pocket
 * of real, standable floor that happens to lie in the band is invisible to the
 * very proof this class exists to run: the grid says "everything free is
 * reachable" while nav says "there is a sealed strip". Measured on three of
 * twelve generated flats -- sealed strips of 0.060, 0.065, 0.075, 0.143 and
 * 0.275 m2 hugging their own walls, 57 cells at x=0.2 in a 6x6 and 110 cells at
 * x=0.3 in an 11x7 -- every one of them passed this grid, and
 * `rejected.sealed` never incremented once because nothing ever asked.
 * Strictness about one property does not buy strictness about the other.
 *
 * So the two halves are now split by direction. The free set is every cell not
 * covered by furniture -- a superset of what nav will walk, so it cannot miss a
 * space nav can stand in. And `take()` asks the strict question instead: after
 * adding this item, is EVERY free cell still reachable from the doorway?
 */
class RoomSpace {
  constructor(U) {
    this.U = U;
    this.cell = GRID;
    this.w = Math.max(1, Math.ceil((U.x1 - U.x0) / GRID));
    this.d = Math.max(1, Math.ceil((U.z1 - U.z0) / GRID));
    this.count = new Int32Array(this.w * this.d);
    /** Cells whose `count` is > 0, maintained on every 0->1 and 1->0 flip so
     *  "is every free cell reachable?" costs one comparison, not a grid scan. */
    this.blockedCells = 0;
  }

  i(x) { return Math.floor((x - this.U.x0) / this.cell); }
  j(z) { return Math.floor((z - this.U.z0) / this.cell); }
  cx(i) { return this.U.x0 + (i + 0.5) * this.cell; }
  cz(j) { return this.U.z0 + (j + 0.5) * this.cell; }

  blocked(k) {
    return this.count[k] > 0;
  }

  /** Free cells in the lattice: the whole grid minus whatever furniture covers. */
  freeCount() {
    return this.w * this.d - this.blockedCells;
  }

  /** Cells an inflated footprint touches. Returns null when it misses entirely. */
  span(a) {
    if (a.x1 + PLAYER_RADIUS < this.U.x0 || a.x0 - PLAYER_RADIUS > this.U.x1) return null;
    if (a.z1 + PLAYER_RADIUS < this.U.z0 || a.z0 - PLAYER_RADIUS > this.U.z1) return null;
    return {
      i0: Math.max(0, this.i(a.x0 - PLAYER_RADIUS)),
      i1: Math.min(this.w - 1, this.i(a.x1 + PLAYER_RADIUS)),
      j0: Math.max(0, this.j(a.z0 - PLAYER_RADIUS)),
      j1: Math.min(this.d - 1, this.j(a.z1 + PLAYER_RADIUS)),
    };
  }

  mark(a, delta) {
    const s = this.span(a);
    if (!s) return;
    for (let j = s.j0; j <= s.j1; j++) {
      for (let i = s.i0; i <= s.i1; i++) {
        const k = j * this.w + i;
        const before = this.count[k];
        const after = before + delta;
        this.count[k] = after;
        if (before === 0 && after > 0) this.blockedCells += 1;
        else if (before > 0 && after === 0) this.blockedCells -= 1;
      }
    }
  }

  /**
   * Every free cell reachable from (i0, j0).
   *
   * Returns `{ seen, count }` rather than the bare bitmap: `count` is the number
   * of cells reached, which is what lets the caller ask "did I reach ALL the
   * free floor?" without walking the grid again. The one call site is `take()`.
   */
  flood(i0, j0) {
    const seen = new Uint8Array(this.w * this.d);
    let count = 0;
    const start = j0 * this.w + i0;
    if (i0 < 0 || j0 < 0 || i0 >= this.w || j0 >= this.d || this.blocked(start)) return { seen, count };
    const stack = [start];
    seen[start] = 1;
    count = 1;
    while (stack.length) {
      const k = stack.pop();
      const i = k % this.w;
      const j = (k - i) / this.w;
      const push = (n) => {
        if (seen[n] || this.blocked(n)) return;
        seen[n] = 1;
        count += 1;
        stack.push(n);
      };
      if (i > 0) push(k - 1);
      if (i < this.w - 1) push(k + 1);
      if (j > 0) push(k - this.w);
      if (j < this.d - 1) push(k + this.w);
    }
    return { seen, count };
  }

  /** The walkable cell nearest a world point, or null. */
  cellNear(x, z) {
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < this.d; j++) {
      for (let i = 0; i < this.w; i++) {
        const k = j * this.w + i;
        if (this.blocked(k)) continue;
        const dx = this.cx(i) - x;
        const dz = this.cz(j) - z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = k; }
      }
    }
    return best < 0 ? null : { i: best % this.w, j: (best - best % this.w) / this.w, d: Math.sqrt(bestD) };
  }

  freeArea() {
    let n = 0;
    for (let k = 0; k < this.count.length; k++) if (!this.blocked(k)) n++;
    return n * this.cell * this.cell;
  }
}

/* ============================================================= 5. furniture */

/** Does an item block navigation? Exactly nav's own rule, or the two disagree. */
function blocksNav(it) {
  return it.y + it.size[1] * it.s > STEP && it.y < BODY_H;
}

const flatUntil = (it) => it.y + it.size[1] * it.s <= 0.02;

function freeIntervals(occupied, lo, hi) {
  const sorted = occupied.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  let cur = lo;
  for (const [a, b] of sorted) {
    if (a > cur) out.push([cur, Math.min(a, hi)]);
    cur = Math.max(cur, b);
  }
  if (cur < hi) out.push([cur, hi]);
  return out.filter(([a, b]) => b - a > 1e-6);
}

const wallAlongHalf = (side, ex, ez) => (side === 'north' || side === 'south' ? ex : ez);
const wallSpan = (side, U) => (side === 'north' || side === 'south' ? [U.x0, U.x1] : [U.z0, U.z1]);

function wallPlace(side, U, along, ex, ez) {
  if (side === 'north') return { x: along, z: U.z0 + ez };
  if (side === 'south') return { x: along, z: U.z1 - ez };
  if (side === 'west') return { x: U.x0 + ex, z: along };
  return { x: U.x1 - ex, z: along };                       // east
}

const cornerDist = (cand, U) => Math.min(
  Math.hypot(cand.x - U.x0, cand.z - U.z0), Math.hypot(cand.x - U.x1, cand.z - U.z0),
  Math.hypot(cand.x - U.x0, cand.z - U.z1), Math.hypot(cand.x - U.x1, cand.z - U.z1));

/**
 * Place one room's furniture, keeping whatever fits.
 *
 * Order is the palette's order and it is load-bearing: rugs before the things
 * that stand on them, hosts before their clutter, structure before decoration.
 * Every accepted item is registered in three places at once -- the room's item
 * list, the room's footprint list, and (when it blocks) the local free space --
 * so those three cannot disagree.
 */
function placeRoom(role, U, lanes, p, rng, sizeOfBound, quota, state) {
  const list = PALETTES[role] || PALETTES.bedroom;
  const items = [];
  const placed = [];
  const occupied = { north: [], south: [], west: [], east: [] };
  const space = new RoomSpace(U);
  const anchors = lanes
    .map((L) => ({ i: space.i((L.x0 + L.x1) / 2), j: space.j((L.z0 + L.z1) / 2) }))
    .filter((a) => !space.blocked(a.j * space.w + a.i));

  const rejected = { overlap: 0, outside: 0, lane: 0, slot: 0, sealed: 0, noHost: 0, noModel: 0, budget: 0, seed: 0 };
  let filled = 0;

  /**
   * The slot this candidate would leave, if it would leave one too narrow to
   * use. Only BLOCKING boxes are asked -- a rug or a wall mirror changes the
   * picture and not the floor, so nothing can be sealed behind one -- and the
   * four room walls are asked as boxes, which is the other half of the pair
   * that a slot always has.
   */
  const walls = [
    { box: { x0: U.x0 - 1, x1: U.x0, z0: U.z0 - 1, z1: U.z1 + 1 } },
    { box: { x0: U.x1, x1: U.x1 + 1, z0: U.z0 - 1, z1: U.z1 + 1 } },
    { box: { x0: U.x0 - 1, x1: U.x1 + 1, z0: U.z0 - 1, z1: U.z0 } },
    { box: { x0: U.x0 - 1, x1: U.x1 + 1, z0: U.z1, z1: U.z1 + 1 } },
  ];
  const deadSlot = (cand) => {
    const others = walls.concat(placed.filter(blocksNav));
    for (const o of others) {
      const s = slotWidth(cand.box, o.box);
      if (!s || s.overlap <= 0) continue;
      if (s.gap > p.gap && s.gap < SLOT) return 'slot';
    }
    return null;
  };

  /**
   * A reason string if this candidate may not go here, else null.
   *
   * THE ORDER IS A COST DECISION, not a style one. `deadSlot` is the only test
   * that walks every blocker, and it is asked LAST, after overlap and lane have
   * thrown out the overwhelming majority of lattice candidates -- which is what
   * keeps a free-standing search over 2300 positions affordable.
   */
  const whyBad = (cand) => {
    if (!insideBox(cand.box, U, 1e-6)) return 'outside';
    for (const q of lanes) if (overlapXZ(cand.box, q, p.gap)) return 'lane';
    for (const o of placed) {
      if (!overlapXZ(cand.box, o.box, p.gap)) continue;
      const aFlat = flatUntil(cand);
      const bFlat = flatUntil(o);
      if (aFlat && bFlat) return 'overlap';        // two rugs may not stack
      if (aFlat || bFlat) continue;                // a rug under a sofa is correct
      const aTop = cand.y + cand.size[1] * cand.s;
      const bTop = o.y + o.size[1] * o.s;
      if (cand.y < bTop + 0.01 && o.y < aTop + 0.01) return 'overlap';
    }
    return deadSlot(cand);
  };

  /**
   * Tentatively take it: reserve the floor, then prove the room is STILL ONE
   * PIECE -- in the strict sense, that every free cell is reachable, not merely
   * that the doorways are. See the class comment: asking only about the anchors
   * is what let three generated flats ship a sealed strip of real floor, and
   * `rejected.sealed` stayed at zero the whole time.
   */
  const take = (cand) => {
    if (!cand.blocks) return true;
    space.mark(cand.box, +1);
    const start = anchors.length
      ? anchors[0]
      : space.cellNear((U.x0 + U.x1) / 2, (U.z0 + U.z1) / 2);
    if (!start) { space.mark(cand.box, -1); return false; }
    const { seen, count } = space.flood(start.i, start.j);
    let bad = !seen[start.j * space.w + start.i];
    if (!bad) for (const a of anchors) if (!seen[a.j * space.w + a.i]) { bad = true; break; }
    // The strict half, and it is one comparison rather than a grid scan: the
    // flood reached fewer cells than the lattice has free, so something free is
    // walled off from the doorway.
    if (!bad && count < space.freeCount()) bad = true;
    if (bad) { space.mark(cand.box, -1); return false; }
    return true;
  };

  const commit = (cand, kind, host) => {
    const it = {
      m: cand.m, x: +cand.x.toFixed(4), z: +cand.z.toFixed(4), r: +cand.r.toFixed(2),
      y: +cand.y.toFixed(4), s: cand.s, size: cand.size,
      box: cand.box, ex: cand.ex, ez: cand.ez, kind, host: host || null, side: cand.side,
    };
    it.alongLo = (cand.side === 'north' || cand.side === 'south' ? it.x : it.z) - cand.alongHalf;
    it.alongHi = it.alongLo + cand.alongHalf * 2;
    items.push(it);
    placed.push(it);
    if (cand.side) occupied[cand.side].push([it.alongLo, it.alongHi]);
    filled += 1;
    // The global budget is spent HERE rather than by the caller afterwards, so
    // that a room's own filler pass sees an honest remaining count instead of
    // one that still includes everything this room has already used.
    state.placed += 1;
    state.models[cand.m] = (state.models[cand.m] || 0) + 1;
    return it;
  };

  const candidate = (m, x, z, r, y, s, side) => {
    const size = sizeOfBound(m);
    if (!size) { rejected.noModel += 1; return null; }
    const sc = s || 1;
    const { ex, ez } = halfExtents(size, r, sc);
    return {
      m, x, z, r, y: y || 0, s: sc, size, ex, ez, side: side || null,
      box: boxAt(x, z, ex, ez),
      alongHalf: wallAlongHalf(side, ex, ez),
      blocks: blocksNav({ y: y || 0, size, s: sc }),
    };
  };

  const tooMany = () => filled >= Math.min(quota, p.roomCap, state.remaining());

  /* ------------------------------------------------------------- placers */

  const tryWall = (m, s, only) => {
    const size = sizeOfBound(m);
    if (!size) { rejected.noModel += 1; return null; }
    const sc = s || 1;
    const sides = only ? [only] : ['north', 'south', 'west', 'east'];
    const options = [];
    for (const side of sides) {
      const [lo, hi] = wallSpan(side, U);
      const { ex, ez } = halfExtents(size, wallRot(side), sc);
      const half = wallAlongHalf(side, ex, ez);
      for (const [a, b] of freeIntervals(occupied[side], lo, hi)) {
        if (b - a < half * 2 + p.gap * 2) continue;
        options.push({ side, a: a + half + p.gap, b: b - half - p.gap, ex, ez, w: b - a });
      }
    }
    if (!options.length) { rejected.outside += 1; return null; }
    options.sort((x, y) => y.w - x.w);

    for (const o of options) {
      for (let t = 0; t < 6; t++) {
        const along = o.a + (o.b - o.a) * (t === 0 ? 0.5 : rng.next());
        const pos = wallPlace(o.side, U, along, o.ex, o.ez);
        const cand = candidate(m, pos.x, pos.z, wallRot(o.side), 0, sc, o.side);
        if (!cand) return null;
        const why = whyBad(cand);
        if (why) { rejected[why] += 1; continue; }
        if (!take(cand)) { rejected.sealed += 1; continue; }
        return commit(cand, 'wall', null);
      }
    }
    return null;
  };

  const trySurface = (m, s, hosts) => {
    const size = sizeOfBound(m);
    if (!size) { rejected.noModel += 1; return null; }
    const sc = s || 1;
    const pool = placed.filter((o) => hosts.includes(o.m));
    if (!pool.length) { rejected.noHost += 1; return null; }
    pool.sort((a, b) => (b.ex * b.ez) - (a.ex * a.ez));

    for (const host of pool) {
      const top = host.y + host.size[1] * host.s;
      for (let t = 0; t < 8; t++) {
        const r = t === 0 ? host.r : [0, 90, 180, 270][rng.int(4)];
        const { ex, ez } = halfExtents(size, r, sc);
        if (ex > host.ex + 0.005 || ez > host.ez + 0.005) continue;
        const slackX = Math.max(0, host.ex - ex) * 0.7;
        const slackZ = Math.max(0, host.ez - ez) * 0.7;
        const cand = candidate(m,
          host.x + (rng.next() * 2 - 1) * slackX,
          host.z + (rng.next() * 2 - 1) * slackZ, r, top, sc, null);
        if (!cand) return null;
        const why = whyBad(cand);
        if (why) { rejected[why] += 1; continue; }
        if (!take(cand)) { rejected.sealed += 1; continue; }
        return commit(cand, 'surface', host.m);
      }
    }
    return null;
  };

  /**
   * Free-standing, chosen from a bounded lattice of legal positions.
   *
   * NOT blind rejection sampling. Twenty-six random points in a 14 x 10 m room
   * mostly land on top of the thing placed two items ago, which is why the first
   * version of this placed 83 of the 130 items it was asked for and blamed the
   * envelope. A lattice is bounded (at most 24 x 24 positions per orientation)
   * and its hit rate is set by how full the room actually is, not by luck, so
   * "I ran out of floor" becomes a measurement rather than a coincidence.
   *
   * The lattice is jittered within one cell, so two seeds do not produce the
   * same furniture on the same 25 cm marks -- but the jitter is applied BEFORE
   * the legality test, so a jittered position that no longer fits is simply not
   * a candidate.
   */
  const tryFloor = (m, s, mode) => {
    const size = sizeOfBound(m);
    if (!size) { rejected.noModel += 1; return null; }
    const sc = s || 1;
    const angles = mode === 'rug' ? [0, 90] : [0, 90, 180, 270];
    const spots = [];

    for (const r of angles) {
      const { ex, ez } = halfExtents(size, r, sc);
      const spanX = U.x1 - U.x0 - ex * 2 - p.gap * 2;
      const spanZ = U.z1 - U.z0 - ez * 2 - p.gap * 2;
      if (spanX < 0 || spanZ < 0) continue;
      const nx = Math.max(1, Math.min(24, Math.round(spanX / 0.25) + 1));
      const nz = Math.max(1, Math.min(24, Math.round(spanZ / 0.25) + 1));
      const dx = nx > 1 ? spanX / (nx - 1) : 0;
      const dz = nz > 1 ? spanZ / (nz - 1) : 0;
      for (let a = 0; a < nx; a++) {
        for (let b = 0; b < nz; b++) {
          const x = U.x0 + ex + p.gap + (nx === 1 ? spanX / 2 : a * dx) + (rng.next() - 0.5) * dx * 0.5;
          const z = U.z0 + ez + p.gap + (nz === 1 ? spanZ / 2 : b * dz) + (rng.next() - 0.5) * dz * 0.5;
          const cand = candidate(m, x, z, r, 0, sc, null);
          if (!cand) return null;
          if (whyBad(cand)) continue;
          spots.push(cand);
        }
      }
    }
    if (!spots.length) { rejected.outside += 1; return null; }

    // Prefer the corners for a corner item, but keep the connectivity proof in
    // the loop either way: `take` is what refuses a sofa that would cut the room
    // in two, and a shortlist that skipped it would accept exactly the placement
    // this generator exists to avoid.
    const pool = mode === 'corner'
      ? rng.shuffle(spots.slice().sort((a, b) => cornerDist(a, U) - cornerDist(b, U)).slice(0, 8))
      : rng.shuffle(spots);
    for (const cand of pool) {
      if (!take(cand)) { rejected.sealed += 1; continue; }
      return commit(cand, mode === 'rug' ? 'rug' : mode === 'corner' ? 'corner' : 'floor', null);
    }
    rejected.sealed += 1;
    return null;
  };

  const tryMounted = (m, s, y) => {
    const size = sizeOfBound(m);
    if (!size) { rejected.noModel += 1; return null; }
    const sc = s || 1;
    const sides = rng.shuffle(['north', 'south', 'west', 'east']);
    for (const side of sides) {
      const [lo, hi] = wallSpan(side, U);
      const { ex, ez } = halfExtents(size, wallRot(side), sc);
      const half = wallAlongHalf(side, ex, ez);
      for (const [a, b] of freeIntervals(occupied[side], lo, hi)) {
        if (b - a < half * 2 + 0.05) continue;
        const along = a + half + (b - a - half * 2) * rng.next();
        const pos = wallPlace(side, U, along, ex, ez);
        const cand = candidate(m, pos.x, pos.z, wallRot(side), y, sc, null);
        if (!cand) return null;
        const why = whyBad(cand);
        if (why) { rejected[why] += 1; continue; }
        if (!take(cand)) { rejected.sealed += 1; continue; }
        return commit(cand, 'mounted', null);
      }
    }
    rejected.outside += 1;
    return null;
  };

  const tryRing = (m, s, of, count) => {
    const size = sizeOfBound(m);
    if (!size) { rejected.noModel += 1; return null; }
    const sc = s || 1;
    const host = placed.find((o) => of.includes(o.m));
    if (!host) { rejected.noHost += 1; return null; }
    const n = count[0] + rng.int(count[1] - count[0] + 1);
    const base = rng.next() * Math.PI * 2;
    let made = 0;
    for (let i = 0; i < n; i++) {
      const a = base + (i / n) * Math.PI * 2;
      for (const rad of [Math.max(host.ex, host.ez) + 0.16, Math.max(host.ex, host.ez) + 0.32]) {
        const x = host.x + Math.cos(a) * rad;
        const z = host.z + Math.sin(a) * rad;
        // Face the table: level.js maps local +Z to (-sin t, cos t).
        const deg = +(Math.atan2(-(host.x - x), host.z - z) * 180 / Math.PI).toFixed(2);
        const cand = candidate(m, x, z, deg, 0, sc, null);
        if (!cand) return null;
        const why = whyBad(cand);
        if (why) { rejected[why] += 1; continue; }
        if (!take(cand)) { rejected.sealed += 1; continue; }
        commit(cand, 'ring', host.m);
        made += 1;
        break;
      }
    }
    return made || null;
  };

  /**
   * A counter run: base cabinets butted end to end along the longest free wall,
   * the upper cabinets above them, the extractor over the stove, the small
   * appliances on the worktop.
   *
   * The one placement that is not per-item, because a kitchen is read as a RUN.
   * Eight cabinets scattered at random angles is the single most obvious tell
   * that a layout was generated, and no amount of tuning the other five roles
   * hides it.
   */
  const tryCounter = (spec) => {
    let best = null;
    for (const side of ['north', 'south', 'west', 'east']) {
      const [lo, hi] = wallSpan(side, U);
      for (const [a, b] of freeIntervals(occupied[side], lo, hi)) {
        if (!best || b - a > best.b - best.a) best = { side, a, b };
      }
    }
    if (!best || best.b - best.a < 1.0) { rejected.outside += 1; return null; }

    const r = wallRot(best.side);
    const laid = [];
    let cursor = best.a + 0.5;
    for (const m of spec.sequence) {
      const size = sizeOfBound(m);
      if (!size) continue;
      const { ex, ez } = halfExtents(size, r, 1);
      const half = wallAlongHalf(best.side, ex, ez);
      const centre = cursor + half;
      if (centre + half > best.b) break;
      const pos = wallPlace(best.side, U, centre, ex, ez);
      const cand = candidate(m, pos.x, pos.z, r, 0, 1, best.side);
      if (!cand) break;
      const why = whyBad(cand);
      if (why) { rejected[why] += 1; cursor = centre + half; continue; }
      if (!take(cand)) { rejected.sealed += 1; break; }
      laid.push(commit(cand, 'counter', null));
      cursor = centre + half;
    }
    if (!laid.length) return null;

    // Uppers: same corner, same direction, at head height. They MAY share a
    // footprint with the base cabinets -- their y0 is above the walker's head,
    // so nav ignores them -- which is what the engine's own `topIsClear` note
    // anticipates, and what the hand-made kitchen does deliberately.
    let up = best.a + 0.5;
    for (const m of spec.upper || []) {
      const size = sizeOfBound(m);
      if (!size) continue;
      const { ex, ez } = halfExtents(size, r, 1);
      const half = wallAlongHalf(best.side, ex, ez);
      const centre = up + half;
      if (centre + half > best.b) break;
      const pos = wallPlace(best.side, U, centre, ex, ez);
      const cand = candidate(m, pos.x, pos.z, r, spec.upperY, 1, null);
      up = centre + half;
      if (!cand || whyBad(cand) || !take(cand)) continue;
      // Wait: the upper must be above the run, so it shares the wall span with
      // the base. Registering it in `occupied` would block the wall for later
      // items, so commit() is called with side null (see candidate).
      commit(cand, 'upper', null);
    }

    if (spec.hoodOver && spec.hood) {
      const stove = laid.find((it) => it.m === spec.hoodOver);
      const size = stove ? sizeOfBound(spec.hood) : null;
      if (stove && size) {
        const cand = candidate(spec.hood, stove.x, stove.z, stove.r, spec.upperY, 1, null);
        if (cand && !whyBad(cand) && take(cand)) commit(cand, 'hood', null);
      }
    }

    let clutter = 0;
    for (const m of spec.surface || []) {
      if (clutter >= 3) break;
      if (trySurface(m, 1, spec.sequence)) clutter += 1;
    }
    return laid;
  };

  /* ------------------------------------------------------------ the walk */
  const wants = Array.isArray(list) ? list : [];
  for (const entry of wants) {
    if (tooMany()) { rejected.budget += 1; break; }
    if (entry.prob != null && !rng.chance(entry.prob)) continue;
    for (let n = 0; n < (entry.repeat || 1); n++) {
      if (tooMany()) break;
      const m = Array.isArray(entry.m) ? rng.pick(entry.m) : entry.m;
      if (entry.where === 'counter') tryCounter(entry);
      else if (entry.where === 'ring') tryRing(m, entry.s, entry.of, entry.count || [2, 3]);
      else if (entry.where === 'surface') trySurface(m, entry.s, entry.on);
      else if (entry.where === 'mounted') tryMounted(m, entry.s, entry.y);
      else if (entry.where === 'ceiling') {
        const size = sizeOfBound(m);
        if (!size) { rejected.noModel += 1; continue; }
        const cand = candidate(m, (U.x0 + U.x1) / 2, (U.z0 + U.z1) / 2, 0, entry.y || 1.1, entry.s, null);
        if (cand) commit(cand, 'ceiling', null);
      } else if (entry.where === 'rug') tryFloor(m, entry.s, 'rug');
      else if (entry.where === 'corner') tryFloor(m, entry.s, 'corner');
      else if (entry.where === 'floor') tryFloor(m, entry.s, 'floor');
      else {
        const it = tryWall(m, entry.s, entry.side && entry.side !== 'any' ? entry.side : null);
        if (!it && entry.near) {
          // Bedside table: sit it beside the bed, on the bed's own wall.
          const host = placed.find((o) => entry.near.includes(o.m));
          const size2 = host ? sizeOfBound(m) : null;
          if (host && host.side && size2) {
            const r2 = wallRot(host.side);
            const { ex, ez } = halfExtents(size2, r2, entry.s || 1);
            const half = wallAlongHalf(host.side, ex, ez);
            const [lo, hi] = wallSpan(host.side, U);
            for (const along of [host.alongLo - half - p.gap, host.alongHi + half + p.gap]) {
              if (along - half < lo || along + half > hi) continue;
              const pos = wallPlace(host.side, U, along, ex, ez);
              const cand = candidate(m, pos.x, pos.z, r2, 0, entry.s, host.side);
              if (!cand || whyBad(cand) || !take(cand)) continue;
              commit(cand, 'wall', null);
              break;
            }
          }
        }
      }
    }
  }

  /* ------------------------------------------------------------- fillers */
  // Only reached when the wish-list could not spend the room's quota. Rotated
  // through placement modes so the extra items do not all pile into the middle
  // of the floor, and bounded so a room that is genuinely full gives up instead
  // of spinning.
  const modes = ['corner', 'floor', 'wall', 'surface', 'floor', 'corner'];
  const goal = Math.min(quota, p.roomCap, state.remaining());
  for (let t = 0; filled < goal && t < quota * 6; t++) {
    const m = FILLERS[rng.int(FILLERS.length)];
    const mode = modes[t % modes.length];
    if (mode === 'wall') tryWall(m, 1, null);
    else if (mode === 'surface') trySurface(m, 1, FILLER_HOSTS);
    else tryFloor(m, 1, mode);
  }

  const spot = space.cellNear((U.x0 + U.x1) / 2, (U.z0 + U.z1) / 2);
  const seed = spot
    ? { x: space.cx(spot.i), z: space.cz(spot.j), snapped: spot.d > 0.3 }
    : { x: (U.x0 + U.x1) / 2, z: (U.z0 + U.z1) / 2, snapped: true };

  return {
    output: items.map((it) => {
      const o = { m: it.m, x: it.x, z: it.z, r: it.r };
      if (it.s && it.s !== 1) o.s = it.s;
      if (it.y) o.y = it.y;
      return o;
    }),
    rejected,
    filled,
    freeArea: space.freeArea(),
    seed,
    // A climbable top: the game's whole prize pool comes from these. Bounded by
    // the climb ceiling, because a 1.07 m stacked washer/dryer is not a surface
    // the player may stand on.
    climbTops: items.filter((it) => {
      const top = it.y + it.size[1] * it.s;
      return top >= 0.20 && top <= CLIMB_CEIL && it.ex >= 0.09 && it.ez >= 0.09;
    }).length,
  };
}

/* ================================================================= 6. zones */

/**
 * A camera preset per room, for the viewer.
 *
 * VIEWER-ONLY fields: the game reads `at` and nothing else. They are derived
 * rather than authored, which is the honest thing to do with a generated room --
 * and stated as derived here, because the hand-made layout's own comment is
 * right that "a formula with no idea what is in the room" is what produced a
 * living-room camera looking at the back of its own TV wall.
 */
function makeZones(rooms, roles, seeds) {
  const cx = rooms.reduce((a, r) => a + (r.x0 + r.x1) / 2, 0) / rooms.length;
  const cz = rooms.reduce((a, r) => a + (r.z0 + r.z1) / 2, 0) / rooms.length;
  return rooms.map((r, i) => {
    const rx = (r.x0 + r.x1) / 2;
    const rz = (r.z0 + r.z1) / 2;
    let ax = rx - cx;
    let az = rz - cz;
    const len = Math.hypot(ax, az) || 1;
    ax /= len; az /= len;
    const dist = Math.max(2.6, Math.max(r.x1 - r.x0, r.z1 - r.z0) * 0.9);
    const info = ROLE_INFO[roles[i]] || { name: roles[i], hue: '#cccccc' };
    return {
      id: seeds[i].id,
      name: info.name,
      hue: info.hue,
      at: [+seeds[i].x.toFixed(3), +seeds[i].z.toFixed(3)],
      focus: [+rx.toFixed(3), 0.45, +rz.toFixed(3)],
      eye: [+(rx + ax * dist).toFixed(3), 3.05, +(rz + az * dist).toFixed(3)],
      face: [+(-ax).toFixed(3), +(-az).toFixed(3)],
    };
  });
}

/* ================================================================ the entry */

/**
 * Generate one floor plan.
 *
 * @param params     see DEFAULTS; anything omitted is defaulted
 * @param ctx.sizes  parsed data/kit_three.json (or a bare { name: { size } })
 * @returns { layout, report }  -- the layout is exactly js/layout.js's schema
 */
export function generateFloorplan(params = {}, ctx = {}) {
  const p = { ...DEFAULTS, ...params };
  p.w = Math.max(2, Math.round(p.w));
  p.d = Math.max(2, Math.round(p.d));
  p.rooms = Math.max(1, Math.min(Math.round(p.rooms), p.w * p.d));

  const rng = new Rng(p.seed);
  const sizeOfBound = (m) => sizeOf(ctx.sizes, m);
  const trace = [];
  const problems = [];

  /* 1. the envelope */
  // A guillotine cut lands on an INTEGER line and every leaf keeps `minRoom` on
  // BOTH sides, so an envelope has room for at most
  // floor(w / ceil(minRoom)) * floor(d / ceil(minRoom)) leaves -- 2 x 1 = 2 for
  // 7 x 5 m. Saying so BEFORE the attempt is the difference between a tool that
  // explains why a request is impossible and one that quietly returns fewer
  // rooms than it was asked for and leaves the caller to guess.
  const edge = Math.ceil(p.minRoom);
  const fits = Math.floor(p.w / edge) * Math.floor(p.d / edge);
  if (p.rooms > fits) {
    problems.push(`asked for ${p.rooms} rooms of at least ${p.minRoom} m a side in ${p.w} x ${p.d} m: `
      + `on the ${edge} m wall grid at most ${fits} fit`);
  }
  const rects = partition(p, rng);
  if (rects.length < p.rooms && p.rooms <= fits) {
    problems.push(`asked for ${p.rooms} rooms in ${p.w} x ${p.d} m with a ${p.minRoom} m minimum; `
      + `only ${rects.length} fit`);
  }

  /* 2. walls */
  const { walls, edges, perimeter } = deriveWalls(rects, p);

  /* 3. roles, then doors (the door note reads better with role names in it) */
  const { roles, counts } = assignRoles(rects, p, rng);
  const seen = {};
  const roomIds = rects.map((r, i) => {
    seen[roles[i]] = (seen[roles[i]] || 0) + 1;
    return seen[roles[i]] === 1 ? roles[i] : `${roles[i]}${seen[roles[i]]}`;
  });
  const { doors, meta, trees, loops } = chooseDoors(rects, roles, edges, perimeter, p, rng, trace);

  /* 4. furniture, on a per-room quota proportional to usable floor */
  const usable = rects.map((r) => usableRect(r, walls));
  const lanes = rects.map((r, i) => doors
    .map((d, j) => doorLane(d, meta[j], i, usable[i], p.lane))
    .filter(Boolean));

  const areaOf = usable.map((U) => Math.max(0, (U.x1 - U.x0) * (U.z1 - U.z0)));
  const totalArea = areaOf.reduce((a, b) => a + b, 0) || 1;
  const quota = areaOf.map((a) => Math.max(2, Math.round((a / totalArea) * p.items)));
  // Largest-remainder top-up so the quotas sum to what was asked for.
  let left = p.items - quota.reduce((a, b) => a + b, 0);
  const byArea = areaOf.map((a, i) => ({ i, a })).sort((x, y) => y.a - x.a);
  for (let n = 0; left > 0 && n < byArea.length * 4; n++, left--) quota[byArea[n % byArea.length].i] += 1;

  const state = { placed: 0, models: {}, remaining: () => Math.max(0, p.items - state.placed) };

  const roomsOut = [];
  const seeds = [];
  const stats = { byRole: {}, climbTops: 0, freeArea: 0, rejected: {} };

  for (let i = 0; i < rects.length; i++) {
    const r = placeRoom(roles[i], usable[i], lanes[i], p, rng, sizeOfBound, quota[i], state);
    roomsOut.push({
      id: roomIds[i],
      name: (ROLE_INFO[roles[i]] || {}).name || roles[i],
      role: roles[i],
      rect: rects[i],
      usable: usable[i],
      quota: quota[i],
      items: r.output,
    });
    seeds.push({ id: roomIds[i], x: r.seed.x, z: r.seed.z, snapped: r.seed.snapped });
    stats.byRole[roles[i]] = (stats.byRole[roles[i]] || 0) + r.output.length;
    stats.climbTops += r.climbTops;
    stats.freeArea += r.freeArea;
    for (const k of Object.keys(r.rejected)) stats.rejected[k] = (stats.rejected[k] || 0) + r.rejected[k];
    if (r.seed.snapped) trace.push(`${roomIds[i]}: seed moved off the room centre (furniture covers it)`);
  }

  const totalItems = roomsOut.reduce((a, r) => a + r.items.length, 0);
  if (totalItems < p.items * 0.8) {
    trace.push(`placed ${totalItems} of the ${p.items} items asked for: the envelope ran out of legal floor`);
  }

  /* 5. emit */
  const layout = {
    WALL_H: 1.29,
    PLAN: { w: p.w, d: p.d },
    ZONES: makeZones(rects, roles, seeds),
    WALLS: walls,
    CORNERS: [],
    DOORS: doors,
    ROOMS: roomsOut.map((r) => ({ id: r.id, name: r.name, items: r.items })),
  };

  return {
    layout,
    params: p,
    report: {
      seed: String(p.seed),
      plan: { w: p.w, d: p.d, area: p.w * p.d },
      rooms: rects.length,
      roomIds,
      roles: { ...counts },
      doors: { spanning: trees, extra: loops, total: doors.length },
      walls: { runs: walls.length, segments: walls.reduce((a, w) => a + Math.round(w.to - w.from), 0) },
      items: {
        wanted: p.items,
        placed: totalItems,
        byRole: stats.byRole,
        perRoom: roomsOut.map((r) => ({ id: r.id, role: r.role, got: r.items.length, quota: r.quota })),
        models: state.models,
      },
      climbTops: stats.climbTops,
      freeArea: +stats.freeArea.toFixed(1),
      freeFraction: +(stats.freeArea / (p.w * p.d)).toFixed(3),
      rejected: stats.rejected,
      rects,
      trace,
      problems,
    },
  };
}
