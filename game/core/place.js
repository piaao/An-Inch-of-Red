/**
 * place.js — where the 红包 go, and how hard each one is.
 *
 * The design's difficulty dial is the visibility tier mix (20/35/30/15 %).
 * A tier is not a label someone types next to a coordinate: it is MEASURED --
 * the fraction of the room from which the thing can be seen at all. So the
 * same code decides "how hard is this" and "did the placement hit its target
 * mix", and a stale label cannot survive a re-run.
 *
 * Three sources of hiding places, and none of them is the floor:
 *   top     — on a surface you can climb to (table, bed, counter, shelf)
 *   tucked  — a top that is also bracketed: 16 rays out, a quarter of them
 *             stopped, and at least one taller neighbour. This is "夹在物品中间"
 *             as a MEASUREMENT, so moving the furniture moves the hiding places.
 *   inside  — behind a pane of glass (fridge, microwave), attenuated
 *
 * There used to be a fourth, `floor`, and its deletion is the player's first
 * complaint ("不要放在地上，太容易被发现了"): it contributed 230 candidates, the
 * only ones at y = 0, and a packet in the open on the floor is spotted from the
 * doorway. The function is gone rather than unused -- see the note above it.
 *
 * Everything else about the placement is a hard constraint, not a preference:
 * every prize must be REACHABLE (a 红包 nobody can grab is a bug, not a
 * challenge) and every prize must be VISIBLE from at least one spot, or it can
 * never be found and the level is unwinnable.
 */
import {
  TIERS, TIER_INFO, DEFAULT_TIER_TARGET, tierCounts, toWorld, aabbOf,
  climbCeilOf, rayBox3,
} from './level.js';
import { sightLine, reachable } from './vision.js';
import { climbPlan, CLIMB } from './climb.js';
import { Rng } from './rng.js';

/**
 * The single definition of "which random stream lays out the 红包".
 *
 * This existed twice and the two copies disagreed. The game drew from a stream
 * built as Rng(seed) forked to 'place'; the workbench's validator drew from a
 * differently-labelled one. Both looked deliberate. The consequence was not:
 * the plan the workbench draws was marking hiding places the game would never
 * use. Measured over the 17 parameter sets the suites actually run, 16 of them
 * placed the six 红包 differently under the two labels -- up to 8.85 m between a
 * previewed dot and the nearest real one, which is a different room's worth of
 * wrong.
 *
 * Both callers come here now. A second copy of this is not a style problem; it
 * is a preview that lies.
 */
export function prizeRng(seed) {
  return new Rng(seed).fork('place');
}

/**
 * The lowest a 红包 may sit.
 *
 * The player's words were "不要放在地上，太容易被发现了", and this is where
 * "on the ground" ends: above every rug (the kit's rugs are 0.01 m) and above
 * the floor, below every usable table top in this flat (a coffee table is
 * 0.23). It is a DESIGNED line, stated as such -- the thing it must not do is
 * pretend to be derived. What is derived, and asserted in
 * scripts/verify_play.mjs, is the consequence: NO packet ends up on the floor.
 *
 * It applies to TOPS, not to glass volumes: a packet inside a fridge sits at
 * y = 0.12 because that is the floor OF THE FRIDGE, which is the "柜子里面" the
 * player asked for in the same breath as "not on the ground".
 */
const OFF_GROUND = 0.20;

/** A quarter of the rays in the way, plus a taller neighbour: "wedged in". */
const TUCKED_FRACTION = 0.25;

/** Half the wall thickness, plus a hair — keeps anchors off the plaster. */
const WALL_PAD = 0.09;

/* -------------------------------------------------------------- anchoring */

function anchorId(kind, x, z, y, extra = '') {
  return `${kind}:${x.toFixed(2)}:${z.toFixed(2)}:${y.toFixed(2)}${extra}`;
}

/* `floorAnchors` used to live here, and it is gone on purpose.
 *
 * It was the biggest source of candidates -- 230 of them, and the only ones at
 * y = 0 -- and it is exactly what the player objected to: a packet lying on the
 * floor in the open is spotted from the doorway, which is "太容易被发现". Every
 * remaining source sits on or in something. The function was deleted rather
 * than left unused, because an unused source that still compiles is a source
 * someone will switch back on. */

function roomAt(level, x, z) {
  for (const r of level.rooms) {
    const b = r.rect;
    if (x >= b.x0 + WALL_PAD && x <= b.x1 - WALL_PAD && z >= b.z0 + WALL_PAD && z <= b.z1 - WALL_PAD) {
      return r.id;
    }
  }
  return null;
}

/** Points on a furniture top, sampled in the solid's own frame. */
function topPoints(s, step = 0.33) {
  const nx = Math.max(1, Math.min(3, Math.floor((s.hx * 2) / step)));
  const nz = Math.max(1, Math.min(3, Math.floor((s.hz * 2) / step)));
  const out = [];
  for (let a = 0; a < nx; a++) {
    for (let b = 0; b < nz; b++) {
      const lx = -s.hx + 0.06 + ((s.hx * 2 - 0.12) * (nx === 1 ? 0.5 : a / (nx - 1)));
      const lz = -s.hz + 0.06 + ((s.hz * 2 - 0.12) * (nz === 1 ? 0.5 : b / (nz - 1)));
      out.push(toWorld(s, lx, lz));
    }
  }
  return out;
}

/** Is the air directly above this patch of top free? A wall cabinet over a
 *  counter would otherwise bury the packet inside geometry. */
function topIsClear(level, p, top, host) {
  for (const o of level.solids) {
    if (o === host) continue;
    if (o.y0 > top + 0.02 && o.y1 > top + 0.02) {
      const ang = -(o.rot * Math.PI) / 180;
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      const lx = dx * Math.cos(ang) - dz * Math.sin(ang);
      const lz = dx * Math.sin(ang) + dz * Math.cos(ang);
      if (Math.abs(lx) <= o.hx && Math.abs(lz) <= o.hz) return false;
    }
  }
  return true;
}

/**
 * How buried is a point? 16 rays out to `reach`, and how many are stopped.
 *
 *   blocked  8 bearings x (level, up). No downward ray: the thing the packet is
 *            sitting ON is directly below it and would score every point as
 *            perfectly hidden.
 *   taller   how many of the rays were stopped by something rising at least
 *            0.10 m ABOVE the anchor. This is the distinction the player drew:
 *            "夹在物品中间" is not "in a corner". A corner has walls; only a
 *            taller neighbour means the packet is wedged between things and
 *            shades whatever is looking at it.
 *
 * `boxes` is the pre-computed AABB list; a 0.9 m pre-filter throws out most of
 * the 189 solids before any ray is cast, which is the difference between a
 * loading screen and a loading screen you notice.
 */
function enclosure(boxes, x, z, y, reach = 0.7) {
  let blocked = 0;
  let taller = 0;
  const pad = reach + 0.05;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    for (const up of [0, 0.55]) {
      const ex = x + Math.cos(a) * reach * Math.cos(up);
      const ez = z + Math.sin(a) * reach * Math.cos(up);
      const ey = y + reach * Math.sin(up);
      const ray = { x, y: y + 0.01, z };
      const to = { x: ex, y: ey, z: ez };
      for (const b of boxes) {
        if (b.x1 < x - pad || b.x0 > x + pad) continue;
        if (b.z1 < z - pad || b.z0 > z + pad) continue;
        const h = rayBox3(b.s, ray, to);
        if (!h || h.tmax < 0 || h.tmin > 1) continue;
        blocked += 1;
        if (b.s.y1 >= y + 0.10) taller += 1;
        break;
      }
    }
  }
  return { blocked, taller, total: 16 };
}

/**
 * Every place a 红包 can sit that is NOT the floor: on a top, or wedged on one.
 *
 * Sampled in the solid's own frame so rotation is handled once, and classified
 * by `enclosure` rather than by a list of "safe" coordinates -- so moving the
 * furniture moves the hiding places with it, and a different arena (one with no
 * bookshelves at all) produces different hiding places without an edit here.
 */
/**
 * Exported so the DIAGNOSTIC can drive the real filter instead of a copy of it.
 *
 * Everything downstream of here (`measureExposure`, `reachable`) is already
 * public, so keeping this one private meant the only way to ask "why did this
 * room produce nothing" was to re-implement it -- and a replica of a filter is
 * not the filter. See scripts/diag_anchors.mjs.
 */
export function topAnchors(level, opts = {}) {
  const step = opts.topStep != null ? opts.topStep : 0.33;
  const ceil = climbCeilOf(level);
  const boxes = level.solids.map((s) => ({ s, ...aabbOf(s) }));
  const out = [];
  const stats = { tooLow: 0, buried: 0, noRoom: 0 };
  for (const s of level.solids) {
    if (s.kind !== 'furniture') continue;
    if (s.hx < 0.09 || s.hz < 0.09) continue;      // too narrow to set anything on
    if (!(s.y1 >= OFF_GROUND)) { stats.tooLow += 1; continue; }
    for (const p of topPoints(s, step)) {
      const room = roomAt(level, p.x, p.z);
      if (!room) { stats.noRoom += 1; continue; }
      if (!topIsClear(level, p, s.y1, s)) { stats.buried += 1; continue; }
      const enc = enclosure(boxes, p.x, p.z, s.y1);
      const frac = enc.blocked / enc.total;
      const tucked = frac >= TUCKED_FRACTION && enc.taller > 0;
      out.push({
        id: anchorId(tucked ? 'tucked' : 'top', p.x, p.z, s.y1, ':' + s.id),
        x: p.x, z: p.z, y: s.y1, room,
        source: tucked ? 'tucked' : 'top',
        host: s.id, model: s.model,
        enclosure: frac, bracketed: enc.taller,
        // What it would take to stand next to it. Filled in by `reachable`.
        ceilingSafe: s.y1 < ceil,
      });
    }
  }
  out.stats = stats;
  return out;
}

/**
 * Points inside a glass-fronted volume.
 *
 * "Usable glass" is derived, not listed: the model must HAVE a glass sub-box
 * big enough to be a door rather than a mirror, and it must be a box you could
 * put something inside (a fridge, a microwave, a washer -- not a mirror, which
 * is a pane with nothing behind it).
 */
/** Exported for the same reason as `topAnchors`: the diagnostic needs the real one. */
export function insideAnchors(level, opts = {}) {
  const minGlassArea = opts.minGlassArea != null ? opts.minGlassArea : 0.04;
  const out = [];
  const rejected = {};
  for (const s of level.solids) {
    if (!s.glass) continue;
    const gw = s.glass.max[0] - s.glass.min[0];
    const gh = s.glass.max[1] - s.glass.min[1];
    if (gw * gh < minGlassArea) { rejected[s.model] = 'glass patch too small (mirror-like)'; continue; }
    if (s.hx < 0.14 || s.hz < 0.1) { rejected[s.model] = 'volume too shallow to hold anything'; continue; }
    const room = roomAt(level, s.x, s.z);
    if (!room) continue;
    // Sit it on the floor of the host volume, a little behind the glass so it
    // reads as "inside" rather than "stuck on the door".
    const depth = Math.min(s.hx, s.hz);
    out.push({
      id: anchorId('inside', s.x, s.z, Math.max(s.y0, 0.10), ':' + s.id),
      x: s.x, z: s.z, y: Math.max(s.y0, 0.12), room, source: 'inside', host: s.id,
      inset: depth * 0.3,
    });
  }
  return { anchors: out, rejected };
}

/* ------------------------------------------------------------ measurement */

/**
 * How exposed is this anchor? Walk a set of viewpoints through its own room
 * (plus the rooms next door, because you can often see through a doorway) and
 * count from how many of them the anchor is actually visible.
 */
export function measureExposure(level, nav, anchor, opts = {}) {
  const eyeY = opts.eyeY != null ? opts.eyeY : level.body.eyeHeight;
  const range = opts.range != null ? opts.range : 6.0;
  const viewpoints = opts.viewpoints || null;

  let total = 0;
  let seen = 0;
  let glassOnly = true;
  let glassSeen = 0;
  const samples = [];

  const list = viewpoints || defaultViewpoints(level, nav);
  for (const v of list) {
    const d = Math.hypot(v.x - anchor.x, v.z - anchor.z);
    if (d > range) continue;
    total += 1;
    // A viewpoint may carry its OWN eye height, because not every standpoint is
    // on the floor any more: the eye of a body standing on a 0.60 m chair is at
    // 0.96 m, and measuring it at 0.36 would be the flat-plane mistake one
    // level up. `v.eye` is optional; a floor viewpoint has no such field and
    // reads `eyeY`, so the pre-climbing viewpoint list keeps its meaning.
    const ve = v.eye != null ? v.eye : eyeY;
    const los = sightLine(level, v, { x: anchor.x, z: anchor.z }, ve,
      anchor.y != null ? anchor.y : ve);
    if (los.clear) {
      seen += 1;
      glassSeen += los.glass > 0 ? 1 : 0;
      if (los.glass === 0) glassOnly = false;
      samples.push({ x: v.x, z: v.z, d, glass: los.glass });
    }
  }
  const cover = total ? seen / total : 0;
  const tier = glassOnly && seen > 0 ? 'inside' : tierFromCover(cover);
  return { cover, seen, total, glassOnly, glassSeen, tier, samples };
}

/**
 * The thresholds. These are the difficulty dial: `open` is spotted from across
 * the room, `concealed` only from close up.
 *
 * RE-MEASURED AFTER THE WALLS STARTED BLOCKING SIGHT (patch_p52). The previous
 * top cut was 0.34, chosen when a viewpoint in one room could see into another
 * and every cover was therefore inflated. With walls opaque the pool's whole
 * distribution slid down (p90 is 0.252 now) and 0.34 sat above the 96th
 * percentile -- the pool offered ~2 `open` anchors a seed against ~26
 * `concealed`, and the target mix was unreachable.
 *
 * `scripts/diag_tiers.mjs` prints the cuts that reproduce the design's
 * 20/35/30/15 on the measured pool; 0.14 is that number. The LOWER cut is
 * unchanged, and that is the point: 0.07 was still right, so the scale did not
 * move, only the top of it. `inside` stays short of its 15% because this flat
 * has two usable glass volumes -- a fact about the building, not a threshold.
 */
export function tierFromCover(cover) {
  if (cover >= 0.14) return 'open';
  if (cover >= 0.07) return 'partial';
  if (cover > 0) return 'concealed';
  return 'hidden';               // visible from nowhere: unusable
}

/**
 * Standpoints a player could reasonably occupy, on a metric lattice.
 *
 * "Every walkable cell centre" was the same 0.5 m spacing while the nav
 * cell was 1 m. At 5 cm it is 23000 standpoints, and exposure is measured
 * by sight-testing an anchor from every one of them, so the lattice keeps
 * the same spacing the floor anchors use.
 */
export function defaultViewpoints(level, nav, spacing = 0.5) {
  const out = [];
  const every = Math.max(1, Math.round(spacing / nav.cell));
  for (let j = 0; j < nav.d; j += every) {
    for (let i = 0; i < nav.w; i += every) {
      if (nav.walkable[j * nav.w + i]) {
        const c = nav.centreOf(i, j);
        // `eye` is explicit even though it equals the level's own eye height:
        // it is the field `climbViewpoints` puts a DIFFERENT number in, and a
        // reader should be able to see the two cases side by side.
        out.push({ x: c.x, z: c.z, eye: level.body.eyeHeight });
      }
    }
  }
  return out;
}

/**
 * The standpoints you have to CLIMB to, with their eye on the surface.
 *
 * This is not a refinement of the exposure test, it is what makes the test
 * meaningful at all for a packet above the eye line. A thing sitting on
 * something is inside that thing's footprint, so every sight line to it crosses
 * the thing, and to clear the crossing the line must be above the top AT THE
 * CROSSING -- which an eye at 0.36 m cannot be for a 0.45 m counter and an eye
 * at 0.81 m can. Without these viewpoints a counter-top packet measured as
 * `hidden`, and `hidden` anchors are thrown away.
 *
 * scripts/probe_climb.mjs measures the effect on the real arena rather than
 * asserting it: over 3000 same-room pairs, 20 were invisible with the eye on
 * the floor and visible from up there, and none went the other way.
 */
export function climbViewpoints(level, nav, plan, opts = {}) {
  const p = plan || climbPlan(level, nav, opts);
  const out = [];
  for (const s of p.surfaces) {
    if (!p.reached.has(s.id)) continue;         // no route: not a standpoint
    out.push({ x: s.x, z: s.z, y: s.y, eye: s.y + level.body.eyeHeight, climb: s.y });
  }
  return out;
}

/**
 * The look-points a PERSON uses: one turn per room, plus one per climbable thing.
 *
 * `defaultViewpoints` is a 0.5 m lattice and it is the right tool for MEASURING
 * exposure -- it is uniform, so "seen from 5 % of the flat" means something. It
 * is the wrong tool for PRICING SEARCH, and the difference is not small:
 * scripts/diag_coverage.mjs put a number on it. A greedy set cover of the
 * 269-point lattice needs 3.3 looks to see all six packets, and the same cover
 * over six room centres plus one stop per climbable model needs 3.4 -- so the
 * placement is not what costs time. What costs time is that 269 standpoints x
 * 2.2 s of turning is 592 s of looking, and a walker sampling that lattice in
 * distance order spends a 180 s budget on the nearest forty of them.
 *
 * So this is the vantage list the rig hands the "player" persona: walk into each
 * room and turn once (`rooms`), then climb onto the countable things in it
 * (`climbed`, one standpoint per model per room -- you climb onto THE counter,
 * not onto five 5 cm marks along it). It is a top-level path through the flat,
 * which is what a person walks.
 */
export function playerViewpoints(level, nav, plan, opts = {}) {
  const p = plan || climbPlan(level, nav, opts);
  const out = [];
  for (const r of level.rooms) {
    const c = nav.nearestWalkable(r.cx, r.cz);
    if (c) out.push({ x: c.x, z: c.z, eye: level.body.eyeHeight, kind: 'room', room: r.id });
  }
  // One standpoint per (room, model): of all the surfaces of one model in one
  // room, the point nearest that room's centre. Keyed on `room|model` rather
  // than on the host id, so two identical nightstands are one look, not two.
  const best = new Map();
  for (const s of p.surfaces) {
    if (!p.reached.has(s.id)) continue;
    const r = level.rooms.find((x) => x.id === s.room);
    const d = r ? Math.hypot(s.x - r.cx, s.z - r.cz) : 0;
    const key = `${s.room}|${s.model}`;
    const cur = best.get(key);
    if (!cur || d < cur.d) best.set(key, { s, d });
  }
  for (const { s } of best.values()) {
    out.push({
      x: s.x, z: s.z, y: s.y, eye: s.y + level.body.eyeHeight,
      climb: s.y, kind: 'climbed', model: s.model, room: s.room,
    });
  }
  return out;
}

/* -------------------------------------------------------------- selection */

/**
 * Build the level's hiding places and pick the prizes.
 *
 * @param opts.count     how many 红包 (default 6)
 * @param opts.target    tier mix (default 20/35/30/15)
 * @param opts.spread    true: strongly prefer one prize per room
 * @param opts.exposure  overrides for measureExposure (range, eyeY)
 */
export function placePrizes(level, nav, rng, opts = {}) {
  const count = opts.count != null ? opts.count : 6;
  const target = opts.target || DEFAULT_TIER_TARGET;
  const spread = opts.spread !== false;
  const policy = opts.policy || (spread ? 'spread' : 'quota');
  const exposureOpts = opts.exposure || {};

  // The climb graph comes FIRST, because both later stages need it: the
  // viewpoints look through the eyes that are up there, and `reachable` needs
  // to know which tops have a route from the spawn before it can promise a
  // packet on one is obtainable.
  const plan = opts.plan || climbPlan(level, nav, opts);
  const viewpoints = [
    ...(opts.viewpoints || defaultViewpoints(level, nav)),
    ...(opts.climbViewpoints || climbViewpoints(level, nav, plan)),
  ];

  // ---- 1. enumerate every candidate spot --------------------------------
  const tops = topAnchors(level, opts);
  const inside = insideAnchors(level, opts);

  const raw = [...tops, ...inside.anchors];

  // ---- 2. measure each one, and drop the unusable -----------------------
  const stats = {
    candidates: { top: 0, tucked: 0, inside: inside.anchors.length },
    anchorRejects: { ...tops.stats },
    rejected: { unreachable: 0, invisible: 0, byModel: { ...inside.rejected } },
    byTier: { open: 0, partial: 0, concealed: 0, inside: 0, hidden: 0 },
    viewpoints: { total: viewpoints.length, climbed: viewpoints.length
      - (opts.viewpoints || []).length },
  };

  const scored = [];
  for (const a of raw) {
    const exp = measureExposure(level, nav, a, { ...exposureOpts, viewpoints });
    stats.byTier[exp.tier] = (stats.byTier[exp.tier] || 0) + 1;
    if (stats.candidates[a.source] != null) stats.candidates[a.source] += 1;
    if (exp.tier === 'hidden') { stats.rejected.invisible += 1; continue; }
    const reach = reachable(level, nav, a, {
      reach: opts.reach, lift: opts.lift, plan,
    });
    if (!reach.ok) { stats.rejected.unreachable += 1; continue; }
    scored.push({
      ...a, ...exp,
      stand: reach.stand, pad: reach.pad, climb: reach.climb, via: reach.kind,
    });
  }

  // ---- 3. choose WHERE, then which -------------------------------------
  //
  // COVERAGE FIRST, tier mix second. `count` prizes are spread over the rooms
  // as evenly as the count allows, and only then does each room choose which of
  // its anchors to spend -- preferring whichever tier still has quota left.
  //
  // The other order was the original, and its failure is worth keeping written
  // down: filling the tier quota first and worrying about rooms afterwards
  // meant that the BATHROOM (3.7 m2, so every anchor in it is fully exposed)
  // could only ever supply the single `open` slot. Living took that slot on
  // higher exposure, and the bathroom got no 红包 in any seed, reported only as
  // "spread 5/6 rooms". Six prizes in six rooms is also just the right design:
  // if the player can win without entering the bathroom, the bathroom is
  // decoration.
  //
  // `policy: 'quota'` keeps the old order, because the difference between the
  // two IS a measurement -- and the verification report prints both.
  const quota = tierCounts(count, target);
  const need = { ...quota };
  const chosen = [];

  if (policy === 'quota') {
    const usedRooms = new Map();
    const seenIds = new Set();
    for (const tier of TIERS) {
      let want = quota[tier] || 0;
      if (!want) continue;
      const pool = scored.filter((a) => a.tier === tier && !seenIds.has(a.id));
      if (!pool.length) continue;

      const byRoom = new Map();
      for (const a of rng.shuffle(pool)) {
        if (!byRoom.has(a.room)) byRoom.set(a.room, []);
        byRoom.get(a.room).push(a);
      }
      for (const list of byRoom.values()) list.sort((p, q) => q.cover - p.cover);

      let progress = true;
      while (want > 0 && progress) {
        progress = false;
        const rooms = [...byRoom.entries()]
          .filter(([, list]) => list.length)
          .sort((p, q) => ((usedRooms.get(p[0]) || 0) - (usedRooms.get(q[0]) || 0))
            || (q[1].length - p[1].length));
        for (const [room, list] of rooms) {
          if (want <= 0) break;
          const a = list.shift();
          chosen.push(a);
          seenIds.add(a.id);
          usedRooms.set(room, (usedRooms.get(room) || 0) + 1);
          want -= 1;
          progress = true;
        }
      }
    }
    while (chosen.length < count) {
      const rest = scored.filter((a) => !seenIds.has(a.id));
      if (!rest.length) break;
      rest.sort((a, b) => b.cover - a.cover);
      const pick = rest.find((a) => !usedRooms.has(a.room)) || rest[0];
      seenIds.add(pick.id);
      chosen.push(pick);
      usedRooms.set(pick.room, (usedRooms.get(pick.room) || 0) + 1);
    }
  } else {
    // ---- 'spread': a RANDOM SUBSET of the rooms, one or two each ---------
    //
    // WHAT CHANGED AND WHY IT IS NOT A DETAIL. This branch used to hand out
    // `floor(count / rooms)` 红包 per room, which with six of each was exactly
    // one per room, every seed, for ever. The reasoning was sound as far as it
    // went ("if the player can win without entering the bathroom, the bathroom
    // is decoration") and the player has overruled it:
    //
    //     不是每个房间都必须有
    //
    // and the counter-argument is the better one. A guaranteed packet in every
    // room turns the flat into a checklist, and a checklist gets walked rather
    // than searched: the only question left is "which order". With the rooms
    // DRAWN, "have I swept this one properly, or is it the empty one" has no
    // safe answer, and the number of rooms a run must enter becomes a random
    // variable instead of a constant six.
    //
    // Bounded so it cannot degenerate into "everything in the bedroom":
    //   * 3-5 of the 6 rooms are drawn, so at least ONE is always empty
    //   * no room holds more than `maxPerRoom` (2)
    //   * every drawn room holds at least one
    //   * if a drawn room cannot supply its share the remainder goes to the
    //     best anchors anywhere, so `count` is still honoured
    const roomIds = [...new Set(scored.map((a) => a.room))].sort();
    const maxPerRoom = opts.maxPerRoom != null ? opts.maxPerRoom : 2;
    const minRooms = Math.max(1, Math.ceil(count / maxPerRoom));
    const maxRooms = Math.max(minRooms, Math.min(roomIds.length - 1, count));
    const k = maxRooms > minRooms ? minRooms + rng.int(maxRooms - minRooms + 1) : minRooms;
    const drawn = roomIds.length ? rng.shuffle(roomIds).slice(0, k) : [];
    const per = new Map(drawn.map((id) => [id, 1]));
    let left = count - drawn.length;
    while (left > 0) {
      const open = drawn.filter((id) => (per.get(id) || 0) < maxPerRoom);
      if (!open.length) break;
      const id = open[rng.int(open.length)];
      per.set(id, (per.get(id) || 0) + 1);
      left -= 1;
    }
    for (const id of drawn) {
      const list = scored.filter((a) => a.room === id);
      for (let n = 0; n < (per.get(id) || 0) && list.length; n++) {
        // Spend a tier that still has quota first; exposure breaks the tie.
        list.sort((a, b) => ((need[b.tier] || 0) - (need[a.tier] || 0)) || (b.cover - a.cover));
        const a = list.shift();
        chosen.push(a);
        need[a.tier] = Math.max(0, (need[a.tier] || 0) - 1);
      }
    }
    // A drawn room that came up short: the remainder goes to the best left.
    const taken = new Set(chosen.map((a) => a.id));
    while (chosen.length < count) {
      const rest = scored.filter((a) => !taken.has(a.id));
      if (!rest.length) break;
      rest.sort((a, b) => b.cover - a.cover);
      taken.add(rest[0].id);
      chosen.push(rest[0]);
    }
    stats.draw = {
      rooms: roomIds.length, drawn: drawn.length, k,
      perRoom: Object.fromEntries(per), empty: roomIds.filter((id) => !per.has(id)),
    };
  }

  const prizes = chosen.slice(0, count).map((a, i) => ({
    id: `hb${i + 1}`,
    x: a.x, z: a.z, y: a.y,
    room: a.room,
    tier: a.tier,
    cover: a.cover,
    source: a.source,
    host: a.host || null,
    // How buried it is (16 rays) and what it takes to stand next to it. Both
    // travel with the prize, because the verifier has to be able to ask "is
    // every packet actually off the ground and actually reachable" without
    // re-running the placement, and the difficulty card has to be able to say
    // "this one is up on the fridge".
    enclosure: a.enclosure != null ? a.enclosure : null,
    bracketed: a.bracketed != null ? a.bracketed : 0,
    stand: a.stand,
    pad: a.pad || null,
    climb: a.climb || 0,
    standKind: a.via || null,
    idealEye: (a.source === 'inside' ? 0 : a.y) + level.body.eyeHeight * 0.0,
  }));

  const achieved = {};
  for (const t of TIERS) achieved[t] = prizes.filter((p) => p.tier === t).length;

  const drawn = stats.draw || null;
  const roomCounts = {};
  for (const p of prizes) roomCounts[p.room] = (roomCounts[p.room] || 0) + 1;

  return {
    prizes,
    report: {
      policy, quota, achieved, stats,
      // The two facts the player's complaint was about, as numbers rather than
      // as intentions: which rooms were drawn (and which were left empty), and
      // how buried each packet is.
      roomsUsed: Object.keys(roomCounts).length,
      roomsTotal: level.rooms.length,
      roomCounts,
      drawn,
      enclosure: prizes.map((p) => p.enclosure).filter((v) => v != null)
        .sort((a, b) => a - b),
      climbed: prizes.filter((p) => p.climb > 0).length,
      onFloor: prizes.filter((p) => p.y <= 0.02).length,
      sources: prizes.reduce((acc, p) => {
        acc[p.source] = (acc[p.source] || 0) + 1;
        return acc;
      }, {}),
      anchorsScored: scored.length,
      // The raw exposure distribution, sorted. The tier thresholds are
      // supposed to be set against this; reporting "the 20/35/30/15 mix is
      // unachievable" while measuring a guess measures the guess.
      covers: scored.map((a) => a.cover).sort((a, b) => a - b),
    },
  };
}
