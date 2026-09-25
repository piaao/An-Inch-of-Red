/**
 * embed_layout.mjs — give an existing arena snapshot the layout it was built from.
 *
 *     node scripts/embed_layout.mjs --arena game/arenas/room_scene.json --layout js/layout.js
 *     node scripts/embed_layout.mjs --arena game/arenas/room_scene.json --force
 *
 * WHY THIS EXISTS. Every Level carries a copy of the layout it was made from
 * (`game/arena/fromLayout.js`), because a snapshot that only knows about its
 * rooms and its solids cannot tell a renderer what to build -- and a floor
 * generated in a browser has no file for a path to point at. Snapshots written
 * before that became true have no `layout`, and `play.html` now refuses them
 * rather than quietly building the shipped apartment over a generated plan.
 *
 * Everything the generators write is embedded automatically, so this tool is
 * only for files that already exist: it re-stamps them in place instead of
 * re-measuring the building. That is exact when the layout has not moved, so
 * the provenance hash the snapshot recorded is CHECKED, and a mismatch refuses
 * the write -- a re-stamp over a changed apartment would be a lie told to the
 * renderer, which is the entire class of bug this is here to end.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashString } from '../game/core/rng.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] != null && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : dflt;
}
const has = (name) => process.argv.includes('--' + name);

/** The key order `buildLevel` writes, so a re-stamped file reads like a fresh one. */
const ORDER = ['meta', 'layout', 'floors', 'solids', 'openings', 'rooms', 'spawn',
  'notes', 'collectible', 'body'];

const arenaPath = path.resolve(ROOT, arg('arena', 'game/arenas/room_scene.json'));
const layoutPath = path.resolve(ROOT, arg('layout', 'js/layout.js'));
const force = has('force');

const level = JSON.parse(fs.readFileSync(arenaPath, 'utf8'));
const mod = await import(pathToFileURL(layoutPath).href);
const layout = {
  WALL_H: mod.WALL_H, PLAN: mod.PLAN,
  ZONES: mod.ZONES || [], WALLS: mod.WALLS || [], CORNERS: mod.CORNERS || [],
  DOORS: mod.DOORS || [], ROOMS: mod.ROOMS || [],
};

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
console.log(`arena   ${rel(arenaPath)}`);
console.log(`layout  ${rel(layoutPath)}  ${layout.ROOMS.length} rooms, ${layout.WALLS.length} wall runs`);

/* ------------------------------------------------- the layout has not moved */
const src = fs.readFileSync(layoutPath, 'utf8');
const hash = hashString(src);
const recorded = level.meta && level.meta.provenance && level.meta.provenance.layout;
if (recorded && recorded.hash !== hash) {
  const msg = `   REFUSED: this snapshot was built from ${recorded.file} hash ${recorded.hash},`
    + ` but ${rel(layoutPath)} is hash ${hash}.`;
  if (!force) {
    console.error(msg);
    console.error('   The apartment moved; re-stamping would tell the renderer to build a');
    console.error('   different flat from the one the walls and furniture in this file describe.');
    console.error('   Re-run the generator instead: scripts/snapshot_arena.mjs, or pass --force');
    console.error('   if you know the difference does not touch geometry.');
    process.exit(2);
  }
  console.log(msg + '  (--force: writing anyway)');
} else {
  console.log(`hash    ${hash}${recorded ? ' (matches the recorded provenance)' : ''}`);
}

/* ------------------------------------------------------ plan and layout agree */
const p = level.meta && level.meta.plan;
if (!p || p.w !== layout.PLAN.w || p.d !== layout.PLAN.d) {
  console.error(`   REFUSED: the snapshot's plan is ${p ? `${p.w}x${p.d}` : 'missing'} m but the layout`
    + ` is ${layout.PLAN.w}x${layout.PLAN.d} m. These are different floors.`);
  process.exit(2);
}
console.log(`plan    ${p.w}x${p.d} m -- matches the layout`);

/* ------------------------------------------------------------------ rewrite */
const out = {};
for (const k of ORDER) {
  if (k === 'layout') { out.layout = layout; continue; }
  if (k in level) out[k] = level[k];
}
for (const k of Object.keys(level)) if (!(k in out)) out[k] = level[k];

const before = fs.statSync(arenaPath).size;
// Serialise BEFORE opening anything, and swap atomically: `open(p, 'w')`
// truncates first, so a throw while producing the payload would leave an empty
// arena behind -- the one failure mode with no way back.
const text = JSON.stringify(out);
fs.writeFileSync(arenaPath + '.tmp', text, 'utf8');
fs.renameSync(arenaPath + '.tmp', arenaPath);
const after = fs.statSync(arenaPath).size;
console.log(`wrote   ${rel(arenaPath)}  ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB`
  + `  (+${((after - before) / 1024).toFixed(0)} KB of layout)`);
console.log(`ready   play.html?arena=./${rel(arenaPath)}`);
