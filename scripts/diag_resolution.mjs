/**
 * diag_resolution.mjs — is the fragmented apartment a GRID artifact or a real
 * obstruction?
 *
 * The 1 m nav says this apartment has seven regions and that the living-room
 * door leads into a two-cell pocket. That is either (a) true, and the furniture
 * really does seal the door, or (b) a sampling artifact of a grid whose cells
 * are 2.3x wider than the doorway they have to notice.
 *
 * The way to tell the two apart is to stop using a grid as the reference. This
 * sweep builds the nav at several resolutions, from 5 cm up to 1 m, and reports
 * how many regions the plan has at each. Connectivity that appears as the grid
 * gets finer is an artifact. Connectivity that is absent at 5 cm is real.
 *
 * The 5 cm row is the reference: at 5 cm the samples are 2.4x denser than the
 * walker's own radius, so "no route at 5 cm" means no route.
 *
 * Run: node scripts/diag_resolution.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNav } from '../game/core/nav.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const level = JSON.parse(fs.readFileSync(path.join(ROOT, 'game', 'arenas', 'room_scene.json'), 'utf8'));

const R = level.body.playerRadius;
const CELLS = [0.05, 0.1, 0.2, 0.25, 0.5, 1.0];
const roomIds = level.rooms.map((r) => r.id);

/** Which region is each room's seed in (snapping across furniture if needed)? */
function seating(nav) {
  const out = {};
  for (const r of level.rooms) {
    let c = nav.componentAt(r.seed[0], r.seed[1]);
    let how = 'seed';
    if (c < 0) {
      const s = nav.nearestWalkable(r.seed[0], r.seed[1], 12);
      c = s ? nav.componentAt(s.x, s.z) : -1;
      how = s ? 'snapped' : 'NOWHERE';
    }
    out[r.id] = { c, how };
  }
  return out;
}

console.log(`player radius ${R} m, doorways measure 0.44 m clear (0.32 m at the bedroom door)`);
console.log('='.repeat(78));
console.log('cell     walkable  regions  room->region (unsealed)                  seeded?');
console.log('-'.repeat(78));

const rows = [];
for (const cell of CELLS) {
  const nav = buildNav(level, { inflate: R, bodyHeight: level.body.playerHeight, step: level.meta.step, cell });
  const st = seating(nav);
  const uniq = new Set(Object.values(st).map((v) => v.c)).size;
  const miss = roomIds.filter((id) => st[id].c < 0);
  const tags = roomIds.map((id) => `${id.slice(0, 4)}:${st[id].c}`).join(' ');
  const seeded = Object.values(st).filter((v) => v.how === 'seed').length;
  rows.push({ cell, walkable: nav.walkableCount, regions: nav.components.length, uniq, miss, tags, seeded });
  console.log(`${String(cell).padEnd(8)} ${String(nav.walkableCount).padEnd(9)} `
    + `${String(nav.components.length).padEnd(8)} ${tags.padEnd(42)} ${seeded}/${roomIds.length}`
    + (miss.length ? `  MISSING ${miss.join(',')}` : ''));
}

console.log('');
console.log('sealed nav (rooms identified with every opening shut)');
console.log('-'.repeat(78));
console.log('cell     walkable  regions  rooms resolved');
for (const cell of CELLS) {
  const nav = buildNav(level, {
    inflate: R, bodyHeight: level.body.playerHeight, step: level.meta.step, cell, sealOpenings: true,
  });
  const st = seating(nav);
  const uniq = new Set(Object.values(st).filter((v) => v.c >= 0).map((v) => v.c)).size;
  console.log(`${String(cell).padEnd(8)} ${String(nav.walkableCount).padEnd(9)} `
    + `${String(nav.components.length).padEnd(8)} ${uniq}/${roomIds.length} distinct regions hold a seed`);
}

console.log('');
console.log('verdict: if the unsealed room->region row shows ONE distinct region at 5 cm');
console.log('         but several at 1 m, the fragmentation is a sampling artifact.');
