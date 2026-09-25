/**
 * sim.js — headless playtests.
 *
 * This is where the design stops being an opinion. A greedy AI walks the real
 * navigation grid, sweeps for red things, walks over to confirm them, and gets
 * caught by the real guard. Two runs differ in ONE respect:
 *
 *   oracle : knows which red blobs are 红包
 *   blind  : only knows "that looks red" -- exactly what a player knows
 *   map    : handed every 红包 position at t = 0 and routed nearest-first.
 *            Not a player -- a CEILING. See scripts/diag_oracle.mjs for the
 *            measurement showing oracle-vs-blind is a policy gap, not a
 *            knowledge gap, and that the decoys are a waypoint field.
 *
 * The gap between them is the price of the near-colour gamble, which is the
 * entire creative claim of the design. If that gap is zero the idea does not
 * work and no amount of art will save it.
 *
 * WHAT THIS CANNOT MEASURE, stated up front so nobody quotes the wrong number:
 * absolute human playtime. A perfect-path AI never backtracks, never gets
 * lost, and reads a room in one sweep. The numbers here are RELATIVE -- blind
 * vs oracle, guard vs no guard, tier mix A vs tier mix B -- plus hard legality
 * facts (everything reachable, nothing unwinnable). The design doc's "25-40 s
 * per 红包" is a human target and stays a human target.
 */
import { redCensus } from './vision.js';
import { Guard } from './guard.js';
import { climbCost } from './climb.js';

const DEG = Math.PI / 180;
const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

/**
 * Default walker: the design's numbers. Height 0.42 with eyes at 0.36 keeps
 * the walls (1.29) at 3.07x body height, so the rooms stay separate.
 */
export const WALKER = {
  radius: 0.12, height: 0.42, eyeHeight: 0.36,
  // 1.5 m/s = 3.6 body-heights/s. It was 2.1 (5 heights/s) until the player
  // said the run was over too quickly; see the note in game/play/config.js.
  // THE RENDERER'S `MOVE.speed` IS THE SAME NUMBER and must be moved with this
  // one, or the matrix measures a walker the player does not drive.
  speed: 1.5,
  pickup: 0.42,
  lift: 0.55,
  sweepSectors: 4,            // 4 x 90 deg = a full look-around
  sweepCost: 0.55,            // seconds per 90 deg sector
  confirmCost: 0.5,           // seconds to walk up and decide "not it"
  sightRange: 9,
};

/** How far can this walker actually get? Cycles through every reachable cell. */
export function reachabilityReport(level, nav, prizes) {
  // Snap to a cell CENTRE: nearestWalkable returns the query point itself
  // when it is already clear, which is not a lattice point, and the walk
  // below then counts it against walkableCount -- hence a reported
  // "23249 of 23248 cells reachable".
  const seed = nav.nearestWalkable(level.spawn.x, level.spawn.z);
  const sc = seed ? nav.cellOf(seed.x, seed.z) : null;
  const start = sc ? nav.centreOf(sc.i, sc.j) : null;
  const reach = new Set();
  if (start) {
    const seen = new Set();
    const key = (p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`;
    const stack = [start];
    seen.add(key(start));
    while (stack.length) {
      const cur = stack.pop();
      reach.add(key(cur));
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          if (!i && !j) continue;
          const c = nav.cellOf(cur.x, cur.z);
          const k = nav.index(c.i + i, c.j + j);
          if (k < 0 || !nav.walkable[k]) continue;
          const nc = nav.centreOf(c.i + i, c.j + j);
          if (seen.has(key(nc))) continue;
          if (!nav.los(cur.x, cur.z, nc.x, nc.z)) continue;
          seen.add(key(nc));
          stack.push(nc);
        }
      }
    }
  }

  const perPrize = prizes.map((p) => {
    // 1 m, in metres. This used to say 4, which was four metres on the
    // 1 m grid and 20 cm once the nav moved to 5 cm.
    const stand = nav.nearestWalkable(p.x, p.z, 1.0);
    const key = stand ? `${stand.x.toFixed(2)},${stand.z.toFixed(2)}` : null;
    const path = start ? nav.astar(start, p) : null;
    return {
      id: p.id, room: p.room, tier: p.tier,
      stand,
      standReachable: key != null && reach.has(key),
      pathOk: !!path,
      pathLength: path ? nav.pathLength(path) : Infinity,
    };
  });

  return {
    reachableCells: reach.size,
    walkableCells: nav.walkableCount,
    coverage: nav.walkableCount ? reach.size / nav.walkableCount : 0,
    perPrize,
    allReachable: perPrize.every((p) => p.pathOk && p.standReachable),
  };
}

/** Move a point along a path, returning how long that took. */
function walk(path, speed) {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
  return { length: d, time: d / speed };
}

/**
 * One run.
 *
 * @param opts.mode      'oracle' | 'blind' | 'map'
 * @param opts.guard     null, or {cfg, patrol}
 * @param opts.budget    seconds
 * @param opts.sectors   how much of the circle the walker sweeps (1..4)
 */
export function runSearch(level, nav, rng, prizes, opts = {}) {
  const W = { ...WALKER, ...(opts.walker || {}) };
  const mode = opts.mode || 'oracle';
  const budget = opts.budget != null ? opts.budget : 180;
  const sectors = opts.sectors != null ? opts.sectors : W.sweepSectors;
  const confusable = opts.confusable !== false;   // blind mode only

  const guard = opts.guard ? new Guard(level, nav, opts.guard.cfg, opts.guard.patrol) : null;

  let pos = { x: level.spawn.x, z: level.spawn.z };
  // THE EYE MOVES WITH THE FEET. See the header: a walker that only ever
  // looks from the floor cannot see four fifths of the packets this flat
  // hides, which is a handicap, not a difficulty.
  let standY = 0;
  // A heading, so a sweep can be an arc. Without one the sector dial did
  // nothing: every bearing was measured against +x.
  let facing = level.spawn.yaw || 0;
  let clock = 0;
  let travel = 0;
  let sweeps = 0;
  let confirmations = 0;
  let falsePositives = 0;
  let penalties = 0;
  let caught = 0;
  let timeToFirstCatch = null;
  const collected = [];
  const visitedRooms = new Set();
  const dismissed = new Set();
  const stood = new Set();
  const vantage = opts.vantages || null;
  const collectTimes = [];
  const trace = [];

  function roomHere(p) {
    for (const r of level.rooms) {
      const b = r.rect;
      if (p.x >= b.x0 && p.x <= b.x1 && p.z >= b.z0 && p.z <= b.z1) return r.id;
    }
    return null;
  }

  /** Walk to a destination, ticking the guard. Returns false on timeout. */
  function goTo(dest) {
    const path = nav.astar(pos, dest);
    if (!path) return false;
    // The route is a floor route (astar snaps both ends to walkable cells), so
    // leaving wherever we were standing puts us back on the floor. The caller
    // raises `standY` again if the destination was a climbed standpoint.
    standY = 0;
    for (let i = 1; i < path.length; i++) {
      const seg = Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
      if (seg > 1e-6) {
        facing = Math.atan2(path[i].z - path[i - 1].z, path[i].x - path[i - 1].x);
      }
      const steps = Math.max(1, Math.ceil(seg / 0.1));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        pos = { x: path[i - 1].x + (path[i].x - path[i - 1].x) * t,
                z: path[i - 1].z + (path[i].z - path[i - 1].z) * t };
        travel += seg / steps;
        clock += (seg / steps) / W.speed;
        const rid = roomHere(pos);
        if (rid) visitedRooms.add(rid);
        if (guard) {
          const dt = (seg / steps) / W.speed;
          for (const ev of guard.update(dt, pos)) {
            if (ev.type === 'caught') {
              caught += 1;
              penalties += ev.penalty;
              clock += ev.penalty;
              if (timeToFirstCatch == null) timeToFirstCatch = clock;
            }
          }
        }
        if (clock > budget * 3) return false;
      }
    }
    return true;
  }

  /** A full or partial look-around. Adds `sweepCost * sectors` to the clock. */
  function sweep() {
    sweeps += 1;
    clock += W.sweepCost * sectors;
    if (guard) {
      for (const ev of guard.update(W.sweepCost * sectors, pos)) {
        if (ev.type === 'caught') {
          caught += 1; penalties += ev.penalty; clock += ev.penalty;
          if (timeToFirstCatch == null) timeToFirstCatch = clock;
        }
      }
    }
    const census = redCensus(level, pos, {
      prizes: prizes.filter((p) => !collected.includes(p.id)),
      range: W.sightRange,
      minPatch: opts.minPatch,
      // AT THE HEIGHT THE WALKER IS STANDING. This used to be omitted, which
      // meant `level.body.eyeHeight` forever -- the floor eye. A packet on a
      // 0.45 m counter is invisible from there and obvious from on the
      // counter, which is the whole climbing design; a persona that never
      // climbs was therefore not playing this game.
      eyeY: standY + level.body.eyeHeight,
    });
    // A sweep covers `sectors` quarters of a turn, centred on where the
    // walker is facing. Four of them is the full look-around; fewer means
    // the arc you did not turn through is an arc you did not see, which is
    // the design's partial-sweep dial -- and it only means anything at all
    // because the walker now has a heading.
    const arc = sectors >= 4 ? Math.PI * 2 : (Math.PI / 2) * sectors;
    const half = arc / 2;
    const covered = (p) => {
      if (sectors >= 4) return true;
      const a = wrap(Math.atan2(p.z - pos.z, p.x - pos.x) - facing);
      return Math.abs(a) <= half;
    };
    const out = census.reds.filter(covered);
    const seenPrizes = census.prizes.filter(covered);
    const notice = (list) => list.filter((r) => !dismissed.has(r.id));
    return { reds: notice(out), prizes: seenPrizes };
  }

  let guardIter = 0;
  while (collected.length < prizes.length && clock < budget && guardIter++ < 2000) {
    // `map` is handed every position up front, so looking around would only
    // spend time it does not need. Its sweeps therefore read 0, and that is
    // the point: it is a routing floor, not a playstyle.
    const look = mode === 'map' ? { reds: [], prizes: [] } : sweep();
    let target = null;
    let isPrize = false;

    // Both modes see EXACTLY the same reds. They differ in one respect, which
    // is the only thing this comparison is allowed to measure:
    //
    //   blind  -- takes the most salient red thing, because that is all it has
    //   oracle -- if a real 红包 is in view it takes that instead, and in every
    //             other situation behaves exactly like blind
    //
    // The oracle used to ignore reds altogether and drop straight into
    // random-vantage exploration. It therefore spent 116.8 s of a 180 s budget
    // wandering at random against blind's 69.2 s (scripts/diag_oracle.mjs ->
    // work/diag_oracle.json) and LOST to blind at every budget. An oracle that
    // loses to a blind agent is not an oracle, it is a different search policy
    // wearing a knowledgeable hat, and "oracle - blind" then reports the price
    // of knowledge PLUS a policy gap. With the fallback shared, the subtraction
    // is meaningful and the gap should be non-negative by construction.
    if (mode === 'map') {
      // Nearest uncollected 红包, no looking required. Everything below finds
      // an empty pool for this mode and leaves `target` alone.
      const rem = prizes.filter((p) => !collected.includes(p.id));
      if (rem.length) {
        rem.sort((a, b) => Math.hypot(a.x - pos.x, a.z - pos.z) - Math.hypot(b.x - pos.x, b.z - pos.z));
        target = rem[0];
        isPrize = true;
      }
    }

    const pool = confusable ? [...look.reds, ...look.prizes] : look.prizes.slice();
    let oraclePick = null;
    if (mode === 'oracle') {
      const seenIds = new Set(look.prizes.map((p) => p.id));
      const cand = prizes.filter((p) => seenIds.has(p.id) && !collected.includes(p.id));
      if (cand.length) {
        // Nearest first. (This used to sort on `a.x === b.x ? 0 : dist`, i.e.
        // it bailed out of comparing whenever two prizes shared an x, which
        // made the order depend on array position rather than distance.)
        cand.sort((a, b) => Math.hypot(a.x - pos.x, a.z - pos.z) - Math.hypot(b.x - pos.x, b.z - pos.z));
        oraclePick = cand[0];
      }
    }

    if (oraclePick) {
      target = oraclePick;
      isPrize = true;
    } else {
      // The shared rule -- blind in both senses: blind mode always, and oracle
      // mode whenever it cannot see a 红包 to spend its knowledge on.
      //
      // Red things are then indistinguishable, so the biggest-looking one wins,
      // which is exactly the mistake the near-colour design induces. Both lists
      // come out of the census, so both were gated by the same size-and-distance
      // rule and both carry salience at their own real size. The prize used to be
      // scored at a hard-coded 1.4 m2 against decoys scored at their measured
      // area, which made the 红包 outrank every carpet in the building: blind
      // then collected 6/6 within 11 % of oracle's clock, i.e. the effect this
      // run exists to measure was gone.
      pool.sort((a, b) => b.salience - a.salience);
      if (pool.length) {
        const pick = pool[0];
        const real = prizes.find((p) => p.id === pick.id);
        target = real || { id: pick.id, x: pick.x, z: pick.z, y: 0, decoy: true, room: null };
        isPrize = !!real;
      }
    }

    if (!target) {
      // Nothing noticed: go and stand somewhere you have not stood.
      //
      // This used to walk to the least-visited room's centroid, which is
      // ONE destination per room. A 红包 that is only noticeable from a
      // corner of the kitchen was therefore unfindable by construction,
      // and every run in every configuration ended at 5/6 with the clock
      // pinned to the budget -- which is an AI limitation wearing the
      // costume of a level result. A player does not visit one spot per
      // room either.
      let dest = null;
      // Two exploration policies.
      //
      //   random  -- jump to an un-stood standpoint anywhere. The default,
      //              kept so earlier numbers still mean what they said.
      //   nearest -- greedy nearest-neighbour tour of the standpoints, i.e.
      //              a systematic sweep. `minHop` stops the tour from
      //              re-sweeping one corner on a 0.5 m lattice while a
      //              2.2 s look-around is charged on every arrival.
      //
      // Every claim of the form "looking costs X seconds" has to be checked
      // against 'nearest', because a random jump is a straw man and the gap
      // between the two policies is the gap between a DESIGN fact and a
      // HARNESS artefact.
      const exploreMode = opts.explore || 'random';
      const minHop = opts.minHop != null ? opts.minHop : 1.5;
      if (vantage && vantage.length && exploreMode === 'nearest') {
        // HEIGHT IS PART OF THE IDENTITY. A floor standpoint and a climbed one
        // can share an x/z; without the height they were the same tour stop and
        // the climbed one was silently dropped.
        const key = (c) => `${c.x.toFixed(1)},${c.z.toFixed(1)},${(c.y || 0).toFixed(2)}`;
        let best = null;
        let bestD = Infinity;
        for (const c of vantage) {
          if (stood.has(key(c))) continue;
          const d = Math.hypot(c.x - pos.x, c.z - pos.z);
          if (d >= minHop && d < bestD) { bestD = d; best = c; }
        }
        if (!best) {
          // Tour exhausted: start a fresh one from wherever we are.
          stood.clear();
          bestD = Infinity;
          for (const c of vantage) {
            const d = Math.hypot(c.x - pos.x, c.z - pos.z);
            if (d < bestD) { bestD = d; best = c; }
          }
        }
        if (best) { dest = best; stood.add(key(dest)); }
      }
      if (!dest && vantage && vantage.length && rng && typeof rng.int === 'function') {
        for (let tries = 0; tries < 12 && !dest; tries++) {
          const c = vantage[rng.int(vantage.length)];
          const k = `${c.x.toFixed(1)},${c.z.toFixed(1)},${(c.y || 0).toFixed(2)}`;
          if (!stood.has(k)) dest = c;
        }
        if (!dest) { stood.clear(); dest = vantage[rng.int(vantage.length)]; }
        stood.add(`${dest.x.toFixed(1)},${dest.z.toFixed(1)},${(dest.y || 0).toFixed(2)}`);
      }
      if (!dest) {
        const rest = level.rooms.filter((r) => !visitedRooms.has(r.id));
        const room = rest.length ? rng.pick(rest) : rng.pick(level.rooms);
        dest = nav.nearestWalkable(room.cx, room.cz) || { x: room.cx, z: room.cz };
      }
      trace.push({ t: clock, kind: 'explore', to: `(${dest.x.toFixed(1)}, ${dest.z.toFixed(1)})` });
      if (!goTo(dest)) break;
      // A CLIMBED STANDPOINT IS A STANDPOINT, and getting onto one costs the
      // same scramble the player pays -- otherwise the persona gets the
      // mechanic for free and the win rate prices a cheat. `astar` already
      // snapped the route to the floor cell at its foot (the launch pad).
      standY = dest.y > 0 ? dest.y : 0;
      if (standY > 0) {
        const dt = climbCost(0, standY);
        clock += dt;
        if (guard) {
          for (const ev of guard.update(dt, pos)) {
            if (ev.type === 'caught') { caught += 1; penalties += ev.penalty; clock += ev.penalty; }
          }
        }
      }
      const rid = roomHere(pos);
      if (rid) visitedRooms.add(rid);
      continue;
    }

    trace.push({ t: clock, kind: isPrize ? 'chase-prize' : 'chase-decoy', id: target.id, dist: Math.hypot(target.x - pos.x, target.z - pos.z) });
    // A packet ON something is fetched from the launch pad BESIDE it, and the
    // scramble is time the walker spends. `pad` is computed by the placement
    // (climb.js -> vision.js `reachable`) and travels on every prize, so this
    // is reading the same route the placement used to promise the packet was
    // obtainable -- not a second guess at it.
    const climb = target.climb > 0 ? target.climb : 0;
    const to = (climb > 0 && target.pad)
      // `nearestWalkable` because a second-rung pad is the TOP of something,
      // and a walker paths to the floor cell at its foot; the cost is paid
      // below either way.
      ? (nav.nearestWalkable(target.pad.x, target.pad.z, 1.0) || { x: target.x, z: target.z })
      : { x: target.x, z: target.z };
    const ok = goTo(to);
    if (!ok) break;
    if (climb > 0) {
      const dt = climbCost(0, climb);
      clock += dt;
      if (guard) {
        for (const ev of guard.update(dt, pos)) {
          if (ev.type === 'caught') { caught += 1; penalties += ev.penalty; clock += ev.penalty; }
        }
      }
    }
    // Up on the surface if the packet was: the next look-around is from there.
    standY = climb;
    const rid = roomHere(pos);
    if (rid) visitedRooms.add(rid);

    if (isPrize) {
      clock += W.confirmCost;
      collected.push(target.id);
      collectTimes.push(clock);
      if (guard) for (const ev of guard.update(W.confirmCost, pos)) if (ev.type === 'caught') { caught += 1; penalties += ev.penalty; clock += ev.penalty; }
    } else {
      confirmations += 1;
      falsePositives += 1;
      dismissed.add(target.id);
      clock += W.confirmCost;
    }
  }

  const win = collected.length === prizes.length && clock <= budget;
  return {
    mode, sectors, budget,
    collected: collected.length,
    collectedIds: collected,
    win,
    clock: Math.round(clock * 10) / 10,
    travel: Math.round(travel * 10) / 10,
    sweeps,
    confirmations,
    // Every prize collected was also a "confirmation"; decoys are the error.
    falsePositives,
    falsePositiveRate: (confirmations + collected.length) ? falsePositives / (confirmations + collected.length) : 0,
    caught, penalties, timeToFirstCatch: timeToFirstCatch != null ? Math.round(timeToFirstCatch * 10) / 10 : null,
    roomsVisited: visitedRooms.size,
    roomsTotal: level.rooms.length,
    collectTimes: collectTimes.map((v) => Math.round(v * 10) / 10),
    trace,
    guardStats: guard ? guard.stats : null,
  };
}

/** Run many seeds and aggregate. Returns means and spreads, not just a mean. */
export function batch(level, nav, prizesAt, opts = {}) {
  const runs = opts.runs != null ? opts.runs : 40;
  const rows = [];
  for (let i = 0; i < runs; i++) {
    const rng = (opts.rngFor || ((k) => null))(i);
    const { prizes } = prizesAt(i, rng);
    // `optsFor` exists so a caller can give each run its own guard patrol.
    // Handing every run the same patrol would make all forty runs the same
    // maze with a different prize layout, and the spread would be a lie.
    const per = opts.optsFor ? opts.optsFor(i) : null;
    rows.push(runSearch(level, nav, rng || { pick: (l) => l[0] }, prizes,
      per ? { ...opts, ...per } : opts));
  }
  const agg = (key) => {
    const vals = rows.map((r) => r[key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (!vals.length) return { n: 0 };
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    vals.sort((a, b) => a - b);
    return { n: vals.length, mean: round(mean), sd: round(sd), min: round(vals[0]), median: round(vals[Math.floor(vals.length / 2)]), max: round(vals[vals.length - 1]) };
  };
  return {
    runs,
    winRate: round(rows.filter((r) => r.win).length / rows.length),
    clock: agg('clock'),
    falsePositiveRate: agg('falsePositiveRate'),
    collected: agg('collected'),
    caught: agg('caught'),
    roomsVisited: agg('roomsVisited'),
    // The other half of "blind wastes confirmations": what did that
    // actually cost in metres and seconds.
    travel: agg('travel'),
    sweeps: agg('sweeps'),
    confirmations: agg('confirmations'),
    timeToFirstCatch: agg('timeToFirstCatch'),
    rows,
  };
}

const round = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
