/**
 * verify_live.mjs — check a server that is ALREADY running.
 *
 *     node scripts/verify_live.mjs
 *     node scripts/verify_live.mjs --url http://127.0.0.1:8791 --w 16 --d 12 --rooms 9 --items 130 --seed live
 *
 * verify_playground.mjs is the self-contained one: it starts its own server on
 * its own free port, so CI can run it with nothing in the background. This is
 * the complement -- it starts NO server on purpose, and checks the exact URL a
 * person has open in front of them. "It worked in my test" and "the thing I am
 * looking at works" are different claims, and only one of them is about your
 * browser tab.
 *
 * It presses the same buttons a person presses (fill the fields, click 生成) and
 * holds the page to Node's answer for the same parameters: rooms, solids, nav
 * cells, components, spawn, and the six 红包 coordinate for coordinate. Without
 * that last one a preview can look convincing -- a lit plan, eight green checks
 * -- while marking a hiding place in the wrong room.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import cdp from './cdp.js';
import { buildCore } from '../game/play/boot.js';

const { launch, attach, killStrayChrome, sleep } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHOTS = path.join(ROOT, 'renders', 'ui');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
}

const BASE = arg('url', 'http://127.0.0.1:8791');
const P = {
  w: Number(arg('w', 16)), d: Number(arg('d', 12)),
  rooms: Number(arg('rooms', 9)), items: Number(arg('items', 130)),
  seed: arg('seed', 'live'),
};
const DEBUG = Number(arg('debug', 9231));
const ARENA = 'work/_live_arena.json';

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++; else failed++;
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

let chrome = null, sess = null;

async function main() {
  console.log(`live workbench  ${BASE}/procgen.html`);
  console.log(`parameters      ${P.w}x${P.d} m, ${P.rooms} rooms, ${P.items} items, seed "${P.seed}"`);
  console.log('');

  /* ------------------------------------------------ 0. Node's own answer */
  const gen = spawnSync(process.execPath, [
    'scripts/procgen.mjs', '--w', String(P.w), '--d', String(P.d),
    '--rooms', String(P.rooms), '--items', String(P.items), '--seed', P.seed,
    '--arena', ARENA, '--out-layout', 'work/_live_layout.js', '--svg', 'work/_live.svg',
    '--report', 'work/_live_procgen.txt',
    '--quiet',
  ], { cwd: ROOT, encoding: 'utf8' });
  const okGen = gen.status === 0;
  check('the generator produced a layout for these parameters', okGen,
    `${gen.status}; ${(gen.stderr || '').trim().split('\n').slice(-1)[0] || ''}`);
  if (!okGen) return;

  const level = JSON.parse(fs.readFileSync(path.join(ROOT, ARENA), 'utf8'));
  const core = buildCore(level, { seed: P.seed, count: 6 });
  console.log(`   node: ${level.rooms.length} rooms, ${level.solids.length} solids, `
    + `${core.nav.walkableCount} nav cells / ${core.nav.components.length} region, `
    + `${core.placement.prizes.length} prizes`);

  /* --------------------------------------------------- 1. drive the page */
  await killStrayChrome();
  chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_live' });
  sess = await attach({ port: DEBUG });
  await sess.viewport(1600, 1000);
  await sess.goto(`${BASE}/procgen.html`, { settle: 1100 });

  const ready = await sess.evalJs('!!(globalThis.__procgen && globalThis.__procgen.ready)');
  const status = await sess.evalJs('document.getElementById("status").textContent');
  check('the live page booted', !!ready, `status "${status}"`);
  if (!ready) return;

  const diag = sess.diagnostics();
  check('no exceptions on the live page', diag.exceptions.length === 0,
    diag.exceptions.slice(0, 2).join(' | '));

  await sess.evalAsync(`__procgen.set(${JSON.stringify(P)}); return 1;`);
  await sess.evalAsync('document.getElementById("go").click(); return 1;');

  let st = null;
  for (let i = 0; i < 80; i++) {
    st = await sess.evalJs('__procgen.state()');
    if (st && st.params && st.params.w === P.w && st.params.seed === P.seed) break;
    await sleep(250);
  }
  check('pressing 生成 produced a floor with those parameters', !!st,
    st ? `w=${st.params.w} seed=${st.params.seed}` : 'no state');
  if (!st) return;

  console.log(`   page: ${st.rooms} rooms, ${st.solids} solids, ${st.walkable} nav cells / `
    + `${st.components} region, ${st.prizes.length} prizes`);
  console.log(`   banner: ${st.readouts}`);
  console.log('');

  /* -------------------------------------------- 2. is it the same floor? */
  // The COUNT is not restated here. "all 8 checks pass" was a label that had
  // already drifted from the ninth check the moment one was added -- and a
  // label nobody re-reads is how a report starts disagreeing with itself. The
  // page's own tally is the assertion; the number in the message comes from it.
  check('every check the live page ran passed', st.fails === 0 && st.checks.length >= 9,
    `${st.checks.length} checks, ${st.fails} failing`);
  check('the page\'s rooms / solids are Node\'s', st.rooms === level.rooms.length
    && st.solids === level.solids.length,
    `${st.rooms}/${level.rooms.length} rooms, ${st.solids}/${level.solids.length} solids`);
  check('the page\'s nav grid is Node\'s, cell for cell',
    st.walkable === core.nav.walkableCount && st.components === core.nav.components.length,
    `${st.walkable}/${core.nav.walkableCount} cells, ${st.components}/${core.nav.components.length} regions`);
  check('the spawn is where Node put it',
    Math.abs(st.spawn.x - level.spawn.x) < 1e-9 && Math.abs(st.spawn.z - level.spawn.z) < 1e-9,
    `(${st.spawn.x.toFixed(6)}, ${st.spawn.z.toFixed(6)})`);

  // For each prize Node placed, how far is the nearest prize the page placed?
  // Matching by ID would assume the two agree on ordering; this asks the only
  // question that matters -- is there a prize at that spot.
  const dist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  const wantPts = core.placement.prizes.map((q) => [q.x, q.z, q.y]);
  let worst = 0, matched = 0;
  for (const q of wantPts) {
    let best = Infinity;
    for (const p of st.prizes) best = Math.min(best, dist(q, p));
    if (best <= 1e-9) matched++;
    worst = Math.max(worst, best);
  }
  check('the six 红包 are where Node put them',
    matched === wantPts.length && wantPts.length === 6,
    `${matched}/${wantPts.length} matched, worst drift ${worst.toExponential(1)} m`);

  // The page strips meta.provenance before handing a floor over, and the CLI
  // stamps it when it writes one. Blank it on BOTH sides so the claim stays
  // exactly as wide as it should be: "the same floor", not "the same file".
  const canon = (lvl) => JSON.stringify(
    Object.assign({}, lvl, { meta: Object.assign({}, lvl.meta, { provenance: null }) }));
  const snap = await sess.evalJs('__procgen.snapshot()');
  const want = canon(level);
  check('the snapshot the page holds is the one the CLI wrote for these parameters',
    snap === want, `${snap ? snap.length : 0} vs ${want.length} chars`);

  /* ------------------------------------------------------- 3. artifacts */
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `02-live-${P.seed}.png`);
  const shot = await sess.shot(file);
  check('a screenshot of the live page was written', shot.ok && shot.bytes > 20000,
    `${shot.bytes} B -> ${path.relative(ROOT, file)}`);

  console.log('');
  console.log(`${passed}/${passed + failed} checks passed`);
  console.log(`VERDICT: ${failed ? 'FAIL' : 'PASS'}`);
}

try {
  await main();
} catch (e) {
  console.error('live probe threw:', e && e.stack ? e.stack : e);
  failed++;
} finally {
  try { if (sess) await sess.close(); } catch { /* ignore */ }
  try { if (chrome) chrome.kill(); } catch { /* ignore */ }
}
process.exit(failed ? 1 : 0);
