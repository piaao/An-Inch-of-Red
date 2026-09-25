/**
 * verify_gen_play.mjs — is a GENERATED floor plan actually playable?
 *
 *     node scripts/verify_gen_play.mjs
 *     node scripts/verify_gen_play.mjs --w 16 --d 14 --rooms 10 --items 160 --seed genA
 *
 * The parameterised generator is only a tool if you can WALK AROUND what it
 * made. scripts/procgen.mjs proves a layout is structurally sound headlessly;
 * this proves the same layout loads in the real game, with the real renderer,
 * and that the player can move in it.
 *
 * THE CHECK THAT MAKES THE OTHERS MEANINGFUL. `play.html` falls back to the
 * shipped apartment when no arena is named, so a page that quietly ignored the
 * ?arena= override would boot perfectly, render a lit room, place six 红包 and
 * report a healthy connected nav -- a full green board describing the WRONG
 * FLOOR. So the numbers here are compared against a Node build of the GENERATED
 * snapshot, AND the generated nav is asserted to differ from the shipped one.
 * Without that second half the whole file would pass on the fallback.
 *
 * THE CLAIM THIS FILE DOES NOT MAKE. Everything above is about the CORE -- nav,
 * rooms, prizes, patrol, spawn. A page can pass all of it while drawing the
 * shipped apartment over a generated plan, which is exactly what happened. The
 * rendering-level claim ("the world on screen is the floor being played") lives
 * in scripts/verify_world.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import cdp from './cdp.js';
import { buildCore } from '../game/play/boot.js';

const { serve, launch, attach, killStrayChrome, sleep } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 8782;
const DEBUG = 9227;
const ARENA_REL = 'game/arenas/gen.json';
// Into `work/`: the game does not read the layout MODULE at all (the arena
// carries its own copy), and a harness that rewrites a file whose name says
// "the generated layout" invites the belief that it is the mechanism. It is not.
const LAYOUT_REL = 'work/_gen_layout.js';
const SHOTS = path.join(ROOT, 'renders', 'gen');
const REPORT = path.join(ROOT, 'reports', 'gen_play.txt');

const log = [];
const say = (s = '') => { log.push(s); console.log(s); };

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++; else failed++;
  say(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

/* ------------------------------------------------------------------- argv */
function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
}
const P = {
  w: arg('w', '16'), d: arg('d', '14'), rooms: arg('rooms', '10'),
  items: arg('items', '160'), seed: arg('seed', 'genA'),
};

/* ------------------------------------------------ 1. generate the floor */
say('-- 1. generate ---------------------------------------------------------');
const gen = spawnSync(process.execPath, [
  'scripts/procgen.mjs',
  '--w', P.w, '--d', P.d, '--rooms', P.rooms, '--items', P.items, '--seed', P.seed,
  '--out-layout', LAYOUT_REL, '--arena', ARENA_REL,
  // keep this run's log AND its plan out of the committed sweep evidence
  '--report', 'work/_gen_procgen.txt', '--svg', 'work/_gen_procgen.svg',
], { cwd: ROOT, encoding: 'utf8' });
const genOut = (gen.stdout || '') + (gen.stderr || '');
const genTail = genOut.trim().split('\n').filter((l) => /PASS|FAIL|wrote|generated/.test(l));
genTail.forEach((l) => say('   ' + l));
check('the generator produced a layout for these parameters',
  gen.status === 0 && /1\/1 PASS/.test(genOut) && fs.existsSync(path.join(ROOT, ARENA_REL)),
  `exit ${gen.status}`);
if (gen.status !== 0) {
  say('\n   cannot continue without a generated arena');
  process.exit(1);
}

const level = JSON.parse(fs.readFileSync(path.join(ROOT, ARENA_REL), 'utf8'));
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'game', 'arenas', 'room_scene.json'), 'utf8'));

// Node's own build of the generated snapshot: the yardstick for the browser.
const ref = buildCore(level, { seed: P.seed, count: 6 });
const refShipped = buildCore(shipped, { seed: P.seed, count: 6 });
say('');
say(`   generated ${level.rooms.length} rooms, nav ${ref.nav.walkableCount} walkable cells, `
  + `${ref.nav.components.length} component(s), ${ref.prizes.length} prizes`);
say(`   shipped   ${shipped.rooms.length} rooms, nav ${refShipped.nav.walkableCount} walkable cells`);

// The floor really is the one the parameters asked for, and really is not the
// shipped one. If either of these is false, nothing below proves what it claims.
check('the ROOM COUNT is the one the parameter asked for',
  level.rooms.length === Number(P.rooms), `${level.rooms.length} vs --rooms ${P.rooms}`);
check('the generated floor is NOT the shipped apartment',
  ref.nav.walkableCount !== refShipped.nav.walkableCount
    && level.rooms.length !== shipped.rooms.length,
  `nav ${ref.nav.walkableCount} vs shipped ${refShipped.nav.walkableCount}; `
  + `rooms ${level.rooms.length} vs shipped ${shipped.rooms.length}`);

/* ------------------------------------------------------ 2. boot the game */
let server = null, chrome = null, sess = null;

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });

  await killStrayChrome();
  server = await serve(ROOT, PORT);
  chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_gen' });
  sess = await attach({ port: DEBUG });
  await sess.viewport(1600, 900);

  say('');
  say('-- 2. boot the generated floor ----------------------------------------');
  const url = `http://127.0.0.1:${PORT}/play.html?arena=./${ARENA_REL}`;
  say(`   ${url}`);
  const t0 = Date.now();
  await sess.goto(url, { settle: 1500 });

  let ready = false;
  for (let i = 0; i < 240; i++) {
    if (await sess.evalJs('!!(window.__ready && window.__play)') === true) { ready = true; break; }
    const err = await sess.evalJs('window.__playError || null');
    if (err) { say(`   boot threw: ${err}`); break; }
    await sleep(500);
  }
  say(`   ready=${ready} in ${((Date.now() - t0) / 1000).toFixed(1)} s   GL ${await sess.glRenderer()}`);

  const diag = sess.diagnostics();
  const errs = [...diag.exceptions, ...diag.consoleErrors, ...diag.logErrors];
  const realFails = (diag.failedDetail || []).filter((f) => !f.canceled && !(f.status >= 200 && f.status < 400));
  check('the page booted on the generated floor', ready, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  check('no exceptions / console errors', ready && errs.length === 0, errs.slice(0, 3).join(' | '));
  check('no HTTP 4xx / 5xx', diag.httpErrors.length === 0, diag.httpErrors.slice(0, 3).join(' | '));
  check('no real failed requests', realFails.length === 0,
    realFails.slice(0, 3).map((f) => `${f.errorText} ${f.url}`).join(' | '));

  if (!ready) { say('\n   cannot continue without a booted page'); return; }

  await sess.evalAsync(`await __play.begin('patrol', { seed: ${JSON.stringify(P.seed)} }); return 1;`);

  /* -------------------------------------- 3. the browser is on that floor */
  say('');
  say('-- 3. is this the generated floor? ------------------------------------');
  const snap = await sess.evalJs('__play.snapshot()');
  say(`   browser nav ${snap.nav.walkable} cells (${snap.nav.w}x${snap.nav.d}), `
    + `${snap.nav.regions} region, ${snap.prizes.length} prizes, ${snap.patrol.waypoints} waypoints`);

  check('the browser nav grid is the generated one, cell for cell',
    snap.nav.walkable === ref.nav.walkableCount && snap.nav.w === ref.nav.w
      && snap.nav.d === ref.nav.d && snap.nav.cell === ref.nav.cell,
    `${snap.nav.walkable}/${ref.nav.walkableCount} walkable, ${snap.nav.w}x${snap.nav.d}`);
  // THE NEGATIVE CONTROL. A silent fallback to the shipped apartment would
  // satisfy every other check in this file.
  check('and it is NOT the shipped fallback', snap.nav.walkable !== refShipped.nav.walkableCount,
    `${snap.nav.walkable} vs shipped ${refShipped.nav.walkableCount}`);

  /* --------------------------------------------- 4. it is one open space */
  say('');
  say('-- 4. the floor is a single connected space ---------------------------');
  check('the generated floor has ONE walkable region',
    snap.nav.regions === 1 && ref.nav.components.length === 1,
    `${snap.nav.regions} region(s) in the browser, ${ref.nav.components.length} in Node`);

  // MATCH BY ID, NOT BY ARRAY POSITION. The claim is "the same six 红包, in the
  // same places", and index-wise comparison silently also asserts the two
  // runtimes happened to produce the same ORDER -- which is not part of the
  // claim, and a difference there would read as a 12 m placement error.
  const byId = (list) => new Map(list.map((p) => [p.id, p]));
  const refById = byId(ref.prizes);
  const snapById = byId(snap.prizes);
  let worst = 0, worstId = null;
  for (const [id, p] of refById) {
    const q = snapById.get(id);
    if (!q) { worst = Infinity; worstId = id; break; }
    const d = Math.max(Math.abs(p.x - q.x), Math.abs(p.z - q.z), Math.abs(p.y - q.y));
    if (d > worst) { worst = d; worstId = id; }
  }
  say(`   node    ${ref.prizes.map((p) => `${p.id}(${p.x.toFixed(2)},${p.z.toFixed(2)})`).join(' ')}`);
  say(`   browser ${snap.prizes.map((p) => `${p.id}(${p.x.toFixed(2)},${p.z.toFixed(2)})`).join(' ')}`);
  check('the six 红包 are placed, prize for prize, exactly as Node placed them',
    refById.size === 6 && snapById.size === 6 && worst < 1e-6,
    `${snap.prizes.length} prizes, ${refById.size} distinct ids, `
    + `worst coordinate drift ${worst.toExponential(1)} m${worstId ? ` at ${worstId}` : ''}`);
  check('the guard has a patrol to walk', snap.patrol.waypoints > 0,
    `${snap.patrol.waypoints} waypoints, ${snap.patrol.dropped} dropped`);
  // A PATROL OF ONE STOP IS NOT A PATROL. buildPatrol gives every room a stop
  // by construction and then drops the legs it cannot route, so "one stop per
  // room survived" is the bar that says the whole floor is patrolled -- and
  // `waypoints > 0` says only that the guard is awake. This is the bar that
  // caught the astar cell bug: it read 1 waypoint for 10 rooms (23 dropped).
  check('every generated room has a patrol stop the guard can reach',
    snap.patrol.waypoints >= level.rooms.length,
    `${snap.patrol.waypoints} waypoints for ${level.rooms.length} rooms, `
    + `${snap.patrol.dropped} dropped`);

  /* --------------------------------------- 5. the player can actually move */
  say('');
  say('-- 5. can you walk in it? ---------------------------------------------');
  const walk = await sess.evalAsync(`
    const inv = __play.navInvariant();
    const start = { x: inv.x, z: inv.z, clear: inv.clear };
    let illegal = 0, moved = 0;
    const bits = [];
    for (let leg = 0; leg < 4; leg++) {
      __play.look(620, 0);
      __play.input({ fwd: 1 });
      for (let i = 0; i < 45; i++) {
        __play.step(1 / 60, 1);
        const n = __play.navInvariant();
        if (!n.clear) illegal += 1;
        if (__play.info().phase !== 'playing') { bits.push('ended at leg ' + leg); leg = 99; break; }
      }
      __play.release();
      const n = __play.navInvariant();
      moved = Math.max(moved, Math.hypot(n.x - start.x, n.z - start.z));
    }
    __play.release();
    return { start, moved, illegal, phase: __play.info().phase, notes: bits.join('; ') };`);

  say(`   spawn (${walk.start.x.toFixed(2)}, ${walk.start.z.toFixed(2)}) clear=${walk.start.clear}, `
    + `walked ${walk.moved.toFixed(2)} m, ${walk.illegal} illegal frames`);
  check('the spawn point is on legal ground', walk.start.clear === true,
    `nav.clear at the spawn = ${walk.start.clear}`);
  check('the player can actually move through the generated rooms',
    walk.moved > 0.3 && walk.phase === 'playing', `${walk.moved.toFixed(2)} m in 3 s`);
  check('and never leaves legal ground while doing it', walk.illegal === 0,
    `${walk.illegal} illegal frames`);

  /* ------------------------------------------------ 6. it renders a room */
  say('');
  say('-- 6. does it render? -------------------------------------------------');
  // THE POSE MAY NOT COME FROM THE SUBJECT'S OWN STATE. A first-person camera
  // at the spawn can legitimately be 30 cm from a wall and fill the frame with
  // one dim flat surface -- a correct render of a correct room, and a false
  // alarm. So the strong claim is measured from ABOVE THE WALL TOPS, where
  // nothing in the level can occlude, and the first-person claim is the BEST of
  // a sweep, so no single unlucky stance can decide the verdict.
  const pcx = level.meta.plan.w / 2, pcz = level.meta.plan.d / 2, wallH = level.meta.wallH;
  const px = await sess.evalAsync(`
    const stat = () => {
      __play.renderOnce();
      const cv = __play.renderer.domElement;
      const c = document.createElement('canvas');
      c.width = 160; c.height = 100;
      const g = c.getContext('2d');
      g.drawImage(cv, 0, 0, 160, 100);
      const d = g.getImageData(0, 0, 160, 100).data;
      let sum = 0, sum2 = 0, dark = 0, opaque = 0;
      const set = new Set();
      for (let i = 0; i < d.length; i += 4) {
        const l = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
        sum += l; sum2 += l * l;
        if (l < 14) dark++;
        opaque++;
        set.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
      }
      const mean = sum / opaque;
      return { mean, sd: Math.sqrt(Math.max(0, sum2 / opaque - mean * mean)),
               darkFrac: dark / opaque, colours: set.size };
    };

    __play.freeCam({ x: ${pcx}, y: ${wallH} + 3.4, z: ${pcz}, tx: ${pcx}, ty: 0, tz: ${pcz} + 0.01 });
    const top = stat();
    __play.freeCam(null);

    const litRoom = (s) => s.mean > 25 && s.sd > 8 && s.darkFrac < 0.35;
    let best = { mean: -1, sd: 0, darkFrac: 1, colours: 0 }, lit = 0, n = 0;
    const step = Math.max(1, Math.floor(__play.nav.w / 12));
    for (let j = 0; j < __play.nav.d; j += step) {
      for (let i = 0; i < __play.nav.w; i += step) {
        if (!__play.nav.walkable[j * __play.nav.w + i]) continue;
        const c = __play.nav.centreOf(i, j);
        __play.teleport(c.x, c.z);
        const s = stat();
        n += 1;
        if (litRoom(s)) lit += 1;
        if (s.mean > best.mean) best = s;
      }
    }
    return { top, best, lit, n };`);

  check('the whole generated floor renders as lit space from above the walls',
    px.top.mean > 25 && px.top.sd > 8 && px.top.darkFrac < 0.35 && px.top.colours >= 8,
    `mean ${px.top.mean.toFixed(1)}, sd ${px.top.sd.toFixed(1)}, `
    + `dark ${(px.top.darkFrac * 100).toFixed(1)}%, ${px.top.colours} colours`);
  say(`   inside sweep: ${px.lit}/${px.n} stances read as a lit room `
    + `(best mean ${px.best.mean.toFixed(1)}, sd ${px.best.sd.toFixed(1)})`);
  check('the generated rooms render as lit space from inside',
    px.lit >= 1 && px.best.mean > 25,
    `best of ${px.n} stances: mean ${px.best.mean.toFixed(1)}, sd ${px.best.sd.toFixed(1)}, `
    + `dark ${(px.best.darkFrac * 100).toFixed(1)}%, ${px.best.colours} colours`);

  /* -------------------------------------------------- 7. a saveable artifact */
  say('');
  say('-- 7. artifact --------------------------------------------------------');
  // TWO SHOTS, BECAUSE ONE IS NOT ENOUGH TO SEE A FLOOR PLAN. The overhead
  // frame is the one that shows the thing the parameters asked for -- rooms and
  // furniture -- and it is the same pose the render claim is measured from, so
  // the picture and the number cannot disagree. The first-person frame shows
  // the floor at eye height, which is what "playable" looks like.
  const shots = [];
  const shot = async (name) => {
    const file = path.join(SHOTS, name + '.png');
    const r = await sess.shot(file);
    shots.push({ name, ...r });
    say(`   ${name.padEnd(26)} ${r.ok ? r.bytes + ' B' : 'FAILED'}`);
  };
  await sess.evalAsync(
    `__play.freeCam({ x: ${pcx}, y: ${wallH} + 3.4, z: ${pcz}, tx: ${pcx}, ty: 0, tz: ${pcz} + 0.01 });
     __play.renderOnce(); return 1;`);
  await shot(`00-generated-${P.seed}-top`);
  await sess.evalAsync(
    `__play.freeCam(null);
     __play.teleport(${level.spawn.x}, ${level.spawn.z}, ${level.spawn.yaw || 0});
     __play.renderOnce(); return 1;`);
  await shot(`01-generated-${P.seed}-eye`);
  check('both screenshots of the generated floor were written',
    shots.length === 2 && shots.every((s) => s.ok && s.bytes > 20000),
    shots.map((s) => `${s.name} ${s.bytes} B`).join(', '));

  const stillErrs = sess.diagnostics();
  const lateErrs = [...stillErrs.exceptions, ...stillErrs.consoleErrors];
  check('still no exceptions after the whole session', lateErrs.length === 0,
    lateErrs.slice(0, 2).join(' | '));
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
