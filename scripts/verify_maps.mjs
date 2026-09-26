/**
 * verify_maps.mjs — the five hand-made maps, checked as DATA and as a GAME.
 *
 *     node scripts/verify_maps.mjs
 *     node scripts/verify_maps.mjs --map manor        (one map, for a mutation run)
 *     node scripts/verify_maps.mjs --log work/_mut.log
 *
 * ONE Node process, no Chrome, no child processes -- the same shape as
 * `verify_packets.mjs` and for the same reason. "Can this floor plan hold 24
 * 红包, does every room resolve, is the prose telling the truth" are questions
 * about `game/core/` and `game/maps/`, all of which are portable by design.
 * Whether the PICTURE matches is a different question and needs a browser.
 *
 * WHAT IT EXISTS TO CATCH, each of these having actually happened or actually
 * been possible:
 *
 *   1. A MAP THAT CANNOT DEAL THE DIFFICULTY TABLE. 一人间 held 7 hiding places
 *      and the table offers 12 and 24. `buildCore` returns what it managed, so
 *      the failure was a run that simply had fewer packets than the card
 *      promised -- no error, anywhere. The floor for this is `pool >= 24`, and
 *      it is asserted per map.
 *   2. AN ARENA THAT IS NOT WHAT THE SOURCE BUILDS. `game/arenas/maps/*.json`
 *      is committed. Rebuilding every one of them here and diffing BYTE FOR
 *      BYTE is the only check that survives someone editing a layout and
 *      forgetting the build step. It goes through `buildOne` with
 *      `{write:false}` -- the same pipeline, not a copy of it.
 *   3. PROSE THAT DISAGREES WITH THE FLOOR PLAN. `game/maps/index.js` shipped
 *      "73 件家具" for a map that had 83. `proseProblems` is the one rule, and
 *      both the build and this file call it.
 *   4. ROOM OWNERSHIP, WHICH IS DECIDED BY BOUNDING BOX. Two rooms that overlap
 *      hand the second one's 红包 to the first, silently. So the rectangles are
 *      asserted disjoint, and every placed packet is re-attributed with
 *      `roomOfPoint` -- which is a DIFFERENT implementation from the `roomAt`
 *      that placed it, so agreement is evidence and not a tautology.
 *   5. THE SIZE VOCABULARY 小 / 中 / 大. "Small maps are dense, large maps are
 *      big" is the request; as an ordering between the measured numbers it can
 *      be checked, and as a label it cannot.
 *   6. TWO NAMES FOR ONE FLOOR. `game/maps/index.js` keyed the shipped apartment
 *      as `origin`; `snapshot_arena.mjs` writes `meta.id: 'room_scene'` into the
 *      artifact. Nothing compared the two, so the map rail drew six cards and
 *      marked none of them on the floor that was actually standing -- a menu
 *      that cannot say which map you are on. An id is only a name if the thing
 *      it names answers to it, so the roster id and the arena's own id are
 *      asserted equal, for every entry, here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildOne, readInputs, measure, MANIFEST, ROOT } from './build_maps.mjs';
import { MAPS, DEFAULT_MAP, CATEGORIES } from '../game/maps/index.js';
import { proseProblems } from '../game/maps/prose.js';
import { validateLevel, roomOfPoint } from '../game/core/level.js';
import { buildNav } from '../game/core/nav.js';
import { climbPlan } from '../game/core/climb.js';
import { resolveRooms } from '../game/core/regions.js';
import { buildCore } from '../game/play/boot.js';
import { buildPatrol } from '../game/core/guard.js';
import { Rng } from '../game/core/rng.js';
import { DIFFICULTIES, guardCountFor, prizeCountFor } from '../game/play/config.js';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Refuse to read a tree that a mutation run has open.
 *
 * A mutation harness and a reader ran concurrently once (see work/_lock.py) and
 * the reader recorded a FAILED transcript -- `wallH 1.30 vs 1.29`, the mutated
 * value -- for a repository that only existed during someone else's run. The
 * harness itself runs this gate, so it passes AIRC_MUTATING=1 and is let in.
 */
const MUTATION_LOCK = path.join(HERE, 'work', '.mutating');
if (fs.existsSync(MUTATION_LOCK) && process.env.AIRC_MUTATING !== '1') {
  let who = 'another run';
  try { who = fs.readFileSync(MUTATION_LOCK, 'utf8').trim() || who; } catch { /* keep default */ }
  console.error(`REFUSING to run: ${who} is holding the working tree`
    + ` (${path.relative(HERE, MUTATION_LOCK).replace(/\\/g, '/')}).`);
  console.error('  While a mutation is applied the tree is INCONSISTENT, so any'
    + ' reading here describes a repository that does not exist.');
  console.error('  Wait for it to finish, or delete that file if it is stale.');
  process.exit(3);
}

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
};
const ONLY = argOf('--map');

const log = [];
const say = (s = '') => { log.push(s); console.log(s); };

const checks = [];
const ok = (cond, label, detail = '') => {
  checks.push({ ok: !!cond, label, detail });
  say(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  -- ' + detail : ''}`);
  return !!cond;
};

/** Where two strings first differ, with a little of each side. */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return `at byte ${i}: on disk ${JSON.stringify(a.slice(i, i + 30))}`
        + ` vs rebuilt ${JSON.stringify(b.slice(i, i + 30))}`;
    }
  }
  return `identical for ${n} bytes, lengths ${a.length} vs ${b.length}`;
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const entryById = new Map(MAPS.map((m) => [m.id, m]));
// The arena path comes from the roster entry, never from a constructed name:
// the shipped apartment's snapshot is `game/arenas/room_scene.json` and is not
// in `game/arenas/maps/`, and inventing a path is how a checker ends up
// reading a file the game does not. Takes an entry or an id, so the two cannot
// be passed to the wrong one of each other.
const arenaOf = (e) => {
  const entry = typeof e === 'string' ? entryById.get(e) : e;
  if (!entry) throw new Error(`arenaOf: no roster entry for ${JSON.stringify(e)}`);
  return path.join(ROOT, entry.arena.replace(/^\.\//, ''));
};
const run = MAPS.filter((m) => !ONLY || m.id === ONLY);

let exitCode = 0;
try {
  const inputs = readInputs();

  /* ------------------------------------------------------------------ 1 */
  say('== the roster and the artifact it produced ==');
  say(`  ${manifest.maps.length} map(s) in ${path.relative(HERE, MANIFEST).replace(/\\/g, '/')}`);
  ok(manifest.generatedBy === 'scripts/build_maps.mjs',
    'the manifest names the script that produced it', manifest.generatedBy);
  ok(manifest.maps.length === MAPS.length,
    `the manifest lists every map on the roster (${MAPS.length})`,
    `${manifest.maps.length}`);
  ok(!!entryById.get(manifest.defaultMap),
    'the default map is one of the maps', manifest.defaultMap);
  ok(manifest.defaultMap === DEFAULT_MAP,
    'and index.js and the manifest agree on which one it is',
    `${DEFAULT_MAP} vs ${manifest.defaultMap}`);
  ok(manifest.maps.every((r) => CATEGORIES.includes(r.category)),
    'every category in the manifest is in the roster vocabulary',
    [...new Set(manifest.maps.map((r) => r.category))].join(' / '));

  const census = {};
  for (const m of MAPS) census[m.category] = (census[m.category] || 0) + 1;
  ok(census['小'] === 2 && census['中'] === 2 && census['大'] === 1,
    'the roster is two 小, two 中 and one 大 (plus the 原型)',
    JSON.stringify(census));

  for (let i = 0; i < MAPS.length; i++) {
    const a = MAPS[i];
    const b = manifest.maps[i];
    if (!b) { ok(false, `${a.id}: has a manifest entry`); continue; }
    const same = b.id === a.id && b.name === a.name && b.category === a.category
      && b.tier === a.tier && b.style === a.style && b.blurb === a.blurb
      && b.arena === a.arena;
    ok(same, `${a.id}: the manifest entry is this roster entry, field for field`,
      same ? '' : `manifest ${JSON.stringify({ id: b.id, name: b.name, tier: b.tier })}`
        + ` vs roster ${JSON.stringify({ id: a.id, name: a.name, tier: a.tier })}`);
  }

  say('');
  for (const r of manifest.maps) {
    const p = path.join(HERE, r.arena.replace(/^\.\//, ''));
    const exists = fs.existsSync(p);
    ok(exists, `${r.id}: ${r.arena} exists`);
    if (exists) {
      ok(fs.statSync(p).size === r.bytes,
        `${r.id}: the manifest's byte count is the file's byte count`,
        `${fs.statSync(p).size} vs ${r.bytes}`);
      // An id is only a name if the thing it names answers to it. The menu
      // marks a card by comparing the loaded level's `meta.id` with the roster
      // id, so a floor that spells itself differently is a floor the menu
      // cannot mark -- which is exactly how `origin` vs `room_scene` shipped.
      const self = JSON.parse(fs.readFileSync(p, 'utf8')).meta.id;
      ok(self === r.id,
        `${r.id}: the roster id is the id the arena gives itself`,
        `${JSON.stringify(r.id)} vs meta.id ${JSON.stringify(self)}`);
    }
  }

  /* ------------------------------------------------------------------ 2 */
  say('\n== the prose states numbers it does not own ==');
  for (const r of manifest.maps) {
    const entry = entryById.get(r.id);
    const stats = {
      plan: r.plan, area: r.area, roomCount: r.roomCount, itemCount: r.itemCount,
    };
    const bad = proseProblems(entry, stats);
    ok(bad.length === 0, `${r.id}: every number in its blurb is the measured one`,
      bad.join(' | '));
  }

  /* ------------------------------------------------------------------ 3 */
  say('\n== every arena is what its source builds today ==');
  const t0 = performance.now();
  for (const entry of run) {
    const r = await buildOne(entry, inputs, [], { write: false });
    const p = arenaOf(entry);
    if (!r.json) {
      say(`  ..  ${entry.id}: not rebuilt (shipped snapshot), prose only`);
      ok(r.hard.length === 0, `${entry.id}: the build reports no problems`);
      continue;
    }
    const disk = fs.readFileSync(p, 'utf8');
    ok(r.json === disk,
      `${entry.id}: the committed arena is byte for byte what the source builds`,
      r.json === disk ? `${(Buffer.byteLength(disk) / 1024).toFixed(0)} KB`
        : firstDiff(disk, r.json));
    ok(r.hard.length === 0, `${entry.id}: the build reports no problems`,
      r.hard.slice(0, 3).join(' | '));
  }
  say(`  (rebuild took ${((performance.now() - t0) / 1000).toFixed(1)} s)`);

  /* ------------------------------------------------------------------ 4 */
  say('\n== the floor plan means what the core thinks it means ==');
  for (const entry of run) {
    const p = arenaOf(entry.id);
    const level = JSON.parse(fs.readFileSync(p, 'utf8'));
    const id = entry.id;

    const v = validateLevel(level);
    ok(v.length === 0, `${id}: validateLevel is clean`, v.slice(0, 3).join(' | '));
    ok((level.meta.problems || []).length === 0,
      `${id}: the arena carries no problems of its own`,
      (level.meta.problems || []).slice(0, 3).join(' | '));

    const unresolved = level.rooms.filter((r) => r.resolved === false);
    ok(unresolved.length === 0, `${id}: every room resolved a rectangle`,
      unresolved.map((r) => r.id).join(', '));
    ok(level.meta.rooms.total === level.rooms.length
      && level.meta.rooms.resolved === level.rooms.length,
      `${id}: the arena's own room census agrees with its room list`,
      JSON.stringify(level.meta.rooms));

    // the manifest's numbers have to be the arena's numbers
    const m = measure(level);
    const r = manifest.maps.find((x) => x.id === id);
    ok(m.roomCount === r.roomCount && m.itemCount === r.itemCount && m.area === r.area,
      `${id}: the manifest's room/item/area numbers are the arena's`,
      `manifest ${r.roomCount}/${r.itemCount}/${r.area}`
      + ` vs arena ${m.roomCount}/${m.itemCount}/${m.area}`);

    // rooms must not share floor: ownership is decided by bounding box
    const rs = level.rooms.filter((x) => x.rect);
    const clashes = [];
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i].rect;
        const b = rs[j].rect;
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const oz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
        if (ox > 0.02 && oz > 0.02) clashes.push(`${rs[i].id}/${rs[j].id}`);
      }
    }
    ok(clashes.length === 0, `${id}: no two room rectangles share floor`,
      clashes.join(', '));

    // the spawn: in exactly one room, and clear of furniture
    const sp = level.spawn;
    const home = level.rooms.filter((x) => x.rect
      && sp.x >= x.rect.x0 && sp.x <= x.rect.x1
      && sp.z >= x.rect.z0 && sp.z <= x.rect.z1);
    ok(home.length === 1, `${id}: the spawn is inside exactly one room`,
      home.map((x) => x.id).join(', ') || 'none');
    const bodyR = level.body.playerRadius;
    const tooClose = level.solids.filter((s) => {
      if (s.blocksMove === false || s.y1 <= level.meta.step) return false;
      const f = s.footprint || {
        x0: s.x - s.hx, x1: s.x + s.hx, z0: s.z - s.hz, z1: s.z + s.hz,
      };
      const qx = Math.max(f.x0 - sp.x, 0, sp.x - f.x1);
      const qz = Math.max(f.z0 - sp.z, 0, sp.z - f.z1);
      return Math.hypot(qx, qz) < bodyR;
    });
    ok(tooClose.length === 0, `${id}: nothing solid is inside the spawn's body`,
      tooClose.map((s) => s.id).join(', '));

    // no unowned floor: rebuilt from the committed level, sealed doorways
    const regionNav = buildNav(level, {
      inflate: level.body.playerRadius,
      bodyHeight: level.body.playerHeight,
      step: level.meta.step,
      sealOpenings: true,
    });
    const resolved = resolveRooms(level, regionNav);
    const bar = Math.PI * bodyR * bodyR;
    const big = resolved.orphans.filter((o) => o.area > bar);
    ok(big.length === 0,
      `${id}: no walkable pocket belongs to no room (over ${bar.toFixed(4)} m2)`,
      big.map((o) => `${o.area.toFixed(4)} m2`).join(', ')
        + (resolved.orphans.length - big.length
          ? ` (+${resolved.orphans.length - big.length} under the bar, recorded)` : ''));
    ok(resolved.ok, `${id}: resolveRooms is happy`, resolved.problems.slice(0, 2).join(' | '));
  }

  /* ------------------------------------------------------------------ 5 */
  say('\n== the difficulty table can be dealt on every map ==');
  const SEED = 'maps-ruler';
  const want = Math.max(...DIFFICULTIES.map(prizeCountFor));
  say(`  the table's largest preset asks for ${want} 红包`
    + ` (${DIFFICULTIES.map((d) => d.id + '=' + prizeCountFor(d)).join(', ')})`
    + `;  the largest garrison is ${Math.max(...DIFFICULTIES.map(guardCountFor))}`);

  for (const entry of run) {
    const level = JSON.parse(fs.readFileSync(arenaOf(entry.id), 'utf8'));
    const id = entry.id;

    const plan = climbPlan(level, buildNav(level, {
      inflate: level.body.playerRadius,
      bodyHeight: level.body.playerHeight,
      step: level.meta.step,
    }));
    ok(plan.reached.size > 0,
      `${id}: the climb graph is not empty (eye height on something, or every`
      + ' packet on a table top measures hidden)',
      `${plan.reached.size}/${plan.surfaces.length} surfaces reachable, home region ${plan.home}`);

    let first = null;
    for (const count of [...new Set(DIFFICULTIES.map(prizeCountFor))]) {
      const core = buildCore(level, { seed: SEED, count });
      if (!first) first = core;
      const placed = core.prizes.length;
      ok(placed === count, `${id}: ${count} 红包 are dealt as ${count}`,
        placed === count ? `pool ${core.placement.report.anchorsScored}`
          : `only ${placed} placed, from a pool of ${core.placement.report.anchorsScored}`);

      const misfiled = core.prizes.filter((q) => roomOfPoint(level, q.x, q.z) !== q.room);
      ok(misfiled.length === 0,
        `${id}/${count}: every 红包 is owned by the room it was placed in`,
        misfiled.map((q) => `${q.id} in ${q.room} but at (${q.x.toFixed(2)},`
          + ` ${q.z.toFixed(2)}) which is ${roomOfPoint(level, q.x, q.z)}`).join(' | '));

      const onFloor = core.prizes.filter((q) => q.y <= 0.02).length;
      ok(onFloor === 0, `${id}/${count}: nothing is lying on the floor`,
        `${onFloor} of ${placed}`);
    }

    const pool = first.placement.report.anchorsScored;
    ok(pool >= want, `${id}: its anchor pool can host the largest preset`,
      `${pool} anchors for ${want} 红包`);

    // patrols
    const core = first;
    const guardNav = core.guardNav;
    ok(core.patrols.length === 2, `${id}: two patrols are built`,
      `${core.patrols.length}`);
    ok(core.patrols.every((x) => x.waypoints.length >= 2),
      `${id}: both patrols have a route`,
      core.patrols.map((x) => x.waypoints.length).join(' + '));
    const offGrid = core.patrols.flatMap((x, gi) => x.waypoints
      .filter((w) => !guardNav.clear(w.x, w.z))
      .map((w) => `p${gi}@${w.x.toFixed(2)},${w.z.toFixed(2)}`));
    ok(offGrid.length === 0,
      `${id}: every patrol stop is a place the guard's body fits`,
      offGrid.slice(0, 4).join(', '));
    const a = core.patrols[0].waypoints.map((w) => w.x.toFixed(6) + ',' + w.z.toFixed(6));
    const b = core.patrols[1].waypoints.map((w) => w.x.toFixed(6) + ',' + w.z.toFixed(6));
    const same = a.length === b.length && a.every((s, i) => s === b[i]);
    ok(!same, `${id}: the second guard does not walk the first one's route`,
      same ? 'IDENTICAL -- the second guard is a shadow' : `${a.length} vs ${b.length} stops`);

    // ...and the cure for that must not have moved guard 1. Guard 1's route is
    // what game/VERDICT.md measured, so the second patrol's stream and the
    // `alt` stop-rotation are both forbidden from touching it. Same assertion
    // scripts/verify_packets.mjs makes on the apartment, made here on every map.
    const lone = buildPatrol(level, guardNav, new Rng(`guard-${SEED}`), {});
    const c = lone.waypoints.map((w) => w.x.toFixed(6) + ',' + w.z.toFixed(6));
    ok(c.length === a.length && c.every((s, i) => s === a[i]),
      `${id}: patrol[0] is bit-for-bit the same with or without patrol[1]`,
      `${c.length} vs ${a.length} stops`);
  }

  /* ------------------------------------------------------------------ 6 */
  say('\n== the size vocabulary is a fact, not a label ==');
  const sized = manifest.maps.filter((m) => m.tier > 0);
  const cat = (c) => sized.filter((m) => m.category === c);
  const spread = (list, f) => list.map(f);
  const roomsOf = (c) => spread(cat(c), (m) => m.roomCount);
  const areaOf = (c) => spread(cat(c), (m) => m.area);
  const densOf = (c) => spread(cat(c), (m) => m.itemDensity);
  say(`  小 rooms ${roomsOf('小')}  area ${areaOf('小')}  items/m2 ${densOf('小')}`);
  say(`  中 rooms ${roomsOf('中')}  area ${areaOf('中')}  items/m2 ${densOf('中')}`);
  say(`  大 rooms ${roomsOf('大')}  area ${areaOf('大')}  items/m2 ${densOf('大')}`);

  const mx = (l) => Math.max(...l);
  const mn = (l) => Math.min(...l);
  ok(sized.length === 5, 'five maps carry a size category', `${sized.length}`);
  ok(mx(roomsOf('小')) < mn(roomsOf('中')),
    '小 has fewer rooms than 中 (small maps are few-roomed)',
    `${mx(roomsOf('小'))} < ${mn(roomsOf('中'))}`);
  ok(mx(roomsOf('中')) < mn(roomsOf('大')),
    '中 has fewer rooms than 大', `${mx(roomsOf('中'))} < ${mn(roomsOf('大'))}`);
  ok(mx(areaOf('小')) < mn(areaOf('中')) && mx(areaOf('中')) < mn(areaOf('大')),
    'the floor area grows 小 < 中 < 大',
    `${mn(areaOf('小'))}..${mx(areaOf('小'))} < ${mn(areaOf('中'))}..${mx(areaOf('中'))}`
    + ` < ${mn(areaOf('大'))}`);
  ok(mn(densOf('小')) > mx(densOf('中')) && mn(densOf('中')) > mx(densOf('大')),
    'item density falls 小 > 中 > 大 (small maps are packed, big ones are open)',
    `${mx(densOf('小'))} > ${mn(densOf('中'))}..${mx(densOf('中'))} > ${mn(densOf('大'))}`);
} catch (err) {
  say('');
  say('HARNESS ERROR: ' + (err && err.stack ? err.stack : err));
  exitCode = 2;
}

const passed = checks.filter((c) => c.ok).length;
say('');
say('='.repeat(72));
say(`  ${passed}/${checks.length} checks passed`);
for (const c of checks) if (!c.ok) say(`   FAILED: ${c.label} — ${c.detail || ''}`);
say('='.repeat(72));
const verdict = checks.length > 0 && passed === checks.length && exitCode === 0;
say(verdict ? '  VERDICT: PASS' : '  VERDICT: FAIL');

// Redirectable, so a mutation run cannot leave a FAILED transcript in the
// canonical slot. Same accident, same cure as verify_packets.mjs.
const logPath = argOf('--log')
  ? path.resolve(argOf('--log'))
  : path.join(HERE, 'work', 'verify_maps.log');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, log.join('\n') + '\n');
say(`  log: ${(path.relative(HERE, logPath) || logPath).replace(/\\/g, '/')}`);

if (!verdict) exitCode = 1;
process.exit(exitCode);
