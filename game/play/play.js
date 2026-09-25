/**
 * play.js — 寻红, the playable build.
 *
 * THE CONTRACT THIS FILE KEEPS
 * ---------------------------
 * Everything that decides whether you win is computed by `game/core/`:
 * the walkable grid and every collision test, the line-of-sight test behind the
 * red census and behind the guard's eyes, where the 红包 were placed, and the
 * patrol. This file owns only three things a simulation does not need:
 *
 *   1. turning an input device into `{fwd, side, turn, look}`
 *   2. putting the result on screen
 *   3. deciding when a run is over
 *   4. building the flat it is standing in -- out of the layout the ARENA
 *      carries, never out of `js/layout.js`. See `requireLayout`.
 *
 * That is why the playable build and the headless matrix in `game/VERDICT.md`
 * are the same game. `scripts/verify_play.mjs` checks it the only way that
 * counts: it recomputes the placement in Node and compares it, prize for prize,
 * with what this file produced in a browser.
 *
 * Determinism is deliberate and testable. `stepSim(dt)` reads nothing from the
 * clock, nothing from `Math.random` and nothing from the DOM except the input
 * set, so a harness can drive a whole 180 s run in milliseconds:
 *
 *     __play.begin('patrol'); __play.input({fwd:1}); __play.step(1/60, 10800)
 */
import * as THREE from 'three';
import { createRenderer, createEnvironment, createLights, createGround } from '../../js/env.js';
import { Kit } from '../../js/kit.js';
import { requiredModels } from '../procgen/required.js';
import { buildApartment } from '../../js/build.js';
import { redCensus } from '../core/vision.js';
import { Guard, GUARD_MODES } from '../core/guard.js';
import { WALKER } from '../core/sim.js';
import { roomById } from '../core/level.js';
import { loadArena, buildCore, placementSummary } from './boot.js';
import { Avatar } from './avatar.js';
import { GlintField, PrizeField, GuardActor, makePlayerShadow } from './scene.js';
import { Minimap } from './minimap.js';
import { Hud, formatClock } from './hud.js';
import { Audio } from './audio.js';
import {
  DIFFICULTIES, DEFAULT_DIFFICULTY, PRIZE_COUNT,
  MOVE, VIEW, LOOP, FEEL, CONE_HZ,
  fanArea, guardCfgFor, collectibleFor, prizeAreaOf, noticeRangeOf, difficultySpec,
} from './config.js';

// WHICH FLOOR AM I PLAYING? The shipped apartment, unless the page was opened
// with ?arena=... . scripts/procgen.mjs writes a generated layout and a
// generated arena snapshot (--out-layout / --arena), and a parameterised
// generator you cannot walk around is a table, not a tool. Nothing else about
// the boot changes: with no query string this resolves to exactly the constant
// it replaced, and scripts/verify_play.mjs (70 checks, no query string) is what
// proves that.
//
// Resolved inside `start()`, not at module scope, for one reason: a branch
// below can THROW, and an error thrown while this module is being imported
// escapes the loader entirely -- play.html's `start().catch(...)` never runs and
// the loading screen hangs instead of saying what is wrong. Putting the
// resolution where that catch can see it costs nothing and fails out loud.
const SESSION_ARENA_PREFIX = 'session:';
// Where in sessionStorage the snapshot lives, namespaced so a value left by
// some other page on this origin cannot be mistaken for an arena.
const SESSION_STORE_PREFIX = 'an-inch-of-red:';

function resolveArenaURL() {
  let q = null;
  try {
    q = new URLSearchParams(location.search).get('arena');
  } catch {
    // No `location`: play.js's dependencies are imported headlessly too, and a
    // module that cannot be imported outside a browser is a worse module.
    return './game/arenas/room_scene.json';
  }
  if (!q) return './game/arenas/room_scene.json';
  if (q.indexOf(SESSION_ARENA_PREFIX) !== 0) return q;

  // `?arena=session:<key>` -- the snapshot is waiting in sessionStorage, put
  // there by procgen.html. That page generates a floor in the browser, and a
  // browser cannot write a file, so it cannot hand over a path the way
  // scripts/procgen.mjs does with --arena. A Blob URL made by the PREVIOUS page
  // is dead by the time this one runs; made HERE, in the document that fetches
  // it, it is exactly as good as a file on disk.
  const key = SESSION_STORE_PREFIX + q.slice(SESSION_ARENA_PREFIX.length);
  const text = sessionStorage.getItem(key);
  if (!text) {
    // Deliberately an error, and deliberately NOT a fall back to the shipped
    // apartment. A quiet fallback is the precise failure `verify_gen_play.mjs`
    // was written to catch: a page that boots, renders, places its six 红包 and
    // reports a healthy nav -- describing a DIFFERENT floor than the one asked
    // for, with every light green.
    throw new Error('?arena=' + q + ': sessionStorage has nothing under "' + key
      + '". Only a page that generates a floor can fill it:'
      + ' open procgen.html and press 走进去玩.');
  }
  return URL.createObjectURL(new Blob([text], { type: 'application/json' }));
}

/**
 * The layout the loaded arena was BUILT FROM: walls, doors, rooms, furniture.
 *
 * `game/arena/fromLayout.js` puts a copy of it in every level it produces, so a
 * snapshot is self-describing -- it carries the geometry it is about instead of
 * a file path to it. That is the only shape that works for a floor generated in
 * a browser, which has no file to point at.
 *
 * Missing or disagreeing, and this THROWS. There is deliberately no fall back
 * to `js/layout.js`: that fallback is precisely the bug this was written for --
 * a page that boots, renders, places its 红包 and reports a healthy nav while
 * describing a different flat. `scripts/verify_world.mjs` holds it to that.
 */
function requireLayout(level) {
  const L = level && level.layout;
  const where = (level && level.meta && level.meta.id) || 'arena';
  if (!L || !L.PLAN || !Array.isArray(L.ROOMS)) {
    throw new Error(`arena "${where}" carries no \`layout\`: nothing says what to build.`
      + ' A snapshot written before this became part of the level needs regenerating --'
      + ' scripts/procgen.mjs --arena for a generated floor, scripts/snapshot_arena.mjs'
      + ' for the shipped apartment, or scripts/embed_layout.mjs to re-stamp an old file'
      + ' whose layout has not moved.');
  }
  const p = level.meta.plan;
  if (L.PLAN.w !== p.w || L.PLAN.d !== p.d) {
    // The cheap half of "what you see is what you play", enforced at the one
    // place every front end must pass through.
    throw new Error(`arena "${where}": its layout is ${L.PLAN.w}x${L.PLAN.d} m but its plan is`
      + ` ${p.w}x${p.d} m -- the floor you would SEE is not the floor you would PLAY.`);
  }
  return {
    WALL_H: L.WALL_H, PLAN: L.PLAN,
    ZONES: L.ZONES || [], WALLS: L.WALLS || [], CORNERS: L.CORNERS || [],
    DOORS: L.DOORS || [], ROOMS: L.ROOMS || [],
  };
}

/**
 * Yield to the browser so a progress bar can actually paint.
 *
 * Races rAF against a short timer on purpose: in headless Chrome a frame that
 * is never presented (no screenshot requested, tab backgrounded) can leave the
 * callback pending, and `await frame()` would then hang the boot forever. A
 * loading screen that can deadlock is worse than a loading screen that stutters.
 */
const frame = () => new Promise((resolve) => {
  let done = false;
  const fin = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(fin);
  setTimeout(fin, 60);
});

/**
 * The seed the MENU opens on: the day, so the first screen is the same
 * screen for everyone on the same day.
 *
 * It is deliberately NOT the seed a run uses. Six fixed hiding places are six
 * places to memorise, and a find-the-object game whose answer you already
 * know is a walk. What the 每日种子 was protecting -- "two players can compare
 * runs" -- is protected instead by PRINTING the seed on the end screen and
 * accepting it back in the menu, so any run can still be reproduced exactly.
 */
function todaySeed() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * A fresh seed for one run.
 *
 * Random, but RECORDED, which is the whole trick: every draw in `game/core/`
 * comes from a named stream off this label (`new Rng(seed).fork('place')`),
 * so a random label still yields a fully deterministic, replayable layout
 * once you know it. Randomness enters exactly once, here, at the start of a
 * run -- `stepSim` still reads no clock and no RNG, so the simulation stays
 * as testable as it was and the headless matrix still describes this game.
 *
 * The date prefix is not decoration: it is what makes a seed read off a
 * week-old screenshot obviously stale rather than mysteriously wrong.
 */
function randomSeed() {
  const d = new Date();
  const day = `${d.getFullYear()}`
    + `${String(d.getMonth() + 1).padStart(2, '0')}`
    + `${String(d.getDate()).padStart(2, '0')}`;
  let r = Math.floor(Math.random() * 0xffffffff);
  if (window.crypto && window.crypto.getRandomValues) {
    const a = new Uint32Array(1);
    window.crypto.getRandomValues(a);
    r = a[0];
  }
  return `${day}-${r.toString(36).padStart(7, '0').slice(-7)}`;
}

/* ---------------------------------------------------------------- state */

const S = {
  phase: 'loading',      // loading | ready | playing | paused | won | lost
  elapsed: 0,            // game seconds; guard penalties are added here
  collected: 0,
  catches: 0,
  penalties: 0,
  confirmations: 0,      // red things walked up to that were NOT 红包
  t: 0,                  // animation clock, accumulated from dt (never Date.now)
};

let hud;
let audio;
let renderer;
let camera;
let scene;
let kit;
let apartment;

let level;
let core;
let nav;
let guardNav;
let patrol;
let prizes = [];
let preset = null;
let seed = '2026-09-25';
/**
 * Whether that seed came from a PERSON. `false` = draw a new one per run;
 * `true` = keep using `seed`, which is what the menu's seed box,
 * `configure({seed})` and the headless harness all want.
 *
 * One flag for one question, so "why did the layout change?" has a single
 * answer, and it is readable from `info().seedPolicy`.
 */
let seedPinned = false;
// The seed the core IN MEMORY was built for. `seed` alone cannot answer "is the
// layout on screen the one this seed names", and conflating the two made a
// pinned replay show a different seed's 红包 -- see `beginRun`.
let coreSeed = null;
let prizeCount = PRIZE_COUNT;
let markersOn = true;

let avatar;
let guard = null;
/** The 红包 AS THIS RUN'S DIFFICULTY SIZES IT. Set in `resetRun`. */
let runCollectible = null;
let guardActor = null;
let minimap = null;
let prizeField;
let glints;
let playerShadow;

const collectedSet = new Set();
const clearedReds = new Set();
let redCentreY = new Map();
let prizeY = new Map();

let lastCensus = { reds: [], prizes: [] };
let clearedList = [];
let censusAcc = 1e9;
let coneAcc = 1e9;
let tickSecond = -1;
let hintFaded = false;
let freeCam = null;

const keys = new Set();
const scripted = { fwd: 0, side: 0, turn: 0, jump: 0 };
let look = { dx: 0, dy: 0 };

const stats = { frames: 0, fps: 0, stepMs: 0, censusMs: 0, coneMs: 0 };

/* ------------------------------------------------------------------ boot */

export async function start() {
  hud = new Hud();
  audio = new Audio();

  /* --- WHICH FLOOR AM I PLAYING? answered before anything is built ------ */
  //
  // The arena used to be loaded LAST, after the apartment was already standing.
  // That order was invisible while there was only one arena, and it is the
  // whole bug: the snapshot chose the rooms, the 红包 and the nav, while
  // `buildApartment` -- which had never heard of an arena -- built the shipped
  // flat regardless. A page could play a generated 16 x 14 m ten-room floor
  // inside the 10 x 8 m six-room apartment, and every harness in this repo
  // reported green while it did.
  //
  // So it is loaded FIRST: the plan sizes the ground and the shadow camera,
  // the layout decides which models to download and what geometry to build,
  // and none of that can be known until the arena has been read.
  hud.loading('正在读取竞技场…', 0.02);
  await frame();
  level = await loadArena(resolveArenaURL());
  const plan = level.meta.plan;
  const floorLayout = requireLayout(level);

  const canvas = document.getElementById('stage');
  renderer = createRenderer(canvas);

  scene = new THREE.Scene();
  createEnvironment(renderer, scene);
  createLights(scene, { w: plan.w, d: plan.d });
  // The site plane is what the wall shadows land on, so it has to be bigger
  // than the flat -- whichever flat this is.
  createGround(scene, Math.max(46, Math.max(plan.w, plan.d) * 2.5));

  camera = new THREE.PerspectiveCamera(VIEW.fov, 1, VIEW.near, VIEW.far);
  camera.rotation.order = 'YXZ';
  scene.add(camera);

  /* --- furniture: this floor's layout, through the viewer's own builder -- */
  //
  // The preload closure comes from the LAYOUT, not from `js/layout.js`. A
  // generated flat asks for 11 models the shipped apartment never mentions
  // (bedSingle, bench, tableGlass, ...) and `kit.instance()` throws on a model
  // that was never loaded -- so a shipped-only preload fails loudly here
  // rather than silently, but it still fails.
  kit = new Kit({ base: 'assets/models' });
  const names = requiredModels(floorLayout);
  hud.loading('正在装载家具模型…', 0.05);
  for (let i = 0; i < names.length; i++) {
    await kit.load(names[i]);
    hud.loading(`正在装载家具模型… ${names[i]}`, 0.05 + (i + 1) / names.length * 0.80);
    if (i % 8 === 0) await frame();       // let the loading bar actually paint
  }
  hud.loading('正在拼装房间…', 0.88);
  await frame();
  apartment = await buildApartment(kit, { layout: floorLayout });
  scene.add(apartment.root);

  seed = todaySeed();
  preset = DIFFICULTIES.find((d) => d.id === DEFAULT_DIFFICULTY) || DIFFICULTIES[0];

  hud.loading('正在建导航网格…', 0.94);
  await frame();
  await rebuildCore();

  /* --- visuals that mirror the core ------------------------------------ */
  prizeField = new PrizeField(scene, level.collectible);
  glints = new GlintField(scene, 28);
  playerShadow = makePlayerShadow(scene);
  guardActor = new GuardActor(scene, level.body, GUARD_MODES.patrol);
  guardActor.hide();
  prizeField.rebuild(prizes, collectibleFor(preset, level.collectible));

  /* --- the thumbnail: a plan of the rooms plus two headings -------------- */
  minimap = new Minimap(document.getElementById('minimap'), level);
  minimap.draw({});

  avatar = new Avatar(level, nav, level.spawn);

  /* --- input ----------------------------------------------------------- */
  bindInput(canvas);

  hud.loading('就绪', 1);
  resize();
  window.addEventListener('resize', resize);
  hud.bindStart({
    onSeed: (v) => { reseed(v); },
    onOptions: (o) => { if (o.markers != null) { markersOn = o.markers; if (!markersOn) glints.hideAll(); } },
  });
  hud.bindPause({
    onResume: () => togglePause(),
    onRestart: () => { hud.hidePause(); beginRun(preset.id); },
    onMenu: () => { hud.hidePause(); S.phase = 'ready'; openMenu(); },
  });
  hud.hideLoading();
  openMenu();
  S.phase = 'ready';

  requestAnimationFrame(loop);

  window.__play = api;
  window.__ready = true;
  return api;
}

async function rebuildCore() {
  core = buildCore(level, {
    seed, count: prizeCount,
    onStage: (s) => hud.loading(s, 0.96),
  });
  coreSeed = seed;
  nav = core.nav;
  guardNav = core.guardNav;
  patrol = core.patrol;
  prizes = core.prizes;
  if (avatar) avatar.nav = nav;              // the avatar holds a nav reference
  redCentreY = new Map();
  for (const s of level.solids) {
    if (!s.red) continue;
    redCentreY.set(`${s.id}#red`, s.y0 + (s.red.min[1] + s.red.max[1]) / 2);
  }
  prizeY = new Map(prizes.map((p) => [p.id, p.y]));
  return core;
}

/**
 * Re-draw the layout and re-mesh the 红包.
 *
 * An EMPTY seed is not a request for a seed called "seed" -- it is the player
 * saying "surprise me", which is the default. So empty clears the pin and
 * draws a fresh one; anything else is taken literally and pinned.
 */
async function reseed(v) {
  const s = (v || '').trim();
  if (s) { seed = s; seedPinned = true; } else { seed = randomSeed(); seedPinned = false; }
  hud.loading('重新藏红包…', 0.9);
  await frame();
  await rebuildCore();
  prizeField.rebuild(prizes, collectibleFor(preset || DIFFICULTIES[0], level.collectible));
  hud.setSummary(placementSummary(level, core));
  if (hud.el.seed) hud.el.seed.value = seed;
  hud.loading('就绪', 1);
  hud.hideLoading();
}

/* ----------------------------------------------------------------- menu */

function openMenu() {
  hud.showStart({
    // `spec` is derived HERE, from the same helpers the run itself uses, so a
    // card cannot advertise a cone or a packet size the game does not use.
    difficulties: DIFFICULTIES.map((d) => ({
      ...d, spec: difficultySpec(d, GUARD_MODES, level.collectible),
    })),
    defaultId: DEFAULT_DIFFICULTY,
    seed,
    seedPinned,
    summary: placementSummary(level, core),
    onStart: (id) => beginRun(id),
  });
}

/* ------------------------------------------------------------------ run */

async function beginRun(id) {
  const p = DIFFICULTIES.find((d) => d.id === id) || DIFFICULTIES[0];
  preset = p;
  audio.unlock();
  hud.hideStart();
  hud.hideEnd();
  hud.hidePause();
  // A FRESH LAYOUT EVERY RUN, unless someone pinned a seed. This is the only
  // place randomness is allowed in, and it costs the ~0.85 s core rebuild
  // that the loading bar is already on screen for. A pinned seed skips the
  // rebuild entirely, so re-playing a known seed is instant AND identical.
  // A PINNED SEED MAY ONLY SKIP THE REBUILD IF THE CORE IN MEMORY IS ALREADY
  // THAT SEED. Skipping it unconditionally made `begin(id, { seed })` -- the
  // documented way to replay a known layout -- pin the new seed and then keep
  // the OLD core, so the run showed 红包 drawn for a different seed while the
  // menu printed the one you asked for. Measured on a generated 16x14 flat:
  // begin({seed:'genA'}) produced six 红包 that a fresh build for 'genA' does
  // not produce, agreeing on one coordinate of six (scripts/_probe_gen_prizes.mjs).
  // "Instant AND identical" only holds while the seed has not moved.
  if (seedPinned && coreSeed === seed) {
    hud.loading(`正在藏红包… ${seed}`, 0.7);
    await frame();
  } else {
    if (!seedPinned) seed = randomSeed();
    hud.loading(`正在藏红包… ${seed}`, 0.7);
    await frame();
    await rebuildCore();
    hud.setSummary(placementSummary(level, core));
    hud.loading('就绪', 1);
    await frame();
  }
  resetRun();
  hud.hideLoading();
  S.phase = 'playing';
  hud.banner(`${p.name} · ${formatClock(p.budget)}${p.guard ? ' · 有守卫' : ''}`, 1600);
  const c = document.getElementById('stage');
  if (c.requestPointerLock) {
    try { const r = c.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch { /* headless */ }
  }
}

function resetRun() {
  // The 红包 the core gates on and the 红包 on screen are built from the SAME
  // `collectibleFor(preset, ...)`. Two derivations of "how big is the target"
  // is exactly how a marker ends up promising a sighting the mesh cannot
  // deliver -- or refusing one it could.
  runCollectible = collectibleFor(preset, level.collectible);
  prizeField.rebuild(prizes, runCollectible);
  collectedSet.clear();
  clearedReds.clear();
  avatar.reset(level.spawn);
  S.elapsed = 0; S.collected = 0; S.catches = 0; S.penalties = 0; S.confirmations = 0;
  tickSecond = -1;
  hintFaded = false;
  const hintEl = document.getElementById('hint');
  if (hintEl) hintEl.classList.remove('fade');
  censusAcc = 1e9; coneAcc = 1e9;
  lastCensus = { reds: [], prizes: [] };
  clearedList = [];
  glints.hideAll();

  if (preset.guard) {
    // The preset's OWN cone and range, not the base mode's. `guardCfgFor`
    // returns a copy, so a widened preset can never mutate the shared
    // GUARD_MODES entry and quietly re-grade the measured base preset.
    guard = new Guard(level, guardNav, guardCfgFor(preset, GUARD_MODES), patrol);
    guardActor.show();
  } else {
    guard = null;
    guardActor.hide();
  }
  hud.objective(0, prizes.length);
  hud.grade('none');
  hudUpdates(0);
}

function finish(win) {
  if (S.phase !== 'playing') return;
  S.phase = win ? 'won' : 'lost';
  if (document.pointerLockElement) document.exitPointerLock();
  hud.showEnd({
    win,
    collected: S.collected,
    total: prizes.length,
    used: Math.min(S.elapsed, preset.budget),
    budget: preset.budget,
    catches: S.catches,
    penalties: S.penalties,
    seed,
    presetName: preset.name,
    timeouts: !win,
    onAgain: () => beginRun(preset.id),
    onMenu: () => { hud.hideEnd(); S.phase = 'ready'; openMenu(); },
  });
  hud.grade(win ? 'win' : 'lose');
  if (win) audio.win(); else audio.lose();
}

/* ----------------------------------------------------------------- step */

/**
 * One simulation step. Pure: `dt` in, state out. No clock, no RNG, no DOM read.
 */
function stepSim(dt) {
  if (S.phase !== 'playing') return;
  const t0 = performance.now();
  S.t += dt;
  S.elapsed += dt;

  const k = (a, b) => ((keys.has(a) || (b && keys.has(b))) ? 1 : 0);
  // Steering is the MOUSE and only the mouse. Q/E -- and the left/right arrows,
  // which did the same job -- are deliberately unmapped: two ways to turn means
  // the mouse is never actually in charge of where you walk. `scripted.turn`
  // survives untouched because the headless harness steers with it.
  const input = {
    fwd: k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown') + scripted.fwd,
    side: k('KeyD') - k('KeyA') + scripted.side,
    turn: scripted.turn,
    jump: k('Space') + scripted.jump,
    look,
  };
  look = { dx: 0, dy: 0 };
  avatar.update(dt, input);

  censusAcc += dt;
  if (censusAcc >= 1 / LOOP.censusHz) { censusAcc = 0; refreshCensus(); }

  checkPickup();

  if (guard) {
    for (const ev of guard.update(dt, avatar.pos())) onGuardEvent(ev);
  }

  const remaining = preset.budget - S.elapsed;
  if (remaining <= 0) { finish(false); return; }
  if (S.collected >= prizes.length) { finish(true); return; }
  if (remaining <= 10) {
    const s = Math.ceil(remaining);
    if (s !== tickSecond) { tickSecond = s; audio.tick(); }
  }
  hudUpdates(dt);
  stats.stepMs = performance.now() - t0;
}

/**
 * The red census, refreshed ~12 Hz.
 *
 * The output is split three ways and the split is the ONLY place the renderer
 * learns anything the player should not:
 *
 *   reds        noticed red patches (carpets, pillows, chair cushions...)
 *   prizes      noticed 红包
 *   clearedList noticed red patches the player has already walked up to
 *
 * `reds` and `prizes` are drawn IDENTICALLY -- same sprite, same opacity rule,
 * same size falloff -- so the marker can only ever say "there is something red
 * over there". Giving the prize a brighter dot would make the design's central
 * claim true by rendering instead of by play, which is the exact mistake
 * `verify_game` had to fix once already on the AI side.
 *
 * (Yes, a player with devtools can read `prizes`. That is not the honesty this
 * cares about: the affordance must not cheat, the game itself must know where
 * its own objects are.)
 */
function refreshCensus() {
  const t0 = performance.now();
  const eye = avatar.eye();
  const pool = [];
  // `y` TRAVELS WITH THE PACKET. The census tests a sloped line to the thing's
  // OWN height (vision.js `redCensus`), so a packet on a 0.45 m counter is
  // correctly invisible from a 0.36 m eye and visible from a body standing on
  // the counter. Omitting `y` here would make the test flat again and quietly
  // undo the whole climbing change at the one call site a player actually sees.
  for (const p of prizes) if (!collectedSet.has(p.id)) pool.push({ id: p.id, x: p.x, z: p.z, y: p.y });

  const c = redCensus(level, { x: eye.x, z: eye.z }, {
    // STANDING eye, not the arc: `groundY` is the surface the body is on and
    // ignores the hop, so climbing onto the counter to spot a packet on it
    // works while a mid-air hop still cannot hand you a marker. The camera
    // keeps using the real, bobbed, airborne eye -- that is the view.
    eyeY: avatar.groundY + level.body.eyeHeight,
    range: WALKER.sightRange,
    prizes: pool,
    // The gate that decides how far away a 红包 counts as NOTICEABLE is the
    // same area the mesh is built at, so a preset that shrinks the packet
    // shrinks the glint's reach with it. Hard-coding the arena's size here
    // would leave the marker announcing a packet from a range the packet
    // itself could not be seen at -- the difficulty menu lying about the
    // game it is a menu for.
    prizeArea: prizeAreaOf(runCollectible || level.collectible),
  });
  lastCensus = c;

  const reds = [];
  clearedList = [];
  for (const r of c.reds) {
    const e = { ...r, y: redCentreY.has(r.id) ? redCentreY.get(r.id) : 0.05 };
    if (markersOn && clearedReds.has(r.id)) clearedList.push(e);
    else reds.push(e);
  }
  const pr = c.prizes.map((p) => ({ ...p, y: (prizeY.get(p.id) || 0) + 0.02 }));

  glints.update({ reds, prizes: markersOn ? pr : [], clearedList: markersOn ? clearedList : [] });
  stats.censusMs = performance.now() - t0;
}

/**
 * Walk over a 红包 to take it; walk over decoration to learn it is decoration.
 *
 * Both use the SAME reach, and that reach is the arena's own `pickup` (0.42 m)
 * and the sim's `WALKER.lift` (0.55 m). Those two numbers were checked before
 * being trusted: `scripts/diag_pickup.mjs` measures the distance from every
 * placed 红包 to the nearest standable cell over 8 seeds, and the worst case is
 * 0.351 m (the fridge, an `inside` anchor). Had that come out above 0.42 the
 * design's "a 红包 nobody can grab is a bug, not a challenge" line would have
 * been a bug -- see `work/_pickup.log`.
 */
function checkPickup() {
  const reach = level.collectible.pickup;
  const lift = WALKER.lift;

  for (const p of prizes) {
    if (collectedSet.has(p.id)) continue;
    if (Math.hypot(p.x - avatar.x, p.z - avatar.z) > reach) continue;
    // Measured from the FEET. It used to be `groundY`, which was the same
    // number while the jump was cosmetic -- and is now the difference between
    // "reach the packet on the table" and "reach nothing". A packet on a
    // surface is taken by standing on that surface (or on something as tall),
    // and `lift` is still the single arm's-reach constant.
    if (p.y - avatar.feetY > lift) continue;
    collect(p);
  }

  const near = reach + 0.28;
  for (const r of lastCensus.reds) {
    if (clearedReds.has(r.id)) continue;
    if (Math.hypot(r.x - avatar.x, r.z - avatar.z) > near) continue;
    clearedReds.add(r.id);
    S.confirmations += 1;
    audio.dismiss();
  }
}

function collect(p) {
  collectedSet.add(p.id);
  prizeField.take(p.id);
  S.collected += 1;
  audio.pickup(S.collected);
  hud.objective(S.collected, prizes.length);
  hud.toast(`+1 红包 · ${roomName(p.room)}`, 'good');
  refreshCensus();
}

function onGuardEvent(ev) {
  if (ev.type === 'caught') {
    S.catches += 1;
    S.penalties += ev.penalty;
    // Exactly the sim's rule: being caught costs TIME, not position.
    S.elapsed += ev.penalty;
    avatar.stun = MOVE.stunAfterCatch;
    hud.flash('caught');
    audio.caught();
    hud.toast(`被发现！罚时 +${ev.penalty}s`, 'bad');
  } else if (ev.type === 'spot') {
    hud.flash('spot');
  } else if (ev.type === 'lost') {
    hud.toast('甩掉了', 'ok');
  }
}

function hudUpdates() {
  const remaining = preset.budget - S.elapsed;
  hud.clock(remaining, preset.budget, remaining <= FEEL.lowTime);
  hud.room(roomName(avatar.room));
  if (!hintFaded && S.elapsed > FEEL.hintFadeAfter) {
    hintFaded = true;
    const h = document.getElementById('hint');
    if (h) h.classList.add('fade');
  }
  if (guard) {
    hud.guard({
      enabled: true, mode: guard.mode, suspicion: guard.suspicion,
      hint: guard.mode === 'chase' ? '被追了 —— 绕开它，等它跟丢。'
        : guard.mode === 'alert' ? '它察觉到你了：离开视线，警觉会回落。'
          : '它在巡逻。别站进它前面的扇区。',
    });
  } else {
    hud.guard({ enabled: false, mode: 'off', suspicion: 0, hint: '没有守卫。把六个房间走熟。' });
  }
  hud.grade(guard && guard.mode === 'chase' ? 'chase' : (remaining <= FEEL.lowTime ? 'low' : 'none'));
}

function roomName(id) {
  const r = id ? roomById(level, id) : null;
  return r ? r.name : '—';
}

/* ---------------------------------------------------------------- render */

function render() {
  if (guard && guardActor) {
    const doCone = coneAcc >= 1 / CONE_HZ;
    if (doCone) coneAcc = 0;
    const t0 = performance.now();
    guardActor.update(level, guard, doCone, S.t);
    if (doCone) stats.coneMs = performance.now() - t0;
  }

  if (!freeCam) {
    const eye = avatar.eye();
    camera.position.set(eye.x, eye.y, eye.z);
    camera.rotation.set(avatar.pitch, avatar.yaw, 0);
  } else {
    camera.position.set(freeCam.x, freeCam.y, freeCam.z);
    camera.lookAt(freeCam.tx, freeCam.ty, freeCam.tz);
  }
  playerShadow.position.set(avatar.x, avatar.feetY + 0.006, avatar.z);
  playerShadow.material.opacity = freeCam ? 0 : 0.42;

  if (minimap && avatar) {
    // Both headings are the CORE's own bearings, for the same reason the world
    // guard is placed from `guard.facing`: a second derivation of "which way am
    // I pointing" is a second thing that can disagree.
    minimap.draw({
      player: { x: avatar.x, z: avatar.z, facing: avatar.facing() },
      guard: guard
        ? { x: guard.pos.x, z: guard.pos.z, facing: guard.facing, mode: guard.mode }
        : null,
    });
  }

  renderer.render(scene, camera);
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

let last = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = last ? Math.min(LOOP.maxDt, (now - last) / 1000) : 0;
  last = now;
  if (S.phase === 'playing') stepSim(dt);
  else { S.t += dt; coneAcc += dt; }
  render();
  stats.frames += 1;
  if (stats.frames % 30 === 0 && dt > 0) stats.fps = Math.round(1 / dt);
}

/* ----------------------------------------------------------------- input */

function bindInput(canvas) {
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === 'Escape') { togglePause(); return; }
    if (e.code === 'KeyM') { audio.setMuted(!audio.muted); hud.toast(audio.muted ? '静音' : '开声', 'info'); }
    if (e.code === 'KeyG') {
      markersOn = !markersOn;
      if (!markersOn) glints.hideAll();
      if (hud.el.markers) hud.el.markers.checked = markersOn;
      hud.toast(markersOn ? '红点提示：开' : '红点提示：关（硬核）', 'info');
    }
    if (e.code === 'KeyP' && S.phase === 'playing') togglePause();
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  canvas.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    look.dx += e.movementX || 0;
    look.dy += e.movementY || 0;
  });
  canvas.addEventListener('click', () => {
    if (S.phase === 'playing') {
      if (canvas.requestPointerLock) {
        try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch { /* */ }
      }
      audio.unlock();
    }
  });
  // Losing the pointer lock is the conventional pause gesture. Guarded so a
  // headless run (which never acquires the lock) is never paused by it.
  document.addEventListener('pointerlockchange', () => {
    if (S.phase === 'playing' && !document.pointerLockElement && hadLock) togglePause();
    if (document.pointerLockElement) hadLock = true;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && S.phase === 'playing') togglePause();
  });
}
let hadLock = false;

export function togglePause() {
  if (S.phase === 'playing') {
    S.phase = 'paused';
    hud.showPause();
    if (document.pointerLockElement) document.exitPointerLock();
  } else if (S.phase === 'paused') {
    S.phase = 'playing';
    hud.hidePause();
  }
  return S.phase;
}

/* ------------------------------------------------------------------- api */

function info() {
  return {
    phase: S.phase,
    seed,
    preset: preset ? preset.id : null,
    budget: preset ? preset.budget : null,
    guardMode: preset ? preset.guard : null,
    elapsed: Math.round(S.elapsed * 1000) / 1000,
    remaining: preset ? Math.round((preset.budget - S.elapsed) * 1000) / 1000 : null,
    collected: S.collected,
    total: prizes.length,
    catches: S.catches,
    penalties: S.penalties,
    confirmations: S.confirmations,
    cleared: clearedReds.size,
    player: avatar ? avatar.state() : null,
    guard: guard ? guard.state() : null,
    census: { reds: lastCensus.reds.length, prizes: lastCensus.prizes.length },
    markersOn,
    seedPolicy: seedPinned ? 'pinned' : 'random',
    difficulty: difficultyReadout(),
    stats: { ...stats },
  };
}

/**
 * Everything the difficulty card claims, read back off the objects the run
 * actually built. If a card said 19.2 m2 and this said 11.4, the verifier
 * would find out before the player did.
 */
function difficultyReadout() {
  const p = preset || DIFFICULTIES[0];
  const cfg = guardCfgFor(p, GUARD_MODES);
  const c = runCollectible || collectibleFor(p, level.collectible);
  const area = prizeAreaOf(c);
  return {
    id: p.id, name: p.name, budget: p.budget, guard: p.guard,
    surveil: p.surveil, prizeScale: p.prizeScale,
    coneDeg: cfg ? cfg.coneDeg : null,
    range: cfg ? cfg.range : null,
    fanArea: cfg ? fanArea(cfg.coneDeg, cfg.range) : 0,
    prizeSize: c.size.slice(),
    prizeArea: area,
    noticeRange: noticeRangeOf(area),
    pickup: level.collectible.pickup,
    packetIsArenaSize: c === level.collectible,
  };
}

const api = {
  THREE, scene: null, camera: null, renderer: null,
  presets: DIFFICULTIES,
  get phase() { return S.phase; },
  get level() { return level; },
  /** The built apartment, for harnesses that need to measure the WORLD rather
   *  than the level: "is the floor you are standing on the one you are
   *  playing" is a question only the scene graph can answer. */
  get apartment() { return apartment; },
  get nav() { return nav; },
  get guardNav() { return guardNav; },
  get patrol() { return patrol; },
  get prizes() { return prizes; },
  get guard() { return guard; },
  get avatar() { return avatar; },
  get prizeField() { return prizeField; },
  get glints() { return glints; },
  get minimap() { return minimap; },
  get seed() { return seed; },
  summary: () => placementSummary(level, core),

  /** Recompute the placement for a new seed / count without restarting. */
  async configure({ seed: s, count, markers, pin } = {}) {
    // An explicit seed PINS. `configure({seed})` is how both the menu's seed
    // box and the headless harness say "this exact layout, please"; `pin:
    // false` is how they say "never mind, go random again".
    if (s) { seed = s; seedPinned = true; }
    if (pin === false) seedPinned = false;
    if (count) prizeCount = count;
    if (markers != null) { markersOn = markers; if (!markersOn) glints.hideAll(); }
    S.phase = 'loading';
    await rebuildCore();
    prizeField.rebuild(prizes, collectibleFor(preset || DIFFICULTIES[0], level.collectible));
    if (!preset) preset = DIFFICULTIES[0];
    resetRun();
    S.phase = 'ready';
    return info();
  },

  /**
   * @param opts.seed    pin this seed first; the run is then reproducible
   * @param opts.random  clear any pin, so this begin draws a fresh layout
   */
  async begin(presetId, opts = {}) {
    if (opts.seed) { seed = opts.seed; seedPinned = true; }
    if (opts.random) seedPinned = false;
    await beginRun(presetId || (preset && preset.id) || DEFAULT_DIFFICULTY);
    return info();
  },

  /** Pin (or clear, with a falsy value) the seed every later `begin` uses. */
  pinSeed(v) {
    seedPinned = !!v;
    if (v) seed = v;
    return { seed, seedPinned, policy: seedPinned ? 'pinned' : 'random' };
  },

  pause() { return togglePause(); },

  /** Advance the simulation deterministically. No rendering, no wall clock. */
  step(dt = 1 / 60, n = 1) {
    for (let i = 0; i < n; i++) { if (S.phase !== 'playing') break; stepSim(dt); }
    return info();
  },

  input(o) { Object.assign(scripted, o); return { ...scripted }; },
  release() { scripted.fwd = 0; scripted.side = 0; scripted.turn = 0; scripted.jump = 0; return { ...scripted }; },

  /** Push a pointer-lock-style look delta. The harness's way to steer, now
   *  that the mouse is the only steering the player has. */
  look(dx, dy) { look.dx += dx || 0; look.dy += dy || 0; return { ...look }; },

  lookAt(x, z, y) { return avatar.lookAt(x, z, y); },
  teleport(x, z, facing) { return avatar.teleport(x, z, facing); },

  census() {
    return {
      reds: lastCensus.reds, prizes: lastCensus.prizes, clearedList,
      cleared: [...clearedReds],
      eyeY: lastCensus.eyeY,
    };
  },

  /**
   * The invariant the whole collision story rests on.
   *
   * AT THE BODY'S OWN HEIGHT. It used to ask `nav.clear(x, z, r)`, which is the
   * same question only while the feet are on the floor -- and since the jump
   * can now land on the counter, "is this cell walkable at floor level" is
   * false for a body that is standing perfectly legally 0.45 m up. Passing
   * `feetY` is what the mover itself tests (`avatar.js`), so this is the same
   * rule the movement obeys rather than a second opinion about it. With the
   * feet at 0 the two calls are bit-identical (measured, 12,000 pairs).
   */
  navInvariant() {
    return {
      clear: nav.clear(avatar.x, avatar.z, avatar.radius, avatar.feetY),
      radius: avatar.radius,
      x: avatar.x, z: avatar.z,
    };
  },

  /**
   * Put the start card back on screen, at phase 'ready'.
   *
   * The harness needs this: `shot('00-menu')` in verify_play used to fire after
   * eight sections of gameplay and photographed whatever the last check left
   * behind, so the file named after the menu did not contain one.
   */
  menu() { S.phase = 'ready'; openMenu(); return info(); },

  freeCam(o) { freeCam = o || null; return freeCam; },
  renderOnce() { render(); return true; },
  info,

  snapshot() {
    return {
      prizes: prizes.map((p) => ({ id: p.id, room: p.room, tier: p.tier, x: p.x, z: p.z, y: p.y, cover: p.cover })),
      nav: { walkable: nav.walkableCount, w: nav.w, d: nav.d, cell: nav.cell, regions: nav.components.length },
      patrol: { waypoints: patrol.waypoints.length, dropped: patrol.dropped.length },
      ms: core.ms,
    };
  },
};

Object.defineProperty(api, 'scene', { get: () => scene });
Object.defineProperty(api, 'camera', { get: () => camera });
Object.defineProperty(api, 'renderer', { get: () => renderer });
