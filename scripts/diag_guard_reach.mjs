/**
 * diag_guard_reach.mjs — which rooms can the GUARD actually reach?
 *
 *     node scripts/diag_guard_reach.mjs                       (the shipped apartment)
 *     node scripts/diag_guard_reach.mjs game/arenas/gen.json  (a generated one)
 *
 * WHY THIS EXISTS. `verify_play.mjs` asks the guard to walk its patrol and it
 * passes; the reading says it entered THREE rooms. "It walks its patrol" and
 * "its patrol covers the flat" are different claims, and only the first was ever
 * asserted. This asks the second one in the only place it can be answered: the
 * nav graph.
 *
 * THE PLAYER'S NAV IS NOT THE GUARD'S NAV. `body.playerRadius` is 0.12 m and
 * `body.guardRadius` is 0.15 m, so the two build different walkable sets from
 * the same plan -- and only the player's connectivity is checked anywhere else.
 * A doorway that a 0.24 m-wide body fits is not a doorway a 0.30 m-wide body
 * fits, and the second body is the one with the patrol.
 *
 * `buildPatrol` drops every stop it cannot route, so a room in a different
 * component does not produce an error -- it produces a SHORTER patrol that still
 * passes every test written about patrols.
 *
 * WHAT THE SHIPPED APARTMENT ACTUALLY MEASURES (2026-09-25, GTX 1660 SUPER):
 *   player nav  21378 walkable cells, 2 components
 *   guard  nav  19593 walkable cells, 7 components (12587, 2965, 2822, 1212, 5, 1, 1)
 *   the spawn is in component 3; bedroom (0), bath (1) and kitchen (2) are NOT
 *   so the guard reaches 6 of 12 built stops -- and "all six rooms covered", a
 *   reading this project published earlier, was measured while the guard could
 *   still walk through the outer wall. That is the whole reason this file prints
 *   components and not a distance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNav } from '../game/core/nav.js';
import { buildPatrol } from '../game/core/guard.js';
import { Rng } from '../game/core/rng.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const file = process.argv[2] || 'game/arenas/room_scene.json';
const seed = process.argv[3] || 'guard-diag';

const level = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

const opt = (r, h) => ({ inflate: r, bodyHeight: h, step: level.meta.step });
const navP = buildNav(level, opt(level.body.playerRadius, level.body.playerHeight));
const navG = buildNav(level, opt(level.body.guardRadius, level.body.guardHeight));

console.log(`${file}  ${level.rooms.length} rooms  plan ${level.meta.plan.w}x${level.meta.plan.d}`);
console.log(`  player nav (r ${level.body.playerRadius}): ${navP.walkableCount} walkable, `
  + `${navP.components.length} component(s)`);
console.log(`  guard  nav (r ${level.body.guardRadius}): ${navG.walkableCount} walkable, `
  + `${navG.components.length} component(s)`);
console.log(`  guard component sizes (cells): `
  + navG.components.map((c) => c.cells.length).sort((a, b) => b - a).join(', '));

// WHICH ROOMS ARE IN THE SPAWN'S COMPONENT. A stop in another component is
// unreachable BY CONSTRUCTION, so buildPatrol drops it -- a fact about the
// level's shape, not a routing bug. Keeping those two apart is the point.
const spawnComp = navG.componentAt(level.spawn.x, level.spawn.z);
console.log('');
console.log(`  spawn is in component ${spawnComp}`);
const away = [];
for (const r of level.rooms) {
  const c = navG.nearestWalkable((r.rect.x0 + r.rect.x1) / 2, (r.rect.z0 + r.rect.z1) / 2);
  if (!c) { away.push(`${r.id} (no walkable point)`); continue; }
  const k = navG.componentAt(c.x, c.z);
  if (k !== spawnComp) away.push(`${r.id} (component ${k})`);
}
console.log(`  rooms NOT in the spawn's component: ${away.length ? away.join(', ') : '(none)'}`);

// Per-room walkable area, both radii: a room can be non-empty and unreachable.
const inRoom = (c, r) => c.x >= r.rect.x0 && c.x <= r.rect.x1
  && c.z >= r.rect.z0 && c.z <= r.rect.z1;
const count = (nav, r) => {
  let n = 0;
  for (let j = 0; j < nav.d; j++) {
    for (let i = 0; i < nav.w; i++) {
      if (!nav.walkable[j * nav.w + i]) continue;
      if (inRoom(nav.centreOf(i, j), r)) n++;
    }
  }
  return n;
};
console.log('');
console.log('  room                       guard cells   player cells');
for (const r of level.rooms) {
  console.log(`  ${r.id.padEnd(24)} ${String(count(navG, r)).padStart(11)} `
    + `${String(count(navP, r)).padStart(14)}`);
}

const patrol = buildPatrol(level, navG, new Rng(seed), {});
console.log('');
console.log(`  patrol: ${patrol.waypoints.length} waypoints, ${patrol.dropped.length} dropped `
  + `(${patrol.stops.length} stops built)`);

let reach = 0;
const unroutable = [];
const from = navG.nearestWalkable(level.spawn.x, level.spawn.z) || level.spawn;
for (const s of patrol.stops) {
  const at = navG.nearestWalkable(s.x, s.z);
  if (at && navG.astar(from, at)) reach++; else unroutable.push(s.room);
}
console.log(`  stops A* can reach from the spawn: ${reach}/${patrol.stops.length}`);
if (unroutable.length) console.log(`    unreachable: ${unroutable.join(', ')}`);

console.log('');
console.log(patrol.dropped.length === 0
  ? 'VERDICT: every built stop is reachable and the patrol visits every room.'
  : `VERDICT: ${patrol.dropped.length} of ${patrol.stops.length} stops are unreachable `
    + '-- the guard cannot patrol those rooms.');
