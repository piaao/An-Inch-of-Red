/**
 * diag_coverage.mjs — how many LOOKS does it take to see all six?
 *
 * The lattice personas (scripts/diag_explore.mjs) collect ~1/6 and the clock is
 * 98 % "explore": they spend the whole budget walking a 0.5 m lattice and
 * looking (2.2 s per 360 deg). 269 standpoints x 2.2 s = 592 s of looking in a
 * 180 s budget, so a lattice searcher CANNOT cover this flat -- which says
 * something about the harness, not about the flat.
 *
 * A person does not search a lattice. A person walks into a room, turns once,
 * and then climbs onto the counter in that room and turns again. So this
 * measures the thing that actually decides whether the level is fair:
 *
 *   GIVEN the vantage points, how many of them (and how many metres between
 *   them) does it take before every 红包 is in view?
 *
 * For each seed it runs a greedy set cover over three candidate vantage sets
 * and reports looks-to-cover-all-six, plus the walking distance of the greedy
 * tour of those looks. If a dozen looks and a lap of the flat is enough, the
 * level is discovery-difficulty and fair. If it takes 100 looks, the level is
 * a lottery and the placement has to change.
 *
 * Run: node scripts/diag_coverage.mjs [runs]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Rng } from '../game/core/rng.js';
import { buildNav } from '../game/core/nav.js';
import { placePrizes, defaultViewpoints, climbViewpoints, playerViewpoints } from '../game/core/place.js';
import { climbPlan } from '../game/core/climb.js';
import { redCensus } from '../game/core/vision.js';
import { WALKER } from '../game/core/sim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARENA = path.join(ROOT, 'game', 'arenas', 'room_scene.json');
const OUT = path.join(ROOT, 'work', 'diag_coverage.json');
const LOG = path.join(ROOT, 'work', '_diag_coverage.log');

const RUNS = Number(process.argv[2]) || 24;
const SWEEP = WALKER.sweepCost * WALKER.sweepSectors;   // 2.2 s for a 360 deg turn

const level = JSON.parse(fs.readFileSync(ARENA, 'utf8'));
const nav = buildNav(level, {
  inflate: level.body.playerRadius, bodyHeight: level.body.playerHeight, step: level.meta.step,
});
const plan = climbPlan(level, nav);
const floorV = defaultViewpoints(level, nav).map((v) => ({ ...v, kind: 'floor' }));
const climbV = climbViewpoints(level, nav, plan).map((v) => ({ ...v, kind: 'climbed' }));

/** One floor look in the middle of each room — what a person does first. */
function roomCentres() {
  const out = [];
  for (const r of level.rooms) {
    const p = nav.nearestWalkable(r.cx, r.cz);
    if (p) out.push({ x: p.x, z: p.z, eye: level.body.eyeHeight, kind: 'room', room: r.id });
  }
  return out;
}

/** Which room rect holds a point. */
function roomOf(x, z) {
  for (const r of level.rooms) {
    const b = r.rect;
    if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return r.id;
  }
  return null;
}

/**
 * One climbed standpoint per (model, room): of all the surfaces of one model in
 * one room, keep the point nearest that room's centre. A person climbs onto
 * *the counter*, not onto five specific 5 cm marks along it.
 */
function climbedPerModelRoom() {
  const groups = new Map();
  for (const s of plan.surfaces) {
    if (!plan.reached.has(s.id)) continue;
    const rid = roomOf(s.x, s.z);
    const key = `${rid}|${s.model || s.id.replace(/[0-9]+$/, '')}`;
    const cx = level.rooms.find((r) => r.id === rid);
    const d = cx ? Math.hypot(s.x - cx.cx, s.z - cx.cz) : 0;
    const cur = groups.get(key);
    if (!cur || d < cur.d) groups.set(key, { s, d });
  }
  return [...groups.values()].map(({ s }) => ({
    x: s.x, z: s.z, y: s.y, eye: s.y + level.body.eyeHeight, kind: 'climbed', model: s.model,
  }));
}

const V = {
  lattice: [...floorV, ...climbV],
  floorOnly: floorV,
  rooms: roomCentres(),
  roomsPlusClimb: [...roomCentres(), ...climbV],
  roomsPlusModel: [...roomCentres(), ...climbedPerModelRoom()],
};

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);
const num = (v, n = 1) => (Number.isFinite(v) ? v.toFixed(n) : '--');

say(`diag_coverage   ${RUNS} seeds   sweep ${SWEEP} s   walker ${WALKER.speed} m/s`);
say(`   vantage sets: ` + Object.entries(V).map(([k, v]) => `${k} ${v.length}`).join('   '));
// INDEPENDENT ACCOUNT. `playerViewpoints` (place.js) is the list the rig
// hands the player persona; `roomsPlusModel` above is derived HERE, from
// the surface table and the room rects, without calling it. If the two ever
// disagree, the tour this file just priced is not the tour the rig runs.
const pv = playerViewpoints(level, nav, plan);
const pk = (v) => `${v.x.toFixed(2)},${v.z.toFixed(2)}`;
const pvSet = new Set(pv.map(pk));
const localSet = new Set(V.roomsPlusModel.map(pk));
const onlyPv = [...pvSet].filter((k) => !localSet.has(k)).length;
const onlyLocal = [...localSet].filter((k) => !pvSet.has(k)).length;
say(`   cross-check: playerViewpoints ${pv.length} vs the tour derived here `
  + `${V.roomsPlusModel.length} — `
  + `${onlyPv + onlyLocal === 0 ? 'identical' : `DIFFER (${onlyPv} + ${onlyLocal})`}`);
say('='.repeat(96));

/** Everything one vantage notices, as a Set of packet ids. */
function seenAt(v, priz) {
  const c = redCensus(level, { x: v.x, z: v.z }, {
    eyeY: v.eye != null ? v.eye : level.body.eyeHeight,
    range: WALKER.sightRange, prizes: priz,
  });
  return new Set(c.prizes.map((p) => p.id));
}

const per = [];   // per-seed rows
for (let i = 0; i < RUNS; i++) {
  const prizes = placePrizes(level, nav, new Rng(`arena-${String(i).padStart(3, '0')}`).fork('place'), {
    count: 6, policy: 'spread',
  }).prizes;
  const priz = prizes.map((p) => ({ id: p.id, x: p.x, z: p.z, y: p.y != null ? p.y : 0 }));
  const row = { seed: i, packets: prizes.length };

  for (const [key, list] of Object.entries(V)) {
    const seen = list.map((v) => ({ v, ids: seenAt(v, priz) }));
    // Greedy set cover from the spawn: at each step take the vantage that adds
    // the most unseen packets, breaking ties on distance from where we are.
    const spawn = nav.nearestWalkable(level.spawn.x, level.spawn.z);
    let pos = spawn ? { x: spawn.x, z: spawn.z } : { x: level.spawn.x, z: level.spawn.z };
    let left = new Set(priz.map((p) => p.id));
    const tour = [];
    let walk = 0;
    while (left.size && tour.length < list.length) {
      let best = null;
      let bestGain = 0;
      let bestD = Infinity;
      for (const e of seen) {
        if (tour.includes(e)) continue;
        let gain = 0;
        for (const id of e.ids) if (left.has(id)) gain += 1;
        if (gain === 0) continue;
        const d = Math.hypot(e.v.x - pos.x, e.v.z - pos.z);
        if (gain > bestGain || (gain === bestGain && d < bestD)) {
          best = e; bestGain = gain; bestD = d;
        }
      }
      if (!best) break;
      // Real walk length: A* on the player's own nav, not the straight line.
      const path = nav.astar(pos, best.v);
      if (path) walk += nav.pathLength(path);
      else walk += bestD;
      pos = { x: best.v.x, z: best.v.z };
      tour.push(best);
      for (const id of best.ids) left.delete(id);
    }
    row[key] = {
      looks: tour.length,
      walk: walk,
      cost: walk / WALKER.speed + tour.length * SWEEP,
      missed: left.size,
      // Where the FIRST look of each kind had to be, in order.
      kinds: tour.map((e) => e.v.kind),
    };
  }
  per.push(row);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

say('');
say(`   ${pad('vantage set', 20)}${padl('n', 5)}${padl('looks to see all 6', 19)}`
  + `${padl('walk m', 9)}${padl('look s', 8)}${padl('total s', 9)}${padl('missed', 8)}`);
for (const key of Object.keys(V)) {
  const looks = per.map((r) => r[key].looks);
  const walk = per.map((r) => r[key].walk);
  const cost = per.map((r) => r[key].cost);
  const miss = per.map((r) => r[key].missed);
  say(`   ${pad(key, 20)}${padl(V[key].length, 5)}${padl(num(mean(looks), 1), 19)}`
    + `${padl(num(mean(walk), 0), 9)}${padl(num(mean(looks) * SWEEP, 0), 8)}`
    + `${padl(num(mean(cost), 0), 9)}${padl(num(mean(miss), 2), 8)}`);
}

say('');
say('   the same, worst case over the seeds (not the mean)');
for (const key of Object.keys(V)) {
  const looks = per.map((r) => r[key].looks);
  const cost = per.map((r) => r[key].cost);
  const miss = per.map((r) => r[key].missed);
  say(`   ${pad(key, 20)} worst looks ${padl(Math.max(...looks), 4)}   worst cost`
    + ` ${padl(num(Math.max(...cost), 0), 5)} s   worst missed ${padl(Math.max(...miss), 3)}`);
}

say('');
say('   composition of the greedy tour (roomsPlusModel), averaged over seeds');
const kindCount = new Map();
const total = per.length;
for (const r of per) {
  for (const k of r.roomsPlusModel.kinds) kindCount.set(k, (kindCount.get(k) || 0) + 1);
}
for (const [k, n] of [...kindCount.entries()].sort()) {
  say(`      ${pad(k, 10)} ${padl(num(n / total, 2), 6)} looks per run`);
}

const latticeLooks = mean(per.map((r) => r.lattice.looks));
const modelLooks = mean(per.map((r) => r.roomsPlusModel.looks));
const floorLooks = mean(per.map((r) => r.floorOnly.looks));
say('');
say(`VERDICT: ${num(modelLooks, 1)} looks (${num(modelLooks * SWEEP, 0)} s of turning + `
  + `${num(mean(per.map((r) => r.roomsPlusModel.walk)), 0)} m of walking) is enough for a person-shaped tour,`
  + ` against ${num(floorLooks, 1)} looks for a floor-only tour and ${num(latticeLooks, 1)} for the lattice.`);

fs.writeFileSync(LOG, out.join('\n') + '\n');
fs.writeFileSync(OUT, JSON.stringify({
  runs: RUNS, sweep: SWEEP, walker: WALKER.speed,
  vantageSets: Object.fromEntries(Object.entries(V).map(([k, v]) => [k, v.length])),
  per,
}, null, 2));
say(`wrote ${path.relative(ROOT, LOG).replace(/\\/g, '/')}`);
