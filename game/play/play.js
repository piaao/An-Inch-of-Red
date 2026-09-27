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
import { redCensus, sightLine } from '../core/vision.js';
import { Guard, GUARD_MODES } from '../core/guard.js';
import { WALKER } from '../core/sim.js';
import { roomById } from '../core/level.js';
import { loadArena, buildCore, placementSummary, MAX_GUARDS } from './boot.js';
import { Avatar } from './avatar.js';
import { GlintField, PrizeField, GuardActor, makePlayerShadow } from './scene.js';
import { loadHostCast, HostBody } from './actors.js';
import { Minimap } from './minimap.js';
import { TouchLayer } from './touch.js';
import { Hud, formatClock } from './hud.js';
import { Audio } from './audio.js';
import { Music } from './music.js';
import { Props } from './props.js';
import {
  DIFFICULTIES, DEFAULT_DIFFICULTY, PRIZE_COUNT,
  MOVE, VIEW, LOOP, FEEL, CONE_HZ, MUSIC,
  fanArea, guardCfgFor, collectibleFor, prizeAreaOf, noticeRangeOf, difficultySpec,
  guardCountFor, prizeCountFor, HOSTS,
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

/* --------------------------------------------------------------- roster */

/**
 * The map rail's source of truth, and it is the ARTIFACT.
 *
 * `game/maps/manifest.json` is written by scripts/build_maps.mjs out of the
 * MEASURED numbers, and `scripts/verify_maps.mjs` checks it against the roster
 * source. The page must not re-derive room and item counts from the layout
 * modules: that would be a second measurement of facts that already have one,
 * and the menu would then be free to disagree with the gate.
 */
const MAP_MANIFEST_URL = './game/maps/manifest.json';

async function loadManifest() {
  try {
    const res = await fetch(MAP_MANIFEST_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    const m = await res.json();
    return Array.isArray(m && m.maps) ? m : null;
  } catch (err) {
    // A menu with no map rail is a smaller loss than a page that will not boot,
    // and `?arena=` -- the workbench's path -- has no roster to show anyway.
    console.warn('map manifest unavailable, no map rail:', err && err.message);
    return null;
  }
}

/**
 * Picking a map is a RELOAD, and the URL is what carries the choice.
 *
 * `start()` builds the scene graph once, out of the floor plan: the ground
 * plane, the lights, the model set it downloads, the apartment mesh. Swapping
 * the level under a live scene would mean tearing down and rebuilding every one
 * of them -- i.e. writing `start()` a second time, which is the exact mistake
 * the arena work was about (a generated 16x14 floor used to be played inside
 * the shipped 10x8 apartment and every harness stayed green).
 *
 * So the choice round-trips through the query string:
 *
 *   ?map=<id>          which floor (default: the manifest's defaultMap)
 *   ?difficulty=<id>   which card is pre-selected
 *   ?seed=<s>          a pinned seed, so a reload is the same layout
 *   ?markers=0         the red-dot checkbox, carried too
 *   ?play=1            start the run as soon as the floor is built
 */
function bootQuery() {
  return new URLSearchParams(location.search);
}

function runURL(mapId, presetId) {
  const q = bootQuery();
  q.delete('arena');                    // a roster map is not the workbench's
  q.set('map', mapId);
  q.set('difficulty', presetId);
  if (seedPinned && seed) q.set('seed', seed); else q.delete('seed');
  if (markersOn) q.delete('markers'); else q.set('markers', '0');
  q.set('play', '1');
  return `${location.pathname}?${q.toString()}`;
}

/**
 * `?map=<id>` -- the map rail's floor, resolved THROUGH THE ROSTER.
 *
 * Not by building a path out of the id. An id the roster does not have must not
 * become a fetch for a file that does not exist, and it must not quietly become
 * the shipped apartment either: a page that boots, renders, places its 红包 and
 * reports a healthy nav while describing a DIFFERENT floor than the one asked
 * for is the exact failure `verify_gen_play.mjs` was written to catch. So this
 * throws, and says which ids exist.
 *
 * `?arena=` is the map rail's opposite -- a direct pointer, used by
 * procgen.html to hand over a floor generated in the browser, and by
 * `scripts/*.mjs --arena` to point at a file. It carries no roster id, so it
 * cannot go through here.
 */
function arenaPathForMap(id) {
  const maps = (roster && roster.maps) || null;
  if (!maps) {
    throw new Error('?map=' + id + ': the map manifest could not be read, so nothing'
      + ' says which arena "' + id + '" names. Booting the shipped apartment instead'
      + ' would show you a different floor than the one you asked for.');
  }
  const m = maps.find((x) => x.id === id);
  if (!m) {
    throw new Error('?map=' + id + ': not on the roster ('
      + maps.map((x) => x.id).join(', ') + '). An id the roster does not have is not a'
      + ' floor, and booting a different one is worse than refusing.');
  }
  return m.arena;
}

function resolveArenaURL() {
  let q = null;
  let wantMap = null;
  try {
    const search = new URLSearchParams(location.search);
    q = search.get('arena');
    wantMap = search.get('map');
  } catch {
    // No `location`: play.js's dependencies are imported headlessly too, and a
    // module that cannot be imported outside a browser is a worse module.
    return './game/arenas/room_scene.json';
  }
  // `?map=` IS CHECKED FIRST. `runURL` deletes `?arena=` when the player picks a
  // roster floor, so the two should never be present together -- but if a stale
  // `?arena=` did survive, honouring it would ignore the card the player just
  // pressed, and the page would look exactly like a working one.
  if (wantMap) return arenaPathForMap(wantMap);
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
let music;
let props;              // 可互动道具（开门 / 推柜）—— 见 game/play/props.js
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
/** One patrol per possible sentry; index 0 is the shipped one. */
let patrols = [];
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
/** The roster artifact, or null when it could not be read (see loadManifest). */
let roster = null;
// The seed the core IN MEMORY was built for. `seed` alone cannot answer "is the
// layout on screen the one this seed names", and conflating the two made a
// pinned replay show a different seed's 红包 -- see `beginRun`.
let coreSeed = null;
let prizeCount = PRIZE_COUNT;
let markersOn = true;

let avatar;
/**
 * THE GARRISON. A preset may run more than one sentry, so this is a LIST --
 * and `guard` stays as an alias for the first one, because `info().guard`
 * and the minimap's single-guard call were both written against it. A
 * second guard is an ADDITION, not a rename.
 */
let guards = [];
let guard = null;
/**
 * A TEST HOOK, and only a test hook: `begin(id, {guards: 0})` runs a preset
 * with its garrison stood down. The collision walk in `verify_play` holds
 * one direction for sixty seconds, and a sentry arresting it halfway would
 * turn "did the body stay out of the walls" into a question about the
 * guard's patrol. Cleared on every `begin`, so it cannot leak into a run
 * that did not ask for it.
 */
let guardOverride = null;
/** The 红包 AS THIS RUN'S DIFFICULTY SIZES IT. Set in `resetRun`. */
let runCollectible = null;
let guardActors = [];
let guardActor = null;
/**
 * 男女主人的素材：`{ source, cast }`。`source` 只有两个值，而且是给测试看的 ——
 * 'files' 表示真的加载到了骨骼角色，'none' 表示这一局用的是程序化机器人。
 * `scripts/verify_actors.mjs` 直接断言这一个字段，而不是去看屏幕上像不像人。
 */
let hostCast = { source: 'none', cast: new Map() };
/** 第 i 个守卫是谁。两个人，按顺序出场：先男主人，再女主人。 */
const HOST_ORDER = ['male', 'female'];
let minimap = null;
let prizeField;
let glints;
let playerShadow;
/**
 * 触屏层（P0）。桌面浏览器上它 `supported === false`，于是 `move()/jump()`
 * 恒返回 0 和 false —— `stepSim` 组装出的 input 与加它之前**逐位相同**。
 * 这一条不是推理，是 `scripts/verify_touch.mjs` 用同种子 600 步的状态哈希钉的。
 */
let touch = null;

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
  music = new Music();

  // The soundtrack is OPTIONAL, and loading it must never be able to fail the
  // boot: no manifest, and this resolves to `false` and the mixer stays off.
  // Deliberately NOT awaited before the loading bar can show progress -- it is
  // one small JSON, but a game that waits on music before it draws its flat has
  // its priorities upside down. Kicked off here, its result read whenever it
  // lands.
  music.load().catch(() => {});

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
  // WITH NO ?arena=, THE QUERY STRING PICKS THE FLOOR. Resolved from the
  // manifest rather than from a name built out of the id, so an id the roster
  // does not have cannot become a fetch for a file that does not exist.
  roster = await loadManifest();
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

  // ---- 可互动道具 --------------------------------------------------------
  // `apartment.heroes` 是建造时从每屋家具里**单独拆出来**的主角道具（见
  // `js/build.js` 的 HERO_MODELS）。合并掉的家具只留下一坨几何体，没有东西
  // 可以开、可以推；这一批是没被合并的那些。
  //
  // 互动**只改渲染，不改物理**——所以它不动 VERDICT 里的任何胜率。理由与
  // 代价写在 `game/play/props.js` 的文件头。
  props = new Props(scene, apartment.heroes, {
    reach: 1.25,       // 略大于红包的 0.42 手臂长度：开门比捡红包够得远一点
    swingDeg: 84,
    slideM: 0.20,
    lidDeg: 56,
  });

  // The query string first, so a reload can carry the player's choice across:
  // choosing another map IS a page load, and dropping the difficulty, the seed
  // or the intent to start on the way would make the rail unusable.
  const boot = bootQuery();
  seed = boot.get('seed') || todaySeed();
  seedPinned = !!boot.get('seed');
  if (boot.get('markers') === '0') markersOn = false;
  preset = DIFFICULTIES.find((d) => d.id === boot.get('difficulty'))
    || DIFFICULTIES.find((d) => d.id === DEFAULT_DIFFICULTY)
    || DIFFICULTIES[0];

  hud.loading('正在建导航网格…', 0.94);
  await frame();
  await rebuildCore();

  /* --- visuals that mirror the core ------------------------------------ */
  prizeField = new PrizeField(scene, level.collectible);
  glints = new GlintField(scene, 28);
  playerShadow = makePlayerShadow(scene);
  // One actor per POSSIBLE sentry, built once: switching difficulty must not
  // cost a scene-graph rebuild, and hiding an actor is free.
  guardActors = [];
  for (let i = 0; i < MAX_GUARDS; i++) {
    const a = new GuardActor(scene, level.body, GUARD_MODES.patrol);
    a.hide();
    guardActors.push(a);
  }
  guardActor = guardActors[0];
  // THE BODIES GO ON BEFORE THE RUN CAN START, and the failure path is not an
  // exception: if the cast will not load, every actor keeps the procedural
  // robot it was built with and the game is bit-for-bit the game it was.
  await loadHosts();
  prizeField.rebuild(prizes, collectibleFor(preset, level.collectible));

  /* --- the thumbnail: a plan of the rooms plus two headings -------------- */
  minimap = new Minimap(document.getElementById('minimap'), level);
  minimap.draw({});

  avatar = new Avatar(level, nav, level.spawn);

  /* --- input ----------------------------------------------------------- */
  bindInput(canvas);
  // 触屏是**第三个输入源**，不是第三个物理：它只往 `{fwd, side, jump, look}`
  // 里加数，那几个字段原本就由键盘和鼠标在写。所以它在 `bindInput` 之后、
  // 在没有任何仿真状态的时候接上，并且除了 `look` 累加器（那是鼠标的去处）
  // 之外不认识这个文件里的任何东西。
  touch = new TouchLayer();
  touch.bind({
    // 视角直接进鼠标那一个累加器。**没有第二条换算链**：`stepSim` 读的
    // `look` 和指针锁定写的是同一个对象，所以灵敏度还是 `MOVE.mouseSens`。
    onLook: (dx, dy) => { look.dx += dx; look.dy += dy; },
    onUse: () => { if (S.phase === 'playing') interact(); },
    onPause: () => { if (S.phase === 'playing') togglePause(); },
    // iOS 只允许在用户手势里建 AudioContext。点屏幕就是那个手势。
    onUnlock: () => { unlockAudio(); },
  });

  hud.loading('就绪', 1);
  resize();
  window.addEventListener('resize', resize);
  hud.bindStart({
    onSeed: (v) => { reseed(v); },
    onOptions: (o) => { if (o.markers != null) { markersOn = o.markers; if (!markersOn) glints.hideAll(); } },
  });
  // ...and the box has to SHOW what the boot was told. `?markers=0` travels
  // with a map change, and a checkbox that reads "on" while the game behaves
  // as if it were off is the kind of small lie this file otherwise avoids.
  if (hud.el.markers) hud.el.markers.checked = markersOn;
  hud.bindPause({
    onResume: () => togglePause(),
    onRestart: () => { hud.hidePause(); beginRun(preset.id); },
    onMenu: () => { hud.hidePause(); S.phase = 'ready'; openMenu(); },
  });
  hud.hideLoading();
  if (boot.get('play')) {
    // `?play=1` is how the map rail's reload finishes: the player already chose
    // the floor and the difficulty on the previous page, so asking again would
    // be a menu that ignores the button that opened it.
    //
    // ...and it is CONSUMED, because a handoff is not a state. Left in the URL,
    // pressing reload would start a run nobody asked for, and the only way back
    // to the menu would be a key the player has to already know. What is kept is
    // the map, the difficulty and the seed, so a reload lands on the menu with
    // the same choices showing.
    boot.delete('play');
    const rest = boot.toString();
    history.replaceState(null, '', rest ? `${location.pathname}?${rest}` : location.pathname);
    await beginRun(preset.id);
  } else {
    S.phase = 'ready';
    openMenu();
  }

  requestAnimationFrame(loop);

  window.__play = api;
  window.__ready = true;
  return api;
}

/**
 * 请主人就位。**失败不是异常，是一条降级路径。**
 *
 * 三段链和配乐（`music.js`）是同一条规矩：有素材就用真身体，没有就让程序化
 * 机器人继续走。所以这个函数永远不抛 —— 它只会把 `hostCast.source` 置成
 * 'none'，而 `verify_actors.mjs` 正是拿这一个字段来回答"到底换上了没有"。
 *
 * 素材名单只认 `data/actors.json`（零 404）：manifest 不在，一个 GLB 请求都
 * 不会发出去。
 */
async function loadHosts() {
  if (!HOSTS.enabled) {
    hostCast = { source: 'none', cast: new Map(), why: 'HOSTS.enabled = false' };
    return;
  }
  hud.loading('正在请主人就位…', 0.95);
  await frame();
  hostCast = await loadHostCast({ url: HOSTS.manifest });
  if (hostCast.source !== 'files') {
    console.warn('[hosts] 退回程序化身体：', hostCast.why || '');
    return;
  }
  const ids = [...hostCast.cast.keys()];
  let attached = 0;
  for (let i = 0; i < guardActors.length; i++) {
    // 先按名册发（男主人 -> 女主人），名册上只剩一个就两个人共用一副身体 ——
    // 少一个人，也比退回两个机器人更像话。
    const pick = hostCast.cast.get(HOST_ORDER[i % HOST_ORDER.length])
      || hostCast.cast.get(ids[i % ids.length]);
    if (!pick) continue;
    const clips = Object.create(null);
    for (const [state, name] of Object.entries(HOSTS.clips)) {
      clips[state] = pick.clips.get(name);
    }
    guardActors[i].setBody(new HostBody(
      pick.def, pick.gltf, level.body, clips, { envIntensity: kit.envIntensity }));
    attached += 1;
  }
  hostCast = { ...hostCast, attached };
  if (!attached) {
    hostCast = { ...hostCast, source: 'none', why: 'no actor could be given a body' };
  }
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
  patrols = core.patrols || [core.patrol];
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
  // WHICH FLOOR IS STANDING, asked of the level rather than of a variable: a
  // generated arena has an id the roster does not know, and then NO map card is
  // marked -- which is the truth, and better than marking the wrong one.
  const here = (level.meta && level.meta.id) || null;
  const maps = (roster && roster.maps) || [];
  const current = maps.some((m) => m.id === here) ? here : null;

  hud.showStart({
    // `spec` is derived HERE, from the same helpers the run itself uses, so a
    // card cannot advertise a cone or a packet size the game does not use.
    difficulties: DIFFICULTIES.map((d) => ({
      ...d, spec: difficultySpec(d, GUARD_MODES, level.collectible),
    })),
    defaultId: (preset && preset.id) || DEFAULT_DIFFICULTY,
    seed,
    seedPinned,
    summary: placementSummary(level, core),
    maps,
    currentMap: current,
    onStart: (id, mapId) => {
      if (mapId && mapId !== here) {
        // A different floor: the choice goes in the URL and the page reloads
        // into it. See `runURL`.
        window.location.href = runURL(mapId, id);
        return;
      }
      beginRun(id);
    },
  });
}

/* ------------------------------------------------------------------ run */

async function beginRun(id) {
  const p = DIFFICULTIES.find((d) => d.id === id) || DIFFICULTIES[0];
  preset = p;
  unlockAudio();
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
  // A PINNED SEED MAY ONLY SKIP THE REBUILD IF THE CORE IS ALREADY THAT SEED
  // **AND ALREADY HOLDS THIS PRESET'S PACKET COUNT**. The count became a
  // per-preset dial, so "same seed" is no longer enough: switching 标准 -> 硬核
  // at a pinned seed would otherwise keep six packets while the card promised
  // twenty-four.
  const wantPrizes = prizeCountFor(p);
  if (seedPinned && coreSeed === seed && prizeCount === wantPrizes) {
    hud.loading(`正在藏红包… ${seed}`, 0.7);
    await frame();
  } else {
    if (!seedPinned) seed = randomSeed();
    prizeCount = wantPrizes;
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
  hud.banner(`${p.name} · ${formatClock(p.budget)} · ${hostLabel(guardCountFor(p))} · ${prizeCountFor(p)} 红包`, 1600);
  // 有手指的设备不锁指针：指针锁定在手机上没有任何意义，而它换来的
  // 是拖拽被系统接管、页面被拽走。玩家仍然可以点画面手动锁（桌面上的
  // 触屏笔记本），那条路留着。
  const c = document.getElementById('stage');
  if (c.requestPointerLock && !(touch && touch.supported)) {
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
  initFog();
  // Every prop back to shut. A door the LAST run left open is a lie about this
  // run's flat -- and since props are built once and reused across runs (a
  // rebuild would mean reloading the kit), resetting them is what makes
  // "one apartment per page load, many runs" honest.
  if (props) props.reset();

  guards = [];
  const nGuards = guardOverride != null ? guardOverride : guardCountFor(preset);
  const gCfg = guardCfgFor(preset, GUARD_MODES);
  for (let i = 0; i < MAX_GUARDS; i++) {
    if (i < nGuards && gCfg && patrols[i]) {
      // The preset's OWN cone and range, not the base mode's. `guardCfgFor`
      // returns a copy, so a widened preset can never mutate the shared
      // GUARD_MODES entry and quietly re-grade the measured base preset.
      guards.push(new Guard(level, guardNav, gCfg, patrols[i]));
      guardActors[i].show();
    } else {
      guardActors[i].hide();
    }
  }
  guard = guards[0] || null;
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
  // The sting is the last word, and it owns the foreground: the beds duck for
  // `MUSIC.stingDuckS` so the four-note synth cue and the six-second orchestral
  // one are heard as ONE event rather than as two things happening at once.
  music.sting(win ? 'win' : 'lose');
}

/* ----------------------------------------------------------------- step */

/**
 * 四个输入源 -> 一个 input。**这是唯一一处定义**。
 *
 * 键盘（`keys`）、无头夹具（`scripted`）、指针锁定与触屏（都写进 `look`），
 * 三个来源在这里合成 `{fwd, side, turn, jump, look}`。验收要断言"摇杆推满
 * 和按住 W 是同一个数"时，`__play.inputNow()` 调的就是这个函数 —— 而不是在
 * 验收里再抄一遍加法。抄一遍就是第二份实现，两份一定会漂。
 *
 * 触屏那两个加数**在没摸屏幕时是 0**：`move()` 返回常驻的 `{fwd:0, side:0}`，
 * `jump()` 返回 0。所以桌面那条路径连浮点都没多算一次，同种子 600 步的状态
 * 与加触屏之前逐位相同（`scripts/verify_touch.mjs` §3）。
 */
function assembleInput() {
  const k = (a, b) => ((keys.has(a) || (b && keys.has(b))) ? 1 : 0);
  const tm = touch ? touch.move() : null;
  return {
    fwd: k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown') + scripted.fwd + (tm ? tm.fwd : 0),
    side: k('KeyD') - k('KeyA') + scripted.side + (tm ? tm.side : 0),
    turn: scripted.turn,
    jump: k('Space') + scripted.jump + (touch ? touch.jump() : 0),
    look,
  };
}

/**
 * One simulation step. Pure: `dt` in, state out. No clock, no RNG, no DOM read.
 */
function stepSim(dt) {
  if (S.phase !== 'playing') return;
  const t0 = performance.now();
  S.t += dt;
  S.elapsed += dt;

  // Steering is the MOUSE and only the mouse. Q/E -- and the left/right arrows,
  // which did the same job -- are deliberately unmapped: two ways to turn means
  // the mouse is never actually in charge of where you walk. `scripted.turn`
  // survives untouched because the headless harness steers with it.
  const input = assembleInput();
  look = { dx: 0, dy: 0 };
  avatar.update(dt, input);

  censusAcc += dt;
  if (censusAcc >= 1 / LOOP.censusHz) { censusAcc = 0; refreshCensus(); }

  checkPickup();
  updateFog();

  const gp = avatar.pos();
  for (let i = 0; i < guards.length; i++) {
    for (const ev of guards[i].update(dt, gp)) onGuardEvent(ev, i);
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

/* --------------------------------------------------------------- fog of war */

/**
 * WHAT THE PLAYER HAS SEEN, on a 1 m lattice.
 *
 * Not a renderer concern and not a sim rule: it is a RECORD of the run, the
 * same way `collectedSet` is. The cell is 1 m because the thumbnail is 26 px
 * per metre -- a 5 cm cell would be a sub-pixel grid, and fog is read at a
 * glance or not at all. The map is a PLAN, not a radar, and this is the half
 * that makes finding your way a thing you earn by walking.
 */
let fog = null;
let fogAt = { x: 1e9, z: 1e9 };

const FOG_CELL = 1;        // m
const FOG_RANGE = 3.2;     // m -- how far a standing eye opens the map

function initFog() {
  const cols = Math.max(1, Math.ceil(level.meta.plan.w / FOG_CELL));
  const rows = Math.max(1, Math.ceil(level.meta.plan.d / FOG_CELL));
  fog = { cols, rows, cell: FOG_CELL, x0: 0, z0: 0, seen: new Uint8Array(cols * rows) };
  fogAt = { x: 1e9, z: 1e9 };
}

/**
 * Reveal what a standing eye can see.
 *
 * Gated on MOVEMENT (0.3 m) rather than on the frame: the test walks
 * `level.solids` once per candidate cell, and nothing about the answer changes
 * while you stand still. `sightLine` is the CORE's own ray -- the same one the
 * guard's cone and the red census use -- so "explored" means "visible from
 * somewhere you have stood", not "within a radius". Walls close the map again,
 * which is the entire point: a radius would hand you the bathroom through the
 * bedroom wall.
 */
function updateFog() {
  if (!fog || !avatar) return;
  const dx = avatar.x - fogAt.x;
  const dz = avatar.z - fogAt.z;
  if (dx * dx + dz * dz < 0.09) return;      // 0.3 m
  fogAt = { x: avatar.x, z: avatar.z };

  const eyeY = avatar.groundY + level.body.eyeHeight;
  const here = { x: avatar.x, z: avatar.z };
  const i0 = Math.max(0, Math.floor((avatar.x - FOG_RANGE) / FOG_CELL));
  const i1 = Math.min(fog.cols - 1, Math.floor((avatar.x + FOG_RANGE) / FOG_CELL));
  const j0 = Math.max(0, Math.floor((avatar.z - FOG_RANGE) / FOG_CELL));
  const j1 = Math.min(fog.rows - 1, Math.floor((avatar.z + FOG_RANGE) / FOG_CELL));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (fog.seen[j * fog.cols + i]) continue;
      const cx = fog.x0 + (i + 0.5) * FOG_CELL;
      const cz = fog.z0 + (j + 0.5) * FOG_CELL;
      if (Math.hypot(cx - avatar.x, cz - avatar.z) > FOG_RANGE) continue;
      if (sightLine(level, here, { x: cx, z: cz }, eyeY, 0.05).clear) {
        fog.seen[j * fog.cols + i] = 1;
      }
    }
  }
}

function onGuardEvent(ev, who) {
  // The body hears the event TOO, and it is the only thing that listens for a
  // purely visual reason: `spot` makes the host flinch, `caught` makes it throw
  // the punch. Nothing here writes back into the sim.
  if (guardActors[who]) guardActors[who].onEvent(ev);
  if (ev.type === 'caught') {
    S.catches += 1;
    S.penalties += ev.penalty;
    // Exactly the sim's rule: being caught costs TIME, not position.
    S.elapsed += ev.penalty;
    avatar.stun = MOVE.stunAfterCatch;
    hud.flash('caught');
    audio.caught();
    music.sting('caught');
    hud.toast(`被发现！罚时 +${ev.penalty}s`, 'bad');
  } else if (ev.type === 'spot') {
    hud.flash('spot');
  } else if (ev.type === 'lost') {
    hud.toast('甩掉了', 'ok');
  }
}

/**
 * How alarming a guard is right now. The HUD has ONE guard line, so it has to
 * pick: a chaser beats an alert, which beats a patrol, and suspicion breaks
 * ties inside a mode. Picking by index would name whoever happens to be first
 * in the list, which is a fact about array order rather than about danger.
 */
const DANGER_RANK = { patrol: 0, alert: 1, chase: 2 };
function dangerRank(g) {
  return (DANGER_RANK[g.mode] || 0) * 10 + (g.suspicion || 0);
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
  const hot = guards.length
    ? guards.reduce((a, b) => (dangerRank(b) > dangerRank(a) ? b : a))
    : null;
  if (hot) {
    const many = guards.length > 1 ? `${guards.length} 位主人` : '主人';
    hud.guard({
      enabled: true, mode: hot.mode, suspicion: hot.suspicion,
      hint: hot.mode === 'chase' ? `${many}在追你 —— 绕开、等它跟丢。`
        : hot.mode === 'alert' ? `${many}里有一个察觉到你了：离开视线，警觉会回落。`
          : `${many}在屋里走动。别站进视锥的黄区。`,
    });
  } else {
    hud.guard({ enabled: false, mode: 'off', suspicion: 0,
      hint: '主人不在家。把六个房间走熟。' });
  }
  hud.grade(hot && hot.mode === 'chase' ? 'chase' : (remaining <= FEEL.lowTime ? 'low' : 'none'));
}

/** 「守卫」在这一局里是**主人** —— 我们才是翻进去的那一个。 */
function hostLabel(n) {
  return n <= 0 ? '空屋' : `${n} 位主人`;
}

function roomName(id) {
  const r = id ? roomById(level, id) : null;
  return r ? r.name : '—';
}

/* ---------------------------------------------------------------- render */

/**
 * Put the camera on the avatar's eyes. The ONE place that poses it, shared by
 * `render()` and by the harness's `aimAt()` -- so "where the camera is" cannot
 * drift between the draw path and the interaction path.
 */
function poseCamera() {
  const eye = avatar.eye();
  camera.position.set(eye.x, eye.y, eye.z);
  camera.rotation.set(avatar.pitch, avatar.yaw, 0);
}

function render() {
  // 触屏层的"现在该不该在屏幕上"，**与 `GuardActor.update()` 同一个位置、
  // 同一个理由**：相位一变就有人管它，而不用在 `beginRun` / `togglePause` /
  // `finish` / `openMenu` / `resetRun` 五处各记得写一句。相位是**问**出来的
  // （`() => S.phase`），不是记住的。
  if (touch) touch.frame(S.phase);

  if (guards.length) {
    const doCone = coneAcc >= 1 / CONE_HZ;
    if (doCone) coneAcc = 0;
    const t0 = performance.now();
    for (let i = 0; i < guards.length; i++) {
      if (guardActors[i]) guardActors[i].update(level, guards[i], doCone, S.t);
    }
    if (doCone) stats.coneMs = performance.now() - t0;
  }

  if (!freeCam) {
    poseCamera();
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
      guards: guards.map((g) => ({
        x: g.pos.x, z: g.pos.z, facing: g.facing, mode: g.mode,
      })),
      fog,
    });
  }

  renderer.render(scene, camera);
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

let last = 0;
/**
 * 男女主人的一帧：状态机 + 骨架动画。**与 `propsTick` 同一个位置、同一个理由。**
 *
 * 它不画东西，所以 `__play.tick()`（不渲染）也能推进它 —— 否则"状态机永远停在
 * 待机"就会变成一句关于正常代码的错误结论。
 */
function hostsTick(dt) {
  if (!guards.length) return 0;
  const p = avatar ? avatar.pos() : null;
  for (let i = 0; i < guards.length; i++) {
    if (guardActors[i]) guardActors[i].animTick(dt, guards[i], p);
  }
  return guards.length;
}

function loop(now) {
  requestAnimationFrame(loop);
  const dt = last ? Math.min(LOOP.maxDt, (now - last) / 1000) : 0;
  last = now;
  if (S.phase === 'playing') stepSim(dt);
  else { S.t += dt; coneAcc += dt; }
  musicTick(dt);
  propsTick(dt);
  hostsTick(dt);
  render();
  stats.frames += 1;
  if (stats.frames % 30 === 0 && dt > 0) stats.fps = Math.round(1 / dt);
}

/**
 * The one place music learns anything about the run.
 *
 * It runs EVERY frame, in every phase, not just while playing -- because the
 * menu bed, the pause duck and the "which phase am I in now" question all live
 * outside `stepSim`. Keeping the decision here rather than sprinkling
 * `setBed('menu')` into `openMenu`, `setBed('explore')` into `beginRun` and so
 * on means the answer to "why is this song playing?" is a single function that
 * reads the same `S.phase` the HUD does.
 *
 * Both signals are READ, never fed back: `danger` is the guard's own position
 * and mode, `low` is the same clock the HUD shows. Music cannot change the sim,
 * which is why a soundtrack may be tuned by ear without invalidating a single
 * measured win rate.
 */
function musicTick(dt) {
  if (!music || !music.enabled) return;
  // Read the REAL guard off the sim, not off `guardActor` (which the harness
  // can drive independently) -- the music must describe the game, not the prop.
  let danger = false;
  if (guard && (S.phase === 'playing' || S.phase === 'paused') && avatar) {
    const g = guard.state();
    const d = Math.hypot(g.pos.x - avatar.x, g.pos.z - avatar.z);
    danger = d < MUSIC.dangerM || g.mode !== 'patrol';
  }
  const remaining = preset ? preset.budget - S.elapsed : Infinity;
  music.update(dt, {
    phase: S.phase,
    danger,
    // `FEEL.lowTime`, not a `MUSIC.lowSeconds` that never existed: the config
    // header promises the sprint cue lands on the same frame the clock turns
    // red, and the two ends of that promise are `hud.clock(..., FEEL.lowTime)`
    // just above and this line. `MUSIC.lowSeconds` was reading `undefined`,
    // so the comparison was always false and the `lastcall` bed could never
    // play -- a silent bug, because "the music never got tense" is exactly
    // what a missing cue sounds like.
    low: S.phase === 'playing' && remaining <= FEEL.lowTime,
  });
}

/* ---------------------------------------------------------------- props */

/**
 * 每帧：更新准星指向的道具，并把当前焦点报给 HUD。
 *
 * 射线只在**游玩中**发射，而且只对着 `props.heroes`（几十个对象，不是上千个
 * 网格）——每帧一次 `intersectObjects` 在这个规模上便宜得可以忽略，但暂停、
 * 菜单、结算时仍然是零成本。
 *
 * **它不改 sim。** 互动（`interact()`）改的是道具自己的 transform，`level.solids`
 * 一动不动，所以 `stepSim` 与它的确定性契约完全不受影响。
 */
function propsTick(dt) {
  if (!props) return;
  // 读数只是为了显示，这一步在逻辑上属于渲染；不管什么 phase 都推进动画，
  // 否则中途暂停会让门停在半开的位置。
  props.update(dt);
  if (S.phase !== 'playing' || !avatar || !camera) { hud.propPrompt(null); return; }
  const eye = avatar.eye();
  // 相机朝向：`camera` 每帧由 avatar 的 yaw/pitch 摆放，getWorldDirection 拿到的
  // 就是屏幕正中的那条线，和准星是同一件事。
  const dir = camera.getWorldDirection(PROP_RAY_DIR);
  const hit = props.pick(eye, dir);
  const p = hit && hit.userData.prop;
  hud.propPrompt(p ? {
    model: p.model,
    kind: p.kind,
    open: p.open > 0.5,
  } : null);
}

/** E 键：对当前准星所指的道具做一次互动，并给一句反馈。 */
function interact() {
  if (!props) return null;
  const r = props.activate();
  if (!r) return null;
  // 一点声音反馈，让"开了"不止是视觉上的。复用现成的合成音效，不加素材。
  audio.dismiss();
  const verb = r.kind === 'slide' ? (r.open ? '拉开' : '推回')
    : (r.open ? '打开' : '关上');
  hud.toast(`${verb} · ${propsLabel(r.model)}`, 'info');
  return r;
}

/** 模型名 -> 玩家看得懂的词。没有映射的就退回原名（而不是猜）。 */
function propsLabel(model) {
  const m = String(model).toLowerCase();
  if (m.startsWith('doorway')) return '门';
  if (m.includes('drawer')) return '抽屉';
  if (m.includes('bookcase')) return '书柜';
  if (m.includes('cabinet')) return '柜子';
  if (m.includes('box')) return '箱子';
  if (m.includes('fridge')) return '冰箱';
  if (m.includes('washers') || m.includes('washer')) return '洗衣机';
  if (m.includes('dryer')) return '烘干机';
  if (m.includes('trashcan')) return '垃圾桶';
  if (m.includes('coatrack')) return '衣帽架';
  if (m.includes('sideTable')) return '边桌';
  return model;
}

// 一个复用的向量，避免每帧 new（`propsTick` 每帧都跑）。
const PROP_RAY_DIR = new THREE.Vector3();

/* ----------------------------------------------------------------- input */

function bindInput(canvas) {
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === 'Escape') { togglePause(); return; }
    if (e.code === 'KeyM') {
      // One switch for the whole house. Two mute keys would be a trap: the
      // player would silence the effects, keep the music, and conclude the
      // music was broken.
      const v = !audio.muted;
      audio.setMuted(v);
      music.setMuted(v);
      hud.toast(v ? '静音' : '开声', 'info');
    }
    if (e.code === 'KeyG') {
      markersOn = !markersOn;
      if (!markersOn) glints.hideAll();
      if (hud.el.markers) hud.el.markers.checked = markersOn;
      hud.toast(markersOn ? '红点提示：开' : '红点提示：关（硬核）', 'info');
    }
    if (e.code === 'KeyP' && S.phase === 'playing') togglePause();
    // E is the interact key: open the door / slide the drawer / shift the prop
    // the crosshair is on. It reads `props.focus`, which `propsTick` refreshed
    // this frame from a ray out of the eye -- so "what E acts on" and "what the
    // prompt says you will act on" are the same variable, not two guesses.
    if (e.code === 'KeyE' && S.phase === 'playing') interact();
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
      unlockAudio();
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

/**
 * 开声。**唯一的解锁入口**，所有需要音频的路径都走它。
 *
 * 两件事必须一起做，而且顺序不能反：先让 `audio.js` 建出那个全局唯一的
 * AudioContext（浏览器只允许在用户手势里建），再把同一个 ctx 交给 `music`
 * 的程序化引擎。少了后半句，没有 mp3 时游戏就是哑的——而这正是当前状态
 * （game/MUSIC.md §8：音乐模型未开通）。
 *
 * 幂等：重复调用只是把已挂起的 ctx resume 一下。
 */
export function unlockAudio() {
  audio.unlock();
  if (audio.ctx) {
    // `audio.musicBus` (unity) rather than `audio.master` (0.35, SFX
    // headroom). Sharing the SFX attenuation put the whole bed at an RMS near
    // 1e-3 -- see `audio.js` unlock(). The master gain is still downstream, so
    // M still mutes both; `master` is the fallback for a caller that built an
    // AudioContext before `musicBus` existed.
    music.attach(audio.ctx, audio.musicBus || audio.master);
  }
  return !!audio.ctx;
}

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
    guards: guards.map((g) => g.state()),
    guardOverride,
    fogSeen: fog ? fog.seen.reduce((a, v) => a + v, 0) : 0,
    census: { reds: lastCensus.reds.length, prizes: lastCensus.prizes.length },
    markersOn,
    seedPolicy: seedPinned ? 'pinned' : 'random',
    difficulty: difficultyReadout(),
    music: music ? music.state() : null,
    props: props ? props.state() : null,
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
  get guards() { return guards; },
  get fog() { return fog; },
  get avatar() { return avatar; },
  get prizeField() { return prizeField; },
  get glints() { return glints; },
  get minimap() { return minimap; },
  get props() { return props; },
  /** 男女主人：谁站在场上、正在演哪个状态。`source:'files'` 才算真的换上了骨骼。 */
  get hosts() {
    return {
      source: hostCast.source,
      why: hostCast.why || null,
      cast: [...hostCast.cast.keys()],
      actors: guardActors.slice(0, guards.length).map((a) => a.report()),
    };
  },
  /** The audio graph, for harnesses that need to MEASURE the soundtrack.
   *  "Which cue is playing" is `music.state()`; "is any sound coming out" can
   *  only be answered by tapping `audio.musicBus` with an analyser. */
  get audio() { return audio; },
  get music() { return music; },
  /** Start the AudioContext from a harness (the start button does this for a
   *  player). Without a real gesture the browser leaves it suspended. */
  unlockAudio: () => unlockAudio(),
  get seed() { return seed; },
  summary: () => placementSummary(level, core),

  /**
   * Interact with whatever the crosshair is on, exactly as the E key does.
   * Returns the prop's { model, kind, open } or null. Exposed so a harness can
   * drive the same path a player's keypress drives -- not a parallel one.
   */
  interact: () => interact(),

  /** Point the crosshair at a world spot and refresh `props.focus` this frame. */
  aimAt(x, y, z) {
    if (!avatar) return null;
    avatar.lookAt(x, z, y);
    poseCamera();
    propsTick(0);
    return props ? props.state().focus : null;
  },

  /** Recompute the placement for a new seed / count without restarting. */
  async configure({ seed: s, count, markers, pin, guards: nG } = {}) {
    // An explicit seed PINS. `configure({seed})` is how both the menu's seed
    // box and the headless harness say "this exact layout, please"; `pin:
    // false` is how they say "never mind, go random again".
    if (s) { seed = s; seedPinned = true; }
    if (pin === false) seedPinned = false;
    if (count) prizeCount = count;
    if (typeof nG === 'number') guardOverride = nG;
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
   * @param opts.guards  override the preset's garrison (0 = none). A test
   *                     hook; every `begin` resets it, so it cannot stick.
   */
  async begin(presetId, opts = {}) {
    if (opts.seed) { seed = opts.seed; seedPinned = true; }
    if (opts.random) seedPinned = false;
    guardOverride = (typeof opts.guards === 'number') ? opts.guards : null;
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

  /**
   * Advance ONE WHOLE FRAME, the way `loop()` does -- sim, music, props, no
   * draw. `step()` deliberately stops at the sim, and that is right for the
   * collision and patrol assertions (they want the sim and nothing else). But
   * anything that animates OUTSIDE `stepSim` -- the prop open/close tween is
   * the only one -- would never advance under `step()`, which made a test read
   * "the door never moved" about a door that was working.
   *
   * Deterministic: fixed dt, no rAF, no wall clock. `render()` is skipped
   * because drawing is not what these assertions are about; call `renderOnce()`
   * to force a frame.
   */
  tick(dt = 1 / 60, n = 1) {
    for (let i = 0; i < n; i++) {
      if (S.phase === 'playing') stepSim(dt);
      else { S.t += dt; coneAcc += dt; }
      musicTick(dt);
      propsTick(dt);
      hostsTick(dt);
    }
    return info();
  },

  /**
   * Advance only the prop tweens, leaving the sim frozen at `dt = 0`.
   *
   * For a harness that wants to watch a door swing WITHOUT also walking the
   * guard around (which can end the run mid-measurement). Reads the same
   * `propsTick` the frame loop does, so it is not a parallel path -- it is the
   * same code with the clock held still.
   */
  animProps(dt = 1 / 60, n = 1) {
    for (let i = 0; i < n; i++) propsTick(dt);
    return info();
  },

  /**
   * Advance ONLY the hosts' animation, leaving the simulation frozen.
   *
   * The twin of `animProps`, for the same reason: driving the state machine by
   * walking the guard around would ALSO walk it in and out of your view, and a
   * test that wants "which clip is playing while it chases" must not have to
   * accept a different chase every time. Returns each actor's `report()`.
   */
  animHosts(dt = 1 / 60, n = 1) {
    for (let i = 0; i < n; i++) hostsTick(dt);
    return guardActors.slice(0, guards.length).map((a) => a.report());
  },

  input(o) { Object.assign(scripted, o); return { ...scripted }; },
  release() { scripted.fwd = 0; scripted.side = 0; scripted.turn = 0; scripted.jump = 0; return { ...scripted }; },

  /**
   * 触屏层的读数。**这是给验收看的量具**，不是一个游戏接口。
   *
   * `totalLook` / `taps` 是**单调计数**：`look` 累加器每帧被 `stepSim` 清零，
   * 只看瞬时值的话，"拖了 300 px" 和"拖了 3 px" 在下一帧长得一模一样。
   */
  touchInfo() { return touch ? touch.state() : null; },

  /**
   * **四个输入源合成出来的 input，就是这一帧 `stepSim` 会交给 avatar 的那一个。**
   *
   * 它调的是 `assembleInput()` 本体，不是在这里重算一遍加法 —— 所以
   * "摇杆推满" 和 "按住 W" 是不是同一个数，是一条**关于生产的断言**，
   * 而不是两段算式的巧合。验收脚本用它做那个 A/B。
   */
  inputNow() {
    const i = assembleInput();
    return { ...i, look: { dx: i.look.dx, dy: i.look.dy } };
  },

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
