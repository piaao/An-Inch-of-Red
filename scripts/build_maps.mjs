/**
 * build_maps.mjs — build every hand-made map into a playable arena snapshot.
 *
 * One step, five outputs, and the same shape as `snapshot_arena.mjs` on
 * purpose: gather the four measured inputs, hand them to the pure arena
 * adapter, resolve the rooms on a nav whose doorways are SEALED, write a Level
 * the portable core can consume. Nothing here is a second implementation of
 * anything -- `buildLevel`, `buildNav`, `resolveRooms` and the wall-opening
 * table are the same four functions the shipped apartment goes through.
 *
 *   game/maps/*.js            the hand-authored layouts (this repo's own data)
 *   data/kit_three.json       bounding boxes measured in the browser (Box3)
 *   data/model_surfaces.json  red patches and glass panes, from the GLBs
 *   data/passages.json        wall openings and door states, measured by
 *                             raycasting the RENDERED scene
 *
 * IN :  game/maps/index.js    the roster (id, name, category, blurb)
 * OUT:  game/arenas/maps/<id>.json   one arena per map, carrying its layout
 *       game/maps/manifest.json      the roster + the numbers MEASURED off it
 *
 * IT REWRITES COMMITTED FILES, AND THAT IS THE POINT -- the arena snapshot IS
 * the deliverable, the way `game/arenas/room_scene.json` is. The list of files
 * it is about to overwrite is printed before anything is written, because a
 * tool whose side effect is "the repo moved" has to say so out loud.
 *
 * Pure Node. No Chrome, no child processes: every measurement it needs was
 * taken once, in a browser, and committed under `data/`.
 *
 * Run: node scripts/build_maps.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildLevel } from '../game/arena/fromLayout.js';
import { buildWallOpenings, buildDoorStates } from '../game/arena/openings.js';
import { buildNav } from '../game/core/nav.js';
import { resolveRooms, applyRooms } from '../game/core/regions.js';
import { validateLevel } from '../game/core/level.js';
import { hashString } from '../game/core/rng.js';
import { MAPS, DEFAULT_MAP } from '../game/maps/index.js';
import { proseProblems } from '../game/maps/prose.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = path.join(ROOT, 'game', 'arenas', 'maps');
export const MANIFEST = path.join(ROOT, 'game', 'maps', 'manifest.json');

/** Where a map's arena snapshot lives. One definition, two callers. */
export const arenaPath = (id) => path.join(OUT_DIR, `${id}.json`);

const readJSON = (p, fallback = null) =>
  (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback);

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/* ------------------------------------------------------------------ linting */

/**
 * Everything `validateLevel` cannot see, checked here so a broken floor plan
 * is reported by the BUILD rather than discovered by a player standing in a
 * wall.
 *
 * The three checks below are all consequences of one fact: room ownership in
 * this engine is decided by BOUNDING BOX (`roomAt` in game/core/place.js).
 * Two rooms whose boxes overlap means the second one's 红包 are handed to the
 * first. Furniture inside a wall means floor that looks walkable and is not.
 * Furniture inside a door means the doorway the plan promised is sealed.
 */
export function lint(level, layout) {
  const hard = [];
  const soft = [];

  // ---- 1. rooms must not share floor -------------------------------------
  const rs = level.rooms.filter((r) => r.rect);
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i].rect;
      const b = rs[j].rect;
      const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const oz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
      if (ox > 0.02 && oz > 0.02) {
        hard.push(`rooms "${rs[i].id}" and "${rs[j].id}" have overlapping bounding boxes`
          + ` (${ox.toFixed(2)} x ${oz.toFixed(2)} m) -- room ownership is decided by`
          + ' bounding box, so their 红包 would be attributed to whichever is listed first');
      }
    }
  }

  // ---- 2. no room's seed may land in a solid ----------------------------
  const walls = level.solids.filter((s) => s.kind === 'wall');
  const doors = level.solids.filter((s) => s.kind === 'door');

  const overlap = (s, box) => {
    const ox = Math.min(s.x + s.hx, box.x1) - Math.max(s.x - s.hx, box.x0);
    const oz = Math.min(s.z + s.hz, box.z1) - Math.max(s.z - s.hz, box.z0);
    return ox > 0 && oz > 0 ? ox * oz : 0;
  };

  for (const room of level.solids.filter((s) => s.kind === 'furniture')) {
    // `footprint`, NOT `x +/- hx`: an item placed at r: 90 has its half extents
    // swapped by the rotation, and reading the unrotated pair reports a box that
    // is 90 degrees out -- which is how the first version of this check managed
    // to miss every rotated piece of furniture in all five maps.
    const box = room.footprint || {
      x0: room.x - room.hx, x1: room.x + room.hx,
      z0: room.z - room.hz, z1: room.z + room.hz,
    };
    let wallArea = 0;
    for (const w of walls) wallArea += overlap(w, box);
    // 0.05 m2 is a fifth of a 0.5 m cabinet: below it the piece is merely
    // flush with the wall, which is how furniture is placed on purpose.
    if (wallArea > 0.05) {
      soft.push(`${room.id}: ${wallArea.toFixed(3)} m2 of it is inside a wall body`);
    }
    let doorArea = 0;
    // Doors carry `rot` too (90 for a leaf in a wall that runs along Z).
    for (const d of doors) doorArea += overlap({ ...d, ...(d.footprint || {}) }, box);
    if (doorArea > 0.05) {
      hard.push(`${room.id}: ${doorArea.toFixed(3)} m2 of it sits in a doorway --`
        + ' the passage the plan promised is blocked by furniture');
    }
  }

  // ---- 3. the spawn has to be standable ---------------------------------
  const r = level.body.playerRadius;
  for (const s of level.solids) {
    if (s.blocksMove === false || s.y1 <= level.meta.step) continue;
    const qx = Math.max(Math.abs(level.spawn.x - s.x) - s.hx, 0);
    const qz = Math.max(Math.abs(level.spawn.z - s.z) - s.hz, 0);
    const d = Math.hypot(qx, qz);
    if (d < r) {
      hard.push(`spawn (${level.spawn.x.toFixed(2)}, ${level.spawn.z.toFixed(2)}) is`
        + ` ${d.toFixed(3)} m from solid ${s.id}, inside the ${r} m body`);
    }
  }

  // ---- 4. a door that is SHUT inside the envelope is a room nobody can
  //         enter, and the whole building minus that room still looks fine.
  for (const d of doors) {
    if (!d.tags.includes('closed')) continue;
    const inner = d.x > 0.5 && d.x < layout.PLAN.w - 0.5
      && d.z > 0.5 && d.z < layout.PLAN.d - 0.5;
    if (inner) {
      hard.push(`door ${d.model} at (${d.x}, ${d.z}) is SHUT and it is NOT on the`
        + ' envelope -- measured coverage says this leaf seals its opening, so it'
        + ' is a wall, not a door. An interior passage needs `doorwayOpen`.');
    }
  }

  return { hard, soft };
}

/* ------------------------------------------------------------------- build */

export function measure(level) {
  const rooms = level.rooms.map((r) => ({
    id: r.id,
    name: r.name,
    resolved: r.resolved !== false,
    cells: r.cells != null ? r.cells : null,
    area: +(r.area || 0).toFixed(2),
    rect: r.rect ? {
      x0: +r.rect.x0.toFixed(2), z0: +r.rect.z0.toFixed(2),
      x1: +r.rect.x1.toFixed(2), z1: +r.rect.z1.toFixed(2),
    } : null,
  }));
  const itemCount = level.layout.ROOMS.reduce(
    (a, r) => a + r.items.filter((i) => !i.skip).length, 0);
  return {
    plan: { w: level.meta.plan.w, d: level.meta.plan.d },
    area: level.meta.plan.w * level.meta.plan.d,
    roomCount: rooms.length,
    rooms,
    itemCount,
    // items per square metre of PLAN -- the one number that separates 小 from
    // 大 in this roster, and the reason `verify_maps.mjs` can assert the tier
    // vocabulary instead of trusting it.
    itemDensity: +(itemCount / (level.meta.plan.w * level.meta.plan.d)).toFixed(3),
    solids: level.solids.length,
    openings: level.openings.length,
    walkable: level.meta.walkable || null,
  };
}

/**
 * Build one map. Returns the Level plus everything the build wants to say about
 * it, and TOUCHES NOTHING when `write` is false -- which is what lets
 * `verify_maps.mjs` rebuild every arena and diff it against the committed file.
 */
export async function buildOne(entry, inputs, log, { write = true } = {}) {
  const say = (s) => { log.push(s); console.log(s); };
  say('');
  say(`=== ${entry.id}  ${entry.name}  [${entry.category}]`);

  if (!entry.layout) {
    // The shipped apartment is not rebuilt here. Its snapshot is the input
    // every number in game/VERDICT.md was measured against; re-deriving it
    // would be a second producer of a fact that must have exactly one.
    const p = path.join(ROOT, entry.arena.replace(/^\.\//, ''));
    if (!fs.existsSync(p)) throw new Error(`${entry.id}: ${rel(p)} does not exist`);
    const level = JSON.parse(fs.readFileSync(p, 'utf8'));
    level.meta.walkable = level.meta.walkable
      || buildNav(level, {
        inflate: level.body.playerRadius,
        bodyHeight: level.body.playerHeight,
        step: level.meta.step,
      }).walkableCount;
    say(`   not rebuilt -- ${rel(p)} is the shipped snapshot (scripts/snapshot_arena.mjs)`);
    const m = measure(level);
    say(`   plan ${m.plan.w}x${m.plan.d}  rooms ${m.roomCount}  items ${m.itemCount}`
      + `  ${m.itemDensity} items/m2  walkable ${m.walkable}`);
    // Not rebuilt, but still described -- and a description is a claim.
    const prose = proseProblems(entry, m);
    for (const q of prose) say(`   !! ${q}`);
    return { entry, level, stats: m, hard: prose, soft: [], bytes: fs.statSync(p).size };
  }

  // ---- evaluate the layout module ---------------------------------------
  const lp = path.join(ROOT, entry.layout);
  const src = fs.readFileSync(lp, 'utf8');
  const layoutFile = {
    data: null, bytes: Buffer.byteLength(src), hash: hashString(src),
  };

  // `import()` is async and the rest of this function is not; the caller
  // already awaits `buildOne`.
  return import(pathToFileURL(lp).href).then((mod) => {
    layoutFile.data = {
      WALL_H: mod.WALL_H, PLAN: mod.PLAN, ZONES: mod.ZONES,
      WALLS: mod.WALLS, CORNERS: mod.CORNERS || [],
      DOORS: mod.DOORS, ROOMS: mod.ROOMS,
    };
    const layout = layoutFile.data;

    const { doorClosed, doorTable } = buildDoorStates(inputs.passages, layout.DOORS);
    const level = buildLevel({
      layout, sizes: inputs.sizes, surfaces: inputs.surfaces,
      wallOpenings: inputs.wallOpenings,
      options: { id: entry.id, name: entry.name, source: entry.layout, doorClosed },
    });

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
    const regionNav = buildNav(level, {
      inflate: level.body.playerRadius,
      bodyHeight: level.body.playerHeight,
      step: level.meta.step,
      sealOpenings: true,
    });
    const resolved = resolveRooms(level, regionNav);
    applyRooms(level, resolved.rooms);
    level.meta.walkable = playerNav.walkableCount;

    level.meta.provenance = {
      layout: { file: entry.layout, bytes: layoutFile.bytes, hash: layoutFile.hash },
      sizes: 'data/kit_three.json',
      surfaces: 'data/model_surfaces.json',
      passages: 'data/passages.json',
      generatedBy: 'scripts/build_maps.mjs',
    };
    level.meta.rooms = {
      total: level.rooms.length,
      resolved: level.rooms.filter((r) => r.resolved !== false).length,
      orphans: resolved.orphans.length,
      sealedOpenings: regionNav.sealedOpenings,
    };

    const problems = [...validateLevel(level), ...resolved.problems];
    // A measured opening with no door frame in it is the 18 cm slit class of
    // bug: a hole in a wall that was never meant to be one. `declared` bays
    // have no model by construction -- that is what `kinds: {i: null}` means.
    for (const o of level.openings) {
      if (o.source !== 'measured') continue;
      const hasDoor = level.solids.some((s) => s.kind === 'door'
        && Math.hypot(s.x - o.x, s.z - o.z) <= 0.7);
      if (!hasDoor) {
        problems.push(`opening in ${o.wall} @ (${o.x.toFixed(2)}, ${o.z.toFixed(2)})`
          + ' is a hole in a wall with no door in it');
      }
    }
    level.meta.problems = problems;

    const { hard, soft } = lint(level, layout);
    const stats = measure(level);
    hard.push(...proseProblems(entry, stats));

    // ---- 5. the spawn should be ON the nav, not merely clear of furniture.
    //         `componentAt` is a CELL query and `clear` is CONTINUOUS, so a
    //         legally occupiable spawn can sit in a cell whose centre is
    //         pinched -- and it then belongs to no region at all. `climbPlan`
    //         asks for the spawn's region; a region of -1 matches no walkable
    //         cell, so `grounded` was false everywhere, `reached` came back
    //         empty and the whole climb graph vanished. `game/core/climb.js`
    //         now falls back to `nav.nodeOf`, which is why this is a warning
    //         and not a failure -- but a map where the player starts in no
    //         region is worth saying out loud.
    const sp = playerNav.componentAt(level.spawn.x, level.spawn.z);
    if (sp < 0) {
      soft.push(`spawn (${level.spawn.x.toFixed(2)}, ${level.spawn.z.toFixed(2)}) is`
        + ' not on a walkable nav cell -- clear of furniture, but its own cell'
        + ' centre is pinched, so it belongs to no region');
    }

    say(`   plan ${stats.plan.w}x${stats.plan.d} (${stats.area} m2)  rooms ${stats.roomCount}`
      + `  items ${stats.itemCount} (${stats.itemDensity}/m2)  solids ${stats.solids}`);
    say(`   walls ${level.solids.filter((s) => s.kind === 'wall').length}`
      + `  doors ${level.solids.filter((s) => s.kind === 'door').length}`
      + ` (shut: ${doorTable.filter((d) => d.shut).map((d) => d.model).join(', ') || 'none'})`
      + `  openings ${stats.openings}`);
    say(`   nav  player ${playerNav.walkableCount}/${playerNav.w * playerNav.d}`
      + ` regions ${playerNav.components.length}`
      + `  guard ${guardNav.walkableCount} regions ${guardNav.components.length}`);
    say(`   rooms resolved ${level.rooms.filter((r) => r.resolved !== false).length}/${level.rooms.length}`
      + `  orphan regions ${resolved.orphans.length}`
      + ` (over the walker: ${resolved.orphans.filter((o) => o.area > Math.PI * 0.12 * 0.12).length})`);
    for (const r of resolved.rooms) {
      say(`      ${r.id.padEnd(11)} ${r.name.padEnd(5)} area ${r.area.toFixed(1).padStart(6)} m2`
        + `  rect [${r.rect.x0.toFixed(1)}, ${r.rect.z0.toFixed(1)}] .. [${r.rect.x1.toFixed(1)}, ${r.rect.z1.toFixed(1)}]`);
    }
    say(`   spawn (${level.spawn.x.toFixed(2)}, ${level.spawn.z.toFixed(2)})`
      + ` yaw ${(level.spawn.yaw * 180 / Math.PI).toFixed(0)} deg`);
    for (const p of problems) say(`   !! ${p}`);
    for (const p of hard) say(`   !! ${p}`);
    for (const p of soft) say(`   .. ${p}`);

    const out = arenaPath(entry.id);
    const json = JSON.stringify(level);
    if (write) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(out, json, 'utf8');
      say(`   wrote ${rel(out)}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
    } else {
      say(`   rebuilt ${rel(out)}  (${(Buffer.byteLength(json) / 1024).toFixed(0)} KB,`
        + ' not written)');
    }

    return {
      entry, level, stats, hard: [...problems, ...hard], soft,
      // The size of the JSON that WOULD be on disk, so the number means the
      // same thing whether or not this run was allowed to write.
      bytes: Buffer.byteLength(json, 'utf8'),
      json,
    };
  });
}

/* ------------------------------------------------------------------ inputs */

/**
 * The four measured inputs every map is built from, read once, here. Both the
 * build and the verifier call this rather than open the files themselves, so
 * there is exactly one place that knows what a map needs.
 */
export function readInputs() {
  const sizes = readJSON(path.join(ROOT, 'data', 'kit_three.json'));
  const surfaces = readJSON(path.join(ROOT, 'data', 'model_surfaces.json'), {});
  const passages = readJSON(path.join(ROOT, 'data', 'passages.json'));
  if (!sizes || !sizes.models) throw new Error('data/kit_three.json missing');
  if (!passages) throw new Error('data/passages.json missing');
  const { wallOpenings } = buildWallOpenings(passages, sizes);
  return { sizes, surfaces, passages, wallOpenings };
}

/* -------------------------------------------------------------------- main */

async function main() {
  const log = [];
  const say = (s) => { log.push(s); console.log(s); };

  const inputs = readInputs();

  say('build_maps');
  say('='.repeat(72));
  say(`roster: ${MAPS.map((m) => m.id).join(', ')}`);
  say('will rewrite:');
  for (const m of MAPS) {
    if (!m.layout) continue;
    say(`   ${rel(path.join(OUT_DIR, m.id + '.json'))}`);
  }
  say(`   ${rel(MANIFEST)}`);

  const results = [];
  for (const m of MAPS) results.push(await buildOne(m, inputs, log));

  // ---- the roster artifact ---------------------------------------------
  const manifest = {
    generatedBy: 'scripts/build_maps.mjs',
    // Not a literal: `DEFAULT_MAP` is the roster's answer, and a second copy of
    // it here is a second answer waiting to disagree.
    defaultMap: DEFAULT_MAP,
    maps: results.map((r) => ({
      id: r.entry.id,
      name: r.entry.name,
      category: r.entry.category,
      tier: r.entry.tier,
      style: r.entry.style,
      blurb: r.entry.blurb,
      arena: r.entry.arena,
      plan: r.stats.plan,
      area: r.stats.area,
      roomCount: r.stats.roomCount,
      itemCount: r.stats.itemCount,
      itemDensity: r.stats.itemDensity,
      walkable: r.stats.walkable,
      bytes: r.bytes,
      rooms: r.stats.rooms.map((x) => ({ id: x.id, name: x.name, area: x.area })),
    })),
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1), 'utf8');
  say('');
  say(`wrote ${rel(MANIFEST)}  ${(fs.statSync(MANIFEST).size / 1024).toFixed(1)} KB`);

  // ---- verdict ----------------------------------------------------------
  const bad = results.filter((r) => r.hard.length);
  say('');
  say('='.repeat(72));
  say(`${results.length - bad.length}/${results.length} maps clean`);
  for (const r of bad) {
    say(`FAIL ${r.entry.id}: ${r.hard.length} problem(s)`);
    for (const p of r.hard) say(`   ! ${p}`);
  }
  const work = path.join(ROOT, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'build_maps.log'), log.join('\n') + '\n', 'utf8');
  return bad.length ? 2 : 0;
}

// Only when RUN. `verify_maps.mjs` imports this file for `buildOne`, and an
// unguarded `process.exit` at module scope would kill it mid-flight.
const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exit(await main());
