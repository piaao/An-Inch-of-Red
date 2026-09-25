/**
 * guard.js — the patrol that turns a search into a stealth game.
 *
 * The design doc is blunt about why this exists: a find-the-object game with
 * nobody looking for you "has no opponent, no failure drama and no story; its
 * ceiling is Hidden Folks, not a game". The guard is the cheapest possible fix
 * -- it reuses the exact vision primitive the red census already uses.
 *
 * Nothing here knows what a fridge is. The guard sees `level.solids` and a
 * player position, which is why the same class will patrol a different
 * building unchanged.
 *
 * The state machine is deliberately small and LEGIBLE, because the guard's job
 * is not to be clever, it is to be READABLE. A player must be able to watch it
 * and predict it, or being caught feels random:
 *
 *   patrol -> (sees something) -> alert   (stops, stares, suspicion rises)
 *          -> (suspicion full)  -> chase   (runs at the last known position)
 *          -> (lost for `loseSight`) -> patrol
 *
 * Suspicion rises with proximity and with how centred the player is in the
 * cone, and it always decays when the player is unseen. That gives the player
 * a readable dial: break the line, and the bar falls.
 */
import { sightLine } from './vision.js';

const TAU = Math.PI * 2;

export function wrapAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

/**
 * WHERE THE PATROL GEOMETRY WENT, because this is the third attempt at it.
 *
 * The patrol used to carry a THINNED CORNER LIST between its stops: first from
 * Ramer-Douglas-Peucker (deviation from the chord, 0.25 m tolerance), then from
 * a nav-verified greedy walk (furthest point joined to this one by a `nav.los`
 * clear line). Both were answering the wrong question.
 *
 * A thinned list is a promise about the LINE between two kept points, and the
 * promise is only worth anything if the guard is standing ON the first point
 * when it starts walking. It is not: it slides off a jamb, or it is stopped
 * early, and the line from where it actually is was never verified at all.
 *
 * Measured (scripts/diag_guard_where.mjs, 4 seeds, 600 s shifts):
 *
 *   RDP corners          inside a solid 17.6 % of the shift
 *   nav-verified corners inside a solid  0.0 %, but BLOCKED 437-493 s (73-82 %),
 *                        walking 88-137 m of a possible 630, bedroom and
 *                        kitchen never entered
 *
 * So the corner list is gone. `Guard.step` routes each leg with `nav.astar`
 * from the position the guard is really at -- a promise about the guard rather
 * than about a line. The route is then a sequence of A*-proven edges, and the
 * only way to be off it is to be off the plan, which the stuck timer handles by
 * re-routing rather than by grinding.
 */

export const GUARD_MODES = {
  off: null,
  patrol: {
    speed: 1.05, chaseSpeed: 1.75, turnRate: 3.2,
    coneDeg: 74, range: 4.2, eyeY: 0.30,
    fillRate: 1.25, decayRate: 0.5,
    loseSight: 3.0, scanRate: 1.15, scanArc: 1.15,
    penalty: 15,
  },
  hunter: {
    speed: 1.45, chaseSpeed: 2.25, turnRate: 4.0,
    coneDeg: 96, range: 6.0, eyeY: 0.34,
    fillRate: 1.9, decayRate: 0.42,
    loseSight: 5.0, scanRate: 1.7, scanArc: 1.4,
    penalty: 20,
  },
};

/**
 * Build a patrol that actually walks the building.
 *
 * Rooms are visited in nearest-neighbour order from the spawn, each room gets
 * its centroid plus the cell farthest from that centroid (so the guard crosses
 * the room instead of hovering at one point), and consecutive stops are joined
 * with A*. If two stops are in different navigation regions the leg is dropped
 * rather than teleported -- a patrol that jumps through walls is worse than a
 * shorter patrol.
 */
export function buildPatrol(level, nav, rng, opts = {}) {
  const extraPerRoom = opts.extraPerRoom != null ? opts.extraPerRoom : 1;
  // Stops scale with FLOOR AREA, not with room count. A flat one-per-room
  // rule gave the 22.9 m2 living room and the 5.2 m2 dining room the same
  // treatment, and the guard ended up crossing the living room 24 times in
  // 300 s while the bedroom waited 47 s between visits.
  const perRoomArea = opts.perRoomArea != null ? opts.perRoomArea : 8;

  // Which room owns each cell, resolved once. The per-cell rooms.find this
  // replaces was 32000 x 6 lookups per room at the nav's 5 cm grid.
  const owner = new Int8Array(nav.w * nav.d).fill(-1);
  for (let j = 0; j < nav.d; j++) {
    for (let i = 0; i < nav.w; i++) {
      const c = nav.centreOf(i, j);
      owner[j * nav.w + i] = level.rooms.findIndex((rr) => {
        const b = rr.rect;
        return c.x >= b.x0 && c.x <= b.x1 && c.z >= b.z0 && c.z <= b.z1;
      });
    }
  }

  const stops = [];
  for (let k = 0; k < level.rooms.length; k++) {
    const r = level.rooms[k];
    const cells = [];
    for (let j = 0; j < nav.d; j++) {
      for (let i = 0; i < nav.w; i++) {
        const idx = j * nav.w + i;
        if (!nav.walkable[idx] || owner[idx] !== k) continue;
        cells.push(nav.centreOf(i, j));
      }
    }
    if (!cells.length) continue;
    const cx = cells.reduce((a, c) => a + c.x, 0) / cells.length;
    const cz = cells.reduce((a, c) => a + c.z, 0) / cells.length;
    const per = [{ x: cx, z: cz, room: r.id }];
    const sorted = cells.slice().sort(
      (a, b) => Math.hypot(b.x - cx, b.z - cz) - Math.hypot(a.x - cx, a.z - cz));
    const floorArea = cells.length * nav.cell * nav.cell;
    const extra = Math.max(extraPerRoom, Math.round(floorArea / perRoomArea) - 1);
    for (let k = 0; k < extra && k < sorted.length; k++) {
      const c = sorted[Math.floor((k + 1) * sorted.length / (extra + 1))];
      if (c) per.push({ x: c.x, z: c.z, room: r.id });
    }
    stops.push(...per);
  }

  // Rooms first, then nearest neighbour inside the list -- so every room is
  // visited before the tour starts doubling back.
  const rooms = rng.shuffle(level.rooms.map((r) => r.id));
  const ordered = [];
  let cur = { x: level.spawn.x, z: level.spawn.z };
  for (const id of rooms) {
    const mine = stops.filter((s) => s.room === id);
    while (mine.length) {
      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < mine.length; k++) {
        const d = Math.hypot(mine[k].x - cur.x, mine[k].z - cur.z);
        if (d < bestD) { bestD = d; best = k; }
      }
      const s = mine.splice(best, 1)[0];
      ordered.push(s);
      cur = s;
    }
  }

  // The stops ARE the waypoints. There used to be a thinned corner list in
  // between (see the note where `thin()` used to live): a corner is a legal
  // DEPARTURE point only if the guard is standing on it, and after a slide it
  // is not. `Guard.step` now routes every leg with A* from where the guard
  // really is, so the corner list bought nothing and cost a straight-line hop
  // from the wrong place.
  //
  // `pause` is what makes the guard halt and sweep, so EVERY stop pauses.
  // Marking every corner of a staircased path as a stop is what turned a
  // patrol into a shuffle -- 785 pauses of 0.87 s in a 300 s shift -- and that
  // is a thing the stop list is small enough to avoid by construction.
  const waypoints = [];
  let from = { x: level.spawn.x, z: level.spawn.z };
  const dropped = [];
  for (const s of ordered) {
    // Snap to a lattice point the nav ACCEPTS. A room centroid is the mean of
    // its walkable cells and is not itself guaranteed to be walkable -- and
    // `new Guard` is constructed standing on waypoints[0].
    const at = nav.nearestWalkable(s.x, s.z) || { x: s.x, z: s.z };
    const leg = nav.astar(from, at);
    if (!leg) { dropped.push(s); continue; }
    waypoints.push({ x: at.x, z: at.z, pause: true, room: s.room });
    from = at;
  }
  if (!waypoints.length) {
    // Degenerate level: fall back to standing at the nearest walkable spot.
    const w = nav.nearestWalkable(level.spawn.x, level.spawn.z) || level.spawn;
    waypoints.push({ x: w.x, z: w.z, room: level.spawn.room || null });
  }
  return { waypoints, dropped, stops: ordered };
}

export class Guard {
  constructor(level, nav, cfg, patrol) {
    this.level = level;
    this.nav = nav;
    this.cfg = cfg;
    this.patrol = patrol;
    this.index = 0;
    this.pos = { x: patrol.waypoints[0].x, z: patrol.waypoints[0].z };
    this.facing = 0;
    this.mode = 'patrol';
    this.suspicion = 0;
    this.lostFor = 0;
    this.path = null;
    this.pathAt = 0;
    this.scanPhase = 0;
    this.scanAnchor = this.facing;
    this.events = [];
    this.stats = { seenFrames: 0, confirmedSightings: 0, caught: 0, distance: 0, suspicionPeak: 0, timeAlert: 0 };
    this.stuck = 0;
    this._seenLast = false;
  }

  /** Is the player inside the cone, in range, and unobstructed? */
  look(player) {
    const dx = player.x - this.pos.x;
    const dz = player.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > this.cfg.range) return { seen: false, reason: 'range', d };
    const bearing = Math.atan2(dz, dx);
    const off = Math.abs(wrapAngle(bearing - this.facing));
    const half = (this.cfg.coneDeg * Math.PI) / 180 / 2;
    if (off > half) return { seen: false, reason: 'cone', d, off, half };
    const los = sightLine(this.level, this.pos, player, this.cfg.eyeY);
    if (!los.clear) return { seen: false, reason: 'occluded', d, off, half, blockedBy: los.blockedBy };
    const proximity = 1 - 0.55 * (d / this.cfg.range);
    const centring = 1 - 0.5 * (off / half);
    return { seen: true, d, off, half, proximity, centring, rate: this.cfg.fillRate * proximity * centring };
  }

  /** Advance one step. `player` is {x, z}. Returns the events raised. */
  update(dt, player) {
    this.events = [];
    const cfg = this.cfg;
    const look = this.look(player);

    if (look.seen) {
      this.suspicion = Math.min(1, this.suspicion + look.rate * dt);
      this.lostFor = 0;
      this.lastSeen = { x: player.x, z: player.z };
      this.stats.seenFrames += 1;
      this.stats.suspicionPeak = Math.max(this.stats.suspicionPeak, this.suspicion);
      if (!this._seenLast) {
        this.events.push({ type: 'spot', at: { x: this.pos.x, z: this.pos.z }, d: look.d });
      }
      if (this.mode === 'patrol') {
        this.mode = 'alert';
        this.alertFor = 0;
      }
      if (this.suspicion >= 1) {
        this.stats.caught += 1;
        this.events.push({ type: 'caught', penalty: cfg.penalty, at: { ...this.pos } });
        this.suspicion = 0;
        this.mode = 'chase';
        this.repath(this.lastSeen);
      } else if (this.mode === 'chase') {
        this.repath(this.lastSeen, 0.35);
      }
    } else {
      this.suspicion = Math.max(0, this.suspicion - cfg.decayRate * dt);
      this.lostFor += dt;
      this.stats.suspicionPeak = Math.max(this.stats.suspicionPeak, this.suspicion);
      if (this.mode === 'chase' && this.lostFor > cfg.loseSight) {
        this.mode = 'patrol';
        this.path = null;
        this.events.push({ type: 'lost' });
      } else if (this.mode === 'alert' && this.lostFor > 0.9) {
        this.mode = 'patrol';
      }
    }
    if (this.mode === 'alert') this.stats.timeAlert += dt;

    const speed = this.mode === 'chase' ? cfg.chaseSpeed : cfg.speed;
    this.step(dt, speed, look.seen);
    return this.events;
  }

  repath(target, tolerance = 0) {
    if (!target) return;
    if (this.path && tolerance > 0) {
      const goal = this.path[this.path.length - 1];
      if (goal && Math.hypot(goal.x - target.x, goal.z - target.z) < tolerance) return;
    }
    const p = this.nav.astar(this.pos, target);
    if (p && p.length > 1) { this.path = p; this.pathAt = 1; }
  }

  /**
   * Finish with the current stop: sweep if it is one, then aim at the next.
   *
   * `wp === null` is the "this stop is not approachable" path -- a stop A*
   * cannot reach from where the guard has ended up, or one it has ground
   * against for `stuckLimit`. Dropping a stop is cheaper than standing still
   * forever, and the next lap will come back to it.
   */
  reachStop(wp) {
    if (wp && wp.pause) {
      // A guard that never stops is unreadable; a guard that stops and turns
      // is a timer the player can learn -- but only if it stops at places that
      // mean something.
      this.scanPhase = 1 / Math.max(0.001, this.cfg.scanRate);
      this.scanAnchor = this.facing;
    }
    this.index = (this.index + 1) % this.patrol.waypoints.length;
  }

  step(dt, speed, chasing) {
    const wps = this.patrol.waypoints;
    const wp = wps[this.index % wps.length];
    const hunting = this.mode === 'chase';

    // ---- 1. route --------------------------------------------------------
    // Patrol locomotion goes through A*, exactly like chase. The waypoint list
    // decides WHERE the guard is going; A* decides HOW it gets there.
    //
    // The straight hop this replaces was legal only FROM the previous
    // waypoint, and a guard that slid off a jamb is not standing on it -- so
    // the line it actually walked was never verified. Measured: 437-493 s of a
    // 600 s shift BLOCKED, 88-137 m walked of a possible 630, bedroom and
    // kitchen never entered (scripts/diag_guard_where.mjs).
    if (!hunting && !this.path) {
      if (Math.hypot(wp.x - this.pos.x, wp.z - this.pos.z) <= 0.10) {
        this.reachStop(wp);
        return;
      }
      const p = this.nav.astar(this.pos, wp);
      if (!p || p.length < 2) {
        // Unroutable stop. `buildPatrol` already dropped every leg A* could
        // not join, so reaching this means the guard itself has ended up
        // somewhere odd -- skip the stop, do not grind on it.
        this.reachStop(null);
        return;
      }
      this.path = p;
      this.pathAt = 1;
    }

    const target = this.path && this.pathAt < this.path.length
      ? this.path[this.pathAt] : null;
    if (!target) {
      // Route consumed. For a patrol that IS arrival at the stop, because an
      // A* path ends on the stop itself.
      this.path = null;
      if (!hunting) this.reachStop(wp);
      return;
    }

    // ---- 2. turn toward the current node ---------------------------------
    const dx = target.x - this.pos.x;
    const dz = target.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-4) {
      const want = Math.atan2(dz, dx);
      const turn = wrapAngle(want - this.facing);
      const maxTurn = this.cfg.turnRate * dt;
      this.facing = wrapAngle(this.facing + Math.max(-maxTurn, Math.min(maxTurn, turn)));
    }

    // ---- 3. sweep instead of walking, while paused at a stop -------------
    if (this.scanPhase > 0 && !chasing) {
      this.scanPhase -= dt;
      this.facing = wrapAngle(this.scanAnchor
        + Math.sin((1 - this.scanPhase) * this.cfg.scanRate * TAU * 0.5) * this.cfg.scanArc);
      return;
    }

    // ---- 4. walk ---------------------------------------------------------
    // A ZERO DISTANCE IS A LEGAL INPUT, NOT A BROKEN ONE. A* answers a goal
    // that snaps to the cell the guard already occupies with a two-node path
    // whose ends are the same point (nav.astar, `if (ka === kb)`), and chasing a
    // player who is standing where the guard cannot stand reaches that case.
    // The turn above guards for it with `d > 1e-4`; this did not, so dx / d was
    // 0 / 0 -> NaN, and because `distance` is a CUMULATIVE sum one NaN made
    // every later reading NaN. The shipped check then reported "null m" for a
    // guard that had walked 28.8 m (step 1910 of 3600, seed 2026-09-25;
    // scripts/_probe_guard_nan.mjs). Walking zero metres is the whole answer
    // when you are already standing on the node, and the consumption loop below
    // then advances past it.
    let travelled = 0;
    // `stepLen` MUST STAY IN THIS SCOPE. The stuck-recovery block below reads it
    // (`travelled < stepLen * 0.3`), so declaring it inside the guard threw
    // `ReferenceError: stepLen is not defined` on the first walk step -- in a
    // file that `node --check` reported as clean. A parser proves well-formed,
    // not working.
    //
    // With `d === 0` this yields stepLen 0 and travelled 0, so the stuck test
    // reads `0 < 0` -> false: standing ON the node is not "stuck", and that
    // needs no special case.
    const stepLen = Math.min(speed * dt, d);
    if (d > 0) travelled = this.moveClear(dx / d, dz / d, stepLen);
    this.stats.distance += travelled;

    // Consume the route nodes the guard has reached. The radius must stay
    // SMALLER than the 5 cm node spacing, or the route runs away from the
    // walker: the walker always steers AT the current node, so it converges on
    // each one and this advances at most one node per frame at walking pace.
    const nodeR = 0.08;
    while (this.pathAt < this.path.length
      && Math.hypot(this.path[this.pathAt].x - this.pos.x,
        this.path[this.pathAt].z - this.pos.z) <= nodeR) this.pathAt += 1;
    if (this.pathAt >= this.path.length) {
      this.path = null;
      if (!hunting) this.reachStop(wp);
      return;
    }

    // ---- 5. stuck recovery -----------------------------------------------
    // Sliding cannot round every corner, and a patrol that grinds into one
    // forever is worse than one that skips a single stop.
    if (travelled < stepLen * 0.3) {
      this.stuck += dt;
      if (this.stuck > 2.5) {
        this.stuck = 0;
        // Re-route from where the guard actually is. Keeping the old route and
        // merely skipping the index was the old cure, and it left the guard
        // aimed at the piece of wall it was already touching.
        this.path = null;
        if (this.mode === 'chase') this.repath(this.lastSeen);
        else this.reachStop(null);
      }
    } else {
      this.stuck = 0;
    }
  }

  /**
   * Move by up to `dist` along a unit direction, sliding instead of stopping.
   *
   * Why this exists, in numbers: the guard used to move straight to its
   * target with no test at all, and spent 17.6 % of a 600 s shift standing
   * inside walls and furniture (scripts/diag_guard.mjs, 4 seeds). It never
   * escaped the building -- 0.00 % of the time outside the plan -- but
   * clipping through a sofa is not a smaller bug than clipping through a
   * wall, and a vision cone whose origin is inside geometry is not the cone
   * the design reasoned about.
   *
   * Axis-separated, like the player's controller, so a corner deflects the
   * guard instead of stopping it. `nav.clear` is the same predicate that
   * decided where the guard could stand in the first place.
   */
  moveClear(ux, uz, dist) {
    const r = this.nav.inflate;
    const steps = Math.max(1, Math.min(16, Math.ceil(dist / 0.04)));
    const s = dist / steps;
    const x0 = this.pos.x;
    const z0 = this.pos.z;
    for (let k = 0; k < steps; k++) {
      const dx = ux * s;
      const dz = uz * s;
      // Diagonal FIRST. The straight micro-step is the one the route
      // verified, so taking it whenever it is legal keeps the guard ON the
      // line. Axis-separated sliding is the FALLBACK, not the default: it
      // leaves the line by up to one micro-step, and one micro-step of inward
      // drift is what catches a 0.44 m doorway.
      if (this.nav.clear(this.pos.x + dx, this.pos.z + dz, r)) {
        this.pos.x += dx;
        this.pos.z += dz;
        continue;
      }
      if (dx && this.nav.clear(this.pos.x + dx, this.pos.z, r)) this.pos.x += dx;
      if (dz && this.nav.clear(this.pos.x, this.pos.z + dz, r)) this.pos.z += dz;
    }
    return Math.hypot(this.pos.x - x0, this.pos.z - z0);
  }

  state() {
    return {
      pos: { ...this.pos }, facing: this.facing, mode: this.mode,
      suspicion: this.suspicion,
      goal: this.patrol.waypoints[this.index % this.patrol.waypoints.length],
      stats: { ...this.stats },
    };
  }
}

/**
 * How long does the guard leave each room unvisited?
 *
 * This is the guard's real difficulty number. A room the guard passes twice a
 * minute is a different game from one it never enters, and unlike "cone
 * angle" it is measurable from the patrol alone.
 */
export function patrolCoverage(level, nav, cfg, patrol, seconds = 300, dt = 0.1) {
  const g = new Guard(level, nav, cfg, patrol);
  const last = new Map();
  const gaps = new Map();
  const visits = new Map();
  for (const r of level.rooms) { last.set(r.id, 0); visits.set(r.id, 0); gaps.set(r.id, []); }

  const dummy = { x: -999, z: -999 };
  for (let t = 0; t < seconds; t += dt) {
    g.update(dt, dummy);
    for (const r of level.rooms) {
      const b = r.rect;
      if (g.pos.x >= b.x0 && g.pos.x <= b.x1 && g.pos.z >= b.z0 && g.pos.z <= b.z1) {
        if (!g._inRoom || g._inRoom !== r.id) {
          gaps.get(r.id).push(t - (last.get(r.id) || 0));
          last.set(r.id, t);
          visits.set(r.id, visits.get(r.id) + 1);
          g._inRoom = r.id;
        }
      }
    }
    if (g._inRoom) {
      const r = level.rooms.find((rr) => rr.id === g._inRoom);
      const b = r.rect;
      if (!(g.pos.x >= b.x0 && g.pos.x <= b.x1 && g.pos.z >= b.z0 && g.pos.z <= b.z1)) g._inRoom = null;
    }
  }

  const out = {};
  for (const r of level.rooms) {
    const list = gaps.get(r.id).filter((v) => v > 0);
    out[r.id] = {
      name: r.name,
      visits: visits.get(r.id),
      meanGap: list.length ? list.reduce((a, b) => a + b, 0) / list.length : null,
      maxGap: list.length ? Math.max(...list) : null,
      never: visits.get(r.id) === 0,
    };
  }
  return { rooms: out, distance: g.stats.distance, waypoints: patrol.waypoints.length, dropped: patrol.dropped.length };
}
