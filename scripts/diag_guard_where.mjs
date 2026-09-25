/**
 * diag_guard_where.mjs — WHERE does the guard's 600 s go?
 *
 * diag_guard.mjs answers "is the guard legal?" (yes, after patch_p16/p17).
 * It does not answer the follow-up: the guard walks 88-137 m of a possible
 * 630 m and never enters the bedroom or the kitchen. Either it is grinding
 * into geometry (stuck) or it is standing still sweeping (scan), and those
 * two have completely different fixes.
 *
 * So: count the budget. Time moving, time scanning, time blocked, how many
 * waypoints it actually consumed, and which waypoints it never reached.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rng } from '../game/core/rng.js';
import { buildNav } from '../game/core/nav.js';
import { buildPatrol, Guard, GUARD_MODES } from '../game/core/guard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const level = JSON.parse(fs.readFileSync(
  path.join(HERE, '..', 'game', 'arenas', 'room_scene.json'), 'utf8'));

const nav = buildNav(level, {
  inflate: level.body.guardRadius, bodyHeight: level.body.guardHeight, step: level.meta.step,
});

const SEEDS = ['guard-2026-09-25', 'guard-000', 'guard-001', 'guard-002'];
const SECONDS = 600;
const DT = 0.05;

const out = [];
const say = (s) => { out.push(s); console.log(s); };

say(`guardRadius ${level.body.guardRadius}  nav.inflate ${nav.inflate}  `
  + `nav.edgeRadius ${nav.edgeRadius}  (all three must agree)`);
say('');

for (const seed of SEEDS) {
  const patrol = buildPatrol(level, nav, new Rng(seed), {});
  const g = new Guard(level, nav, GUARD_MODES.patrol, patrol);
  const dummy = { x: -999, z: -999 };

  let tScan = 0, tStuck = 0, tMove = 0, advances = 0;
  let prevIndex = g.index;
  const hit = new Array(patrol.waypoints.length).fill(0);

  // Consecutive stops are in DIFFERENT rooms, so the direct line between them
  // is blocked on purpose -- that is why the guard routes with A*. What has to
  // hold is that A* can join them, which `buildPatrol` already checked; this
  // re-checks it from the stop list alone so the number is not taken on trust.
  let badLegs = 0;
  const badAt = [];
  for (let k = 0; k + 1 < patrol.waypoints.length; k++) {
    const a = patrol.waypoints[k];
    const b = patrol.waypoints[k + 1];
    const leg = nav.astar(a, b);
    if (!leg) {
      badLegs += 1;
      if (badAt.length < 6) badAt.push(`#${k}(${a.x.toFixed(2)},${a.z.toFixed(2)})->#${k + 1}(${b.x.toFixed(2)},${b.z.toFixed(2)})`);
    }
  }

  for (let t = 0; t < SECONDS; t += DT) {
    const before = { x: g.pos.x, z: g.pos.z };
    g.update(DT, dummy);
    const moved = Math.hypot(g.pos.x - before.x, g.pos.z - before.z);
    if (g.scanPhase > 0) tScan += DT;
    else if (g.stuck > 0) tStuck += DT;
    else if (moved > 1e-4) tMove += DT;
    if (g.index !== prevIndex) { advances += 1; hit[g.index] = (hit[g.index] || 0) + 1; prevIndex = g.index; }
  }

  const never = [];
  for (let k = 0; k < hit.length; k++) if (!hit[k]) never.push(k);

  say(`seed ${seed}`);
  say(`   waypoints         ${patrol.waypoints.length}  (pauses ${patrol.waypoints.filter((w) => w.pause).length})`);
  say(`   distance          ${g.stats.distance.toFixed(1)} m  (ceiling ${(GUARD_MODES.patrol.speed * SECONDS).toFixed(0)} m)`);
  say(`   budget            moving ${tMove.toFixed(0)} s | scanning ${tScan.toFixed(0)} s | blocked ${tStuck.toFixed(0)} s`);
  say(`   advances          ${advances}  (one full lap = ${patrol.waypoints.length})`);
  if (never.length) {
    say(`   NEVER reached     ${never.length}/${hit.length} waypoints, rooms: `
      + [...new Set(never.map((k) => patrol.waypoints[k].room).filter(Boolean))].join(', '));
  } else {
    say(`   NEVER reached     none`);
  }
  say(`   leg A* joinable    ${patrol.waypoints.length - 1 - badLegs}/${patrol.waypoints.length - 1} consecutive stop pairs`);
  for (const b of badAt) say(`        ${b}`);
  say('');
}

fs.writeFileSync(path.join(HERE, '..', 'work', '_guard_where.log'), out.join('\n') + '\n');
