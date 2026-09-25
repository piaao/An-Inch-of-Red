/**
 * diag_ai_sight.mjs — why does the blind walker collect 0.83/6?
 *
 * The matrix walker collects a packet unconditionally once it has routed to
 * it (sim.js), so its whole game is the CENSUS: can it notice a packet at all?
 * Its census runs at the FLOOR eye (0.36 m) from `defaultViewpoints`.
 *
 * The placement, meanwhile, scores exposure from the floor viewpoints AND the
 * CLIMBED ones. If packets are now mostly visible only from a climbed eye,
 * then the AI is a persona without the mechanic the level was built around --
 * and the win rate is describing a crippled agent, not a difficulty.
 *
 * So: per packet, how many FLOOR vantages notice it, and how many CLIMBED ones.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rng } from '../game/core/rng.js';
import { buildNav } from '../game/core/nav.js';
import { placePrizes, defaultViewpoints, climbViewpoints } from '../game/core/place.js';
import { climbPlan } from '../game/core/climb.js';
import { redCensus } from '../game/core/vision.js';
import { WALKER } from '../game/core/sim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const level = JSON.parse(fs.readFileSync(path.join(ROOT, 'game', 'arenas', 'room_scene.json'), 'utf8'));
const RUNS = Number(process.argv[2] || 24);

const nav = buildNav(level, {
  inflate: level.body.playerRadius, bodyHeight: level.body.playerHeight, step: level.meta.step,
});
const plan = climbPlan(level, nav);
const floorV = defaultViewpoints(level, nav);
const climbV = climbViewpoints(level, nav, plan);

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };
const yOf = (p) => (p.y != null ? p.y : 0);

say(`level.body.eyeHeight ${level.body.eyeHeight}   WALKER.sightRange ${WALKER.sightRange}`);
say(`floor vantages ${floorV.length}   climbed vantages ${climbV.length}`);
say('');

function notices(viewer, eyeY, priz) {
  const c = redCensus(level, { x: viewer.x, z: viewer.z }, {
    eyeY, range: WALKER.sightRange, prizes: priz,
  });
  return c.prizes.map((p) => p.id);
}

const rows = [];
for (let i = 0; i < RUNS; i++) {
  const prizes = placePrizes(level, nav, new Rng(`arena-${String(i).padStart(3, '0')}`).fork('place'), {
    count: 6, policy: 'spread',
  }).prizes;
  const priz = prizes.map((p) => ({ id: p.id, x: p.x, z: p.z, y: yOf(p) }));
  const floorHits = new Map(priz.map((p) => [p.id, 0]));
  const climbHits = new Map(priz.map((p) => [p.id, 0]));
  for (const v of floorV) {
    for (const id of notices(v, v.eye != null ? v.eye : level.body.eyeHeight, priz)) {
      floorHits.set(id, floorHits.get(id) + 1);
    }
  }
  for (const v of climbV) {
    for (const id of notices(v, v.eye != null ? v.eye : level.body.eyeHeight, priz)) {
      climbHits.set(id, climbHits.get(id) + 1);
    }
  }
  for (const p of prizes) {
    rows.push({
      seed: i, id: p.id, room: p.room, tier: p.tier, y: yOf(p),
      climb: p.climb, floor: floorHits.get(p.id), climbed: climbHits.get(p.id),
    });
  }
}

const nFloorOnly = rows.filter((r) => r.floor === 0).length;
const nBoth = rows.filter((r) => r.floor === 0 && r.climbed > 0).length;
const nNever = rows.filter((r) => r.floor === 0 && r.climbed === 0).length;
const nFloorSeen = rows.filter((r) => r.floor > 0).length;

say(`packets ${rows.length} over ${RUNS} seeds`);
say(`  noticed from at least one FLOOR vantage          ${nFloorSeen}`);
say(`  NOT noticed from any floor vantage               ${nFloorOnly}`);
say(`     ... but noticed from a CLIMBED vantage        ${nBoth}`);
say(`     ... noticed from neither (would be a bug)     ${nNever}`);
say('');
const byTier = new Map();
for (const r of rows) {
  if (!byTier.has(r.tier)) byTier.set(r.tier, { n: 0, blind: 0, climb: 0, dead: 0, ys: [] });
  const t = byTier.get(r.tier);
  t.n += 1; t.ys.push(r.y);
  if (r.floor === 0 && r.climbed > 0) t.climb += 1;
  else if (r.floor === 0) t.dead += 1;
  else t.blind += 1;
}
say('tier            n   seen-by-floor  climb-only  never    median y');
for (const [tier, t] of [...byTier.entries()].sort()) {
  const ys = t.ys.slice().sort((a, b) => a - b);
  say(`  ${tier.padEnd(12)} ${String(t.n).padStart(4)} ${String(t.blind).padStart(12)}`
    + ` ${String(t.climb).padStart(11)} ${String(t.dead).padStart(6)}   ${ys[Math.floor(ys.length / 2)].toFixed(3)}`);
}
say('');
say('floor vantage heights: ' + [...new Set(floorV.map((v) => (v.eye != null ? v.eye : level.body.eyeHeight).toFixed(2)))].join(', '));
say('climbed vantage heights: ' + [...new Set(climbV.map((v) => (v.eye != null ? v.eye : 0).toFixed(2)))].join(', '));
say('');
say(`VERDICT: ${nNever === 0 ? (nBoth > rows.length * 0.25
  ? 'the AI persona lacks the mechanic — a quarter or more of packets are invisible to a floor eye'
  : 'floor eyes are enough; the collapse is elsewhere')
  : 'BUG — some packets are visible from nothing'}`);

fs.writeFileSync(path.join(ROOT, 'work', '_ai_sight.log'), out.join('\n') + '\n');
fs.writeFileSync(path.join(ROOT, 'work', '_ai_sight.json'), JSON.stringify({
  runs: RUNS, packets: rows.length, floorSeen: nFloorSeen, floorOnly: nFloorOnly,
  climbOnly: nBoth, never: nNever, rows,
}, null, 2));
