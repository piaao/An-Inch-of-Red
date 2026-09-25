/**
 * fromLayout.js — the ONLY file that knows this is an apartment.
 *
 * It takes plain data in and hands a Level out:
 *
 *     in : { layout, sizes, surfaces, wallOpenings, options }
 *    out : a Level (per game/core/level.js)
 *
 * `layout` is `js/layout.js`'s exports; `sizes` is `work/kit_three.json`'s
 * browser-measured bounding boxes; `surfaces` is the red/glass sub-box census.
 * Every number is passed in, so this file has no import of the project and
 * could be dropped into another repository as-is.
 *
 * Two things here are worth calling out because they are where a naive port
 * goes wrong:
 *
 *  1. WALLS ARE MEASURED, NOT ASSUMED. "A doorway is a gap in a wall" is easy
 *     to say and easy to get wrong -- is the hole 0.4 m or 0.9 m? is there a
 *     lintel? `wallOpenings` carries solid intervals actually ray-cast out of
 *     each wall model, so the gap between two jambs is whatever the asset
 *     really has, and the resulting passage width can be checked against the
 *     door frame that sits in it.
 *
 *  2. BEHAVIOUR IS DERIVED FROM GEOMETRY. Nothing says "a sofa blocks sight".
 *     A sofa is 0.46 tall and eyes are at 0.36, so it does. Change the eye
 *     height and the whole level re-derives -- including which pieces you can
 *     hide behind, which is the stealth game.
 */
import { aabbOf } from '../core/level.js';

const DEG = Math.PI / 180;

const DEFAULTS = {
  id: 'arena',
  name: 'arena',
  cell: 1.0,
  step: 0.26,          // tallest rise you can walk onto (design doc §1.4)
  lift: 0.55,          // how high a hand reaches above the feet
  body: {
    playerRadius: 0.12, playerHeight: 0.42, eyeHeight: 0.36,
    guardRadius: 0.15, guardHeight: 0.55, guardEye: 0.30,
  },
  collectible: {
    id: 'hongbao',
    name: '红包',
    colour: '#C8102E',          // ΔE 19.6 from the kit's #F05E57 -- design doc §3.2
    shadowColour: '#8E0F22',
    sealColour: '#E8C46A',
    size: [0.16, 0.026, 0.10],
    pickup: 0.42,
  },
};

export function buildLevel({ layout, sizes, surfaces = {}, wallOpenings = {}, options = {} }) {
  const opt = {
    ...DEFAULTS, ...options,
    body: { ...DEFAULTS.body, ...(options.body || {}) },
    collectible: { ...DEFAULTS.collectible, ...(options.collectible || {}) },
  };
  const { WALL_H, PLAN, ZONES, WALLS, CORNERS, DOORS, ROOMS } = layout;
  const sizeOf = (n) => {
    const e = sizes.models ? sizes.models[n] : sizes[n];
    if (!e) throw new Error(`fromLayout: no measured size for "${n}"`);
    return e.size;
  };
  const surfOf = (n) => surfaces[n] || null;

  const solids = [];
  const openings = [];
  const notes = { wallGaps: [], openingsUsed: 0, skippedDoors: [], openings: 0 };

  /* --------------------------------------------------------------- floors */
  const floors = [];
  for (let i = 0; i < PLAN.w; i++) {
    for (let j = 0; j < PLAN.d; j++) floors.push({ x: i + 0.5, z: j + 0.5, w: 1, d: 1 });
  }

  /* ---------------------------------------------------------------- walls */
  //
  // One wall run is a line of 1 m segments (plus a `wallHalf` for a .5
  // remainder). Each segment's model decides where the gaps are.
  //
  // A `kinds` key is the segment's coordinate ALONG THE RUN (from + k),
  // NOT a 0-based index into it. A run from 3 to 8 therefore uses keys
  // 3, 4, 5, ... and `kinds: { 3: ... }` puts the doorway at 3..4, not
  // 6..7. That trap has been walked into once already.
  for (const w of WALLS) {
    const len = w.to - w.from;
    const whole = Math.floor(len + 1e-9);
    const segs = [];
    for (let k = 0; k < whole; k++) segs.push({ i: w.from + k, from: w.from + k, length: 1 });
    if (len - whole > 0.01) segs.push({ i: w.from + whole, from: w.from + whole, length: len - whole, half: true });

    for (const seg of segs) {
      // A `kinds` entry of null is a deliberate hole with no model at all.
      const declared = w.kinds && Object.prototype.hasOwnProperty.call(w.kinds, seg.i)
        ? w.kinds[seg.i] : undefined;
      if (declared === null) {
        // A whole segment removed from the run with no model in it: a
        // deliberate open bay. It is a passage exactly like a doorway --
        // the only difference is that its width is declared rather than
        // measured, because there is no model to measure.
        openings.push(makeOpening(w, seg.from + seg.length / 2, sizeOf('wall')[2],
          seg.length / 2, WALL_H, { source: 'declared', model: null }));
        continue;
      }

      const kind = declared || (seg.half ? 'wallHalf' : 'wall');
      const size = sizeOf(kind);
      const depth = size[2];
      const mid = seg.from + seg.length / 2;

      const open = wallOpenings[kind];
      const intervals = open ? open.body : [[-size[0] / 2, size[0] / 2]];
      const eyeIntervals = open ? open.eye : intervals;

      for (const [a, b] of intervals) {
        const bodySpan = { a, b };
        // `eyeIntervals` is where the wall MATERIAL is present at eye height
        // (snapshot_arena's `intervalsAt` returns `best.solid`, and its
        // unmeasured fallback is commented "treat as a solid of its own
        // measured width"). So the material blocking sight IS `covers(...)`.
        // The old `!covers(...)` read the flag backwards and left every wall
        // in the building transparent -- 65 of 65 wall solids came out
        // `blocksSight: false`, and `scripts/_walltest.mjs` measures 2 of 15
        // room-to-room sight lines as CLEAR through them.
        const blockedSight = covers(eyeIntervals, (bodySpan.a + bodySpan.b) / 2);
        const box = axisBox(w, mid + (a + b) / 2, depth, (b - a) / 2, WALL_H);
        box.kind = 'wall';
        box.model = kind;
        box.blocksMove = true;
        box.blocksSight = blockedSight;
        box.tags = ['wall', w.id];
        solids.push(box);
      }
      // Gaps that are open at head height but covered by a sight-blocker
      // (a low sill, say) need a box too. Skipped when the two agree, which is
      // every case in this kit, so this branch stays cold.
      for (const [a, b] of eyeIntervals) {
        if (covers(intervals, (a + b) / 2)) continue;
        const box = axisBox(w, mid + (a + b) / 2, depth, (b - a) / 2, WALL_H);
        box.kind = 'wall';
        box.model = kind;
        box.blocksMove = false;
        box.blocksSight = true;
        box.tags = ['wall', w.id, 'sightonly'];
        solids.push(box);
      }

      // Every gap between two solid intervals is a HOLE IN A WALL: the run
      // of the wall line you can walk through. Recorded, never sealed -- a
      // doorway is a passage in the game and must stay passable. It is
      // recorded so that "what connects these two rooms" becomes something
      // the level can answer instead of something a reader has to
      // remember, and so a nav built with `sealOpenings` can put the wall
      // back and recover one region per room.
      for (let g = 0; g + 1 < intervals.length; g++) {
        const a = intervals[g][1];
        const b = intervals[g + 1][0];
        if (b - a < 0.02) continue;
        openings.push(makeOpening(w, mid + (a + b) / 2, depth, (b - a) / 2, WALL_H,
          { source: 'measured', model: kind }));
      }
    }
  }

  /* ---------------------------------------------------------------- doors */
  //
  // The door model IS the passage, and whether it is shut is MEASURED, not
  // inferred from its name. `option.doorClosed` comes from sweeping a ray
  // across each door in the rendered scene: a leaf that covers more than 90%
  // of its own width at body height is closed. That rule reproduces the
  // expected answer from geometry alone -- `doorwayOpen` measures 8% covered
  // (an empty frame), `doorway` and `doorwayFront` measure 99% -- and it would
  // keep working if the kit ever swapped which model is the shut one.
  for (const d of DOORS) {
    const size = sizeOf(d.m);
    const declared = opt.doorClosed && Object.prototype.hasOwnProperty.call(opt.doorClosed, d.m);
    const shut = declared ? !!opt.doorClosed[d.m] : d.m !== 'doorwayOpen';
    const box = {
      id: `door:${d.m}:${d.x}:${d.z}`,
      model: d.m,
      kind: 'door',
      x: d.x, z: d.z, rot: d.r || 0,
      hx: size[0] / 2, hz: size[2] / 2,
      y0: 0, y1: size[1],
      blocksMove: shut,
      blocksSight: shut,
      tags: ['door', shut ? 'closed' : 'open'],
      room: null,
      glass: surfOf(d.m)?.glass || null,
      red: null,
    };
    box.footprint = aabbOf(box);
    solids.push(box);
    if (shut) notes.skippedDoors.push(d.m);
  }

  /* ------------------------------------------------------------ furniture */
  for (const room of ROOMS) {
    for (const it of room.items) {
      if (it.skip) continue;
      const size = sizeOf(it.m);
      const s = it.s && it.s !== 1 ? it.s : 1;
      const y0 = it.y || 0;
      const y1 = y0 + size[1] * s;
      const surf = surfOf(it.m);

      const box = {
        id: `${room.id}#${it.m}@${it.x.toFixed(2)},${it.z.toFixed(2)}`,
        model: it.m,
        kind: 'furniture',
        x: it.x, z: it.z, rot: it.r || 0,
        hx: (size[0] * s) / 2, hz: (size[2] * s) / 2,
        y0, y1,
        // Derived, never declared:
        blocksMove: y1 > opt.step,
        blocksSight: y1 > opt.body.eyeHeight,
        climbable: y1 <= opt.step,
        tags: [room.id, it.y ? 'elevated' : 'grounded'],
        room: room.id,
        red: surf?.red ? scaleBox(surf.red, s, y0) : null,
        glass: surf?.glass ? scaleBox(surf.glass, s, y0) : null,
      };
      box.footprint = aabbOf(box);
      solids.push(box);
    }
  }

  /* ---------------------------------------------------------------- rooms */
  //
  // Rooms carry only a SEED. Their rectangles are filled in by resolveRooms()
  // after the walkable grid exists, by flood-filling and asking which region
  // each seed landed in. Hand-drawing rectangles would silently disagree with
  // the walls the moment someone moves one.
  const rooms = ZONES.map((z) => ({ id: z.id, name: z.name, seed: [z.at[0], z.at[1]] }));

  /* ---------------------------------------------------------------- spawn */
  const spawn = deriveSpawn(layout, PLAN, solids, opt);

  return {
    // THE GEOMETRY TRAVELS WITH THE LEVEL.
    //
    // A level said which ROOMS exist, where the walls block movement and where
    // the 红包 go -- and said nothing at all about what to BUILD. The renderer
    // therefore built `js/layout.js`'s apartment whatever arena it had been
    // handed, and a page playing a generated 16 x 14 m ten-room floor drew the
    // shipped 10 x 8 m six-room one: the player spawned outside the flat,
    // looking at its exterior wall, with the 红包 hanging in empty space.
    // Measured before the fix, scripts/diag_world.mjs: plan 16x14 with 10
    // rooms vs apartment 10.14x8.15 with 6.
    //
    // So the copy of the layout this level was built from goes into the level.
    // Not a PATH to it -- a path cannot describe a floor generated in a browser,
    // which has no file to point at, and a stale path is a second truth waiting
    // to disagree with the first. The snapshot IS the geometry, so the arena is
    // self-describing and `level.meta.plan` can be checked against `layout.PLAN`
    // by anyone who receives it.
    layout: {
      WALL_H, PLAN,
      ZONES: ZONES || [], WALLS: WALLS || [], CORNERS: CORNERS || [],
      DOORS: DOORS || [], ROOMS: ROOMS || [],
    },
    meta: {
      id: opt.id, name: opt.name,
      wallH: WALL_H,
      plan: { w: PLAN.w, d: PLAN.d },
      cell: opt.cell,
      step: opt.step,
      lift: opt.lift,
      source: opt.source || 'layout',
      solids: solids.length,
      floorTiles: floors.length,
    },
    floors,
    solids,
    openings,
    rooms,
    spawn,
    notes: { ...notes, openings: openings.length },
    collectible: opt.collectible,
    body: opt.body,
    notes,
  };
}

/* ------------------------------------------------------------------ helpers */

function covers(intervals, x, eps = 1e-6) {
  return intervals.some(([a, b]) => x >= a - eps && x <= b + eps);
}

/**
 * A hole in a wall run, in the same frame as the wall boxes around it, so
 * that sealing one really does put the wall back where it was.
 *
 * The thickness is forced to at least 0.16 m even though the kit's walls
 * are 0.05 m. A sealed opening is tested by sampling a straight line at
 * cell/8 intervals; a 0.05 m slab can fall between two samples, and a wall
 * you can step over is not a wall.
 */
function makeOpening(run, alongWorld, depth, halfLen, wallH, extra) {
  const thick = Math.max(depth / 2, 0.08);
  const at = run.at + run.side * 0.025;
  const base = run.axis === 'x'
    ? { x: alongWorld, z: at, hx: halfLen, hz: thick }
    : { x: at, z: alongWorld, hx: thick, hz: halfLen };
  return {
    ...base,
    id: `open:${run.id}:${alongWorld.toFixed(3)}`,
    kind: 'opening',
    wall: run.id,
    rot: 0,
    y0: 0, y1: wallH,
    // Never blocking: an opening is a passage. Sealing is a nav option.
    blocksMove: false,
    blocksSight: false,
    ...extra,
  };
}

/** A wall box on a run: `axis` decides which way the thickness points. */
function axisBox(run, alongWorld, depth, halfLen, wallH) {
  if (run.axis === 'x') {
    return {
      id: `wall:${run.id}:${alongWorld.toFixed(3)}`,
      x: alongWorld, z: run.at + run.side * 0.025,
      rot: 0, hx: halfLen, hz: depth / 2,
      y0: 0, y1: wallH,
    };
  }
  return {
    id: `wall:${run.id}:${alongWorld.toFixed(3)}`,
    x: run.at + run.side * 0.025, z: alongWorld,
    rot: 0, hx: depth / 2, hz: halfLen,
    y0: 0, y1: wallH,
  };
}

/** A model sub-box (red patch, glass pane) promoted into the placed frame. */
function scaleBox(box, s, yOff) {
  return {
    min: [box.min[0] * s, box.min[1] * s + yOff, box.min[2] * s + (0)],
    max: [box.max[0] * s, box.max[1] * s + yOff, box.max[2] * s + (0)],
  };
}

/**
 * Stand just inside the front door.
 *
 * Derived from the perimeter door model rather than typed in, so moving the
 * entrance in layout.js moves the spawn with it.
 *
 * THE REQUEST AND THE GUARANTEE ARE DIFFERENT THINGS, and conflating them cost
 * three assertions on the first generated floor to place a door beside a
 * partition. The request is "0.75 m inward from the door toward the plan
 * centre". The guarantee has to be "a point the walker can occupy", because a
 * straight line to the middle of the flat crosses whatever internal wall stands
 * in the way. Measured on that floor: the requested point sat 0.071 m from a
 * wall and 0.067 m from the bookcase against it -- inside both, so
 * `nav.componentAt()` answered -1 for a floor that was structurally fine.
 *
 * So the request is honoured verbatim WHENEVER IT IS LEGAL, and only otherwise
 * does the spawn walk in from the doorway along the door's own inward normal,
 * stopping at the last clear point before the first blockage -- which is by
 * construction on the entrance side of whatever the straight line was cutting
 * through. Measured on the shipped apartment the requested point has 0.36 m of
 * clearance, so the shipped spawn is bit-for-bit what it always was, and every
 * measurement taken from it stays valid.
 *
 * Clearance mirrors `nav.clear()` at ground level rather than calling it:
 * this runs BEFORE the walkable grid exists, and the arena layer is not
 * allowed to depend on the nav layer having been built.
 */
function deriveSpawn(layout, PLAN, solids, opt) {
  const centre = { x: PLAN.w / 2, z: PLAN.d / 2 };
  const doors = layout.DOORS || [];
  const front = doors.find((d) => d.m === 'doorwayFront')
    || doors.find((d) => d.z >= PLAN.d - 0.6 || d.z <= 0.6 || d.x >= PLAN.w - 0.6 || d.x <= 0.6)
    || doors[0];
  if (!front) return { x: centre.x, z: centre.z, yaw: 0 };
  const dx = centre.x - front.x;
  const dz = centre.z - front.z;
  const len = Math.hypot(dx, dz) || 1;
  const inside = { x: front.x + (dx / len) * 0.75, z: front.z + (dz / len) * 0.75 };
  // Face out of the door, i.e. back the way we came in.
  const face = (p) => Math.atan2(front.z - p.z, front.x - p.x);

  const radius = (opt.body && opt.body.playerRadius) || 0.12;
  const bodyH = (opt.body && opt.body.playerHeight) || 0.42;
  const clear = (x, z) => !solids.some((s) => {
    if (s.blocksMove === false) return false;   // a passage, or a pane of glass
    if (s.y1 <= opt.step) return false;         // at or under the feet: walk over
    if (s.y0 >= bodyH) return false;            // over the head: walk under
    const a = -(s.rot * Math.PI) / 180;
    const lx = (x - s.x) * Math.cos(a) - (z - s.z) * Math.sin(a);
    const lz = (x - s.x) * Math.sin(a) + (z - s.z) * Math.cos(a);
    const qx = Math.max(Math.abs(lx) - s.hx, 0);
    const qz = Math.max(Math.abs(lz) - s.hz, 0);
    return qx * qx + qz * qz < radius * radius;  // circular, like nav's
  });

  if (clear(inside.x, inside.z)) return { x: inside.x, z: inside.z, yaw: face(inside) };

  // Blocked. Walk in along the door's OWN normal: a door is set in a wall that
  // runs along X or along Z, and its inward side is whichever way the centre is.
  const wallAlongZ = front.r === 90 || front.r === -90;
  const nx = wallAlongZ ? (Math.sign(centre.x - front.x) || 1) : 0;
  const nz = wallAlongZ ? 0 : (Math.sign(centre.z - front.z) || 1);
  let best = null;
  for (let t = 0.05; t <= 2.05; t += 0.05) {
    const x = front.x + nx * t;
    const z = front.z + nz * t;
    if (clear(x, z)) best = { x, z };
    else if (best) break;                       // walked into something: stop short of it
  }
  if (!best) return { x: inside.x, z: inside.z, yaw: face(inside) };
  return { x: best.x, z: best.z, yaw: face(best) };
}

/** Total footprint area of every solid, for a sanity cross-check. */
export function solidArea(level) {
  return level.solids.reduce((a, s) => a + s.hx * 2 * s.hz * 2, 0);
}
