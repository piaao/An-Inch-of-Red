/**
 * time_boot.mjs — how long does the play layer's boot cost?
 *
 * The play page has to build the same nav, the same placement and the same
 * patrol the headless verification used. If that is 300 ms it happens live on
 * the loading screen; if it is 30 s it has to be precomputed into the arena.
 * GUESSING which is the whole point of this script.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rng } from '../game/core/rng.js';
import { buildNav } from '../game/core/nav.js';
import { placePrizes, defaultViewpoints } from '../game/core/place.js';
import { buildPatrol, GUARD_MODES } from '../game/core/guard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARENA = path.join(HERE, '..', 'game', 'arenas', 'room_scene.json');

const level = JSON.parse(fs.readFileSync(ARENA, 'utf8'));
const out = [];
const say = (s) => { out.push(s); console.log(s); };

const t0 = Date.now();
const playerNav = buildNav(level, {
  inflate: level.body.playerRadius, bodyHeight: level.body.playerHeight, step: level.meta.step,
});
const tNav = Date.now() - t0;
say(`buildNav(player)   ${String(tNav).padStart(6)} ms   ${playerNav.walkableCount} cells`);

const t1 = Date.now();
const guardNav = buildNav(level, {
  inflate: level.body.guardRadius, bodyHeight: level.body.guardHeight, step: level.meta.step,
});
say(`buildNav(guard)    ${String(Date.now() - t1).padStart(6)} ms   ${guardNav.walkableCount} cells`);

const t2 = Date.now();
const vantages = defaultViewpoints(level, playerNav);
say(`defaultViewpoints  ${String(Date.now() - t2).padStart(6)} ms   ${vantages.length} standpoints`);

const t3 = Date.now();
const placed = placePrizes(level, playerNav, new Rng('hongbao-01').fork('place'), {
  count: 6, policy: 'spread', viewpoints: vantages,
});
const tPlace = Date.now() - t3;
say(`placePrizes        ${String(tPlace).padStart(6)} ms   ${placed.prizes.length} prizes  `
  + `(${placed.report.anchorsScored} scored of ${placed.report.stats.candidates.floor}`
  + `+${placed.report.stats.candidates.top}+${placed.report.stats.candidates.inside} candidates)`);
for (const p of placed.prizes) {
  say(`     ${p.id}  ${p.room.padEnd(8)} ${p.tier.padEnd(9)} cover ${(p.cover * 100).toFixed(1)}%  `
    + `at (${p.x.toFixed(2)}, ${p.z.toFixed(2)}, y${p.y.toFixed(2)})  via ${p.source}`);
}

const t4 = Date.now();
const patrol = buildPatrol(level, guardNav, new Rng('guard-000'), {});
say(`buildPatrol        ${String(Date.now() - t4).padStart(6)} ms   ${patrol.waypoints.length} waypoints, `
  + `${patrol.dropped.length} legs dropped`);

say('');
say(`TOTAL              ${String(Date.now() - t0).padStart(6)} ms`);

fs.writeFileSync(path.join(HERE, '..', 'work', '_time_boot.log'), out.join('\n') + '\n');
