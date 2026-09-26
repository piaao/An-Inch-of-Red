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
 *   1. BANDS      the envelope is split into horizontal bands, and each band
 *                 into cells. ALWAYS on the 1 m grid, because the kit's wall is
 *                 a 1 m segment and a wall at x = 4.37 would need a model that
 *                 does not exist -- but also because a partition edge that is
 *                 not on the grid produces NO WALL AT ALL, and two rooms merge.
 *                 The band nearest the front door gets few, wide cells, so the
 *                 room you arrive in can touch a lot of others; see
 *                 `bandStructure` for why that shape and not another.
 *   2. WALLS      wall runs are DERIVED from the plan, not authored. Two
 *                 rectangles that touch along a line differ on both sides of
 *                 it, and that difference IS the wall. Nothing can drift.
 *   3. DOORS      a breadth-first tree of doorways from the entry room, so the
 *                 path to any room is the shortest one the walls allow. Extra
 *                 doors are then added -- a flat is not a tree, and in a tree
 *                 one door seals a wing -- GATED so that they can never make
 *                 some other room better connected than the entry.
 *   4. FURNITURE  the palette is a wish-list; the placer keeps what fits.
 *   5. SEEDS      each room's label/camera seed is chosen from the FREE floor
 *                 left after furniture, not typed in. This is the difference
 *                 between a room that resolves and a room whose seed landed
 *                 inside a wardrobe.
 *
 * STAGES 1 AND 3 ARE NOW ONE SEARCH, and that is the P1 change. Roles used to
 * be handed out by area AFTER the partition, so nothing in the chain could know
 * that the front door has to open into a hall -- measured, seven of twelve
 * flats opened it into a bedroom or a bathroom. `planCirculation` proposes
 * roles and doorways together and refuses a structure that cannot put the front
 * door in a most-connected room within `MAX_DOOR_HOPS` doorways of every room;
 * `generateFloorplan` retries with another structure and reports a problem if
 * none survives.
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
  ROLE_INFO, PALETTES, FILLERS, FILLER_HOSTS,
} from './palette.js';
// The bar the RULER judges by, imported rather than copied. A placer that aims
// at 0.28 while the ruler judges at 0.30 makes rooms that are "almost
// grouped", and nothing in the system would say so.
import { MAX_DOOR_HOPS, AGAINST_WALL } from './siting.js';
// ...and the same three answers the placer has to AIM at. `furnishing.js` owns
// "how far apart are two footprints", "is this piece against a wall" and "does
// it butt against that piece", so the two hands cannot disagree about what a
// group is.
import {
  halfExtents, boxAt, againstWall, joined, buttedSpots,
} from './furnishing.js';

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
  program: null,       // an explicit room list; see roomProgram(). Overrides `rooms`
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

// `halfExtents` and `boxAt` are imported from ./furnishing.js. They used to be
// defined here AND in arrangement.js, which meant one footprint measured two
// ways: a group placed on this answer and judged on that one.

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

/* ================================================================ 1. bands */

/**
 * The room list: what this flat is supposed to contain.
 *
 * THIS IS WHAT DECIDES THE SHAPE OF THE PLAN. It replaced "bisect the envelope
 * into N pieces, then hand the pieces out by descending area", and that pairing
 * could not have been right: when the roles are handed out AFTER the partition,
 * the plan has no way to know that the door you come in by has to open into a
 * hall. Measured on the twelve-set sweep, the front door opened into a bedroom
 * or a bathroom in SEVEN of the twelve.
 *
 * So the order is inverted. The program says which rooms exist, and the
 * partition is built to hold exactly that list -- one rectangle per entry.
 *
 * The first six entries are the six roles `palette.js` can furnish. Past that
 * the residential roles repeat, because a building does; never living or
 * kitchen, because two kitchens in one flat is a bug a player would notice.
 */
export const PROGRAM = ['living', 'bedroom', 'kitchen', 'bath', 'dining', 'study'];

/** Roles a plan may repeat when it asks for more rooms than PROGRAM holds. */
const REPEATS = ['bedroom', 'bedroom', 'study'];

/** The six roles the palette and the viewer know. Anything else is a typo. */
export const KNOWN_ROLES = new Set(PROGRAM);

/**
 * At most this many bands, and it is arithmetic rather than taste.
 *
 * The ruler asks whether every room is within MAX_DOOR_HOPS doorways of the
 * front door. In a band plan the far band is exactly (bands - 1) hops away, so
 * a fifth band could not pass at any width -- allowing one would only make the
 * search spend its budget on plans that are already known to fail.
 */
const MAX_BANDS = 4;

/**
 * How many band plans may be proposed before the generator admits it cannot
 * make one. Cheap (arithmetic, no nav) and the accept test is decidable, so
 * this is a search rather than a re-roll -- but it is still bounded, because a
 * search that cannot fail is not a check.
 */
const BAND_TRIES = 400;

/**
 * The room list for these parameters, one role per room.
 *
 * @returns { roles, unknown }. `unknown` lists role names the palette does not
 *          know, RETURNED rather than thrown: one bad word in a room list must
 *          not cost the sweep its other eleven layouts. The caller turns it
 *          into a problem on the layout, which the pipeline reports as a
 *          failed check rather than as a footnote.
 */
export function roomProgram(params) {
  const asked = Array.isArray(params.program) && params.program.length ? params.program : null;
  if (asked) {
    const roles = asked.map((r) => String(r).trim()).filter((r) => r.length);
    return {
      roles: roles.length ? roles : ['living'],
      unknown: roles.filter((r) => !KNOWN_ROLES.has(r)),
    };
  }
  const n = Math.max(1, Math.round(params.rooms));
  const roles = [];
  for (let i = 0; i < n; i++) {
    roles.push(i < PROGRAM.length ? PROGRAM[i] : REPEATS[(i - PROGRAM.length) % REPEATS.length]);
  }
  return { roles, unknown: [] };
}

/**
 * Split `total` into `k` positive integers inside [minEach, maxEach], at random.
 *
 * Deliberately dull, and deliberately not a tuning surface: the interesting
 * decisions in a band plan are how many bands there are and how many cells each
 * holds, not whether a cut lands at 3 m or at 4. Handing that last choice to the
 * rng is what keeps two seeds from producing the same plan.
 *
 * It returns null when the arithmetic is impossible, rather than nudging a cut
 * to make it work. An off-the-metre cut makes `deriveWalls` produce NO WALL AT
 * ALL, and two rooms then silently merge into one -- which reads as a bug in the
 * adapter three hundred lines away.
 */
function splitCount(rng, total, k, minEach, maxEach) {
  const hi = maxEach == null ? Infinity : maxEach;
  if (!(k >= 1) || total < k * minEach || total > k * hi) return null;
  const parts = new Array(k).fill(minEach);
  let left = total - k * minEach;
  let guard = k * 64;
  while (left > 0 && guard-- > 0) {
    const i = rng.int(k);
    if (parts[i] >= hi) continue;
    parts[i] += 1;
    left -= 1;
  }
  if (left !== 0) return null;
  return rng.shuffle(parts);
}

/**
 * A BAND PLAN: horizontal bands, each cut into cells, every edge on the metre.
 *
 * WHY BANDS AND NOT RECURSIVE BISECTION. Two facts elsewhere in this system
 * force it, and both are measurements rather than preferences.
 *
 * 1. EVERY CUT LANDS ON AN INTEGER. The kit's wall is a 1 m segment and
 *    `deriveWalls` walks integer positions, so a partition edge at x = 3.33
 *    produces no wall at all: the two rooms merge and checks 3 and 4 of the
 *    playability axis fail on a plan whose picture still looks reasonable.
 *    Bisection already respected this; a band plan has to respect it in one
 *    more place, which is why `splitCount` refuses instead of rounding.
 *
 * 2. THE ENTRY ROOM HAS TO BE THE HUB, AND THAT IS GEOMETRY, NOT NAMING.
 *    `arrangement.js` compares the entry room's degree in the circulation graph
 *    against the highest degree in the flat. A degree is the number of walls two
 *    rooms share, so no role name can make a corner cell better connected than a
 *    middle one -- the plan has to be BORN with a room that touches many others
 *    and sits on the front wall.
 *
 * A band plan gives exactly that control: the band the front door is cut into
 * gets FEW, WIDE cells, so each one touches many of the cells behind it, and the
 * bands behind it get more, narrower ones. This function only proposes;
 * `planCirculation` is what accepts or rejects.
 *
 * The alternative was measured before it was abandoned. Bisecting and re-rolling
 * until the entry happened to be a hub produced a usable plan in 3 attempts of
 * 24 at 10 x 8 m with six rooms, and at 24 x 16 m with sixteen rooms the entry
 * could not reach the far corner within three doorways at ANY bisection of that
 * granularity -- a bisection tree of sixteen rooms is four rooms deep by
 * construction, and no choice of doors can shorten a path the walls do not
 * allow.
 *
 * @returns { rects, rows, bands } -- rows are listed FRONT FIRST, so rows[0] is
 *          the band the front door is cut into -- or null when this seed's
 *          arithmetic does not work out.
 */
function bandStructure(p, rng, n) {
  const edge = Math.ceil(p.minRoom);
  const maxRows = Math.floor(p.d / edge);
  const maxCols = Math.floor(p.w / edge);
  if (maxRows < 1 || maxCols < 1) return null;

  const R = 1 + rng.int(Math.min(MAX_BANDS, maxRows));
  const headMax = Math.max(1, Math.min(3, maxCols));
  const head = 1 + rng.int(headMax);
  const rest = n - head;
  if (rest < 0) return null;
  if (R === 1) { if (rest !== 0) return null; }
  else if (rest < R - 1 || rest > (R - 1) * maxCols) return null;

  const depths = splitCount(rng, p.d, R, edge, null);
  if (!depths) return null;

  const counts = [head];
  if (R > 1) {
    const tail = splitCount(rng, rest, R - 1, 1, maxCols);
    if (!tail) return null;
    for (const q of tail) counts.push(q);
  }

  const rects = [];
  const rows = [];
  let z1 = p.d;
  for (let r = 0; r < R; r++) {
    const widths = splitCount(rng, p.w, counts[r], edge, null);
    if (!widths) return null;
    const z0 = z1 - depths[r];
    let x = 0;
    for (const wd of widths) {
      rects.push({ x0: x, z0, x1: x + wd, z1 });
      x += wd;
    }
    rows.push({ z0, z1, widths: widths.slice() });
    z1 = z0;
  }
  return { rects, rows, bands: R };
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
 * Where in a shared wall a doorway may go: `doorMargin` in from either end.
 *
 * The margin is what keeps a doorway out of a corner, where the two walls' own
 * bodies meet. When the run is too short to afford it, the whole run is offered
 * instead of refusing -- a 1 m shared wall is a legitimate place for a door and
 * a plan that could not use one would be a plan that lost a room.
 */
function pickSeg(e, rng, p) {
  let lo = e.lo;
  let hi = e.hi - 1;
  if (hi - lo >= 2 * p.doorMargin) { lo += p.doorMargin; hi -= p.doorMargin; }
  if (hi < lo) { lo = e.lo; hi = e.hi - 1; }
  return lo + rng.int(hi - lo + 1);
}

/**
 * The breadth-first tree of doorways from the entry room, and the depths it
 * implies.
 *
 * BREADTH-FIRST ON PURPOSE, because it is what makes the depths minimal: the
 * path this tree gives to any room is the shortest path the walls allow. The
 * ruler's "within N doorways" is therefore decided by the plan's SHAPE and not
 * by which doors happened to be cut first -- a depth-first tree can reach a room
 * in five doorways over walls that allow two.
 *
 * A BATH IS A LEAF. It may be reached, never passed through. That is the
 * difference between "one door into the bathroom" and "a bathroom used as a
 * corridor", and the ruler counts DOORS into a bath rather than asking whether
 * it has any, so a bath with two doors fails whatever the circulation looks
 * like.
 */
function doorTree(root, adj, roles) {
  const N = adj.length;
  const parent = new Array(N).fill(-1);
  const depth = new Array(N).fill(-1);
  const done = new Array(N).fill(false);
  const q = [root];
  done[root] = true;
  depth[root] = 0;
  let reached = 1;
  let max = 0;
  while (q.length) {
    const id = q.shift();
    if (roles[id] === 'bath') continue;
    for (const nb of adj[id]) {
      if (done[nb]) continue;
      done[nb] = true;
      parent[nb] = id;
      depth[nb] = depth[id] + 1;
      if (depth[nb] > max) max = depth[nb];
      reached += 1;
      q.push(nb);
    }
  }
  return { parent, depth, reached, max };
}

/**
 * Roles AND doorways, decided together -- because they are one decision.
 *
 * WHY ONE FUNCTION AND NOT THREE STAGES. The six arrangement questions are not
 * independently satisfiable by independent choices, and the couplings are the
 * interesting part:
 *
 *   - the room you enter must be a most-connected room, which fixes WHICH CELL
 *     the front door goes into (the best-connected one on the front wall), and
 *     therefore which cell can be the living room;
 *   - the bathroom must be reached from the entry without crossing a bedroom
 *     and must have exactly ONE door, which is one fact stated twice: it is a
 *     leaf of the door tree, hanging off the entry;
 *   - the kitchen and the dining room must share a doorway, so they are chosen
 *     as a PAIR of adjacent cells rather than one after the other.
 *
 * Doing these in separate passes is what produced the readings P0 made red: a
 * role table handed out by area cannot know any of it afterwards.
 *
 * @returns null when this structure cannot satisfy all three. The caller tries
 *          another structure -- the failure is a rejection, not an exception,
 *          because "this envelope cannot hold a legible flat" is a real answer
 *          that the report has to be able to carry.
 */
function planCirculation(rects, edges, perimeter, program, p, rng, trace) {
  const N = rects.length;

  /* the adjacency graph, with the widest shared wall kept for each pair ---- */
  const adj = rects.map(() => []);
  const widest = new Map();
  const key = (a, b) => `${Math.min(a, b)}|${Math.max(a, b)}`;
  for (const e of edges) {
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
    const k = key(e.a, e.b);
    const got = widest.get(k);
    if (!got || e.len > got.len) widest.set(k, e);
  }
  const deg = adj.map((a) => a.length);
  const maxDeg = Math.max(...deg);

  /* which cell the front door opens into ---------------------------------- */
  const centre = (i) => (rects[i].x0 + rects[i].x1) / 2;
  const front = rects.map((r, i) => i).filter((i) => rects[i].z1 === p.d);
  if (!front.length) return null;
  const entryIdx = front.slice().sort((a, b) =>
    (deg[b] - deg[a])
    || (Math.abs(centre(a) - p.w / 2) - Math.abs(centre(b) - p.w / 2))
    || (a - b))[0];

  // THE PRECONDITION THE RULER WILL ASK ABOUT, asked here first. Whether the
  // room you enter can be one of the most-connected rooms is a fact about the
  // walls, so it is decidable before a single door exists -- which is what makes
  // this a search rather than a hope. Everything after it assumes it.
  if (deg[entryIdx] !== maxDeg) return null;

  /* roles ----------------------------------------------------------------- */
  const roles = new Array(N).fill(null);
  const pool = program.slice();
  const draw = (name) => {
    const at = pool.indexOf(name);
    if (at < 0) return false;
    pool.splice(at, 1);
    return true;
  };
  const freeCells = () => roles.map((r, i) => (r === null ? i : -1)).filter((i) => i >= 0);
  const openNbrs = (i) => adj[i].filter((j) => roles[j] === null);

  roles[entryIdx] = 'living';
  if (!draw('living')) return null;

  if (pool.includes('bath')) {
    const cands = openNbrs(entryIdx).slice().sort((a, b) => (adj[a].length - adj[b].length) || (a - b));
    if (!cands.length) return null;
    roles[cands[0]] = 'bath';
    draw('bath');
  }

  const wantK = pool.includes('kitchen');
  const wantD = pool.includes('dining');
  if (wantK && wantD) {
    const pairs = [];
    for (const i of freeCells()) {
      for (const j of adj[i]) {
        if (j <= i || roles[j] !== null) continue;
        const onHall = adj[i].includes(entryIdx) || adj[j].includes(entryIdx);
        pairs.push({ i, j, rank: onHall ? 0 : 1 });
      }
    }
    if (!pairs.length) return null;
    pairs.sort((a, b) => (a.rank - b.rank) || (a.i - b.i) || (a.j - b.j));
    const put = pairs[rng.int(Math.min(pairs.length, 3))];
    roles[put.i] = 'kitchen';
    roles[put.j] = 'dining';
    draw('kitchen');
    draw('dining');
  } else if (wantK || wantD) {
    const name = wantK ? 'kitchen' : 'dining';
    const cands = freeCells().slice().sort((a, b) => (adj[b].length - adj[a].length) || (a - b));
    if (!cands.length) return null;
    roles[cands[0]] = name;
    draw(name);
  }

  // Everything else. Bedrooms take the cells that CAN have a window first --
  // not because the ruler demands it (it exempts a room with no outside wall)
  // but because a bedroom with an outside wall and no window is the dullest way
  // to fail a plan, and a plan that hands out its perimeter last will do it.
  const outside = (i) => rects[i].x0 === 0 || rects[i].x1 === p.w
    || rects[i].z0 === 0 || rects[i].z1 === p.d;
  const cells = freeCells().sort((a, b) => ((outside(b) ? 1 : 0) - (outside(a) ? 1 : 0)) || (a - b));
  const rest = pool.slice().sort((a, b) => (a === 'bedroom' ? 0 : 1) - (b === 'bedroom' ? 0 : 1));
  if (cells.length !== rest.length) return null;
  for (let i = 0; i < rest.length; i++) roles[cells[i]] = rest[i];
  if (roles.some((r) => r === null || r === undefined)) return null;

  /* doorways -------------------------------------------------------------- */
  const doors = [];
  const meta = [];
  const used = new Set();
  const degT = new Array(N).fill(0);
  const cut = (a, b, note) => {
    const e = widest.get(key(a, b));
    if (!e) return false;
    const made = makeDoor(e.wall, [e.a, e.b], pickSeg(e, rng, p), 'doorwayOpen', note);
    doors.push(made.door);
    meta.push(made.meta);
    used.add(key(a, b));
    degT[a] += 1;
    degT[b] += 1;
    return true;
  };
  const label = (a, b) => `${roles[a]}|${roles[b]}`;

  const tree = doorTree(entryIdx, adj, roles);
  if (tree.reached !== N) return null;                 // the bath cannot be a through-route
  if (tree.max > MAX_DOOR_HOPS) return null;

  let spanning = 0;
  for (let i = 0; i < N; i++) {
    if (i === entryIdx) continue;
    if (cut(tree.parent[i], i, label(tree.parent[i], i))) spanning += 1;
  }

  let kd = 0;
  if (wantK && wantD) {
    const ki = roles.indexOf('kitchen');
    const di = roles.indexOf('dining');
    if (!used.has(key(ki, di))) {
      if (!cut(ki, di, `${roles[ki]}=${roles[di]}`)) return null;
      kd = 1;
    }
  }

  // A flat is not a tree: in a tree, one door seals a wing. Extra doorways are
  // added, GATED so that they can never raise anybody above the entry -- the
  // entry's degree is the number the ruler compares, and it was fixed by
  // geometry before this loop ran. The bath is excluded outright: a second door
  // into a bathroom fails the ruler on its own.
  const capDeg = degT[entryIdx];
  let extra = 0;
  for (const e of rng.shuffle(edges.slice())) {
    if (extra >= p.maxLoopDoors) break;
    if (e.a === entryIdx || e.b === entryIdx) continue;
    if (roles[e.a] === 'bath' || roles[e.b] === 'bath') continue;
    if (used.has(key(e.a, e.b))) continue;
    if (degT[e.a] + 1 > capDeg || degT[e.b] + 1 > capDeg) continue;
    if (!rng.chance(p.loopDoor)) continue;
    if (cut(e.a, e.b, `${roles[e.a]}=${roles[e.b]}`)) extra += 1;
  }

  /* the way in ------------------------------------------------------------ */
  // Cut into the entry cell's own metre segments, and never within one segment
  // of its edges: the front door has to be findable from the resolved
  // rectangles, and a door on a cell corner is a door whose room is ambiguous.
  const cell = rects[entryIdx];
  const lo = Math.ceil(cell.x0);
  const span = Math.floor(cell.x1) - lo;
  if (span < 1) return null;
  const k = span >= 3 ? (lo + 1) + rng.int(span - 2) : lo + rng.int(span);
  const way = makeDoor(perimeter.south, [entryIdx], k, 'doorwayFront', '入户门');
  doors.push(way.door);
  meta.push(way.meta);
  trace.push(`front door on the south wall at x ${k}..${k + 1}, into the ${roles[entryIdx]}`);

  /* windows --------------------------------------------------------------- */
  // A perimeter segment belongs to the room a point just inside it lands in.
  // Asked of the plan's OWN rectangles rather than of the picture, so a window
  // and the room it lights cannot disagree.
  const ownerOf = (name, i) => {
    const x = name === 'west' ? 0.5 : name === 'east' ? p.w - 0.5 : i + 0.5;
    const z = name === 'north' ? 0.5 : name === 'south' ? p.d - 0.5 : i + 0.5;
    return rects.findIndex((r) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1);
  };
  const facades = (i) => {
    const r = rects[i];
    const out = [];
    if (r.z1 === p.d) out.push('south');
    if (r.z0 === 0) out.push('north');
    if (r.x0 === 0) out.push('west');
    if (r.x1 === p.w) out.push('east');
    return out;
  };
  const windowable = (name, i) => {
    const run = perimeter[name];
    if (!run || i < run.from || i >= run.to) return false;
    if (Object.prototype.hasOwnProperty.call(run.kinds, i)) return false;
    if (name === 'south' && Math.abs(i - k) < 2) return false;
    return true;
  };

  // Seed one window per bedroom that HAS an outside wall. A bedroom with no
  // facade is not "blind" -- it has nothing to cut, and holding it to a window
  // would be holding it to arithmetic rather than design. Which bedrooms those
  // are is counted BELOW, after the scatter, so that the number this reports
  // and the number the ruler measures are the same population.
  for (let i = 0; i < N; i++) {
    if (roles[i] !== 'bedroom') continue;
    const cands = [];
    for (const name of facades(i)) {
      const run = perimeter[name];
      if (!run) continue;
      for (let s = run.from; s < run.to; s++) {
        if (windowable(name, s) && ownerOf(name, s) === i) cands.push([name, s]);
      }
    }
    if (!cands.length) continue;
    const pick = cands[rng.int(cands.length)];
    perimeter[pick[0]].kinds[pick[1]] = 'wallWindow';
  }
  // And a scattering elsewhere, so a plan does not read as "one window per
  // bedroom, none anywhere else".
  for (const name of Object.keys(perimeter)) {
    const run = perimeter[name];
    if (!run) continue;
    for (let i = run.from; i < run.to; i++) {
      if (!windowable(name, i)) continue;
      if (rng.chance(p.windowChance)) run.kinds[i] = 'wallWindow';
    }
  }

  // `blind` -- bedrooms WITH an outside wall that ended up with no window.
  //
  // WAS "bedrooms that found no candidate slot", and that was a different set:
  // on a 24 x 16 m plan the middle band is cut into cells that have no facade,
  // so the old counter reported `blindBedrooms: 1` for a plan whose every
  // outside bedroom does have a window -- a number that reads as a failure and
  // is not one. `report.circulation.blindBedrooms` is compared against the
  // ruler's `bedroom-window` check on all twelve sweep layouts, and two numbers
  // may only be compared when they count the same thing.
  let blind = 0;
  for (let i = 0; i < N; i++) {
    if (roles[i] !== 'bedroom') continue;
    const sides = facades(i).filter((name) => perimeter[name]);
    if (!sides.length) continue;                       // no outside wall -> out of scope
    const lit = sides.some((name) => {
      const run = perimeter[name];
      for (let s = run.from; s < run.to; s++) {
        if (run.kinds[s] === 'wallWindow' && ownerOf(name, s) === i) return true;
      }
      return false;
    });
    if (!lit) blind += 1;
  }

  return {
    roles, doors, meta, spanning, loops: kd + extra,
    entryIdx, entryRole: roles[entryIdx],
    entryDegree: deg[entryIdx], maxDegree: maxDeg,
    hops: tree.max, blind,
  };
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
  // The same footprints as `placed`, without the per-call `map`. Both are
  // appended in `commit` and nowhere else, so they cannot drift.
  const boxes = [];
  const occupied = { north: [], south: [], west: [], east: [] };
  const space = new RoomSpace(U);
  const anchors = lanes
    .map((L) => ({ i: space.i((L.x0 + L.x1) / 2), j: space.j((L.z0 + L.z1) / 2) }))
    .filter((a) => !space.blocked(a.j * space.w + a.i));

  const rejected = { overlap: 0, outside: 0, lane: 0, slot: 0, sealed: 0, noHost: 0,
                     noModel: 0, budget: 0, seed: 0, floating: 0 };
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
   * Would this piece be left standing on its own, touching nothing?
   *
   * THE RULE THE P2 NUMBERS ARE ABOUT. A room whose pieces each sit at a random
   * legal spot measures 1.29 pieces per group and leaves 10.8 pieces per flat on
   * open floor -- and an object alone in the middle of a room is the loudest
   * "this was generated" tell there is. So a candidate that is neither against a
   * wall nor butted against something already down is not a legal position AT
   * ALL: the generator cannot express it, and no later pass has to notice it.
   *
   * Three exemptions, each with a reason rather than a mood
   *   * flat things (rugs) are floor coverings, not pieces of furniture;
   *   * anything with y above the floor stands ON something, so it is joined to
   *     its host by construction;
   *   * a host -- a model some palette entry names in its `on`, `near` or `of`
   *     -- is the CENTRE of an arrangement, and the walk places its companions
   *     the moment it lands (see `ordered`), so it is not a loner even when
   *     nothing is near it yet.
   */
  const floating = (cand) => {
    if (flatUntil(cand) || cand.y > 0.02) return false;
    if (hostModels.has(cand.m)) return false;
    if (againstWall(cand.box, U)) return false;
    return !joined(cand.box, boxes);
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
    if (floating(cand)) return 'floating';
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
    boxes.push(it.box);
    // EVERY FLOOR PIECE AGAINST A WALL TAKES THAT WALL'S SPAN, whoever put it
    // there.
    //
    // This was `if (cand.side) occupied[cand.side].push(...)` -- only `tryWall`
    // registered. A sofa set down by `tryFloor` three centimetres off the north
    // wall, a bedside table butted by `tryBeside`, a worktop laid by
    // `tryCounter` from the west: none was recorded, so the NEXT wall item
    // computed a free span that was already taken, aimed at its flush end, and
    // collided. Measured over twelve flats: 397 flush shots tried, **132 of
    // them rejected as `overlap`, 18 landing**. The wall model was not wrong
    // about geometry -- it was wrong about WHO COUNTS, and the price was that
    // those 132 placements went back to the middle of an empty wall.
    //
    // Flat things are exempt: a rug is a floor covering and a wall run may
    // cross one. So is anything lifted off the floor -- a wall lamp or an upper
    // cabinet leaves the floor along that wall clear.
    if (it.y <= 0.02 && !flatUntil(it)) {
      const b = it.box;
      const near = {
        north: b.z0 - U.z0, south: U.z1 - b.z1,
        west: b.x0 - U.x0, east: U.x1 - b.x1,
      };
      for (const side of ['north', 'south', 'west', 'east']) {
        if (near[side] > AGAINST_WALL) continue;
        occupied[side].push(side === 'north' || side === 'south' ? [b.x0, b.x1] : [b.z0, b.z1]);
      }
    }
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
        // WHICH END MATTERS, and it is not a detail. An end of this free span
        // that coincides with a piece already down is an end that continues a
        // RUN; the other ends are the room's own corners. Sorting by span width
        // alone -- which is what this did -- sends the second piece to a
        // DIFFERENT and wider wall, and a wall holding one thing reads exactly
        // like an empty one. Measured before the fix: 14 of 92 neighbouring
        // pairs along a wall were within JOIN.
        const taken = occupied[side];
        const nearLo = taken.some(([, hi2]) => Math.abs(hi2 - a) < 1e-6);
        const nearHi = taken.some(([lo2]) => Math.abs(lo2 - b) < 1e-6);
        options.push({ side, a: a + half + p.gap, b: b - half - p.gap, ex, ez,
          w: b - a, nearLo, nearHi });
      }
    }
    if (!options.length) { rejected.outside += 1; return null; }
    // Runs first, then the widest span. Both halves earn their place: without
    // the first, nothing ever joins a run; without the second, everything piles
    // onto one wall and the rest of the room stays bare.
    options.sort((x, y) => ((y.nearLo || y.nearHi) ? 1 : 0) - ((x.nearLo || x.nearHi) ? 1 : 0)
      || (y.w - x.w));

    // FLUSH SPOTS ON EVERY WALL, BEFORE ANY COLD SPOT ON ANY WALL.
    //
    // This ordering is the P2 fix, and the counter that found it: of 216 wall
    // placements, 158 calls had a spot flush against a piece already down
    // available and **102 placements still came back standing on their own**.
    // The cause was the shape of the loop, not the palette. One span was
    // exhausted -- its flush end, its other end, then random spots inside it --
    // before the next span was looked at at all, so a wall whose flush end was
    // blocked (a door lane crosses it, the slot behind it would seal) got its
    // piece dropped in the middle of THAT SAME WALL, a metre and a half from
    // anything. Sorting the spans does not fix that; the singles have to be
    // tried across all four walls first, which is what this does.
    //
    // A cold spot is still reachable, so a room that already has a piece on
    // every wall still gets its next one -- the flush pass is a preference,
    // never a filter.
    const shots = [];
    for (const o of options) {
      const flush = [];
      if (o.nearLo) flush.push(o.a);
      if (o.nearHi) flush.push(o.b);
      for (const along of flush) shots.push({ o, along, flush: true });
      for (const along of [o.a, o.b]) if (!flush.includes(along)) shots.push({ o, along, flush: false });
      for (let t = 0; t < 2; t++) shots.push({ o, along: null, flush: false });
    }
    shots.sort((x, y) => (y.flush ? 1 : 0) - (x.flush ? 1 : 0));

    for (const { o, along } of shots) {
      const at = along == null ? o.a + (o.b - o.a) * rng.next() : along;
      const pos = wallPlace(o.side, U, at, o.ex, o.ez);
      const cand = candidate(m, pos.x, pos.z, wallRot(o.side), 0, sc, o.side);
      if (!cand) return null;
      const why = whyBad(cand);
      if (why) { rejected[why] += 1; continue; }
      if (!take(cand)) { rejected.sealed += 1; continue; }
      return commit(cand, 'wall', null);
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
   * Butt a companion against the host it belongs to.
   *
   * The palette already says which pieces belong together -- `near: [bedDouble]`
   * on a bedside table is that statement. This is what turns it into geometry.
   * The old code read the same field and then tried the SAME WALL at a random
   * spot, which is not the same thing at all: a table at the far end of the bed's
   * wall is two unrelated objects, and measured as such.
   *
   * The companion is placed FLUSH (`p.gap` away, two orders of magnitude under
   * `JOIN`), so the pair is a group by arithmetic. The host's two ENDS are tried
   * before its two faces -- a bed's table continues the wall run the bed
   * started, it does not stand in front of the bed -- and the biggest host is
   * tried first, so a table looked for by several things goes to the main one.
   */
  const tryBeside = (m, s, hosts) => {
    const size = sizeOfBound(m);
    if (!size) { rejected.noModel += 1; return null; }
    const sc = s || 1;
    const pool = placed.filter((o) => hosts.includes(o.m));
    if (!pool.length) { rejected.noHost += 1; return null; }
    pool.sort((a, b) => (b.ex * b.ez) - (a.ex * a.ez));
    for (const host of pool) {
      // Same rotation as the host on its ends (a pair of tables flanking a bed
      // face the way the bed does) and a quarter turn on its faces.
      for (const r of [host.r, host.r + 90]) {
        for (const spot of buttedSpots(host.box, size, r, sc, p.gap)) {
          const cand = candidate(m, spot.x, spot.z, r, 0, sc, null);
          if (!cand) return null;
          const why = whyBad(cand);
          if (why) { rejected[why] += 1; continue; }
          if (!take(cand)) { rejected.sealed += 1; continue; }
          return commit(cand, 'beside', host.m);
        }
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
    //
    // And for anything else, THE SPOTS THAT TOUCH SOMETHING COME FIRST. A sofa
    // dropped at a random legal spot is legal and reads as a mistake; the same
    // sofa with its coffee table butted against it reads as a room. This is a
    // PREFERENCE, never a filter -- every candidate in `spots` has already
    // passed `whyBad`, so a room with nothing else in it still gets its first
    // piece down.
    const touching = spots.filter((c) => joined(c.box, boxes));
    const wallside = spots.filter((c) => againstWall(c.box, U));
    // A CORNER PIECE EARNS ITS CORNER.
    //
    // `touching` was skipped for `corner` mode: the eight nearest corners were
    // shuffled and one of them was taken. That is why the plants, the coat rack
    // and the washer/dryer were still standing on their own after every other
    // rule had been repaired -- a corner is where a plant goes when it stands
    // BESIDE something, and the code was treating "the corner" as the whole
    // requirement. Measured after the first two P2 levers: they were the top of
    // the lone-item census. The nearest corners are still the shortlist; the
    // ones that touch something simply come first, and a room whose corners are
    // all empty keeps its first piece exactly as before.
    const nearby = spots.slice().sort((a, b) => cornerDist(a, U) - cornerDist(b, U)).slice(0, 10);
    const tucked = nearby.filter((c) => joined(c.box, boxes));
    const pool = mode === 'corner'
      ? rng.shuffle(tucked.length ? tucked : nearby)
      : touching.length ? rng.shuffle(touching)
        : wallside.length ? rng.shuffle(wallside) : rng.shuffle(spots);
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
    // Flush with the end of the span, not half a metre along it: a worktop that
    // starts 0.5 m off the corner is a worktop that is against no wall.
    let cursor = best.a;
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

  /** Is this entry a companion -- a piece that belongs to another one? */
  const isCompanion = (e) => e.where === 'surface' || !!e.near;

  /**
   * Every model some palette entry names as its host.
   *
   * Read off the palette's own `on` / `near` / `of` fields, so "what goes with
   * what" keeps exactly one source. Used by `floating`: a host is the centre of
   * an arrangement and is not disqualified for having nothing near it yet.
   */
  const hostModels = new Set();
  for (const e of wants) {
    for (const k of ['on', 'near', 'of']) {
      for (const h of e[k] || []) hostModels.add(h);
    }
  }

  /**
   * THE ORDER IS THE ARRANGEMENT. Each companion is placed immediately after the
   * entry that can host it, so a bed and its bedside tables are ONE ACT rather
   * than two that might never meet. Everything else keeps the palette's order,
   * which is itself load-bearing (rugs before the things that stand on them,
   * structure before decoration).
   */
  const ordered = [];
  const taken = new Set();
  const push = (e) => { if (!taken.has(e)) { taken.add(e); ordered.push(e); } };
  const companionsOf = (models) => wants.filter((c) => isCompanion(c) && !taken.has(c)
    && (c.on || c.near).some((h) => models.includes(h)));
  for (const e of wants) if (!isCompanion(e)) { push(e); for (const c of companionsOf(Array.isArray(e.m) ? e.m : [e.m])) push(c); }
  for (const e of wants) push(e);

  for (const entry of ordered) {
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
        // `near` is the palette saying "this piece belongs to that one", so BUTT
        // IT AGAINST THE HOST first and only then fall back to a wall at large.
        const it = (entry.near ? tryBeside(m, entry.s, entry.near) : null)
          || tryWall(m, entry.s, entry.side && entry.side !== 'any' ? entry.side : null);
        void it;
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

  /* 1 + 3. ONE decision: bands, roles and doorways ----------------------- */
  //
  // These were three stages with three authors. A partition that only knew
  // about areas, roles handed out by area afterwards, doorways chosen by wall
  // width -- and none of the three could know that the front door has to open
  // into a hall, so none of them could be asked. Measured on the sweep: seven
  // of twelve flats opened their front door into a bedroom or a bathroom.
  //
  // They are now one search, whose accept test is the ruler's own
  // precondition. A structure that cannot put the front door in a hub within
  // MAX_DOOR_HOPS doorways of every room is REJECTED here rather than shipped
  // to fail there, and `problems` says so loudly if no structure survives.
  const { roles: programList, unknown } = roomProgram(p);
  if (unknown.length) {
    problems.push(`the room list names ${unknown.length} role(s) the palette does not know: `
      + `${unknown.join(', ')} -- those rooms will be furnished as bedrooms`);
  }
  const n = programList.length;
  p.rooms = n;

  const edge = Math.ceil(p.minRoom);
  const maxCols = Math.floor(p.w / edge);
  const rMax = Math.min(MAX_BANDS, Math.floor(p.d / edge));
  const fits = (rMax < 1 || maxCols < 1) ? 0 : maxCols * (rMax - 1) + Math.min(3, maxCols);
  if (n > fits) {
    problems.push(`asked for ${n} rooms of at least ${p.minRoom} m a side in ${p.w} x ${p.d} m: `
      + `on the ${edge} m wall grid, laid out as bands, at most ${fits} fit`);
  }

  let plan = null;
  for (let t = 0; t < BAND_TRIES && !plan; t++) {
    const cand = bandStructure(p, rng.fork(`band${t}`), n);
    if (!cand) continue;
    const walls = deriveWalls(cand.rects, p);
    const circ = planCirculation(cand.rects, walls.edges, walls.perimeter, programList, p,
      rng.fork(`circ${t}`), t === 0 ? trace : []);
    if (!circ) continue;
    plan = { ...cand, ...walls, ...circ };
  }
  if (!plan) {
    // LOUD, and shaped like a layout. A generator that returns five rooms when
    // six were asked for, or a flat with no front door, must not look like a
    // success to anything downstream -- so this is a `problem`, which the
    // pipeline turns into a failed check, and the layout it returns is the
    // honest degenerate case rather than a plausible-looking guess.
    problems.push(`no band plan kept the front door in a most-connected room within `
      + `${MAX_DOOR_HOPS} doorways of every room, in ${BAND_TRIES} attempts: `
      + `${p.w} x ${p.d} m was not generated`);
    const only = [{ x0: 0, z0: 0, x1: p.w, z1: p.d }];
    plan = {
      rects: only, rows: [], bands: 1, ...deriveWalls(only, p),
      roles: ['living'], doors: [], meta: [], spanning: 0, loops: 0,
      entryIdx: null, entryRole: 'living', entryDegree: 0, maxDegree: 0, hops: 0, blind: 0,
    };
  }

  const rects = plan.rects;
  const { walls, edges, perimeter, doors, meta, spanning: trees, loops } = plan;
  const { roles } = plan;

  const seen = {};
  const roomIds = rects.map((r, i) => {
    seen[roles[i]] = (seen[roles[i]] || 0) + 1;
    return seen[roles[i]] === 1 ? roles[i] : `${roles[i]}${seen[roles[i]]}`;
  });
  const counts = {};
  for (const role of roles) counts[role] = (counts[role] || 0) + 1;

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
      // The plan's OWN claim about its circulation, so the ruler's verdict can
      // be held against something rather than merely believed. Two independent
      // computations of one fact: `verify_arrangement.mjs` checks them against
      // each other on all twelve layouts, and a divergence is a finding.
      circulation: {
        bands: plan.bands,
        entry: plan.entryIdx == null ? null : roomIds[plan.entryIdx],
        entryRole: plan.entryRole,
        entryDegree: plan.entryDegree,
        maxDegree: plan.maxDegree,
        hops: plan.hops,
        blindBedrooms: plan.blind,
        rows: plan.rows.map((r) => ({ z0: r.z0, z1: r.z1, cells: r.widths.length })),
      },
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
