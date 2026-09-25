/**
 * diag_anchors.mjs — WHY do three rooms never hold a 红包?
 *
 * probe_place.mjs, 40 seeds: `roomsUsed` is 3 every time and the occupied room
 * set is always the same one. diag (first pass) showed all six rooms have
 * furniture tall and wide enough to carry a packet, so the rejection is in one
 * of the three LATER filters -- `topIsClear` (already inside `topAnchors`),
 * `measureExposure` -> `hidden`, or `reachable` -> not ok.
 *
 * This drives the REAL enumerator and the REAL filters (place.js exports them
 * for exactly this reason, see patch_p51) and prints, per room, how many
 * candidates each stage destroys. A replica of a filter would not be evidence.
 *
 * Node only. Writes work/_diag_anchors.json and prints a table.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNav } from '../game/core/nav.js';
import { climbCeilOf } from '../game/core/level.js';
import { climbPlan } from '../game/core/climb.js';
import {
  topAnchors, insideAnchors, measureExposure, defaultViewpoints, climbViewpoints,
} from '../game/core/place.js';
import { reachable } from '../game/core/vision.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARENA = path.join(ROOT, 'game', 'arenas', 'room_scene.json');
const OUT = path.join(ROOT, 'work', '_diag_anchors.json');

const lines = [];
const say = (s) => { lines.push(s); process.stdout.write(s + '\n'); };

const level = JSON.parse(fs.readFileSync(ARENA, 'utf8'));
const ceil = climbCeilOf(level);

say('='.repeat(84));
say('diag_anchors  --  where each room\'s candidates die');
say('='.repeat(84));

const nav = buildNav(level, {
  inflate: level.body.playerRadius,
  bodyHeight: level.body.playerHeight,
  step: level.meta.step,
});
const plan = climbPlan(level, nav);
const viewpoints = [...defaultViewpoints(level, nav), ...climbViewpoints(level, nav, plan)];

say(`  ceiling ${ceil.toFixed(3)} m;  nav ${nav.walkableCount} walkable cells, `
  + `${nav.components.length} regions;  ${plan.surfaces.length} surface points, `
  + `${plan.reached.size} reachable`);
say(`  viewpoints: ${viewpoints.length} (${defaultViewpoints(level, nav).length} floor`
  + ` + ${viewpoints.length - defaultViewpoints(level, nav).length} climbed)`);
say(`  spawn region = ${plan.home}`);
say('');

const tops = topAnchors(level, {});
const inside = insideAnchors(level, {});
say(`  enumerators: topAnchors ${tops.length} (raw stats ${JSON.stringify(tops.stats)}), `
  + `insideAnchors ${inside.anchors.length} (rejected ${JSON.stringify(inside.rejected)})`);
say('');

const rooms = level.rooms.map((r) => r.id);
const T = {};
const blank = () => ({ raw: 0, tucked: 0, inside: 0, hidden: 0, unreachable: 0, scored: 0, noRoom: 0 });
for (const id of rooms) T[id] = blank();
T['<none>'] = blank();
const bucket = (room) => (room && T[room] ? T[room] : T['<none>']);

const samples = { hidden: [], unreachable: [] };
const jsonAnchors = [];

for (const a of [...tops, ...inside.anchors]) {
  const B = bucket(a.room);
  B.raw += 1;
  if (a.source === 'tucked') B.tucked += 1;
  if (a.source === 'inside') B.inside += 1;
  if (!a.room) B.noRoom += 1;

  const exp = measureExposure(level, nav, a, { viewpoints });
  const reach = reachable(level, nav, a, { plan });
  const rec = {
    room: a.room, source: a.source, model: a.model || null, y: +a.y.toFixed(3),
    tier: exp.tier, cover: +exp.cover.toFixed(4),
    stand: reach.ok, standKind: reach.kind || null, pad: reach.pad || null,
    climb: reach.climb || 0,
  };
  if (exp.tier === 'hidden') {
    B.hidden += 1;
    if (samples.hidden.length < 8) samples.hidden.push(rec);
  } else if (!reach.ok) {
    B.unreachable += 1;
    if (samples.unreachable.length < 8) samples.unreachable.push(rec);
  } else {
    B.scored += 1;
  }
  jsonAnchors.push(rec);
}

say('  room        raw  tucked  inside   hidden  unreach   SCORED   (<- the pool)');
say('  ' + '-'.repeat(78));
let tot = blank();
for (const id of [...rooms, '<none>']) {
  const B = T[id];
  if (!B.raw) continue;
  for (const k of Object.keys(tot)) tot[k] += B[k];
  say(`  ${String(id).padEnd(10)} ${String(B.raw).padStart(4)} ${String(B.tucked).padStart(7)}`
    + ` ${String(B.inside).padStart(7)} ${String(B.hidden).padStart(8)}`
    + ` ${String(B.unreachable).padStart(8)} ${String(B.scored).padStart(8)}`
    + (B.scored === 0 ? '   <- CANNOT HOST, and it has candidates' : ''));
}
say('  ' + '-'.repeat(78));
say(`  ${'TOTAL'.padEnd(10)} ${String(tot.raw).padStart(4)} ${String(tot.tucked).padStart(7)}`
  + ` ${String(tot.inside).padStart(7)} ${String(tot.hidden).padStart(8)}`
  + ` ${String(tot.unreachable).padStart(8)} ${String(tot.scored).padStart(8)}`);
say('');

const dead = rooms.filter((id) => T[id].raw > 0 && T[id].scored === 0);
say(`  rooms with candidates but an EMPTY pool: ${dead.length}/${rooms.length}`
  + `  (${dead.join(', ') || 'none'})`);
say('');

if (samples.hidden.length) {
  say('  -- a few that came back HIDDEN (invisible from every viewpoint) --');
  for (const s of samples.hidden) {
    say(`     ${String(s.room).padEnd(9)} ${String(s.model || '-').padEnd(24)} y ${String(s.y).padStart(6)}`
      + `  cover ${s.cover}`);
  }
  say('');
}
if (samples.unreachable.length) {
  say('  -- a few that came back UNREACHABLE (no standpoint within reach) --');
  for (const s of samples.unreachable) {
    say(`     ${String(s.room).padEnd(9)} ${String(s.model || '-').padEnd(24)} y ${String(s.y).padStart(6)}`
      + `  tier ${s.tier}`);
  }
  say('');
}

// The most diagnostic pair of numbers: how many TOP points are anywhere near a
// reachable surface, and where the walkable regions actually are.
say('  -- regions, because "reachable" depends on which one the spawn is in --');
const compOfRoom = {};
for (const r of level.rooms) {
  const cx = (r.rect.x0 + r.rect.x1) / 2;
  const cz = (r.rect.z0 + r.rect.z1) / 2;
  compOfRoom[r.id] = nav.componentAt(cx, cz);
}
for (const r of level.rooms) {
  say(`     ${String(r.id).padEnd(10)} centre (${((r.rect.x0 + r.rect.x1) / 2).toFixed(2)}, `
    + `${((r.rect.z0 + r.rect.z1) / 2).toFixed(2)})  region ${compOfRoom[r.id]}`
    + `${compOfRoom[r.id] === plan.home ? '   <- the spawn\'s region' : ''}`);
}
say('');

const json = {
  ceil,
  nav: { walkable: nav.walkableCount, regions: nav.components.length, home: plan.home },
  surfaces: { total: plan.surfaces.length, reached: plan.reached.size },
  enumerators: { tops: tops.length, topStats: tops.stats, inside: inside.anchors.length, insideRejected: inside.rejected },
  rooms: rooms.map((id) => ({ id, ...T[id], region: compOfRoom[id] })),
  deadRooms: dead,
  samples,
  anchors: jsonAnchors,
};
fs.writeFileSync(OUT, JSON.stringify(json, null, 2));
say(`wrote ${path.relative(ROOT, OUT)}`);
