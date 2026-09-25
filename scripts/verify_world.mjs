/**
 * verify_world.mjs — IS THE WORLD YOU SEE THE FLOOR YOU PLAY?
 *
 *     node scripts/verify_world.mjs
 *
 * THE BUG THIS FILE EXISTS FOR. A generated floor plan was declared playable by
 * every other suite in this repo -- nav grid, rooms, prizes, patrol, spawn,
 * "does it render" -- and it was, in the sense that the CORE ran on it. What
 * the player actually saw was the SHIPPED apartment, because `play.js` built its
 * renderer from `js/layout.js` at module scope and had never heard of an arena.
 * Boot the two together and you spawn OUTSIDE the flat you are playing, facing
 * its exterior wall, with the 红包 hanging in mid-air:
 *
 *   arena game/arenas/gen.json
 *     plan the core plays   16 x 14 m   (10 rooms)
 *     world actually drawn  10.14 x 8.15 m   (6 rooms)     <- the shipped one
 *
 * So this suite asks nothing about the core. It measures the SCENE GRAPH against
 * the LEVEL, and the level against the file the layout was written from, on
 * three different floors plus one decoy. Two of the three floors have plans that
 * differ from each other and from the shipped apartment, so no single
 * hand-tuned file can make it pass by accident.
 *
 *   1. three floors, three plans, three worlds -- each world IS its plan
 *   2. the counts that must be 1:1: floor tiles, doors, furniture
 *   3. you are standing ON the flat, not on the bare ground beside it
 *   4. a snapshot with NO layout is REFUSED, loudly, rather than silently
 *      built as the shipped apartment
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import cdp from './cdp.js';
import { requiredModels } from '../game/procgen/required.js';

const { serve, launch, attach, killStrayChrome, sleep } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 8795;
const DEBUG = 9231;
const SHOTS = path.join(ROOT, 'renders', 'world');
const REPORT = path.join(ROOT, 'reports', 'world.txt');

const log = [];
const say = (s = '') => { log.push(s); console.log(s); };

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++; else failed++;
  say(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const canon = (o) => JSON.stringify(o);

/* ================================================================== 1. the floors */

say('-- 1. the floors under test ---------------------------------------------');

// A THIRD FLOOR, at a size neither of the other two uses. It is generated here
// rather than committed so the suite cannot be satisfied by one hand-tuned file:
// three plans, three footprints, three worlds.
const SMALL = { w: 9, d: 9, rooms: 5, items: 55, seed: 'worldB' };
const small = spawnSync(process.execPath, [
  'scripts/procgen.mjs', '--w', String(SMALL.w), '--d', String(SMALL.d),
  '--rooms', String(SMALL.rooms), '--items', String(SMALL.items), '--seed', SMALL.seed,
  '--arena', 'work/_world_small.json', '--out-layout', 'work/_world_small_layout.js',
  '--report', 'work/_world_small_procgen.txt', '--svg', 'work/_world_small.svg',
], { cwd: ROOT, encoding: 'utf8' });
const smallOut = (small.stdout || '') + (small.stderr || '');
check('a third floor was generated, at a size of its own',
  small.status === 0 && /1\/1 PASS/.test(smallOut),
  `${SMALL.w}x${SMALL.d}, ${SMALL.rooms} rooms, ${SMALL.items} items`);
if (small.status !== 0) {
  say(smallOut.trim().split('\n').slice(-6).join('\n'));
  process.exit(1);
}

const ARENAS = [
  { id: 'shipped', url: 'game/arenas/room_scene.json', expectRooms: 6 },
  { id: 'generated', url: 'game/arenas/gen.json', expectRooms: 10 },
  { id: 'small', url: 'work/_world_small.json', expectRooms: SMALL.rooms },
];
const levels = {};
for (const a of ARENAS) levels[a.id] = readJSON(a.url);

// The decoy: a real floor with its `layout` amputated. Not a different plan and
// not a broken one -- the same file, minus the thing that says what to build.
const decoy = JSON.parse(canon(levels.small));
delete decoy.layout;
fs.writeFileSync(path.join(ROOT, 'work/_world_nolayout.json'), canon(decoy), 'utf8');
say(`   ${ARENAS.map((a) => `${a.id} ${levels[a.id].meta.plan.w}x${levels[a.id].meta.plan.d}m`).join('  ·  ')}`);
say(`   decoy  work/_world_nolayout.json (the ${SMALL.w}x${SMALL.d} floor, no layout)`);

/* three plans, all different -- otherwise the comparison below proves nothing */
const plans = ARENAS.map((a) => `${levels[a.id].meta.plan.w}x${levels[a.id].meta.plan.d}`);
check('the three floors have three different plans, none of them the shipped default',
  new Set(plans).size === 3, plans.join(' · '));

/* ------------------------------- the shipped snapshot is the shipped layout */
// `game/arenas/room_scene.json` is COMMITTED and its geometry is a copy of
// `js/layout.js` taken when it was made. If the apartment moves and the snapshot
// does not follow, the game would faithfully render a flat nobody has edited
// for months -- so the hash the snapshot recorded is re-derived here.
const lvlFile = fs.readFileSync(path.join(ROOT, 'js', 'layout.js'), 'utf8');
const shippedLayout = await import('../js/layout.js');
const strip = (L) => canon({
  WALL_H: L.WALL_H, PLAN: L.PLAN,
  ZONES: L.ZONES || [], WALLS: L.WALLS || [], CORNERS: L.CORNERS || [],
  DOORS: L.DOORS || [], ROOMS: L.ROOMS || [],
});
const embedded = levels.shipped.layout;
check('the shipped snapshot carries its own layout',
  !!embedded && !!embedded.PLAN, embedded ? `${embedded.ROOMS.length} rooms` : 'MISSING');
check('and that layout is byte-for-byte js/layout.js',
  !!embedded && strip(embedded) === strip(shippedLayout),
  'if this fails: re-run node scripts/snapshot_arena.mjs');
// Not decorative: it is what makes re-stamping an old snapshot safe.
const { hashString } = await import('../game/core/rng.js');
const recorded = levels.shipped.meta.provenance && levels.shipped.meta.provenance.layout;
check('and the provenance hash still matches the file on disk',
  !!recorded && recorded.hash === hashString(lvlFile),
  recorded ? `recorded ${recorded.hash}, file ${hashString(lvlFile)}` : 'no recorded hash');

/* ============================================================== 2. the worlds */
let server = null, chrome = null, sess = null;

/** What the page must report back after booting one arena. */
const MEASURE = `(() => {
  const T = __play.THREE;
  const apt = __play.apartment;
  const root = apt.root;
  const lvl = __play.level;
  const box = new T.Box3().setFromObject(root);
  const size = box.getSize(new T.Vector3());
  const fur = root.getObjectByName('furniture');
  const zones = fur ? fur.children.map((c) => c.userData.zone || '(none)').sort() : [];

  // WHERE AM I STANDING? A downward ray from the spawn. If the flat you are
  // playing is not the flat that was built, this is the measurement that says
  // so: the ray lands on the bare site plane beside the building.
  const sp = lvl.spawn;
  const rc = new T.Raycaster(new T.Vector3(sp.x, 2.5, sp.z), new T.Vector3(0, -1, 0));
  const hits = rc.intersectObject(root, true);
  const group = (o) => { const n = []; let p = o; while (p && p !== root) { if (p.name) n.push(p.name); p = p.parent; } return n; };
  const grounded = hits.filter((h) => group(h.object).indexOf('floor') >= 0);

  return {
    plan: lvl.meta.plan,
    world: { x: +size.x.toFixed(3), z: +size.z.toFixed(3), y: +size.y.toFixed(3) },
    worldMin: { x: +box.min.x.toFixed(3), z: +box.min.z.toFixed(3) },
    worldMax: { x: +box.max.x.toFixed(3), z: +box.max.z.toFixed(3) },
    zones,
    levelRooms: lvl.rooms.map((r) => r.id).sort(),
    stats: apt.stats,
    levelCounts: {
      floors: lvl.floors.length,
      doors: lvl.solids.filter((s) => s.kind === 'door').length,
      furniture: lvl.solids.filter((s) => s.kind === 'furniture').length,
    },
    spawn: { x: +sp.x.toFixed(3), z: +sp.z.toFixed(3) },
    spawnHits: hits.length,
    spawnTopGroup: hits.length ? group(hits[0].object).join('/') : null,
    spawnTopY: hits.length ? +hits[0].point.y.toFixed(3) : null,
    spawnGrounded: grounded.length > 0,
  };
})()`;

async function bootOn(url) {
  const full = `http://127.0.0.1:${PORT}/play.html?arena=./${url}`;
  await sess.goto(full, { settle: 1200 });
  for (let i = 0; i < 240; i++) {
    if (await sess.evalJs('!!(window.__ready && window.__play)') === true) return { ready: true };
    const err = await sess.evalJs('window.__playError || null');
    if (err) return { ready: false, error: String(err) };
    await sleep(500);
  }
  return { ready: false, error: 'timed out' };
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });

  await killStrayChrome();
  server = await serve(ROOT, PORT);
  chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_world' });
  sess = await attach({ port: DEBUG });
  await sess.viewport(1600, 900);
  say(`   GL ${await sess.glRenderer()}`);

  for (const a of ARENAS) {
    say('');
    say(`-- 2.${ARENAS.indexOf(a) + 1} ${a.id}: ${a.url} ------------------------------`);
    const boot = await bootOn(a.url);
    if (!boot.ready) {
      check(`${a.id}: the page booted`, false, boot.error);
      continue;
    }
    const m = await sess.evalJs(MEASURE);
    const plan = m.plan;
    say(`   plan ${plan.w}x${plan.d} m, ${m.levelRooms.length} rooms   ·   `
      + `world ${m.world.x.toFixed(2)}x${m.world.z.toFixed(2)} m, ${m.zones.length} rooms, `
      + `height ${m.world.y.toFixed(2)} m`);

    // (a) THE FOOTPRINT. The flat plus its own wall thickness, and nothing
    // else: a world SMALLER than the plan is a building that does not cover the
    // floor you are walking on, which is exactly the shipped-apartment bug.
    const dx = m.world.x - plan.w;
    const dz = m.world.z - plan.d;
    check(`${a.id}: the world is as wide as the plan it plays`,
      dx >= 0 && dx <= 0.4 && dz >= 0 && dz <= 0.4,
      `plan ${plan.w}x${plan.d} -> world ${m.world.x.toFixed(2)}x${m.world.z.toFixed(2)} `
      + `(+${dx.toFixed(2)}, +${dz.toFixed(2)} of wall)`);

    // (b) THE ROOMS, BY NAME. A generated 10-room flat has bedroom2, dining2...
    // The shipped six do not, so a mismatch here is the shipped builder showing.
    check(`${a.id}: the rooms drawn are the rooms of the level`,
      m.zones.length === m.levelRooms.length && m.zones.join() === m.levelRooms.join(),
      `${m.zones.length} drawn, ${m.levelRooms.length} in the level, ${a.expectRooms} expected`);

    // (c) THE 1:1 COUNTS. Not "it looks furnished" -- every floor tile, door and
    // piece of furniture the level reasons about must have been built, once.
    check(`${a.id}: floor tiles, doors and furniture are 1:1 with the level`,
      m.stats.floorTiles === m.levelCounts.floors
        && m.stats.doors === m.levelCounts.doors
        && m.stats.furniture === m.levelCounts.furniture,
      `tiles ${m.stats.floorTiles}/${m.levelCounts.floors}, `
      + `doors ${m.stats.doors}/${m.levelCounts.doors}, `
      + `furniture ${m.stats.furniture}/${m.levelCounts.furniture}`);

    // (d) YOU ARE STANDING ON IT. Ray straight down from the spawn.
    check(`${a.id}: the spawn stands on the flat's own floor`,
      m.spawnGrounded,
      `spawn (${m.spawn.x}, ${m.spawn.z}) -> ${m.spawnTopGroup} at y=${m.spawnTopY}, `
      + `${m.spawnHits} hit(s), ${m.spawnGrounded ? 'floor found' : 'NOTHING UNDERFOOT'}`);

    m.id = a.id;
    ARENAS[ARENAS.indexOf(a)].measured = m;
  }

  /* ==================================================== 3. the decoy refuses */
  say('');
  say('-- 3. a snapshot with no layout is refused, not guessed -----------------');
  // THE NEGATIVE CONTROL. Every other check in this file passes if play.js
  // quietly builds the shipped apartment; this one is the only thing standing
  // between "the arena says nothing about geometry" and "so we built something
  // and called it a day".
  const bad = await bootOn('work/_world_nolayout.json');
  const msg = bad.error || String(await sess.evalJs('window.__playError || "(none)"'));
  say(`   the page says: ${msg.slice(0, 140)}`);
  check('the boot FAILED rather than falling back', bad.ready === false,
    bad.ready ? 'it booted on a layout-less arena' : 'no __ready');
  check('and it says why, by name',
    /layout/.test(msg) && /carries no/.test(msg), msg.slice(0, 160));
  const overlay = await sess.evalJs(`(() => {
    const l = document.getElementById('ov-load');
    return { failed: l.classList.contains('failed'),
             visible: !l.classList.contains('hidden'),
             title: (document.getElementById('load-title') || {}).textContent || '' };
  })()`);
  check('and the player is told, on screen, instead of a loading bar that hangs',
    overlay.failed && overlay.visible, JSON.stringify(overlay));
  if (sess.shot) {
    await sess.shot(path.join(SHOTS, '03-refused-no-layout.png'));
  }

  /* ========================================================== 4. artifacts */
  say('');
  say('-- 4. artifacts ---------------------------------------------------------');
  for (const a of ARENAS) {
    const m = a.measured;
    if (!m) continue;
    const boot = await bootOn(a.url);
    if (!boot.ready) continue;
    await sess.evalAsync(`await __play.begin('patrol', { seed: 'world' }); return 1;`);
    await sess.evalAsync(`__play.lookAt(${m.plan.w / 2}, ${m.plan.d / 2}); return 1;`);
    const f = path.join(SHOTS, `01-${a.id}-eye.png`);
    const r = await sess.shot(f);
    say(`   ${a.id.padEnd(10)} ${r.ok ? r.bytes + ' B' : 'FAILED'}  ${path.relative(ROOT, f).replace(/\\/g, '/')}`);
    // An overhead frame per floor, so three plans can be compared by eye -- the
    // picture and the numbers come from the same pose.
    await sess.evalAsync(
      `__play.freeCam({ x: ${m.plan.w / 2}, y: ${levels[a.id].meta.wallH + 4.5},`
      + ` z: ${m.plan.d / 2}, tx: ${m.plan.w / 2}, ty: 0, tz: ${m.plan.d / 2 + 0.01} });
       __play.renderOnce(); return 1;`);
    const f2 = path.join(SHOTS, `00-${a.id}-top.png`);
    const r2 = await sess.shot(f2);
    say(`   ${(a.id + ' top').padEnd(10)} ${r2.ok ? r2.bytes + ' B' : 'FAILED'}  ${path.relative(ROOT, f2).replace(/\\/g, '/')}`);
    check(`${a.id}: both frames of this floor were written`,
      r.ok && r.bytes > 20000 && r2.ok && r2.bytes > 20000, `${r.bytes} B / ${r2.bytes} B`);
  }

  const diag = sess.diagnostics();
  // THE DECOY IN SECTION 3 IS SUPPOSED TO THROW -- that is the check. Counting
  // it here as well would make a pass print a stack trace, which is how a
  // report teaches a reader to stop reading it.
  const errs = [...diag.exceptions, ...diag.consoleErrors];
  const expected = errs.filter((e) => /carries no .?layout/.test(e));
  const unexpected = errs.filter((e) => expected.indexOf(e) < 0);
  const realFails = (diag.failedDetail || []).filter((f) => !f.canceled && !(f.status >= 200 && f.status < 400));
  check('no unexpected exceptions across the whole session',
    unexpected.length === 0,
    unexpected.length ? unexpected.slice(0, 2).join(' | ')
      : `${expected.length} expected (the decoy being refused), 0 others`);
  check('and every model the layouts asked for exists in the kit',
    realFails.length === 0,
    realFails.slice(0, 3).map((f) => `${f.errorText} ${f.url}`).join(' | ')
      || ARENAS.map((a) => `${a.id} ${requiredModels(levels[a.id].layout).length} models`).join(', '));
}

main()
  .catch((e) => { say(`\n   harness threw: ${e && e.stack || e}`); failed += 1; })
  .finally(async () => {
    try { if (sess) sess.close(); } catch { /* ignore */ }
    try { if (chrome) chrome.kill(); } catch { /* ignore */ }
    try { if (server) await server.close(); } catch { /* ignore */ }

    say('');
    say('='.repeat(78));
    say(`  ${passed}/${passed + failed} checks passed`);
    if (failed) say(`  FAILED: ${failed}`);
    say('='.repeat(78));
    say(`  VERDICT: ${failed === 0 ? 'PASS' : 'FAIL'}`);
    fs.writeFileSync(REPORT, log.join('\n') + '\n', 'utf8');
    process.exit(failed === 0 ? 0 : 1);
  });
