/**
 * snapshot_arena.mjs — build `game/arenas/room_scene.json`.
 *
 * This is the one step that knows about this repository. It gathers four
 * inputs that were each measured independently, hands them to the pure arena
 * adapter, and writes a Level the portable core can consume:
 *
 *   js/layout.js            the apartment as data (walls, doors, furniture)
 *   data/kit_three.json      bounding boxes measured in the browser (Box3)
 *   data/model_surfaces.json red patches and glass panes, measured from the GLBs
 *   data/passages.json       wall openings and door states, measured by
 *                            raycasting the RENDERED scene
 *
 * The last one is the one that matters most and the one that took three tries.
 * "Where can anything get through a wall" is not a question about a file, it is
 * a question about a building, so it is answered by asking the thing that draws
 * the building.
 *
 * Run: node scripts/snapshot_arena.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildLevel } from '../game/arena/fromLayout.js';
import { buildNav } from '../game/core/nav.js';
import { resolveRooms, applyRooms } from '../game/core/regions.js';
import { validateLevel } from '../game/core/level.js';
import { hashString } from '../game/core/rng.js';
import { buildWallOpenings, buildDoorStates } from '../game/arena/openings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'js', 'layout.js');
const OUT = path.join(ROOT, 'game', 'arenas', 'room_scene.json');

function readJSON(p, fallback = null) {
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Evaluate `js/layout.js` as data.
 *
 * Deliberately NOT a parser: the file is `export const NAME = ...` with no
 * side effects, so stripping the `export` keywords and running the body is
 * exact, cheap, and cannot drift from the real source the way a
 * re-implementation would. If the file ever grows side effects this throws
 * rather than silently producing a wrong level.
 */
function loadLayout() {
  const src = fs.readFileSync(SRC, 'utf8');
  const body = src.replace(/^export\s+/gm, '');
  const fn = new Function(`${body}\n;return { WALL_H, PLAN, ZONES, WALLS, CORNERS, DOORS, ROOMS, requiredModels };`);
  return { data: fn(), hash: hashString(src), bytes: Buffer.byteLength(src) };
}

function main() {
  const layoutFile = loadLayout();
  const layout = layoutFile.data;
  const sizes = readJSON(path.join(ROOT, 'data', 'kit_three.json'));
  const surfaces = readJSON(path.join(ROOT, 'data', 'model_surfaces.json'), {});
  const passages = readJSON(path.join(ROOT, 'data', 'passages.json'));

  if (!sizes || !sizes.models) throw new Error('data/kit_three.json missing — run scripts/measure.js first');
  if (!passages) throw new Error('data/passages.json missing — run scripts/probe_passages.js first');

  /* ------------------------------------------------ wall openings, measured */
  // ONE definition, shared with scripts/procgen.mjs -- see game/arena/openings.js.
  // Two copies of this table would be two chances to disagree about how wide a
  // doorway is, and the measured width of a door must not differ between arenas.
  const { wallOpenings, openingTable } = buildWallOpenings(passages, sizes);

  /* ------------------------------------------------ door states, measured */
  const { doorClosed, doorTable } = buildDoorStates(passages, layout.DOORS);

  /* ------------------------------------------------------------ assemble */
  const level = buildLevel({
    layout, sizes, surfaces, wallOpenings,
    options: {
      id: 'room_scene',
      name: '剖面公寓',
      source: 'js/layout.js',
      doorClosed,
    },
  });

  level.meta.provenance = {
    layout: { file: 'js/layout.js', bytes: layoutFile.bytes, hash: layoutFile.hash },
    sizes: 'data/kit_three.json',
    surfaces: 'data/model_surfaces.json',
    passages: 'data/passages.json',
    generatedBy: 'scripts/snapshot_arena.mjs',
  };

  /* --------------------------------------------------------------- rooms */
  const playerNav = buildNav(level, {
    inflate: level.body.playerRadius,
    bodyHeight: level.body.playerHeight,
    step: level.meta.step,
  });
  const guardNav = buildNav(level, {
    inflate: level.body.guardRadius,
    bodyHeight: level.body.guardHeight,
    step: level.meta.step,
  });

  // Rooms are identified on a nav whose doorways and declared bays are
  // SEALED. A room is what you get when you shut the doors; flood-fill the
  // plan with them open and the whole apartment is one room, which is both
  // true and useless. The player's and the guard's navs are this same plan
  // with the doors open again.
  const regionNav = buildNav(level, {
    inflate: level.body.playerRadius,
    bodyHeight: level.body.playerHeight,
    step: level.meta.step,
    sealOpenings: true,
  });

  const resolved = resolveRooms(level, regionNav);
  applyRooms(level, resolved.rooms);

  // An opening with no door in it is a HOLE IN A WALL. Every `measured`
  // opening in this layout has a frame in it, so one that does not is the
  // 18 cm slit class of bug the renderer probe found in the south wall.
  // A `declared` bay has no model by construction -- that is the point.
  const openingRows = level.openings.map((o) => ({
    o,
    door: level.solids.find((s) => s.kind === 'door'
      && Math.hypot(s.x - o.x, s.z - o.z) <= 0.7) || null,
  }));

  const problems = [...validateLevel(level), ...resolved.problems];
  for (const { o, door } of openingRows) {
    if (o.source === 'measured' && !door) {
      problems.push(`opening in ${o.wall} @ (${o.x.toFixed(2)}, ${o.z.toFixed(2)})`
        + ' is a hole in a wall with no door in it');
    }
  }

  /* ------------------------------------------------------------- report */
  const lines = [];
  const say = (s) => { lines.push(s); console.log(s); };

  say('snapshot_arena  ' + path.relative(ROOT, OUT).replace(/\\/g, '/'));
  say('='.repeat(72));
  say(`layout.js        ${layoutFile.bytes} bytes  fnv=${layoutFile.hash.toString(16)}`);
  say(`solids           ${level.solids.length}  (walls ${level.solids.filter((s) => s.kind === 'wall').length}, `
    + `doors ${level.solids.filter((s) => s.kind === 'door').length}, `
    + `furniture ${level.solids.filter((s) => s.kind === 'furniture').length})`);
  const reds = level.solids.filter((s) => s.red);
  const glass = level.solids.filter((s) => s.glass);
  say(`red-bearing      ${reds.length} solids   glass-bearing ${glass.length}`);
  say('');
  say('wall openings (measured by raycasting the rendered scene)');
  for (const o of openingTable) {
    const gaps = o.gaps && o.gaps.length ? '  gap ' + JSON.stringify(o.gaps.map(g => [g[0], g[1], +(g[1] - g[0]).toFixed(3)])) : '';
    say(`   ${o.kind.padEnd(17)} w=${String(o.width).padEnd(6)} solid ${JSON.stringify(o.body)}${gaps}`);
  }
  say('');
  say('doors');
  for (const d of doorTable) {
    say(`   ${d.model.padEnd(14)} (${d.x}, ${d.z})  ${d.covered == null ? '?' : (d.covered * 100).toFixed(0) + '% covered'}  -> ${d.shut ? 'SHUT' : 'open'}   ${d.note}`);
  }
  say('');
  say('openings (a hole in a wall run: a doorway, or a declared bay)');
  for (const { o, door } of openingRows) {
    const span = (o.hx > o.hz ? o.hx : o.hz) * 2;
    const which = door
      ? `door ${door.model} (${door.tags.includes('closed') ? 'SHUT' : 'open'})`
      : 'NO DOOR';
    say(`   [${o.source.padEnd(8)}] ${o.wall.padEnd(11)} @ (${o.x.toFixed(2)}, ${o.z.toFixed(2)})`
      + `  span ${span.toFixed(2)} m  -> ${which}`);
  }
  say('');
  say('walkable grid');
  say(`   player  cell=${playerNav.cell}  walkable=${playerNav.walkableCount}/${playerNav.w * playerNav.d}  regions=${playerNav.components.length}`);
  say(`   guard   walkable=${guardNav.walkableCount}/${guardNav.w * guardNav.d}  regions=${guardNav.components.length}`);
  say(`   region  walkable=${regionNav.walkableCount}  regions=${regionNav.components.length}`
    + `  (openings sealed: ${regionNav.sealedOpenings})`);
  if (playerNav.components.length === 1) {
    say('            player nav is ONE region: every room is reachable by both walkers');
  }
  say('');
  say('rooms (rectangles derived by flood fill, not typed in)');
  for (const r of resolved.rooms) {
    say(`   ${r.id.padEnd(9)} ${r.name.padEnd(5)} cells=${String(r.cells).padStart(5)}`
      + `  area ${r.area.toFixed(1).padStart(5)} m2`
      + `  rect [${r.rect.x0.toFixed(1)}, ${r.rect.z0.toFixed(1)}] .. [${r.rect.x1.toFixed(1)}, ${r.rect.z1.toFixed(1)}]`
      + (r.snapped ? '  (seed was inside furniture)' : ''));
  }
  const unresolved = level.rooms.filter((r) => r.resolved === false);
  say(`   resolved ${level.rooms.length - unresolved.length}/${level.rooms.length} rooms`);
  if (unresolved.length) {
    say(`   UNRESOLVED: ${unresolved.map((r) => r.id).join(', ')}`);
  }
  if (resolved.orphans.length) {
    say('');
    say(`   unowned walkable regions: ${resolved.orphans.length}`);
    for (const o of resolved.orphans) say(`      ${o.cells} cells @ (${o.cx.toFixed(1)}, ${o.cz.toFixed(1)})`);
  }
  say('');
  say(`spawn            (${level.spawn.x.toFixed(2)}, ${level.spawn.z.toFixed(2)}) yaw ${(level.spawn.yaw * 180 / Math.PI).toFixed(0)} deg`);
  say(`collectible      ${level.collectible.name} colour ${level.collectible.colour} size ${level.collectible.size.join(' x ')}`);
  say('');
  if (problems.length) {
    say(`VALIDATION       ${problems.length} problem(s)`);
    for (const p of problems) say('   ! ' + p);
  } else {
    say('VALIDATION       clean');
  }
  say('='.repeat(72));

  level.meta.openings = level.openings.length;
  level.meta.rooms = {
    total: level.rooms.length,
    resolved: level.rooms.filter((r) => r.resolved !== false).length,
    orphans: resolved.orphans.length,
    sealedOpenings: regionNav.sealedOpenings,
  };
  level.meta.problems = problems;

  if (!fs.existsSync(path.dirname(OUT))) fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(level), 'utf8');
  say(`wrote ${path.relative(ROOT, OUT)}  ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
  fs.writeFileSync(path.join(ROOT, 'work', '_snapshot.log'), lines.join('\n') + '\n', 'utf8');

  return problems.length ? 2 : 0;
}

process.exit(main());
