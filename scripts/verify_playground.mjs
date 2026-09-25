/**
 * verify_playground.mjs — does the WORKBENCH work?
 *
 *     node scripts/verify_playground.mjs
 *     node scripts/verify_playground.mjs --w 13 --d 9 --rooms 8 --items 110 --seed pui
 *
 * procgen.html is a front end: knobs in, floor out, drawn and judged. A front
 * end is exactly the kind of thing that can look right while doing nothing, so
 * nothing here is read off the screen. The page is driven the way a person
 * drives it -- set the fields, press 生成 -- and then held to Node's answer for
 * the same parameters.
 *
 * THE THREE CHECKS THAT CARRY THE REST
 *
 *  1. NEGATIVE CONTROL. The workbench could silently show the shipped apartment
 *     (10 x 8, 6 rooms) and still look convincing: a lit plan, eight green
 *     checks, six 红包. So the floor it produced is asserted to DIFFER from the
 *     shipped one, both in nav cells and in plan size.
 *  2. THE PREVIEW TRACKS THE KNOBS. Pressing 生成 with new dimensions must change
 *     the drawing. Otherwise the SVG on screen could be a picture left over from
 *     the previous run -- a stale artifact wearing the new parameters' name.
 *  3. NO SILENT FALLBACK ON THE HANDOFF. play.html falls back to the shipped flat
 *     when it cannot find an arena. So the session handoff is tested twice: once
 *     that it lands on the GENERATED floor, and once that a session key with
 *     nothing behind it FAILS OUT LOUD instead of quietly serving a different
 *     apartment.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import cdp from './cdp.js';
import { buildCore } from '../game/play/boot.js';

const { serve, launch, attach, killStrayChrome, sleep } = cdp;

const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const EVIDENCE = ['reports/procgen.svg', 'reports/procgen.txt'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 8783;
const DEBUG = 9228;
const UI_ARENA = 'work/_ui_arena.json';
const UI_ARENA_Q = 'work/_ui_arena_q.json';
const SHOTS = path.join(ROOT, 'renders', 'ui');
const REPORT = path.join(ROOT, 'reports', 'ui_play.txt');
const SESSION_KEY = 'an-inch-of-red:procgen';

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
  w: Number(arg('w', 13)), d: Number(arg('d', 9)),
  rooms: Number(arg('rooms', 8)), items: Number(arg('items', 110)),
  seed: arg('seed', 'pui'),
};
// The SECOND parameter set, used to prove the preview follows the fields.
const Q = { ...P, w: P.w + 4 };

/* ------------------------------------------- 1. the Node yardstick, first */
say('-- 1. Node yardstick ---------------------------------------------------');
const gen = spawnSync(process.execPath, [
  'scripts/procgen.mjs', '--w', String(P.w), '--d', String(P.d),
  '--rooms', String(P.rooms), '--items', String(P.items), '--seed', P.seed,
  '--arena', UI_ARENA, '--out-layout', 'work/_ui_layout.js', '--svg', 'work/_ui.svg',
  '--report', 'work/_ui_procgen.txt',
], { cwd: ROOT, encoding: 'utf8' });
const genOut = (gen.stdout || '') + (gen.stderr || '');
genOut.trim().split('\n').filter((l) => /PASS|FAIL|wrote|generated/.test(l)).forEach((l) => say('   ' + l));
check('the generator produced a layout for these parameters',
  gen.status === 0 && /1\/1 PASS/.test(genOut) && fs.existsSync(path.join(ROOT, UI_ARENA)),
  `exit ${gen.status}`);
if (gen.status !== 0) {
  say('\n   cannot continue without a generated arena');
  process.exit(1);
}

const nodeLevel = JSON.parse(fs.readFileSync(path.join(ROOT, UI_ARENA), 'utf8'));
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'game', 'arenas', 'room_scene.json'), 'utf8'));
const ref = buildCore(nodeLevel, { seed: P.seed, count: 6 });
const refShip = buildCore(shipped, { seed: P.seed, count: 6 });
say(`   generated ${nodeLevel.rooms.length} rooms, plan ${nodeLevel.meta.plan.w}x${nodeLevel.meta.plan.d}, `
  + `${nodeLevel.solids.length} solids, nav ${ref.nav.walkableCount} cells / ${ref.nav.components.length} region`);
say(`   shipped   ${shipped.rooms.length} rooms, plan ${shipped.meta.plan.w}x${shipped.meta.plan.d}, `
  + `${shipped.solids.length} solids, nav ${refShip.nav.walkableCount} cells`);

check('the two floors are genuinely different (so "not the shipped one" can mean something)',
  ref.nav.walkableCount !== refShip.nav.walkableCount
    && nodeLevel.meta.plan.w !== shipped.meta.plan.w,
  `nav ${ref.nav.walkableCount} vs ${refShip.nav.walkableCount}; `
  + `plan ${nodeLevel.meta.plan.w} vs ${shipped.meta.plan.w}`);

// The SECOND parameter set gets its own yardstick, and it is the one that
// matters at the end. The handoff happens AFTER the knobs are moved, so the
// floor that should reach the game is the one on screen at that moment -- Q.
// Holding the handoff to the first set's numbers was a harness bug: it demanded
// a stale floor, and reported a correct handoff as "not the generated one".
const genQ = spawnSync(process.execPath, [
  'scripts/procgen.mjs', '--w', String(Q.w), '--d', String(Q.d),
  '--rooms', String(Q.rooms), '--items', String(Q.items), '--seed', Q.seed,
  '--arena', UI_ARENA_Q,
  '--report', 'work/_ui_procgen_q.txt', '--svg', 'work/_ui_procgen_q.svg',
], { cwd: ROOT, encoding: 'utf8' });
const genQOut = (genQ.stdout || '') + (genQ.stderr || '');
check('the generator produced the SECOND parameter set too',
  genQ.status === 0 && /1\/1 PASS/.test(genQOut), `exit ${genQ.status}`);
const nodeLevelQ = JSON.parse(fs.readFileSync(path.join(ROOT, UI_ARENA_Q), 'utf8'));
const refQ = buildCore(nodeLevelQ, { seed: Q.seed, count: 6 });
say(`   ${Q.w}x${Q.d}   ${nodeLevelQ.rooms.length} rooms, ${nodeLevelQ.solids.length} solids, `
  + `nav ${refQ.nav.walkableCount} cells, grid ${refQ.nav.w}x${refQ.nav.d}`);
check('the two generated floors differ from each other (so "the current one" is a real distinction)',
  refQ.nav.walkableCount !== ref.nav.walkableCount,
  `${Q.w}x${Q.d} nav ${refQ.nav.walkableCount} vs ${P.w}x${P.d} nav ${ref.nav.walkableCount}`);

/**
 * A level with its provenance field blanked.
 *
 * `meta.provenance` records WHICH front end made the floor, and the workbench
 * and the CLI are different front ends -- so it is expected to differ, and the
 * two snapshots are compared on everything else. Blanking it on both sides
 * keeps the claim ("these are the same floor") exactly as wide as it should be.
 */
const canon = (lvl) => JSON.stringify(
  Object.assign({}, lvl, { meta: Object.assign({}, lvl.meta, { provenance: null }) }));

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return `at char ${i}: browser ${JSON.stringify(a.slice(i, i + 50))} vs node ${JSON.stringify(b.slice(i, i + 50))}`;
    }
  }
  return a.length === b.length ? 'identical' : `lengths ${a.length} vs ${b.length}`;
}

/* --------------------------------------------------------------- session */
let server = null, chrome = null, sess = null;

async function waitFor(expr, ms = 40000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await sess.evalJs(expr);
    if (v) return v;
    await sleep(step);
  }
  return null;
}

async function waitState(pred, ms = 40000) {
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < ms) {
    st = await sess.evalJs('__procgen.state()');
    if (st && pred(st)) return st;
    await sleep(200);
  }
  return st;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });

  // Fingerprint the committed evidence BEFORE anything runs, so "this suite
  // keeps its own mess out of the repo" is a measurement rather than a promise.
  const evidence = {};
  for (const rel of EVIDENCE) evidence[rel] = sha(fs.readFileSync(path.join(ROOT, rel)));

  await killStrayChrome();
  server = await serve(ROOT, PORT);
  chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_ui' });
  sess = await attach({ port: DEBUG });
  await sess.viewport(1600, 1000);
  const base = `http://127.0.0.1:${PORT}/`;

  /* ------------------------------------------------- 2. the page loads */
  say('');
  say('-- 2. the workbench loads ---------------------------------------------');
  say(`   ${base}procgen.html`);
  await sess.goto(`${base}procgen.html`, { settle: 900 });

  const ready = await waitFor('!!(window.__procgen && window.__procgen.ready)');
  const bootErr = await sess.evalJs('document.getElementById("status").textContent');
  say(`   ready=${!!ready}   status "${bootErr}"`);
  check('the workbench booted and loaded its assets', !!ready, String(bootErr).slice(0, 120));

  const diag = sess.diagnostics();
  const errs = [...diag.exceptions, ...diag.consoleErrors, ...diag.logErrors];
  const realFails = (diag.failedDetail || []).filter((f) => !f.canceled && !(f.status >= 200 && f.status < 400));
  check('no exceptions / console errors', !!ready && errs.length === 0, errs.slice(0, 2).join(' | '));
  check('no HTTP 4xx / 5xx', diag.httpErrors.length === 0, diag.httpErrors.slice(0, 2).join(' | '));
  check('no real failed requests', realFails.length === 0,
    realFails.slice(0, 2).map((f) => `${f.errorText} ${f.url}`).join(' | '));
  if (!ready) { say('\n   cannot continue without a booted workbench'); return; }

  // The controls are built FROM DEFAULTS. Scoped to `.field input` so the
  // 改动即重算 checkbox is not counted as a parameter.
  const form = await sess.evalJs(`(function () {
    const inputs = [...document.querySelectorAll('#params .field input')];
    const byName = {};
    for (const el of inputs) byName[el.name] = el.value;
    return { count: inputs.length, byName };
  })()`);
  const dflt = await sess.evalJs('__procgen.defaults()');
  const KNOBS = ['w', 'd', 'rooms', 'items', 'minRoom', 'lane', 'gap', 'doorMargin',
    'loopDoor', 'maxLoopDoors', 'windowChance', 'roomCap', 'floorTries', 'seed'];
  const drifted = KNOBS.filter((n) => String(form.byName[n]) !== String(dflt[n]));
  check('every control is built from the generator\'s own DEFAULTS, with none drifted',
    form.count === KNOBS.length && drifted.length === 0,
    `${form.count}/${KNOBS.length} inputs`
    + (drifted.length
      ? `; drifted: ` + drifted.map((n) => `${n}="${form.byName[n]}" vs "${dflt[n]}"`).join(', ')
      : `; w=${form.byName.w} rooms=${form.byName.rooms} seed=${form.byName.seed}`));

  /* ------------------------------------ 3. it waits for the first run */
  // The page auto-generates once on load. Let that finish before driving it, or
  // the click below lands while `busy` is set and is (correctly) ignored.
  const initial = await waitState((st) => st.fails != null, 60000);
  check('the page generated a floor on load without being asked',
    !!initial && initial.rooms > 0, initial ? `${initial.rooms} rooms, ${initial.solids} solids` : 'no state');

  /* --------------------------------------- 4. generate THROUGH the UI */
  say('');
  say('-- 3. press 生成 with the parameters in the boxes ----------------------');
  const echo = await sess.evalAsync(`return __procgen.set(${JSON.stringify(P)});`);
  await sess.evalAsync('document.getElementById("go").click(); return 1;');
  const st = await waitState((s) => s.params.w === P.w && s.params.seed === P.seed);
  say(`   fields echoed as: ${JSON.stringify(echo)}`);
  say(`   readings: ${st ? st.readouts : '(none)'} | rooms ${st && st.rooms} `
    + `| nav ${st && st.walkable} cells / ${st && st.components} region | solids ${st && st.solids}`);
  say(`   drawn plan: ${st && st.planSVG} chars of SVG`);

  check('the fields are what the form reports back', st
    && st.params.w === P.w && st.params.d === P.d && st.params.rooms === P.rooms
    && st.params.items === P.items && st.params.seed === P.seed,
    st ? JSON.stringify(st.params) : 'no state');
  check('all eight checks pass in the page',
    !!st && st.checks.length === 9 && st.fails === 0,
    st ? `${st.checks.length} checks, ${st.fails} failing` : 'no state');
  check('the page\'s rooms / solids are Node\'s rooms / solids',
    !!st && st.rooms === nodeLevel.rooms.length && st.solids === nodeLevel.solids.length,
    st ? `${st.rooms}/${nodeLevel.rooms.length} rooms, ${st.solids}/${nodeLevel.solids.length} solids` : 'no state');
  check('the page\'s nav grid is Node\'s nav grid, cell for cell',
    !!st && st.walkable === ref.nav.walkableCount && st.components === ref.nav.components.length,
    st ? `${st.walkable}/${ref.nav.walkableCount} cells, ${st.components}/${ref.nav.components.length} regions` : 'no state');
  check('the spawn is where Node put it',
    !!st && st.spawn
      && Math.hypot(st.spawn.x - nodeLevel.spawn.x, st.spawn.z - nodeLevel.spawn.z) < 1e-9,
    st && st.spawn ? `(${st.spawn.x}, ${st.spawn.z})` : 'no state');
  // The plan marks the 红包 the page's validator placed. If that stream and the
  // game's ever diverge again, the dots on the preview stop being the dots you
  // play with -- and none of the checks above would notice, because every one
  // of them is about geometry rather than about prizes. Measured before the
  // fix: 16 of the 17 parameter sets the suites run disagreed, by up to 8.85 m.
  const prizeGap = (() => {
    if (!st || !st.prizes || st.prizes.length !== ref.prizes.length) return Infinity;
    let worst = 0;
    for (const p of st.prizes) {
      let best = Infinity;
      for (const g of ref.prizes) {
        best = Math.min(best, Math.max(
          Math.abs(p[0] - g.x), Math.abs(p[1] - g.z), Math.abs(p[2] - g.y)));
      }
      worst = Math.max(worst, best);
    }
    return worst;
  })();
  check('the 红包 the plan marks are the ones the game will place',
    !!st && st.prizes.length === ref.prizes.length && prizeGap < 1e-9,
    st ? `${st.prizes.length}/${ref.prizes.length} prizes, worst gap ${prizeGap.toExponential(1)} m` : 'no state');
  check('the verdict banner reports the checks, and a plan is actually drawn',
    !!st && st.planSVG > 4000 && /通过/.test(String(st.readouts)),
    st ? `${st.planSVG} chars of SVG, banner "${st.readouts}"` : 'no state');

  const label = await sess.evalJs('(document.querySelector("#plan svg text") || {}).textContent || ""');
  check('the caption names the requested dimensions',
    String(label).indexOf(`${P.w}×${P.d}`) >= 0, String(label));

  // THE NEGATIVE CONTROL.
  check('THE FLOOR IS NOT THE SHIPPED APARTMENT',
    !!st && st.walkable !== refShip.nav.walkableCount
      && st.plan.w === P.w && st.plan.d === P.d,
    st ? `nav ${st.walkable} (shipped ${refShip.nav.walkableCount}), plan `
      + `${st.plan.w}x${st.plan.d} (shipped ${shipped.meta.plan.w}x${shipped.meta.plan.d})` : 'no state');

  /* ------------------------------------- 5. the PREVIEW follows the knobs */
  say('');
  say('-- 4. change the parameters, and the picture changes ------------------');
  const lenBefore = await sess.evalJs('document.getElementById("plan").innerHTML.length');
  await sess.evalAsync(`__procgen.set(${JSON.stringify({ w: Q.w })});
    document.getElementById("go").click(); return 1;`);
  const st2 = await waitState((s) => s.params.w === Q.w);
  const lenAfter = await sess.evalJs('document.getElementById("plan").innerHTML.length');
  const label2 = await sess.evalJs('(document.querySelector("#plan svg text") || {}).textContent || ""');
  say(`   ${P.w}x${P.d} -> ${Q.w}x${Q.d}: SVG ${lenBefore} -> ${lenAfter} chars, caption "${label2}"`);

  check('widening the flat changes the plan the page holds',
    !!st2 && st2.plan.w === Q.w && st2.plan.w !== st.plan.w,
    st2 ? `${st.plan.w} -> ${st2.plan.w}` : 'no state');
  check('and the DRAWING changed with it, rather than being the previous one relabelled',
    lenAfter !== lenBefore && lenAfter > 4000,
    `${lenBefore} -> ${lenAfter} chars`);
  check('the new caption names the new dimensions',
    String(label2).indexOf(`${Q.w}×${Q.d}`) >= 0, String(label2));

  /* ------------------------------------------- 6. the handoff to the game */
  say('');
  say('-- 5. 走进去玩: hand the floor to the game ----------------------------');
  // The bytes, checked BEFORE the click destroys the page that would produce
  // them: the claim is that the workbench hands over exactly the snapshot the
  // CLI would have written for these parameters, not a re-derivation that might
  // quietly differ from what was previewed.
  const payload = await sess.evalJs('__procgen.snapshot()');
  const want = canon(nodeLevelQ);
  check('the snapshot about to be handed over is the one the CLI would have written',
    payload === want,
    `${String(payload).length} vs ${want.length} chars -- ${firstDiff(String(payload), want)}`);

  await sess.evalAsync('document.getElementById("play").click(); return 1;');
  const href = await waitFor('(location.search.indexOf("arena=session:procgen") >= 0) ? location.href : null');
  check('the button navigated to the session arena', !!href, String(href).slice(0, 90));
  if (!href) { say('\n   cannot continue without the navigation'); return; }

  const gameReady = await waitFor('!!(window.__ready && window.__play)');
  const playErr = await sess.evalJs('window.__playError || null');
  check('the game booted on the handed-over floor', !!gameReady,
    playErr ? `boot threw: ${playErr}` : 'ready');
  if (!gameReady) return;

  await sess.evalAsync(`await __play.begin('patrol', { seed: ${JSON.stringify(Q.seed)} }); return 1;`);
  const snap = await sess.evalJs('__play.snapshot()');
  say(`   game nav ${snap.nav.walkable} cells (${snap.nav.w}x${snap.nav.d}), `
    + `${snap.nav.regions} region, ${snap.prizes.length} prizes, ${snap.patrol.waypoints} waypoints`);

  // Compared against Q -- the floor that was ON SCREEN when the button was
  // pressed -- so this also refuses a handoff of a stale floor.
  check('the game is on the floor that was on screen, not the earlier one',
    snap.nav.walkable === refQ.nav.walkableCount && snap.nav.walkable !== ref.nav.walkableCount,
    `${snap.nav.walkable} cells; current ${refQ.nav.walkableCount}, previous ${ref.nav.walkableCount}`);
  check('and not on the shipped one', snap.nav.walkable !== refShip.nav.walkableCount,
    `${snap.nav.walkable} vs shipped ${refShip.nav.walkableCount}`);

  const byId = (list) => new Map(list.map((p) => [p.id, p]));
  const refById = byId(refQ.prizes);
  const snapById = byId(snap.prizes);
  let worst = 0, worstId = null;
  for (const [id, p] of refById) {
    const q = snapById.get(id);
    if (!q) { worst = Infinity; worstId = id; break; }
    const d = Math.max(Math.abs(p.x - q.x), Math.abs(p.z - q.z), Math.abs(p.y - q.y));
    if (d > worst) { worst = d; worstId = id; }
  }
  check('the same six 红包, in the same places as Node put them',
    snap.prizes.length === 6 && worst < 1e-6,
    `${snap.prizes.length} prizes, worst drift ${worst === Infinity ? 'missing ' + worstId : worst.toExponential(1)} m`);

  const gDiag = sess.diagnostics();
  const gErrs = [...gDiag.exceptions, ...gDiag.consoleErrors, ...gDiag.logErrors];
  check('no exceptions in the game session', gErrs.length === 0, gErrs.slice(0, 2).join(' | '));

  // The camera pose is derived from the PLAN, not from the player's state: a
  // pose taken from where the player happens to stand can legally be a wall
  // 30 cm away, and then a perfectly good floor reads as a dark frame. Overhead,
  // above wall height, nothing can occlude it.
  say('');
  say('-- 6. does the handed-over floor render? ------------------------------');
  const planQ = nodeLevelQ.meta.plan;
  const cx = planQ.w * 0.5;
  const cz = planQ.d * 0.5;
  await sess.evalAsync(`__play.freeCam({ x: ${cx + planQ.w * 0.02}, y: ${Math.max(10, planQ.w * 0.55)}, `
    + `z: ${cz + planQ.d * 0.62}, tx: ${cx}, ty: 0.35, tz: ${cz} }); return 1;`);
  // renderOnce() MUST sit in the same task as drawImage. Split across two
  // round-trips, the canvas has already been presented and cleared, and the read
  // comes back as a uniform black frame -- a 0 that says nothing about the
  // render. (Measured both ways in this file's history: split, mean 0.0 / 1
  // colour, while the SCREENSHOT of that same camera was 131 KB of content.)
  const px = await sess.evalJs(`(function () {
    __play.renderOnce();
    const cv = __play.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = 200; c.height = 125;
    const g = c.getContext('2d');
    g.drawImage(cv, 0, 0, 200, 125);
    const d = g.getImageData(0, 0, 200, 125).data;
    let sum = 0, sum2 = 0, dark = 0, n = 0;
    const set = new Set();
    for (let i = 0; i < d.length; i += 4) {
      const l = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      sum += l; sum2 += l * l; n += 1;
      if (l < 14) dark += 1;
      set.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
    }
    const mean = sum / n;
    return { mean: mean, sd: Math.sqrt(Math.max(0, sum2 / n - mean * mean)),
             darkFrac: dark / n, colours: set.size };
  })()`);
  check('the handed-over floor renders as lit space, not a black frame',
    px.mean > 25 && px.sd > 8 && px.darkFrac < 0.35 && px.colours >= 8,
    `mean ${px.mean.toFixed(1)}, sd ${px.sd.toFixed(1)}, dark ${(px.darkFrac * 100).toFixed(1)}%, ${px.colours} colours`);

  const shotOver = await sess.shot(path.join(SHOTS, `01-generated-${P.seed}-dollhouse.png`));
  check('a dollhouse screenshot of the floor the workbench handed over',
    shotOver.ok && shotOver.bytes > 20000, `${shotOver.bytes} B`);

  await sess.evalAsync('__play.freeCam(null); __play.renderOnce(); return 1;');
  const shot2 = await sess.shot(path.join(SHOTS, `02-generated-${P.seed}-eye.png`));
  check('a first-person screenshot at the spawn', shot2.ok && shot2.bytes > 20000,
    `${shot2.bytes} B`);

  /* -------------------------------- 7. a session key with nothing behind it */
  say('');
  say('-- 7. a session arena with nothing behind it --------------------------');
  await sess.goto(`${base}play.html?arena=session:nope`, { settle: 1200 });
  const missing = await waitFor('window.__playError || null', 25000);
  say(`   __playError: ${String(missing).slice(0, 150)}`);
  // The failure mode this refuses: playing.html falls back to the shipped
  // apartment when it cannot resolve an arena, so "no error" here would mean a
  // page that boots happily on a floor nobody asked for.
  check('it fails LOUDLY instead of silently serving a different apartment',
    typeof missing === 'string' && /sessionStorage/.test(missing),
    String(missing).slice(0, 110));

  /* ------------------------------------------------------- 8. artifact */
  say('');
  say('-- 8. artifacts -------------------------------------------------------');
  await sess.goto(`${base}procgen.html`, { settle: 800 });
  await waitFor('!!(window.__procgen && window.__procgen.ready)');
  await waitState((s) => s.rooms > 0, 60000);
  const shot1 = await sess.shot(path.join(SHOTS, `00-workbench-${P.seed}.png`));
  check('a screenshot of the workbench itself', shot1.ok && shot1.bytes > 20000, `${shot1.bytes} B`);

  /* ------------------------ 9. the committed sweep evidence survived --------- */
  say('');
  say('-- 9. the committed sweep evidence still exists ------------------------');

  // THIS SUITE RUNS THE GENERATOR TWICE, and a drawing is a second output with
  // its own flag. The second parameter set passed --report and not --svg, so
  // every run of this suite quietly replaced the committed twelve-floor contact
  // sheet with a single floor. Measured, before and after: 323000 B -> 31927 B,
  // 24 <g> -> 1, and the per-plan label " rooms - " 12 times -> once. (Not the
  // <svg> count: the contact sheet is ONE root holding twelve plans, so counting
  // roots would have reported no change at all.) Nothing noticed, because every
  // other assertion in this file looks at something this file produced itself.
  // This one looks at what it must NOT have touched.
  for (const rel of EVIDENCE) {
    const now = sha(fs.readFileSync(path.join(ROOT, rel)));
    check(`${rel} 跑完这一套之后逐字节未变`,
      now === evidence[rel], `${evidence[rel]} -> ${now}`);
  }
}

/* ---------------------------------------------------------------- run it */
main().catch((err) => {
  say('');
  say('   HARNESS THREW: ' + (err && err.stack || err));
  failed += 1;
}).finally(async () => {
  try { if (sess) await sess.close(); } catch { /* ignore */ }
  try { if (chrome) chrome.kill(); } catch { /* ignore */ }
  try { if (server) server.kill(); } catch { /* ignore */ }

  say('');
  say('='.repeat(72));
  say(`  ${passed}/${passed + failed} checks passed`);
  say('='.repeat(72));
  say(`  VERDICT: ${failed === 0 ? 'PASS' : 'FAIL'}`);

  try {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, log.join('\n') + '\n', 'utf8');
  } catch { /* ignore */ }
  process.exit(failed === 0 ? 0 : 2);
});
