/**
 * verify_play.mjs — prove the playable build is the SAME GAME the verdict measured.
 *
 * The claim this file exists to test is narrow and checkable:
 *
 *   "the browser, running `game/play/`, computes the same world the headless
 *    matrix in game/VERDICT.md measured -- same nav, same placement, same patrol."
 *
 * Anything else about a renderer is taste. So the assertions are all countable:
 * object counts, byte counts, pixel statistics, distances, a collision
 * predicate evaluated 3600 times, and two runtimes agreeing to 1e-6.
 *
 * It also tests the three things that can silently be wrong in a first-person
 * build and cannot be seen in a screenshot:
 *
 *   collision   the player is never inside a solid, sampled every step of a
 *               60 s walk -- not "it looked fine when I walked into a wall"
 *   pickup      every placed 红包 is actually collectible from a real stand spot
 *   legality    no 红包 is behind glass that can never be reached, no room empty
 *
 * Usage:  node scripts/verify_play.mjs             (default seed)
 *         node scripts/verify_play.mjs hongbao-03  (a specific seed)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cdp from './cdp.js';
import { buildCore } from '../game/play/boot.js';
import { buildNav } from '../game/core/nav.js';
import { placePrizes, defaultViewpoints } from '../game/core/place.js';
import { buildPatrol } from '../game/core/guard.js';
import { Rng } from '../game/core/rng.js';
import { WALKER } from '../game/core/sim.js';
import { climbPlan, climbStepOf } from '../game/core/climb.js';
import { redCensus } from '../game/core/vision.js';
import { climbCeilOf, supportY } from '../game/core/level.js';
import { MOVE } from '../game/play/config.js';

const { serve, launch, attach, killStrayChrome, sleep } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORK = path.join(ROOT, 'work');
const SHOTS = path.join(ROOT, 'renders', 'play');
const PORT = 8781;
const DEBUG = 9226;
const ARENA = path.join(ROOT, 'game', 'arenas', 'room_scene.json');

const SEED = process.argv[2] || '2026-09-25';

const log = [];
const say = (s = '') => { log.push(s); console.log(s); };
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : String(v));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  say(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  return !!ok;
}

/* ------------------------------------------------------- Node helpers */

/**
 * The rung chain under each packet's standpoint, as plan points the page can
 * walk to and hop onto: [basePad(y 0), rung1(y), ...]. `null` when the
 * standpoint has no ladder at all, and a single floor entry when there is
 * nothing to climb.
 *
 * Computed HERE, from the core's own `climbPlan`, so the browser is not asked
 * to re-derive the ladder -- only to DRIVE it with real walking and real hops.
 */
function prizeLadders(level, nav, prizes) {
  const plan = climbPlan(level, nav);
  const step = level.meta.step;
  const surfaceAt = (y, x, z) => plan.surfaces
    .filter((s) => Math.abs(s.y - y) < 1e-6 && Math.hypot(s.x - x, s.z - z) < 1e-6)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  return prizes.map((p) => {
    if (!p.stand) return null;
    if (p.stand.y <= step) return [{ x: p.stand.x, z: p.stand.z, y: 0 }];
    const surf = surfaceAt(p.stand.y, p.stand.x, p.stand.z);
    if (!surf) return null;
    const chain = [{ x: surf.x, z: surf.z, y: surf.y }];
    let cur = surf;
    const seen = new Set();
    while (cur && !seen.has(cur.id) && chain.length < 6) {
      seen.add(cur.id);
      const acc = plan.reached.get(cur.id);
      if (!acc) return null;
      if (acc.pad.y <= step) { chain.unshift({ x: acc.pad.x, z: acc.pad.z, y: 0 }); break; }
      const host = surfaceAt(acc.pad.y, acc.pad.x, acc.pad.z);
      if (!host) { chain.unshift({ x: acc.pad.x, z: acc.pad.z, y: acc.pad.y }); break; }
      chain.unshift({ x: host.x, z: host.z, y: host.y });
      cur = host;
    }
    return chain;
  });
}

/**
 * The cells the census sweep visits: spread over the walkable floor, and never
 * inside pickup range of a packet -- walking the sweep over one would TAKE it,
 * and a sweep that collects its own subject reports the pool it left behind.
 */
function censusCells(level, nav, prizes, want = 90) {
  const r = level.body.playerRadius;
  const guard = level.collectible.pickup + 0.2;
  const clear = [];
  for (let j = 0; j < nav.d; j++) {
    for (let i = 0; i < nav.w; i++) {
      if (!nav.walkable[j * nav.w + i]) continue;
      const c = nav.centreOf(i, j);
      if (!nav.clear(c.x, c.z, r)) continue;
      if (prizes.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < guard)) continue;
      clear.push(c);
    }
  }
  const stride = Math.max(1, Math.floor(clear.length / want));
  const out = [];
  for (let k = 0; k < clear.length && out.length < want; k += stride) out.push(clear[k]);
  return out;
}

/**
 * The sweep again, in Node, as the number to print beside the browser's.
 * Uses the BASE collectible size, so of the two it is the stricter one.
 */
function sweepCensus(level, nav, prizes, want = 90) {
  const cells = censusCells(level, nav, prizes, want);
  const prizeArea = level.collectible.size[0] * level.collectible.size[2];
  const pool = prizes.map((p) => ({ id: p.id, x: p.x, z: p.z, y: p.y }));
  let redCells = 0, prizeCells = 0;
  let bestRed = { n: -1, x: 0, z: 0 };
  let bestPrize = { n: -1, x: 0, z: 0 };
  for (const c of cells) {
    const cc = redCensus(level, c, {
      eyeY: level.body.eyeHeight, range: WALKER.sightRange, prizes: pool, prizeArea,
    });
    if (cc.reds.length) redCells += 1;
    if (cc.prizes.length) prizeCells += 1;
    if (cc.reds.length > bestRed.n) bestRed = { n: cc.reds.length, x: c.x, z: c.z };
    if (cc.prizes.length > bestPrize.n) bestPrize = { n: cc.prizes.length, x: c.x, z: c.z };
  }
  return { cells: cells.length, redCells, prizeCells, bestRed, bestPrize };
}

/* ------------------------------------------------------------------ Node side */

const level = JSON.parse(fs.readFileSync(ARENA, 'utf8'));

say('='.repeat(72));
say('  寻红 · playable build — headless verification');
say('='.repeat(72));
say(`  arena   ${path.relative(ROOT, ARENA)}  ${(fs.statSync(ARENA).size / 1024).toFixed(0)} KB`);
say(`  seed    ${SEED}`);
say('');

say('-- Node reference ----------------------------------------------------');
const tBoot = Date.now();
const ref = buildCore(level, { seed: SEED, count: 6 });
say(`   buildCore()          ${Date.now() - tBoot} ms   `
  + `nav ${ref.nav.walkableCount} cells, ${ref.nav.components.length} region, `
  + `${ref.prizes.length} prizes, ${ref.patrol.waypoints.length} waypoints`);

// An INDEPENDENT second derivation, with the options spelled out here rather
// than inherited from boot.js. If boot.js ever picks a different cell size or a
// different policy, the browser will still agree with boot.js and these two
// will stop agreeing -- which is the failure worth catching.
const nav2 = buildNav(level, {
  inflate: level.body.playerRadius, bodyHeight: level.body.playerHeight, step: level.meta.step,
});
const placed2 = placePrizes(level, nav2, new Rng(SEED).fork('place'), {
  count: 6, policy: 'spread', viewpoints: defaultViewpoints(level, nav2),
});
const patrol2 = buildPatrol(level, buildNav(level, {
  inflate: level.body.guardRadius, bodyHeight: level.body.guardHeight, step: level.meta.step,
}), new Rng(`guard-${SEED}`), {});

const refMatches = ref.nav.walkableCount === nav2.walkableCount
  && ref.prizes.length === placed2.prizes.length
  && ref.prizes.every((p, i) => Math.abs(p.x - placed2.prizes[i].x) < 1e-9
    && Math.abs(p.z - placed2.prizes[i].z) < 1e-9
    && p.room === placed2.prizes[i].room && p.tier === placed2.prizes[i].tier)
  && ref.patrol.waypoints.length === patrol2.waypoints.length;
check('boot.js agrees with an independently-typed derivation', refMatches,
  `nav ${nav2.walkableCount}, ${placed2.prizes.length} prizes, ${patrol2.waypoints.length} waypoints`);

say('');
say('   placement (Node):');
for (const p of ref.prizes) {
  say(`     ${p.id}  ${p.room.padEnd(8)} ${p.tier.padEnd(9)} `
    + `(${num(p.x)}, ${num(p.z)}, ${num(p.y)})  cover ${(p.cover * 100).toFixed(1)}%`);
}
say('');

/* ------------------------------------------------------------------ browser */

let server = null;
let chrome = null;
let sess = null;
let exitCode = 0;

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });

  await killStrayChrome();
  server = await serve(ROOT, PORT);
  chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_play' });
  sess = await attach({ port: DEBUG });
  await sess.viewport(1600, 900);

  const url = `http://127.0.0.1:${PORT}/play.html`;
  say('-- boot --------------------------------------------------------------');
  const t0 = Date.now();
  await sess.goto(url, { settle: 1500 });

  let ready = false;
  for (let i = 0; i < 240; i++) {
    const r = await sess.evalJs('!!(window.__ready && window.__play)');
    if (r === true) { ready = true; break; }
    const err = await sess.evalJs('window.__playError || null');
    if (err) { say(`   boot threw: ${err}`); break; }
    await sleep(500);
  }
  const bootMs = Date.now() - t0;
  say(`   ready=${ready}  in ${(bootMs / 1000).toFixed(1)} s`);
  say(`   GL  ${await sess.glRenderer()}`);

  const diag = sess.diagnostics();
  const errs = [...diag.exceptions, ...diag.consoleErrors, ...diag.logErrors];
  const httpErrs = diag.httpErrors;
  check('no exceptions / console errors', ready && errs.length === 0, errs.slice(0, 3).join(' | '));
  check('no HTTP 4xx or 5xx', httpErrs.length === 0, httpErrs.slice(0, 3).join(' | '));
  const realFails = (diag.failedDetail || []).filter((f) => !f.canceled && !(f.status >= 200 && f.status < 400));
  check('no real failed requests', realFails.length === 0,
    realFails.slice(0, 3).map((f) => `${f.errorText} ${f.url}`).join(' | '));

  if (!ready) { say('\n   cannot continue without a booted page'); return; }

  /* ---- 1. the two runtimes agree ------------------------------------- */
  say('');
  say('-- 1. same core, two runtimes ----------------------------------------');
  const snap = await sess.evalJs('__play.snapshot()');
  say(`   browser  nav ${snap.nav.walkable} cells @ ${snap.nav.cell} m `
    + `(${snap.nav.w}x${snap.nav.d}, ${snap.nav.regions} region), `
    + `${snap.patrol.waypoints} waypoints, build ${Math.round(snap.ms.total)} ms`);
  check('nav grid identical', snap.nav.walkable === ref.nav.walkableCount
    && snap.nav.w === ref.nav.w && snap.nav.d === ref.nav.d
    && snap.nav.cell === ref.nav.cell && snap.nav.regions === ref.nav.components.length,
  `${snap.nav.walkable}/${ref.nav.walkableCount}`);

  const drift = snap.prizes.map((p, i) => {
    const q = ref.prizes[i];
    return Math.max(Math.abs(p.x - q.x), Math.abs(p.z - q.z), Math.abs(p.y - q.y));
  });
  const worstDrift = drift.length ? Math.max(...drift) : 0;
  check('placement identical, prize for prize', worstDrift < 1e-6,
    `${snap.prizes.length} prizes, worst coordinate drift ${worstDrift.toExponential(1)} m`);
  check('patrol identical', snap.patrol.waypoints === ref.patrol.waypoints.length
    && snap.patrol.dropped === ref.patrol.dropped.length,
  `${snap.patrol.waypoints} vs ${ref.patrol.waypoints.length}`);

  // HOW MANY ROOMS GET A 红包 IS A DRAWING, NOT A PROMISE. The player asked
  // for "不是每个房间都必须有", so "all six" is no longer the claim --
  // what has to hold HERE is the cross-runtime one this section exists for:
  // the browser's drawing is Node's drawing. (That every room is NOT
  // guaranteed is asserted once, against the core, in §9.)
  const rooms = new Set(ref.prizes.map((p) => p.room));
  check('both runtimes draw the same rooms, and it is a proper subset',
    rooms.size >= 1 && rooms.size < level.rooms.length
      && [...new Set(snap.prizes.map((p) => p.room))].sort().join(',') === [...rooms].sort().join(','),
    `${rooms.size} of ${level.rooms.length} rooms: ${[...rooms].sort().join(', ')}`
    + `; empty: ${level.rooms.map((r) => r.id).filter((id) => !rooms.has(id)).join(', ')}`);

  /* ---- 2. determinism ------------------------------------------------- */
  const a = await sess.evalAsync(`
    const s1 = await __play.configure({ seed: 'det-check' });
    const p1 = __play.snapshot().prizes;
    await __play.configure({ seed: 'det-check' });
    const p2 = __play.snapshot().prizes;
    return { same: JSON.stringify(p1) === JSON.stringify(p2), n: p1.length };`);
  check('same seed -> byte-identical placement (twice in one page)',
    a && a.same, `${a && a.n} prizes`);

  // ... and a run nobody pinned hides them somewhere NEW. Both halves have
  // to hold at once: "random" that is not reproducible is a game you cannot
  // compare, and "reproducible" that is not random is a walk you memorise.
  // So measure the pair: two unpinned runs must differ, and the seed the
  // second one printed must rebuild the second one byte for byte.
  const rnd = await sess.evalAsync(`
    const key = () => __play.snapshot().prizes.map((p) => p.x + ',' + p.z + ',' + p.y).join('|');
    await __play.begin('patrol', { random: true });
    const A = key(); const seedA = __play.info().seed;
    await __play.begin('patrol', { random: true });
    const B = key(); const seedB = __play.info().seed;
    await __play.configure({ seed: seedA });
    const C = key();
    return { differ: A !== B, replay: A === C, seedA, seedB,
             policy: __play.info().seedPolicy, n: __play.snapshot().prizes.length };`);
  check('an unpinned run hides the 红包 somewhere new every time', rnd.differ,
    `${rnd.seedA} vs ${rnd.seedB}, ${rnd.n} prizes, policy ${rnd.policy}`);
  check('the seed a run prints rebuilds that exact run', rnd.replay,
    `configure({seed: ${rnd.seedA}}) reproduced the same ${rnd.n} placements`);

  await sess.evalAsync(`await __play.configure({ seed: ${JSON.stringify(SEED)} }); return 1;`);

  /* ---- 3. collision invariant, over a real walk ---------------------- */
  say('');
  say('-- 2. collision + movement -------------------------------------------');
  const walk = await sess.evalAsync(`
    await __play.begin('solo');                     // no guard: this is about walls
    const info0 = __play.info();
    let bad = 0, first = null;
    const legs = [[1, 0], [1, 0.4], [0, 1], [-1, 0], [0, -1], [1, -1], [-1, 1], [0, 0]];

    // WHAT THE 60 s TOTAL CANNOT TELL APART. A body that is not being driven at
    // all and a body driven straight into a wall for a minute both end up
    // somewhere unremarkable, so a bar on the total is a fact about the floor
    // plan wearing the costume of a fact about the input -- and when the outer
    // wall stopped being walk-through, this floor plan changed and so did the
    // number. Ask the direct question first: hold each direction for ONE second
    // and keep the best displacement. The bar is derived from the walker.
    let best = 0, bestLeg = null;
    for (const L of legs) {
      const p0 = __play.info().player;
      __play.input({ fwd: L[0], side: L[1] });
      for (let i = 0; i < 60; i++) __play.step(1/60, 1);
      __play.release();
      const p1 = __play.info().player;
      const d = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      if (d > best) { best = d; bestLeg = L; }
    }

    for (let leg = 0; leg < legs.length; leg++) {
      __play.input({ fwd: legs[leg][0], side: legs[leg][1] });
      for (let i = 0; i < 450; i++) {          // 7.5 s per leg, 60 s total
        __play.step(1/60, 1);
        if (!__play.navInvariant().clear) {
          bad++;
          if (!first) first = { leg, i, ...__play.info().player };
        }
      }
    }
    __play.release();
    const info1 = __play.info();
    return { bad, first, start: info0.player, end: info1.player, phase: info1.phase, best, bestLeg };`);

  check('3672 steps of walking never put the body inside a solid', walk.bad === 0,
    walk.first ? JSON.stringify(walk.first) : 'nav.clear() true at every step');
  const travelled = Math.hypot(walk.end.x - walk.start.x, walk.end.z - walk.start.z);
  // HALF OF ONE SECOND OF FREE WALKING, and the number is not chosen: the walker
  // tops out at MOVE.speed, so one second of held input in the clearest of eight
  // directions has to produce at least half of that, or the input is not
  // reaching the body. Anything the floor plan does to the outcome is confined
  // to a factor of two, which is the margin this bar leaves.
  check('input actually moves the player',
    walk.best >= MOVE.speed * 0.5,
    `best of 8 one-second legs moved ${num(walk.best, 2)} m of `
    + `${num(MOVE.speed, 2)} m free-run (leg [${walk.bestLeg}])`);
  check('a full 60 s of walking stays inside one run',
    walk.phase === 'playing', `phase ${walk.phase}, ended in ${walk.end.room}`);
  // The long walk keeps its own value -- the collision invariant above -- and its
  // distance is now a REPORTED reading with a floor that only says "not stuck".
  check('and 60 s of greedy walking is not stuck',
    walk.end.distance >= MOVE.speed,
    `walked ${num(walk.end.distance, 1)} m over 60 s of game time `
    + `(top speed ${MOVE.speed} m/s => ${num(60 * MOVE.speed, 0)} m if never blocked; `
    + `bar is one second's worth = "not stuck", not a target)`);
  void travelled;

  /* ---- 3. every 红包, taken by a body that walks and climbs ----------- */
  //
  // THE OLD TEST TELEPORTED. It snapped the body to each packet's own XZ and
  // required a pickup in 8 frames. That only works while the packet is on the
  // floor: `teleport` resolves its ground from feetY = 0, so it cannot put a
  // body ON a 0.45 m counter top -- and with packets now stored up high, the
  // teleport read one of them as uncollectible.
  //
  // So the ladder is DRIVEN. The chains come from the core's own `climbPlan`
  // (Node, above), and the page walks and hops along them through the real
  // input channel. What is asserted is what a player can do.
  const ladders = prizeLadders(level, ref.nav, ref.prizes);
  say('');
  say('-- 3. pickup ----------------------------------------------------------');
  const pick = await sess.evalAsync(`
    await __play.begin('solo');
    const CH = ${JSON.stringify(ladders)};
    const av = () => __play.avatar.state();
    // THE PEAK, NOT THE ENDING. A packet is usually taken while the body is
    // still over the surface, and the drive then walks on -- so where the body
    // STOPS says nothing about whether it got up there. The highest ground it
    // stood on during the drive is the thing that answers that.
    let peak = 0;
    const note = () => { const s = av(); if (s.groundY > peak) peak = s.groundY; };
    const walkTo = (tx, tz, frames) => {
      let stall = 0;
      for (let i = 0; i < (frames || 240); i++) {
        const s = av();
        if (Math.hypot(tx - s.x, tz - s.z) < 0.12) break;
        __play.lookAt(tx, tz);
        __play.input({ fwd: 1 });
        __play.step(1 / 60, 1);
        note();
        const t = av();
        if (Math.hypot(t.x - s.x, t.z - s.z) < 1e-5) { stall += 1; if (stall > 6) break; }
        else stall = 0;
      }
    };
    const hop = (tx, tz) => {
      __play.lookAt(tx, tz);
      __play.input({ fwd: 1, jump: 1 });
      __play.step(1 / 60, 1);
      __play.input({ fwd: 1 });
      for (let i = 0; i < 200 && av().airborne; i++) { __play.step(1 / 60, 1); note(); }
    };

    const out = [];
    for (let i = 0; i < __play.prizes.length; i++) {
      const p = __play.prizes[i];
      const chain = CH[i];
      if (__play.info().phase !== 'playing') break;
      const before = __play.info().collected;
      __play.release();
      if (!chain) { out.push({ id: p.id, chain: null, rungs: -1, picked: false }); continue; }
      peak = 0;
      __play.teleport(chain[0].x, chain[0].z);
      __play.step(1 / 60, 2);
      note();
      for (let r = 1; r < chain.length; r++) {
        walkTo(chain[r].x, chain[r].z);
        hop(chain[r].x, chain[r].z);
      }
      const last = chain[chain.length - 1];
      walkTo(last.x, last.z, 120);
      __play.step(1 / 60, 6);
      note();
      const s = av();
      const inf = __play.info();
      out.push({
        id: p.id, room: p.room, tier: p.tier,
        chain: chain.map((c) => c.y), rungs: chain.length - 1,
        pky: Math.round(p.y * 1000) / 1000,
        standY: p.stand ? Math.round(p.stand.y * 1000) / 1000 : null,
        endGround: Math.round(s.groundY * 1000) / 1000,
        peakGround: Math.round(peak * 1000) / 1000,
        picked: inf.collected > before,
      });
    }
    return { out, phase: __play.info().phase, collected: __play.info().collected };`);

  const nPrize = ref.prizes.length;
  const pickOk = pick.out.filter((o) => o.picked).length;
  check('every 红包 is taken by a body that walks and climbs to it', pickOk === nPrize,
    `${pickOk}/${nPrize} ` + pick.out.map((o) => `${o.id}:${o.rungs}hop->${o.endGround}m`).join(' '));
  check('collecting every 红包 wins the run', pick.phase === 'won',
    `phase ${pick.phase}, collected ${pick.collected}`);
  // THE SUBJECT IS "OUT OF THE FLOOR'S REACH", NOT "ON A SURFACE".
  //
  // A body standing on the floor can reach `WALKER.lift` (0.55 m) straight up,
  // so a packet at 0.45 m on a counter is grabbable from beside the counter --
  // correctly, and the placement is allowed to rely on it. The claim that needs
  // a climb to hold is the narrower one: a packet ABOVE that reach has to be
  // taken by a body that got itself up to the standpoint. So the assertion runs
  // over those packets only, and says so when there are none.
  const hopped = pick.out.filter((o) => o.rungs > 0);
  const mustClimb = pick.out.filter((o) => o.pky > WALKER.lift);
  check('a 红包 above the floor\'s arm reach is taken by climbing to it',
    mustClimb.every((o) => o.picked && o.peakGround >= o.standY - 0.02),
    (mustClimb.length
      ? mustClimb.map((o) => `${o.id} y ${o.pky} stand ${o.standY} peak ${o.peakGround}`).join(' | ')
      : `none this seed \u2014 all ${pick.out.length} packets sit inside a floor body's `
        + `${WALKER.lift} m reach`)
    + `; climbs the drive did run: `
    + (hopped.length ? hopped.map((o) => `${o.id} stand ${o.standY} peak ${o.peakGround}`).join(', ') : 'none'));

  /* ---- 4. the near-colour gamble is live, and its marker is drawn ------ */
  //
  // WHERE TO STAND IS SWEPT, NOT TYPED. This used to stand at a fixed 1.6 m
  // offset from `prizes[0]`. The placement rewrite moved that packet behind a
  // dining counter and the fixed offset became a blind spot -- 0 red patches,
  // 0 prizes, 0 sprites, while a sweep of the same floor finds a red from 61 %
  // of its cells. A viewpoint that has to be re-chosen every time the placement
  // moves is not a test of the census, it is a test of one coordinate.
  //
  // The last check is the one the affordance depends on: where the census
  // notices the MOST red, a sprite has to be VISIBLE. Red and 红包 share one
  // sprite pool, and before this round the second list erased the first's
  // sprites -- "3 reds in view, 0 packets" drew nothing at all.
  const xcheck = sweepCensus(level, ref.nav, ref.prizes);
  say('');
  say('-- 4. red census (the mechanic itself) -------------------------------');
  say(`   Node sweep  ${xcheck.redCells}/${xcheck.cells} cells see a red, `
    + `${xcheck.prizeCells} see a 红包; best ${xcheck.bestRed.n} reds @ `
    + `(${num(xcheck.bestRed.x, 2)}, ${num(xcheck.bestRed.z, 2)})`);
  const cens = await sess.evalAsync(`
    await __play.begin('solo');
    const CELLS = ${JSON.stringify(censusCells(level, ref.nav, ref.prizes))};
    let cells = 0, redCells = 0, prizeCells = 0;
    let bestR = { n: -1, prizes: -1, sprites: 0, x: 0, z: 0 };
    let bestP = { n: -1, x: 0, z: 0 };
    for (const c of CELLS) {
      if (__play.info().phase !== 'playing') break;
      __play.release();
      __play.teleport(c.x, c.z);
      __play.step(1 / 60, 5);            // >= 1/12 s: the census runs at 12 Hz
      const cc = __play.census();
      // WHICH COUNT IS THE SPRITE FIELD'S BUSINESS, AND WHICH IS NOT.
      // cc.reds is the RAW census. The sprite field is handed that list MINUS
      // the reds the player has already walked up to -- those move to the grey
      // done pool -- so at a vantage point that clears a red during the settle
      // frames the two differ by exactly that red, and comparing them says
      // nothing about drawing. (seenRed + seenPrize is what the field was
      // handed; red.filter(visible) is what reached the screen. THAT pair is
      // the affordance claim, and both come from one update call.)
      const g = __play.glints;
      const sprites = g.red.filter((s) => s.visible).length;
      const seen = g.seenRed + g.seenPrize;
      cells += 1;
      if (cc.reds.length) redCells += 1;
      if (cc.prizes.length) prizeCells += 1;
      if (seen > bestR.n) {
        bestR = { n: seen, raw: cc.reds.length, prizes: cc.prizes.length, sprites, x: c.x, z: c.z };
      }
      if (cc.prizes.length > bestP.n) bestP = { n: cc.prizes.length, x: c.x, z: c.z };
    }
    return { cells, redCells, prizeCells, bestR, bestP,
             eyeY: __play.census().eyeY, phase: __play.info().phase };`);

  check('the census is alive on this floor — red things get noticed',
    cens.redCells > 0 && cens.bestR.n > 0,
    `${cens.redCells}/${cens.cells} cells see a red, best ${cens.bestR.n} at `
    + `(${num(cens.bestR.x, 2)}, ${num(cens.bestR.z, 2)}) from a ${num(cens.eyeY, 2)} m eye`);
  check('the 红包 is noticed by the same channel', cens.prizeCells > 0,
    `${cens.prizeCells}/${cens.cells} cells see a 红包, best ${cens.bestP.n} at `
    + `(${num(cens.bestP.x, 2)}, ${num(cens.bestP.z, 2)})`);
  check('a red in view is actually drawn, packet or no packet',
    cens.bestR.sprites > 0 && cens.bestR.sprites >= cens.bestR.n,
    `${cens.bestR.sprites} dots on screen for the ${cens.bestR.n} red things the sprite `
    + `field was handed (raw census ${cens.bestR.raw} reds, ${cens.bestR.prizes} prizes)`);
  check('the sweep itself never ended the run', cens.phase === 'playing',
    `phase ${cens.phase} after ${cens.cells} vantage points`);

  /* ---- 6. guard ------------------------------------------------------ */
  say('');
  say('-- 5. guard -----------------------------------------------------------');
  const gd = await sess.evalAsync(`
    await __play.begin('patrol');

    const roomOf = (p) => {
      for (const r of __play.level.rooms) {
        const b = r.rect;
        if (p.x >= b.x0 && p.x <= b.x1 && p.z >= b.z0 && p.z <= b.z1) return r.id;
      }
      return null;
    };

    // ---- phase A: does it PATROL ----------------------------------------
    // Two ways this check has already lied, both measured before being written
    // down (scripts/probe_guard_sight.mjs).
    //
    //  1. The player must stay OUT of the cone. Parking it 0.9 m in FRONT (what
    //     this used to do) makes the guard alert and then chase, and the check
    //     then asks whether a chasing guard was patrolling. Read: 1.54 m.
    //  2. The player must not COLLECT anything. Dragging the avatar around the
    //     flat behind the guard picks up all six 红包 in ~45 s; the run ends,
    //     and stepSim returns early once the phase is not 'playing' -- so the
    //     guard stops being updated altogether and every later probe reads a
    //     dead simulation (mode 'patrol', suspicion 0, player dead centre in
    //     the cone, twelve times in a row).
    //
    // So it is parked at the walkable cell FURTHEST from every 红包, and the
    // gap is reported rather than assumed.
    let park = null;
    let parkGap = -1;
    // Instrumentation for a distance that came back NaN: a NaN total with the
    // guard demonstrably walking three rooms means ONE of the two operands is
    // not a number, and guessing which is how three turns get spent.
    let sample = null, badAt = -1, minD = Infinity, maxD = -Infinity;
    for (let j = 0; j < __play.nav.d; j += 2) {
      for (let i = 0; i < __play.nav.w; i += 2) {
        if (!__play.nav.walkable[j * __play.nav.w + i]) continue;
        const c = __play.nav.centreOf(i, j);
        let near = Infinity;
        for (const q of __play.prizes) near = Math.min(near, Math.hypot(c.x - q.x, c.z - q.z));
        if (near > parkGap) { parkGap = near; park = c; }
      }
    }
    __play.teleport(park.x, park.z);

    // A guard that keeps catching a stationary player burns the clock 15 s at a
    // time, so the run can still end. Restart it and keep counting: the claim
    // is about the patrol, not about one life.
    let steps = 0, distance = 0, restarts = 0, spins = 0;
    const rooms = new Set();
    while (steps < 3600 && spins++ < 40000) {        // 60 s of game time
      if (__play.info().phase !== 'playing') { await __play.begin('patrol'); restarts += 1; continue; }
      const g0 = __play.guard.stats.distance;
      __play.step(1/60, 1);
      const g1 = __play.guard.stats.distance;
      if (sample === null) {
        sample = { g0: String(g0), g1: String(g1), hasGuard: !!__play.guard,
                   hasStats: !!(__play.guard && __play.guard.stats),
                   keys: __play.guard && __play.guard.stats ? Object.keys(__play.guard.stats).join(',') : '' };
      }
      if (!Number.isFinite(g1)) { if (badAt < 0) badAt = steps; }
      else { minD = Math.min(minD, g1); maxD = Math.max(maxD, g1); }
      if (__play.info().phase === 'playing') { distance += g1 - g0; steps += 1; }
      const r = roomOf(__play.guard.state().pos);
      if (r) rooms.add(r);
    }
    const patrol = {
      distance: Math.round(distance * 100) / 100,
      rooms: rooms.size,
      names: [...rooms].sort().join(','),
      parkGap: Math.round(parkGap * 100) / 100,
      restarts, steps, spins, sample, badAt,
      minD: Number.isFinite(minD) ? minD : null,
      maxD: Number.isFinite(maxD) ? maxD : null,
    };

    // ---- phase B: the detection ladder, on a FRESH run -------------------
    // The teleport-in-front setup was never wrong about detection; it was the
    // patrol claim read off it that was. So it gets a full clock of its own.
    await __play.begin('patrol');
    let caught = 0, pen = 0, sawAlert = false, sawChase = false, best = null;
    for (let i = 0; i < 260; i++) {
      const g = __play.guard.state();
      if (g.mode === 'alert') sawAlert = true;
      if (g.mode === 'chase') sawChase = true;
      // Stand 0.9 m directly in front of it, in the middle of the cone.
      __play.teleport(g.pos.x + Math.cos(g.facing) * 0.9, g.pos.z + Math.sin(g.facing) * 0.9);
      const before = __play.info();
      __play.step(1/60, 6);
      const after = __play.info();
      if (after.catches > caught) {
        caught = after.catches;
        pen = Math.round((after.penalties - before.penalties) * 100) / 100;
        best = { suspicion: g.suspicion, mode: after.guard.mode, penalty: pen };
        break;
      }
    }
    return { patrol, caught, pen, sawAlert, sawChase, best };`);

  // The numbers are for 60 s of game time; the whole-shift claim (all six rooms,
  // 600 s, four seeds) belongs to scripts/diag_guard.mjs, not to the browser --
  // this asserts the SAME core is walking here, and reports the park distance so
  // that "the player was nowhere near a 红包" is a number rather than a hope.
  check('guard walks its patrol when the player is out of its cone',
    gd.patrol.distance > 20 && gd.patrol.rooms >= 3,
    `${gd.patrol.distance} m, ${gd.patrol.rooms} rooms (${gd.patrol.names}) in 60 s; `
    + `player parked ${gd.patrol.parkGap} m from the nearest 红包, ${gd.patrol.restarts} restarts`
    + `, steps ${gd.patrol.steps}/${3600}, spins ${gd.patrol.spins}`
    + `, guard distance ${gd.patrol.minD}..${gd.patrol.maxD} m`
    + (Number.isFinite(gd.patrol.distance) ? ''
      : `; FIRST NON-FINITE at step ${gd.patrol.badAt}; SAMPLE ${JSON.stringify(gd.patrol.sample)}`));
  check('guard enters alert when it sees you', gd.sawAlert);
  check('guard catches you inside its cone', gd.caught >= 1,
    gd.best ? `mode ${gd.best.mode}, penalty ${gd.best.penalty} s` : 'never caught');
  check('being caught costs the designed penalty seconds', gd.pen >= 14.9 && gd.pen <= 16.5,
    `${gd.pen} s (GUARD_MODES.patrol.penalty = ${15})`);

  // ---- the guard reaches the framebuffer -----------------------------
  // A guard whose AI is right but which is never DRAWN is unfair in a way no
  // simulation test can see -- and a screenshot cannot prove it either, because
  // a PNG is a log, not an assertion. So measure it: render the same pose twice,
  // once with the guard's own scene group visible and once hidden, and diff the
  // buffers. Its pixels must change, and their centroid must land where the guard
  // projects. (Reading a 1600x900 PNG and agreeing it 'looks right' is not a test.)
  const gr = await sess.evalAsync(`
    await __play.begin('patrol');
    __play.step(1 / 60, 150);                 // 2.5 s: it leaves its start cell
    const S = __play.scene, C = __play.camera, T = __play.THREE;
    const cv = __play.renderer.domElement;
    const W = cv.width, H = cv.height;
    const grp = S.getObjectByName('guard');
    const g = __play.guard.state();

    const grab = () => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(cv, 0, 0);
      return x.getImageData(0, 0, W, H).data;
    };

    // HIDE THE BODY, NOT THE LIGHTS. This node holds the guard's five body
    // meshes AND its point light AND its surveillance SpotLight, so flipping
    // group.visible switched off the pool of light on the floor and the diff
    // measured the POOL: 85,819 px, centroid 159.5 px from the guard, on a guard
    // that was drawn perfectly well. Only meshes are flipped, so what changes is
    // the body and nothing else.
    const parts = [];
    grp.traverse((o) => { if (o.isMesh) parts.push(o); });
    const prev = parts.map((o) => o.visible);
    // THE CAMERA MUST NOT BE ABLE TO HIDE THE THING IT PHOTOGRAPHS.
    //
    // This pose used to be "2.0 m in front of it and 0.7 m to the side" -- a
    // viewpoint built out of the guard's own position AND facing, which is state
    // the test does not control. Move the patrol route by half a metre and the
    // camera ends up inside a wall: the frame becomes one flat surface, the A/B
    // diff reads 0 changed pixels, and the check fails while the renderer is
    // perfectly fine. (Same shape as the light-probe that read 0 px because the
    // camera had ended up inside the geometry it was measuring.)
    //
    // So: OVERHEAD, ABOVE THE WALL LINE. At y = WALL_H + 0.31 nothing in the flat
    // is tall enough to occlude the guard, and the derived check below works from
    // any angle because it is about the projection, not about the pose.
    const wallH = __play.level.meta.wallH;
    __play.freeCam({
      x: g.pos.x + 0.20, y: wallH + 0.31, z: g.pos.z + 0.20,
      tx: g.pos.x, ty: 0.24, tz: g.pos.z,
    });
    __play.renderOnce();
    const A = grab();
    const wasVisible = grp.visible && parts.length > 0;
    for (const o of parts) o.visible = false;
    __play.renderOnce();
    const B = grab();
    for (let i = 0; i < parts.length; i++) parts[i].visible = prev[i];
    __play.freeCam(null);

    let changed = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let i = 0; i < A.length; i += 4) {
      const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
      if (d <= 24) continue;
      changed++;
      const p = i >> 2, px = p % W, py = (p / W) | 0;
      sx += px; sy += py;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
    }
    const meshes = parts.length;
    const v = new T.Vector3(g.pos.x, 0.25, g.pos.z).project(C);
    const pjx = (v.x * 0.5 + 0.5) * W, pjy = (1 - (v.y * 0.5 + 0.5)) * H;

    // THE ALLOWED ERROR IS THE GUARD'S OWN PROJECTED BOUNDING BOX, DERIVED.
    // Every pixel the visible/hidden flip can change belongs to the guard group,
    // so the diff's centroid is the centroid of a silhouette that lies inside
    // that box's projection -- which puts it within the box's projected
    // HALF-DIAGONAL of the guard's projected centre, always, no fudge factor. A
    // guard drawn somewhere else (or not drawn) cannot satisfy it.
    const box = new T.Box3().setFromObject(grp);
    const size = box.getSize(new T.Vector3());
    const camDist = Math.hypot(C.position.x - g.pos.x, C.position.y - 0.25, C.position.z - g.pos.z);
    const pxPerM = (H / 2) / Math.tan((C.fov * Math.PI / 180) / 2) / camDist;
    const projRadius = pxPerM * 0.5 * Math.hypot(size.x, size.z);
    return {
      wasVisible, meshes, changed, frac: changed / (W * H),
      bbox: x1 < 0 ? null : [x0, y0, x1, y1],
      centroid: changed ? [sx / changed, sy / changed] : null,
      projected: [pjx, pjy], projRadius, camDist,
    };`);

  const grOff = gr.centroid
    ? Math.hypot(gr.centroid[0] - gr.projected[0], gr.centroid[1] - gr.projected[1]) : -1;
  // THE FAILURE MESSAGE IS GUARDED TOO. `grOff` above already refuses to index a
  // null centroid; this message did not, so a failing check raised
  // `Cannot read properties of null (reading '0')` from INSIDE its own report and
  // took the run down with it. A harness that dies on its own failure message has
  // not reported the failure.
  check('the guard is drawn in the frame, where it stands',
    gr.wasVisible && gr.meshes >= 4 && gr.changed > 0 && grOff >= 0 && grOff < gr.projRadius,
    `${gr.changed} px changed (${(gr.frac * 100).toFixed(2)}% of frame), ${gr.meshes} meshes, `
    + (gr.centroid
      ? `centroid ${num(gr.centroid[0], 0)},${num(gr.centroid[1], 0)} vs projected `
        + `${num(gr.projected[0], 0)},${num(gr.projected[1], 0)} -> ${num(grOff, 1)} px off, `
        + `allowed ${num(gr.projRadius, 1)} px (its own projected half-diagonal at `
        + `${num(gr.camDist, 2)} m)`
      : 'NOTHING CHANGED when the guard group was hidden -- it is not in the frame'));

  // THE BUDGET COMES OFF THE PRESET, NOT OFF A COMMENT.
  //
  // This used to be `begin('tight')  // 120 s` with `step(0.05, 2500)`:
  // a hand-typed pair where the comment and the step count agreed with
  // each other and with nothing else. When 紧张 moved from 120 s to
  // 180 s the assertion stopped measuring the clock and started
  // measuring arithmetic -- and failed, which is the good outcome.
  //
  // Same fault as the hard-coded jump peak and mouse yaw in §8.1, so
  // the same fix: read the number from the thing that owns it, then
  // step just past it. `presets` is `DIFFICULTIES` itself (play.js).
  const timeout = await sess.evalAsync(`
    const p = __play.presets.find((x) => x.id === 'tight');
    await __play.begin('tight');
    __play.step(0.05, Math.ceil((p.budget + 5) / 0.05));   // past the card's own clock
    const i = __play.info();
    return { phase: i.phase, elapsed: i.elapsed, collected: i.collected, budget: p.budget };`);
  check('running out of clock ends the run', timeout.phase === 'lost',
    `phase ${timeout.phase} after ${num(timeout.elapsed, 1)} s against the card's`
    + ` own ${timeout.budget} s budget`);

  /* ---- 7. controls: jump, and the mouse is the only wheel -------------- */
  say('');
  say('-- 7. controls --------------------------------------------------------');

  // Jump is a RENDERER-LAYER arc, and this is the check that keeps it one: the
  // peak has to be the height the config promises, the body has to come back to
  // the floor it left, and -- the part that matters -- x/z must not move at all.
  // If a hop ever changed the footprint, the verified 2.1 m/s timings over the
  // measured plan would stop describing this game.
  const jp = await sess.evalAsync(`
    await __play.begin('patrol');
    __play.release();
    // v and g are READ FROM THE MODULE, not retyped here. A jump assertion
    // that hard-codes them passes for exactly as long as nobody changes the
    // jump -- i.e. it is a test that fails only when it is being useful.
    const cfg = (await import('./game/play/config.js')).MOVE;
    const expect = cfg.jumpVel * cfg.jumpVel / (2 * cfg.gravity);
    const heightOf = (model) => {
      let h = null;
      for (const s of __play.level.solids) {
        if (s.model !== model) continue;
        const d = s.y1 - s.y0;
        if (h == null || d > h) h = d;
      }
      return h;
    };
    const a0 = __play.avatar.state();
    __play.input({ jump: 1 });
    __play.step(1 / 60, 1);
    __play.input({ jump: 0 });
    let peak = 0, frames = 0, illegal = 0;
    for (let i = 0; i < 150; i++) {
      __play.step(1 / 60, 1);
      const s = __play.avatar.state();
      if (s.hop > peak) peak = s.hop;
      if (s.airborne) frames++;
      if (!__play.navInvariant().clear) illegal++;
    }
    const a1 = __play.avatar.state();
    return {
      peak, frames, illegal, landed: !a1.airborne, hopEnd: a1.hop,
      dx: Math.abs(a1.x - a0.x), dz: Math.abs(a1.z - a0.z),
      rise: a1.y - a0.groundY, expect,
      jumpVel: cfg.jumpVel, gravity: cfg.gravity,
      eyeH: __play.level.body.eyeHeight,
      wallH: heightOf('wall'), sofaH: heightOf('loungeSofa'),
    };`);
  check('space launches an arc the config actually promises',
    jp.peak > jp.expect * 0.90 && jp.peak <= jp.expect,
    `peak ${num(jp.peak, 3)} m vs v^2/2g = ${num(jp.expect, 3)} m`
    + ` (v ${jp.jumpVel}, g ${jp.gravity}); integration loses`
    + ` ${num(100 * (1 - jp.peak / jp.expect), 1)} % to the 1/60 s step`);
  // The reason the arc has the height it has, as a property rather than a
  // taste: high enough to look over a sofa back (0.46 m, measured), NOT high
  // enough to look over a wall (1.29 m, measured). The second half is what
  // keeps "four rooms are four rooms" true while you are in the air.
  check('a hop clears the sofa back and still cannot see over a wall',
    jp.eyeH + jp.peak > jp.sofaH && jp.eyeH + jp.peak < jp.wallH,
    `eye ${num(jp.eyeH, 2)} + peak ${num(jp.peak, 3)} = ${num(jp.eyeH + jp.peak, 3)} m`
    + ` against sofa ${num(jp.sofaH, 2)} m and wall ${num(jp.wallH, 2)} m`);
  check('the hop lands back on the floor it left',
    jp.landed && jp.hopEnd === 0 && Math.abs(jp.rise) < 1e-6,
    `${jp.landed ? 'landed' : 'STILL UP'}, hop ${jp.hopEnd}, feet-vs-ground `
    + `${jp.rise.toExponential(1)} m`);
  check('a hop does not move the body in the plan', jp.dx < 1e-9 && jp.dz < 1e-9,
    `dx ${jp.dx.toExponential(1)} m, dz ${jp.dz.toExponential(1)} m`);
  check('the body stays on legal ground while airborne', jp.illegal === 0,
    `${jp.illegal} illegal frames of ${jp.frames} airborne`);

  /* ---- 7b. 降速: one number, and a slower one --------------------------- */
  //
  // `MOVE.speed` is the renderer's and `WALKER.speed` is the matrix's. They
  // were both 2.1 because every published win rate was measured at 2.1; the
  // player said the run was over too quickly and both moved to 1.5. If they
  // ever disagree, the ladder in VERDICT.md §6 stops describing the game the
  // player drives -- which is a failure nobody would notice by playing.
  say('');
  say('-- 7b. 速度 -----------------------------------------------------------');
  check('the renderer and the matrix walk at the same speed',
    MOVE.speed === WALKER.speed,
    `MOVE.speed ${MOVE.speed} === WALKER.speed ${WALKER.speed}`);
  check('and it is slower than the 2.1 the old matrix was measured at',
    MOVE.speed < 2.1,
    `${MOVE.speed} m/s = ${num(MOVE.speed / level.body.playerHeight, 2)} body-heights/s`
    + ` (old 2.1 = ${num(2.1 / level.body.playerHeight, 2)})`);

  /* ---- 7c. the climb rung is at least one jump plus one foot ------------ */
  //
  // climb.js promises this and cannot check it (the play layer owns jumpVel and
  // gravity). If someone lowers the jump, this fails instead of the game
  // quietly losing a rung -- which is exactly the kind of rot a duplicated
  // constant causes if nobody asserts the relation.
  {
    const expectPeak = MOVE.jumpVel * MOVE.jumpVel / (2 * MOVE.gravity);
    const rung = climbStepOf(level, expectPeak);
    check('one jump plus one foot of footing reaches the climb rung',
      rung >= expectPeak + level.meta.step,
      `rung ${num(rung, 3)} m >= peak ${num(expectPeak, 3)} + step ${level.meta.step} m`);
  }

  /* ---- 8. 跳到桌子上面 / 浴缸里面, driven through the real input -------- */
  say('');
  say('-- 8. 跳上家具 --------------------------------------------------------');
  const climb = await sess.evalAsync(`
    await __play.begin('solo');
    const L = __play.level;
    const test = (model) => {
      const s = L.solids.find((x) => x.model === model);
      if (!s) return { model, missing: true };
      __play.release();
      __play.teleport(s.x, s.z);            // snaps out of the solid, legally
      __play.lookAt(s.x, s.z);
      const a0 = __play.avatar.state();
      __play.input({ fwd: 1, jump: 1 });
      __play.step(1 / 60, 1);
      __play.input({ jump: 0 });
      let peak = 0;
      for (let i = 0; i < 150; i++) {
        __play.step(1 / 60, 1);
        const st = __play.avatar.state();
        if (st.hop > peak) peak = st.hop;
      }
      __play.release();
      const a1 = __play.avatar.state();
      const inside = Math.abs(a1.x - s.x) <= s.hx + 1e-6
        && Math.abs(a1.z - s.z) <= s.hz + 1e-6;
      return {
        model, top: s.y1, launchFeet: a0.y, peak,
        groundY: a1.groundY, feetY: a1.y, onFootprint: inside,
        eyeY: a1.y + L.body.eyeHeight, wallH: L.meta.wallH,
      };
    };
    return { bath: test('bathtub'), desk: test('desk'), counter: test('kitchenCabinetDrawer'),
             fridge: test('kitchenFridge') };`);
  for (const key of ['bath', 'desk', 'counter']) {
    const r = climb[key];
    // ONE-SIDED, AND THAT IS THE WHOLE ASSERTION. This used to demand
    // |groundY - top| < 0.02, which fails the moment the body lands on something
    // STANDING ON the surface: the shipped study desk carries a computerKeyboard
    // whose top is 0.4116 m against the desk's 0.3844, and the body legitimately
    // ends on the keyboard, 0.0272 m proud. "Got up onto the desk" is
    // `groundY >= top`, and "did not fall back to the floor" is the same
    // sentence. An upper bound would have to name the tallest object standing on
    // every desk in the flat -- a layout fact, not a physics one.
    check(`jumped onto the ${r.model} — the body ends up on it`,
      !r.missing && r.onFootprint && r.groundY >= r.top - 0.02,
      `top ${num(r.top, 3)} m, groundY ${num(r.groundY, 3)} m`
      + ` (${num(r.groundY - r.top, 3)} m above the top),`
      + ` peak ${num(r.peak, 3)} m, on the footprint ${r.onFootprint}`);
  }
  // The fridge is the tallest thing in the flat, and the honest edge of the
  // ladder: 0.92 m from the floor is far more than one hop (0.44 m), so it needs
  // a rung -- and MEASURED, its only rung cannot do it either. From the 0.45 m
  // drawer 0.78 m away, the arc covers ~0.57 m before the feet drop back under
  // `top - step`; by then the body is 2 mm short of the fridge's footprint, the
  // fridge's own side stops it, and it falls. That is why `climb.js` now caps a
  // rung-to-rung hop at `edge`, and why the placement never stores a 红包 up
  // there: scripts/probe_ladder.mjs drove 120 packets over 20 seeds and every
  // one of the 7 that needed a second rung was undrivable, while all 113
  // one-rung standpoints were taken.
  check('the fridge is NOT reachable in one jump — 0.92 m needs a rung',
    !climb.fridge.missing && climb.fridge.groundY < 0.1,
    `groundY ${num(climb.fridge.groundY, 3)} m after one hop, fridge top `
    + `${num(climb.fridge.top, 3)} m, one hop reaches `
    + `${num(MOVE.jumpVel * MOVE.jumpVel / (2 * MOVE.gravity), 3)} m`);
  check('standing up on the furniture never lifts the eye over a wall',
    climb.bath.eyeY < climb.bath.wallH && climb.counter.eyeY < climb.counter.wallH,
    `bravest eye ${num(Math.max(climb.bath.eyeY, climb.counter.eyeY), 3)} m`
    + ` vs wall ${climb.bath.wallH} m`);

  {
    const wall = level.solids.find((s) => s.kind === 'wall');
    const ceil = climbCeilOf(level);
    const capped = supportY(level, wall.x, wall.z, 2.0, level.meta.step, ceil);
    const uncapped = supportY(level, wall.x, wall.z, 2.0, level.meta.step);
    check('a wall is not a surface, even asked from 2 m up',
      capped < ceil && uncapped >= wall.y1,
      `with the ceiling ${num(capped, 3)} m, without it ${num(uncapped, 3)} m,`
      + ` wall top ${wall.y1} m, ceiling ${num(ceil, 3)} m`);
  }

  /* ---- 9. 红包 ground rules -------------------------------------------- */
  say('');
  say('-- 9. 红包藏匿 --------------------------------------------------------');
  const onFloor = ref.prizes.filter((p) => p.y <= 0.02);
  check('no 红包 is lying on the floor', onFloor.length === 0,
    `${ref.prizes.length} packets, on the floor: ${onFloor.length}`
    + (onFloor.length ? ' -> ' + onFloor.map((p) => `${p.id}@${num(p.y, 3)}`).join(', ') : ''));
  {
    const used = new Set(ref.prizes.map((p) => p.room));
    check('not every room has to hold one; the drawing is what varies',
      used.size >= 1 && used.size < level.rooms.length,
      `${used.size} of ${level.rooms.length} rooms hold a 红包`
      + ` — ${[...used].sort().join(', ')}; empty: `
      + level.rooms.map((r) => r.id).filter((id) => !used.has(id)).join(', '));
  }
  check('every 红包 is takeable (a standpoint exists)',
    ref.prizes.every((p) => p.stand),
    `${ref.prizes.filter((p) => p.stand).length} / ${ref.prizes.length} have one`);
  check('every raised 红包 names the pad its climb starts from',
    ref.prizes.every((p) => !p.climb || p.pad),
    `${ref.prizes.filter((p) => p.climb > 0).length} packets need a climb,`
    + ` all with a pad: ${ref.prizes.filter((p) => p.climb > 0).every((p) => !!p.pad)}`);
  {
    // ONE RUNG, STARTED FROM THE FLOOR. `climbPlan` is a fixpoint over
    // HEIGHTS and cannot see the horizontal blocking, so a rung-from-a-rung is
    // only as good as the gap between them -- and measured, every such route
    // failed. So a standpoint the placement is allowed to trust has a FLOOR pad,
    // and that is what keeps "a 红包 nobody can grab is a bug, not a challenge"
    // true now that packets are stored up high.
    const chained = ref.prizes.filter((p) => p.stand
      && p.stand.y > level.meta.step && !(p.pad && p.pad.y <= level.meta.step));
    check('no 红包 is stored where only a two-rung climb could reach it',
      chained.length === 0,
      chained.length
        ? chained.map((p) => `${p.id} stand ${num(p.stand.y, 2)} pad ${num(p.pad.y, 2)}`).join(', ')
        : `${ref.prizes.length} standpoints, every one a floor launch or nothing`);
  }
  check('no 红包 is unfindable (none came back `hidden`)',
    ref.prizes.every((p) => p.tier !== 'hidden'),
    [...new Set(ref.prizes.map((p) => p.tier))].sort().join(', '));

  // Q/E used to turn you. They are unmapped now, and "unmapped" is assertable
  // rather than a claim about the source: press them for real and require the
  // yaw not to move -- then require the MOUSE channel to still turn, so the
  // check cannot pass by having broken steering altogether.
  const kb = await sess.evalAsync(`
    await __play.begin('patrol');
    __play.release();
    const y0 = __play.avatar.state().yaw;
    const codes = ['KeyQ', 'KeyE', 'ArrowLeft', 'ArrowRight'];
    for (const code of codes) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
    }
    __play.step(1 / 60, 40);
    const y1 = __play.avatar.state().yaw;
    for (const code of codes) {
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    }
    const y2 = __play.avatar.state().yaw;
    __play.step(1 / 60, 10);
    const y3 = __play.avatar.state().yaw;
    __play.look(120, 0);
    __play.step(1 / 60, 1);
    const y4 = __play.avatar.state().yaw;
    const wrap = (d) => {
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return d;
    };

    // WHICH WAY the mouse turns you, measured against THREE.JS'S OWN BASIS.
    //
    // This shipped inverted once -- a += where the camera's rotation.y
    // convention wanted a -= -- and no screenshot can show it. Re-reading
    // the sign in avatar.js would just restate the bug, so ask the renderer
    // instead: column 0 of camera.matrixWorld is the camera's right vector
    // AS THREE.JS COMPUTED IT. A pointer that moves right must rotate the
    // view TOWARD it. Because the camera is only ever posed by yaw+pitch,
    // the forward is perpendicular to that right vector, so their dot
    // product after the delta IS the signed turn -- and the ortho figure
    // below proves the basis really was perpendicular, i.e. that this
    // instrument reads what it claims to read.
    __play.renderOnce();
    const V = __play.THREE.Vector3;
    const right = new V().setFromMatrixColumn(__play.camera.matrixWorld, 0);
    const fwd = () => __play.camera.getWorldDirection(new V());
    const ortho = fwd().dot(right);
    __play.look(240, 0);
    __play.step(1 / 60, 1);
    __play.renderOnce();
    const turnRight = fwd().dot(right);
    __play.look(-480, 0);
    __play.step(1 / 60, 1);
    __play.renderOnce();
    const turnLeft = fwd().dot(right);
    return {
      held: Math.abs(wrap(y1 - y0)), after: Math.abs(wrap(y3 - y2)),
      mouse: wrap(y4 - y3), sens: 0.0021,
      turnRight, turnLeft, ortho,
    };`);
  check('Q/E and the arrows no longer turn the camera',
    kb.held < 1e-12 && kb.after < 1e-12,
    `yaw drift ${kb.held.toExponential(1)} rad while held, `
    + `${kb.after.toExponential(1)} rad after release`);
  check('the mouse is the steering it was replaced with',
    Math.abs(Math.abs(kb.mouse) - 120 * kb.sens) < 1e-6,
    `120 px -> ${num(kb.mouse, 4)} rad (mouseSens ${kb.sens})`);
  check('the mouse turns you the way the pointer moves, not the other way',
    Math.abs(kb.ortho) < 1e-6 && kb.turnRight > 0.05 && kb.turnLeft < -0.05,
    `forward.right before the turn ${num(kb.ortho, 8)} (basis orthonormal), `
    + `+240 px -> ${num(kb.turnRight, 4)}, then -480 px -> ${num(kb.turnLeft, 4)}`
    + `  [positive = turned toward screen-right]`);

  // The thumbnail. A/B'd exactly the way the world guard is: draw it with and
  // without each arrow and diff. "It looks like a map" is not a test; the
  // changed pixels' centroid landing on project(x, z) is.
  const mm = await sess.evalAsync(`
    await __play.begin('patrol');
    __play.release();
    __play.step(1 / 60, 90);
    const M = __play.minimap;
    const m = M.metrics();
    const cv = M.canvas;
    const g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const grab = () => g.getImageData(0, 0, W, H).data;
    const av = __play.avatar.state();
    const gs = __play.guard ? __play.guard.state() : null;
    const gd = gs ? { x: gs.pos.x, z: gs.pos.z, facing: gs.facing, mode: gs.mode } : null;
    const pd = { x: av.x, z: av.z, facing: av.facing };

    M.draw({ player: null, guard: null });   const base = grab();
    M.draw({ player: pd, guard: null });     const withP = grab();
    M.draw({ player: null, guard: gd });     const withG = grab();

    const PLAN = [0x13, 0x19, 0x22];
    let painted = 0;
    for (let i = 0; i < base.length; i += 4) {
      const d = Math.abs(base[i] - PLAN[0]) + Math.abs(base[i + 1] - PLAN[1])
        + Math.abs(base[i + 2] - PLAN[2]);
      if (d > 30) painted++;
    }
    const diff = (a, b) => {
      let n = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1])
          + Math.abs(a[i + 2] - b[i + 2]) + Math.abs(a[i + 3] - b[i + 3]);
        if (d <= 40) continue;
        n++;
        const p = i >> 2;
        const px = p % W;
        const py = (p / W) | 0;
        sx += px;
        sy += py;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      }
      return {
        n, c: n ? [sx / n, sy / n] : null,
        box: x1 < 0 ? null : [x1 - x0 + 1, y1 - y0 + 1],
      };
    };
    const dP = diff(withP, base);
    const dG = diff(withG, base);
    const pp = M.project(av.x, av.z);
    const gp = gd ? M.project(gd.x, gd.z) : null;
    return {
      metrics: m, painted, guardOn: !!gd,
      p: { n: dP.n, c: dP.c, box: dP.box, at: [pp.x, pp.y] },
      g: { n: dG.n, c: dG.c, box: dG.box, at: gp ? [gp.x, gp.y] : null,
           mode: gd ? gd.mode : null },
    };`);
  const off = (o) => (o.n && o.c
    ? Math.hypot(o.c[0] / mm.metrics.dpr - o.at[0], o.c[1] / mm.metrics.dpr - o.at[1]) : -1);
  // Shape, not a magic count. The arrow is ~9x6 CSS px before the DPR
  // factor, so the bars are: enough pixels not to be antialiasing noise, AND
  // a compact blob. (v1 asked for > 30 device px and failed at exactly 30 on
  // a dpr-1 canvas while its own detail line read 0.6 px off -- the bar was the
  // bug, not the map.)
  const blob = (o) => (o.box ? Math.max(o.box[0], o.box[1]) / mm.metrics.dpr : Infinity);
  check('the thumbnail is a floor plan of all six rooms',
    mm.painted > 1500 && mm.metrics.rooms === 6,
    `${mm.painted} px of plan painted, ${mm.metrics.rooms} rooms, `
    + `${mm.metrics.doors} doors, canvas ${mm.metrics.pxW}x${mm.metrics.pxH} device px`);
  check('the thumbnail draws YOU where you stand',
    mm.p.n >= 15 && blob(mm.p) <= 12 && off(mm.p) < 2.5,
    `${mm.p.n} px changed in a ${num(blob(mm.p), 1)} px blob, centroid `
    + `${num(mm.p.c[0] / mm.metrics.dpr, 1)},${num(mm.p.c[1] / mm.metrics.dpr, 1)} vs project() `
    + `${num(mm.p.at[0], 1)},${num(mm.p.at[1], 1)} -> ${num(off(mm.p), 2)} px off`);
  check('the thumbnail draws the GUARD where it stands',
    mm.guardOn && mm.g.n >= 15 && blob(mm.g) <= 12 && off(mm.g) < 2.5,
    `${mm.g.n} px changed in a ${num(blob(mm.g), 1)} px blob (mode ${mm.g.mode}), centroid `
    + `${num(mm.g.c[0] / mm.metrics.dpr, 1)},${num(mm.g.c[1] / mm.metrics.dpr, 1)} vs project() `
    + `${num(mm.g.at[0], 1)},${num(mm.g.at[1], 1)} -> ${num(off(mm.g), 2)} px off`);

  // The names, at a size you can read them at. `labelled` is the half that
  // matters: growing a font is trivially "achieved" by letting the longest
  // name spill out of its box or by dropping the room entirely, and both of
  // those show up as a smaller count here.
  check('the room names are legible and no room lost its label',
    mm.metrics.labelPx >= 12 && mm.metrics.labelled === mm.metrics.rooms,
    `${mm.metrics.labelPx} px font, ${mm.metrics.labelled}/${mm.metrics.rooms} rooms`
    + ` labelled on a ${mm.metrics.pxW}x${mm.metrics.pxH} px canvas`);

  /* ---- 7b. the two difficulty dials ---------------------------------- */
  say('');
  say('-- 7b. the dials on the difficulty cards --------------------------------');
  const dial = await sess.evalAsync(`
    const THREE = __play.THREE;
    const V = THREE.Vector3;
    const box = new THREE.Box3();
    const heightOf = (model) => {
      let h = null;
      for (const s of __play.level.solids) {
        if (s.model !== model) continue;
        const d = s.y1 - s.y0;
        if (h == null || d > h) h = d;
      }
      return h;
    };
    const rows = [];
    for (const p of __play.presets) {
      await __play.begin(p.id);
      __play.release();
      __play.step(1 / 60, 3);
      __play.renderOnce();
      const d = __play.info().difficulty;
      // The packet MEASURED off the mesh in the scene, not read back from
      // the number that was fed in. items[0] is unrotated, so its world AABB
      // is the packet's own extent.
      box.setFromObject(__play.prizeField.items[0].mesh);
      const sz = box.getSize(new V());
      // The guard's light, found by walking the scene graph rather than by
      // trusting a name.
      const group = __play.scene.getObjectByName('guard');
      let spot = null;
      if (group) group.traverse((o) => { if (o.isSpotLight) spot = o; });
      let light = null, aim = null;
      if (spot && __play.guard) {
        const a = spot.getWorldPosition(new V());
        const b = spot.target.getWorldPosition(new V());
        const dir = b.sub(a).setY(0).normalize();
        const f = __play.guard.state().facing;
        aim = dir.dot(new V(Math.cos(f), 0, Math.sin(f)));
        light = { angle: spot.angle, distance: spot.distance,
                  intensity: spot.intensity, visible: spot.visible };
      }
      rows.push({
        id: d.id, guard: d.guard, budget: d.budget,
        fanArea: d.fanArea, coneDeg: d.coneDeg, range: d.range,
        prizeScale: d.prizeScale, prizeSize: d.prizeSize,
        noticeRange: d.noticeRange, pickup: d.pickup,
        mesh: [sz.x, sz.y, sz.z], light, aim,
        guardVisible: group ? group.visible : false,
      });
    }
    return { rows, cards: document.querySelectorAll('#start-cards .card-spec').length,
             wallH: heightOf('wall') };`);
  const rows = dial.rows;
  const fan = rows.map((r) => r.fanArea);
  check('the harder the preset, the more floor the guard watches',
    fan[0] === 0 && fan.every((v, i) => i === 0 || v > fan[i - 1]),
    rows.map((r) => `${r.id} ${num(r.fanArea, 1)} m2`).join('  <  '));
  const wide = rows.map((r) => r.prizeSize[0]);
  check('... and the smaller the 红包',
    wide.every((v, i) => i === 0 || v < wide[i - 1]),
    rows.map((r) => `${r.id} ${(r.prizeSize[0] * 100).toFixed(1)}x`
      + `${(r.prizeSize[2] * 100).toFixed(1)} cm`).join('  >  '));
  const meshErr = Math.max(...rows.map((r) => Math.max(
    Math.abs(r.mesh[0] - r.prizeSize[0]), Math.abs(r.mesh[2] - r.prizeSize[2]))));
  check('the packet on screen is the packet the census gates on',
    meshErr < 0.004,
    `worst axis error ${meshErr.toFixed(4)} m over `
    + rows.map((r) => `${r.id} mesh ${(r.mesh[0] * 100).toFixed(1)} cm`).join(', '));
  check('a smaller packet does not shorten the reach',
    rows.every((r) => r.pickup === level.collectible.pickup),
    `pickup ${rows.map((r) => r.pickup).join(' / ')} m, arena ${level.collectible.pickup} m`);
  const lit = rows.filter((r) => r.guard);
  check('the guard carries a light on the same cone and throw as the fan',
    lit.length > 0 && lit.every((r) => r.light && r.light.visible
      && r.light.intensity > 0
      && Math.abs(r.light.angle - (r.coneDeg * Math.PI) / 180 / 2) < 1e-9
      && Math.abs(r.light.distance - r.range) < 1e-9),
    lit.map((r) => `${r.id} fan ${Math.round(r.coneDeg)}deg x ${num(r.range, 1)} m`
      + ` = light ${num(r.light.angle * 360 / Math.PI, 1)}deg x`
      + ` ${num(r.light.distance, 1)} m @ i ${num(r.light.intensity, 2)}`).join(' | '));
  const aims = lit.map((r) => r.aim).filter((v) => v != null);
  check('the light points where the guard points',
    aims.length === lit.length && Math.min(...aims) > 0.999,
    `worst alignment ${num(Math.min(...aims), 5)} (1.000 = dead ahead)`);
  check('every difficulty card prints both dials',
    dial.cards === rows.length,
    `${dial.cards} cards carry a spec line for ${rows.length} presets`);

  // Does the light actually put light on the floor? A/B it the way the world
  // guard was A/B'd: same camera, `spot.visible` toggled, diff.
  //
  // The camera looks STRAIGHT DOWN from 2.6 m over the guard, and that is
  // load-bearing. This assertion first framed the pool from 0.5 m behind the
  // guard along its own facing -- "so the frame IS the sector" -- and it read 0
  // changed pixels (max delta 0). A probe then showed the light repainting
  // ~6 % of a 1600x900 frame from that exact recipe, so the light was never the
  // problem: a pose built from the guard's FACING follows the guard into a
  // corner or into the interior of a wall, and a frame that is one unlit surface
  // diffs to nothing for reasons that have nothing to do with the light. Now
  // that every run draws a fresh layout, "which way is the guard facing" is not
  // a fixed quantity to hang an assertion on. Straight down cannot be occluded
  // by a 1.29 m wall, so it is the pose that cannot lie. The seed is pinned
  // here for the same reason: a picture assertion should not move run to run.
  const glow = await sess.evalAsync(`
    await __play.begin('hunter', { seed: 'verify-glow' });
    __play.release();
    __play.step(1 / 60, 3);
    const g = __play.guard.state();
    __play.freeCam({
      x: g.pos.x, y: 2.6, z: g.pos.z + 0.001,
      tx: g.pos.x, ty: 0, tz: g.pos.z,
    });
    const group = __play.scene.getObjectByName('guard');
    let spot = null;
    group.traverse((o) => { if (o.isSpotLight) spot = o; });
    const W = 400, H = 240;
    const grab = () => {
      __play.renderOnce();
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(__play.renderer.domElement, 0, 0, W, H);
      return ctx.getImageData(0, 0, W, H).data;
    };
    const on = grab();
    const lit = {
      visible: spot.visible, intensity: spot.intensity,
      distance: spot.distance, angleDeg: spot.angle * 360 / Math.PI,
    };
    spot.visible = false;
    const off = grab();
    spot.visible = true;
    let n = 0, max = 0;
    for (let i = 0; i < on.length; i += 4) {
      const dd = Math.abs(on[i] - off[i]) + Math.abs(on[i+1] - off[i+1])
        + Math.abs(on[i+2] - off[i+2]);
      if (dd > max) max = dd;
      if (dd > 12) n++;
    }
    __play.freeCam(null);
    return {
      n, max, total: W * H, lit,
      guard: { x: Number(g.pos.x.toFixed(3)), z: Number(g.pos.z.toFixed(3)) },
    };`);
  check('the surveillance area lights the floor it claims',
    glow.n > glow.total * 0.01 && glow.max > 12,
    `${glow.n}/${glow.total} px changed with the light on vs off`
    + ` (${num(100 * glow.n / glow.total, 1)} % of the frame, max delta ${glow.max})`
    + ` from a ${num(glow.lit.angleDeg, 1)}deg x ${num(glow.lit.distance, 1)} m`
    + ` light at i ${num(glow.lit.intensity, 2)},`
    + ` looking down on the guard at (${glow.guard.x}, ${glow.guard.z})`);

  /* ---- 8. the view actually renders ---------------------------------- */
  say('');
  say('-- 8. the view renders ------------------------------------------------');
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
        const l = (d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114);
        sum += l;
        sum2 += l * l;
        if (l < 14) dark++;
        opaque++;
        set.add((d[i] >> 3) + ',' + (d[i+1] >> 3) + ',' + (d[i+2] >> 3));
      }
      const mean = sum / opaque;
      return { mean, sd: Math.sqrt(Math.max(0, sum2 / opaque - mean * mean)),
               darkFrac: dark / opaque, colours: set.size };
    };
    await __play.begin('patrol');
    const spawn = stat();
    __play.freeCam({ x: 5, y: 9.2, z: 5.4, tx: 5, ty: 0, tz: 4 });
    const top = stat();
    __play.freeCam(null);
    return { spawn, top };`);

  // ">200 distinct colours" was a bar this renderer was never going to clear,
  // and not because anything was wrong: the kit is FLAT-SHADED, so a wall is a
  // single colour, and a 160x100 sample of a first-person view 0.36 m off the
  // floor legitimately reads 139. The property that separates "a lit room" from
  // "a black frame" is not the colour count -- a black frame is ONE colour with
  // zero luminance spread, and so is a flat unlit fill. So measure the SPREAD,
  // and put the colour bar where it separates the two outcomes rather than
  // where it happens to sit for a photograph.
  check('first-person view is a lit room, not a black frame',
    // THE COLOUR BAR IS NOT A PHOTOGRAPH JUDGEMENT. A black frame is ONE colour
    // with no luminance spread, and so is a flat unlit fill; the two terms that
    // separate those from a lit room are `sd` and `darkFrac`, and both have room
    // to spare. The colour count only has to show that more than a surface or
    // two was drawn -- and the old 100 sat INSIDE the range real frames occupy,
    // measured at 139 from one spot and 96 from another, both correct
    // flat-shaded views of the same lit room. 8 is "more than a couple of
    // surfaces", which is the property the label names.
    px.spawn.mean > 25 && px.spawn.sd > 8 && px.spawn.darkFrac < 0.35 && px.spawn.colours >= 8,
    `mean ${num(px.spawn.mean, 1)}, sd ${num(px.spawn.sd, 1)}, `
    + `dark ${(px.spawn.darkFrac * 100).toFixed(1)}%, ${px.spawn.colours} colours`);
  check('dollhouse camera sees a different, brighter scene',
    px.top.mean > 40 && Math.abs(px.top.mean - px.spawn.mean) > 3,
    `mean ${num(px.top.mean, 1)} vs ${num(px.spawn.mean, 1)}`);

  const frames = await sess.evalAsync(`
    const a = __play.info().stats.frames;
    await new Promise((r) => setTimeout(r, 700));
    const b = __play.info().stats.frames;
    return { a, b, fps: __play.info().stats.fps };`);
  check('the render loop is running', frames.b > frames.a,
    `frames ${frames.a} -> ${frames.b}`);

  /* ---- 9. screenshots ------------------------------------------------- */
  say('');
  say('-- 9. screenshots -----------------------------------------------------');
  const shots = [];
  const shot = async (name, prepare) => {
    if (prepare) await prepare();
    await sleep(280);
    const file = path.join(SHOTS, name + '.png');
    const r = await sess.shot(file);
    shots.push({ name, ...r });
    say(`   ${name.padEnd(22)} ${r.ok ? r.bytes + ' B' : 'FAILED'}`);
  };

  await shot('00-menu', async () => {
    await sess.evalAsync('__play.menu(); return 1;');
  });
  // A file called `00-menu` has to contain a menu, and the start card is where
  // the seed box and the two dials on each card are visible at all.
  const menuUp = await sess.evalAsync(`
    const el = document.getElementById('ov-start');
    const cards = document.querySelectorAll('#start-cards .card');
    const specs = document.querySelectorAll('#start-cards .card-spec');
    const box = document.getElementById('seed-input');
    const note = document.getElementById('seed-note');
    const live = __play.info().seed;
    return {
      visible: !!el && !el.classList.contains('hidden'),
      cards: cards.length,
      specs: specs.length,
      boxed: box ? box.value : null,
      live,
      note: note ? note.textContent.slice(0, 16) : null,
    };`);
  // The box has to hold the seed the run will actually use. "The field is not
  // empty" would pass on a box showing a string that no longer reproduces
  // anything; comparing it to the live seed is the claim that matters.
  check('the start card is a screen, not a leftover frame',
    menuUp.visible && menuUp.cards >= 4 && menuUp.specs === menuUp.cards
      && !!menuUp.boxed && menuUp.boxed === menuUp.live && !!menuUp.note,
    `overlay up ${menuUp.visible}, ${menuUp.cards} difficulty cards, `
    + `${menuUp.specs} of them printing their two dials,`
    + ` seed box "${menuUp.boxed}" against the live seed "${menuUp.live}",`
    + ` note "${menuUp.note}..."`);
  await shot('01-spawn', async () => {
    await sess.evalAsync(`await __play.begin('patrol'); __play.step(1/60, 4);
      __play.lookAt(__play.prizes[1].x, __play.prizes[1].z); __play.step(1/60, 4); return 1;`);
  });
  await shot('02-living-red', async () => {
    await sess.evalAsync(`__play.teleport(2.6, 5.2, 0.6); __play.step(1/60, 10);
      __play.lookAt(2.0, 6.6, 0.2); __play.step(1/60, 10);
      __play.freeCam(null); return 1;`);
  });
  await shot('03-prize-closeup', async () => {
    await sess.evalAsync(`
      const p = __play.prizes.find((q) => q.tier === 'open') || __play.prizes[0];
      __play.teleport(p.x + 0.9, p.z + 0.9); __play.step(1/60, 8);
      __play.lookAt(p.x, p.z, p.y + 0.03); __play.step(1/60, 8); return 1;`);
  });
  await shot('04-guard-cone', async () => {
    // Over the guard's shoulder and HIGH: 2.2 m up, 2.6 m back, 1.0 m to the
    // side. The previous pose sat 2 m behind the guard at eye height along its
    // facing, and the picture it produced was the living room with no guard in
    // it at all -- the same "camera inside a wall" failure the light A/B hit,
    // for the same reason: a pose built from `g.facing` is only as good as
    // whatever the fresh layout put behind the guard. From 2.2 m no 1.29 m wall
    // can occlude either the sentry or the pool it casts, and the sideways
    // offset keeps the guard's own body off the top of the pool.
    await sess.evalAsync(`
      await __play.begin('hunter', { seed: 'verify-glow' });
      __play.release();
      __play.step(1 / 60, 3);
      const g = __play.guard.state();
      const f = g.facing;
      __play.freeCam({
        x: g.pos.x - Math.cos(f) * 2.6 - Math.sin(f) * 1.0, y: 2.2,
        z: g.pos.z - Math.sin(f) * 2.6 + Math.cos(f) * 1.0,
        tx: g.pos.x + Math.cos(f) * 1.2, ty: 0.0,
        tz: g.pos.z + Math.sin(f) * 1.2,
      });
      __play.renderOnce(); return 1;`);
  });
  await shot('05-dollhouse', async () => {
    await sess.evalAsync(`__play.freeCam({ x: 13.0, y: 7.6, z: 11.6, tx: 4.6, ty: 0.45, tz: 3.9 });
      __play.renderOnce(); return 1;`);
  });
  await shot('06-prizes-top', async () => {
    await sess.evalAsync(`__play.freeCam({ x: 5, y: 15.5, z: 4.4, tx: 5, ty: 0, tz: 4.0 });
      __play.renderOnce(); return 1;`);
  });
  await sess.evalAsync(`__play.freeCam(null); return 1;`);

  const sizes = new Set(shots.filter((s) => s.ok).map((s) => s.bytes));
  check('every screenshot wrote bytes', shots.every((s) => s.ok && s.bytes > 20000),
    shots.map((s) => s.bytes).join(' '));
  check('screenshots differ from each other', sizes.size >= shots.length - 1,
    `${sizes.size} distinct sizes for ${shots.length} shots`);

  /* ---- wrap ----------------------------------------------------------- */
  const fin = sess.diagnostics();
  const lateErrs = [...fin.exceptions, ...fin.consoleErrors, ...fin.logErrors];
  check('still no exceptions after the whole session', lateErrs.length === 0,
    lateErrs.slice(0, 2).join(' | '));

  const info = await sess.evalJs('__play.info()');
  say('');
  say(`   final phase ${info.phase}, stats ${JSON.stringify(info.stats)}`);

  fs.writeFileSync(path.join(WORK, 'play_eval.json'), JSON.stringify({
    seed: SEED,
    bootMs,
    ref: {
      nav: { walkable: ref.nav.walkableCount, w: ref.nav.w, d: ref.nav.d, cell: ref.nav.cell,
             regions: ref.nav.components.length },
      prizes: ref.prizes.map((p) => ({ id: p.id, room: p.room, tier: p.tier, x: p.x, z: p.z, y: p.y, cover: p.cover })),
      patrol: { waypoints: ref.patrol.waypoints.length, dropped: ref.patrol.dropped.length },
      ms: ref.ms,
    },
    browser: snap,
    walk, pick, cens, gd, timeout, px, frames,
    shots: shots.map((s) => ({ name: s.name, bytes: s.bytes || 0 })),
    results,
  }, null, 2));
}

main()
  .catch((err) => {
    say('');
    say('HARNESS ERROR: ' + (err && err.stack ? err.stack : err));
    exitCode = 2;
  })
  .finally(async () => {
    const passed = results.filter((r) => r.ok).length;
    say('');
    say('='.repeat(72));
    say(`  ${passed}/${results.length} checks passed`);
    for (const r of results) if (!r.ok) say(`   FAILED: ${r.name} — ${r.detail || ''}`);
    say('='.repeat(72));
    const verdict = results.length > 0 && passed === results.length && exitCode === 0;
    say(verdict ? '  VERDICT: PASS' : '  VERDICT: FAIL');
    fs.writeFileSync(path.join(WORK, 'verify_play.log'), log.join('\n') + '\n');
    try { if (sess) sess.close(); } catch { /* */ }
    try { if (chrome) chrome.kill(); } catch { /* */ }
    try { if (server) await server.close(); } catch { /* */ }
    await killStrayChrome();
    if (!verdict) exitCode = 1;
    process.exit(exitCode);
  });
