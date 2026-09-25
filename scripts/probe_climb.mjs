/**
 * probe_climb.mjs — does the vertical axis do what the comments claim?
 *
 * THE TWO CLAIMS WORTH TESTING, because both are of the form "nothing changed
 * except the thing I meant to change", and that form is exactly how a
 * regression hides:
 *
 *   1. `nav.clear(x, z, r, 0)` is IDENTICAL to `nav.clear(x, z, r)` -- so the
 *      guard, A*, the region flood fill and the placement's own clearance probe
 *      all keep the behaviour the headless matrix measured. Tested on the real
 *      arena, over sampled points and three radii, not asserted in a comment.
 *
 *   2. `sightLine(a, b, y)` is IDENTICAL to `sightLine(a, b, y, y)` -- so the
 *      guard's vision and the guard's fan keep their measured meaning while the
 *      player's census opts into the sloped test.
 *
 * And one claim of the form "the new thing is not dead code": the sloped sight
 * test must actually disagree with the flat one somewhere, or the whole
 * `targetY` argument is decoration. So both directions are counted and an
 * example of each is printed.
 *
 * Plus the ladder: what is standable, what is reachable from the spawn, and
 * what the ceiling keeps out. Read `work/_probe_climb.json` for the raw table.
 *
 * Node only. No browser, no DOM -- this is core, and it runs headless.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNav } from '../game/core/nav.js';
import { supportY, climbCeilOf, containsXZ, roomOfPoint } from '../game/core/level.js';
import { climbPlan, standableSurfaces, CLIMB } from '../game/core/climb.js';
import { sightLine } from '../game/core/vision.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARENA = path.join(ROOT, 'game', 'arenas', 'room_scene.json');
const OUT = path.join(ROOT, 'work', '_probe_climb.json');
const lines = [];
const say = (s) => { lines.push(s); process.stdout.write(s + '\n'); };

const level = JSON.parse(fs.readFileSync(ARENA, 'utf8'));
const W = level.meta.plan.w;
const D = level.meta.plan.d;
const ceil = climbCeilOf(level);

/** Deterministic sampling -- a probe that moves under you is not a probe. */
let s0 = 12345;
const rnd = () => {
  s0 = (s0 * 1103515245 + 12345) & 0x7fffffff;
  return s0 / 0x7fffffff;
};

say('='.repeat(78));
say('probe_climb  --  the vertical axis, measured');
say('='.repeat(78));
say(`  plan ${W} x ${D} m,  wallH ${level.meta.wallH},  eye ${level.body.eyeHeight},  `
  + `step ${level.meta.step}`);
say(`  climbCeil = wallH - eyeHeight = ${ceil.toFixed(4)} m`);
say('');

const t0 = Date.now();
const nav = buildNav(level, {
  inflate: level.body.playerRadius,
  bodyHeight: level.body.playerHeight,
  step: level.meta.step,
});
say(`  nav built in ${Date.now() - t0} ms  (${nav.walkableCount} walkable cells, `
  + `${nav.components.length} regions)`);
say('');

/* ------------------------------------------- 1. the ground-level equivalence */

const POINTS = 4000;
const RADII = [0.07, level.body.playerRadius, 0.15];
const eq = { points: POINTS, radii: [], mismatches: 0, examples: [] };
for (let k = 0; k < POINTS; k++) {
  const x = rnd() * W;
  const z = rnd() * D;
  for (const r of RADII) {
    const a = nav.clear(x, z, r);
    const b = nav.clear(x, z, r, 0);
    if (a !== b) {
      eq.mismatches += 1;
      if (eq.examples.length < 4) eq.examples.push({ x, z, r, three: a, four: b });
    }
  }
}
eq.radii = RADII;
say('-- 1. clear(x, z, r)  vs  clear(x, z, r, 0) -------------------------------');
say(`   ${POINTS} points x ${RADII.length} radii = ${POINTS * RADII.length} pairs,  `
  + `mismatches: ${eq.mismatches}`);
say(`   ${eq.mismatches === 0 ? 'OK   the ground-level test is bit-identical'
  : 'FAIL the ground-level test MOVED'}`);
say('');

/* ------------------------------------------------- 2. what a raised foot buys */

const raised = {};
for (const fy of [0.30, 0.42, 0.70]) {
  let blocked0 = 0;
  let opensUp = 0;
  let closesOff = 0;
  for (let k = 0; k < POINTS; k++) {
    const x = rnd() * W;
    const z = rnd() * D;
    const at0 = nav.clear(x, z, level.body.playerRadius, 0);
    const atF = nav.clear(x, z, level.body.playerRadius, fy);
    if (!at0) blocked0 += 1;
    if (!at0 && atF) opensUp += 1;
    if (at0 && !atF) closesOff += 1;
  }
  raised[String(fy)] = { blocked0, opensUp, closesOff };
  say(`-- 2. feet at ${fy.toFixed(2)} m -----------------------------------------`);
  say(`   of ${POINTS} points, ${blocked0} were blocked from the ground;`);
  say(`   ${opensUp} open up (you are now above that furniture) and ${closesOff} close off`);
  say('   (you can no longer duck under it). Both are correct, and both are why');
  say('   this had to be one rule instead of a second collision model.');
}
say('');

/* ------------------------------------------------ 3. the bathtub, end to end */

const bath = level.solids.find((s) => s.model === 'bathtub');
const desk = level.solids.find((s) => s.model === 'desk');
const counter = level.solids.find((s) => s.model === 'kitchenCabinetDrawer');
const wall = level.solids.find((s) => s.kind === 'wall');
const r = level.body.playerRadius;

function vertical(s, label) {
  if (!s) return null;
  const fromFloor = supportY(level, s.x, s.z, 0, level.meta.step, ceil);
  const onTop = supportY(level, s.x, s.z, s.y1, level.meta.step, ceil);
  const standsFromFloor = nav.clear(s.x, s.z, r, 0);
  const standsOnTop = nav.clear(s.x, s.z, r, s.y1);
  const pts = standableSurfaces(level, nav).filter((p) => p.host === s.id);
  const out = {
    model: s.model, kind: s.kind, y1: s.y1, half: [s.hx, s.hz],
    supportFromFloor: fromFloor, supportOnTop: onTop,
    clearFromFloor: standsFromFloor, clearOnTop: standsOnTop,
    standPoints: pts.length,
  };
  say(`-- 3. ${label} (${s.model}, top ${s.y1.toFixed(3)} m) -------------------`);
  say(`   standable points on it:  ${pts.length}`
    + `   <- sampled, not its middle: a desk's middle has a monitor on it`);
  say(`   AT ITS MIDDLE: walk in from the floor? ${standsFromFloor ? 'yes' : 'no'}`
    + `   stand there with feet at ${s.y1.toFixed(3)}? ${standsOnTop ? 'yes' : 'no'}`);
  say(`   support at (x, z) with feet at 0:    ${fromFloor.toFixed(3)} m`);
  say(`   support at (x, z) with feet on top:  ${onTop.toFixed(3)} m`);
  return out;
}
const bathV = vertical(bath, 'the bathtub');
const deskV = vertical(desk, 'the desk');
const counterV = vertical(counter, 'the kitchen counter');
const wallV = vertical(wall, 'a WALL -- must stay out of reach');
if (wall) {
  // The honest full picture for the wall, because it is the one place where
  // three different queries give three different answers and only the middle
  // one is the game's rule:
  const surface = standableSurfaces(level, nav).some((p) => p.host === wall.id);
  say('   the wall, three questions:');
  say(`     does a body FIT on top of it (raw collision)?   ${nav.clear(wall.x, wall.z, r, wall.y1) ? 'yes' : 'no'}`);
  say(`     is it a SURFACE at all (climbCeil >= its top)?  ${surface ? 'yes' : 'NO -- and that is the rule'}`);
  say(`     would you LAND on it (supportY at feet 1.29)?   ${supportY(level, wall.x, wall.z, wall.y1, level.meta.step, ceil).toFixed(3)} m`);
  say('     The top row is why the ceiling cannot be a convention: the collision');
  say('     test alone would happily let a 1.29 m body stand on a 1.29 m wall.');
}
say('');

/* -------------------------------------------------------- 4. the climb graph */

const t1 = Date.now();
const plan = climbPlan(level, nav);
const msPlan = Date.now() - t1;
const byY = plan.surfaces.slice().sort((a, b) => a.y - b.y);
const reachByY = byY.filter((s) => plan.reached.has(s.id));

say('-- 4. surfaces and the ladder ------------------------------------------');
say(`   ${plan.surfaces.length} standable surface points on ${new Set(plan.surfaces.map((s) => s.host)).size}`
  + ` pieces of furniture, built in ${msPlan} ms`);
say(`   ${reachByY.length} of them reachable from the spawn (edge ${plan.edge} m, `
  + `one rung ${plan.step} m)`);
say(`   ceiling ${plan.ceiling.toFixed(3)} m -- nothing above it is a surface at all`);
say('');

const models = new Map();
for (const s of byY) {
  if (!models.has(s.model)) models.set(s.model, { y: s.y, n: 0, reached: 0, via: new Set() });
  const m = models.get(s.model);
  m.n += 1;
  if (plan.reached.has(s.id)) {
    m.reached += 1;
    const via = plan.reached.get(s.id).via;
    m.via.add(via ? 'rung' : 'floor');
  }
}
say('   model                    top m   points  reachable   route');
for (const [m, v] of [...models.entries()].sort((a, b) => a[1].y - b[1].y)) {
  say(`   ${m.padEnd(22)} ${v.y.toFixed(3).padStart(6)} ${String(v.n).padStart(7)} `
    + `${String(v.reached).padStart(10)}   ${[...v.via].join('+') || '-'}`);
}
say('');
say(`   rooftop check: the tallest reachable surface is ${Math.max(...reachByY.map((s) => s.y)).toFixed(3)} m,`
  + ` so the highest possible eye is ${(Math.max(...reachByY.map((s) => s.y)) + level.body.eyeHeight).toFixed(3)} m`);
say(`   against a wall top of ${level.meta.wallH} m -> `
  + `${Math.max(...reachByY.map((s) => s.y)) + level.body.eyeHeight < level.meta.wallH ? 'still under it' : 'SEEING OVER -- BUG'}`);

const wallOnLadder = plan.surfaces.filter((s) => s.y >= ceil);
say(`   surfaces at or above the ceiling: ${wallOnLadder.length} (must be 0)`);
say('');

/* --------------------------------------- 5. the flat sight line is unchanged */

let flatSame = 0;
let flatDiff = 0;
const diffExamples = [];
let slopeChangesAtFloorEye = 0;   // the 3D test itself disagrees with the plane
let climbOpensItUp = 0;           // invisible from the floor, visible from a top
let climbLosesIt = 0;             // visible from the floor, lost from a top
let pairs = 0;

const solidPts = [];
for (const s of level.solids) {
  if (s.kind === 'furniture' && s.y1 > 0.2 && s.y1 < ceil) {
    solidPts.push({ x: s.x, z: s.z, y: s.y1, model: s.model, room: s.room });
  }
}
// A viewer ACROSS THE FLAT tests nothing but the walls: both tests agree it is
// blocked. The question this probe exists to ask is what happens at the
// distance a player would actually look from, in the room the thing is in.
for (let k = 0; k < 40000 && pairs < 3000; k++) {
  const b = solidPts[Math.floor(rnd() * solidPts.length)];
  if (!b) continue;
  const ang = rnd() * Math.PI * 2;
  const dist = 0.6 + rnd() * 2.4;
  const ax = b.x + Math.cos(ang) * dist;
  const az = b.z + Math.sin(ang) * dist;
  if (ax < 0 || az < 0 || ax > W || az > D) continue;
  if (roomOfPoint(level, ax, az) !== b.room) continue;   // "the same room" only

  const a = { x: ax, z: az };
  const eyeFloor = level.body.eyeHeight;
  const flat = sightLine(level, a, { x: b.x, z: b.z }, eyeFloor);
  const same = sightLine(level, a, { x: b.x, z: b.z }, eyeFloor, eyeFloor);
  if (flat.clear === same.clear && flat.glass === same.glass) flatSame += 1;
  else flatDiff += 1;

  const slopedFloor = sightLine(level, a, { x: b.x, z: b.z }, eyeFloor, b.y);
  const slopedTop = sightLine(level, a, { x: b.x, z: b.z }, b.y + eyeFloor, b.y);
  if (flat.clear !== slopedFloor.clear) slopeChangesAtFloorEye += 1;
  if (!slopedFloor.clear && slopedTop.clear) climbOpensItUp += 1;
  if (slopedFloor.clear && !slopedTop.clear) climbLosesIt += 1;
  if (!slopedFloor.clear && slopedTop.clear && diffExamples.length < 3) {
    diffExamples.push({
      model: b.model, viewer: [+ax.toFixed(2), +az.toFixed(2)],
      top: b.y, at: +dist.toFixed(2),
    });
  }
  pairs += 1;
}
say('-- 5. sightLine(a, b, y)  vs  sightLine(a, b, y, y) --------------------');
say(`   ${flatSame} identical, ${flatDiff} different  (must be 0 different)`);
say('');
say('-- 6. and the height argument is not decoration -----------------------');
say(`   ${pairs} (viewer, furniture-top) pairs, viewer in the SAME room, 0.6-3.0 m away:`);
say(`     with the eye on the FLOOR, the sloped test disagrees with the plane: ${slopeChangesAtFloorEye}`);
say(`     invisible with the eye on the floor, visible from up there:          ${climbOpensItUp}`);
say(`     visible from the floor, lost from up there:                          ${climbLosesIt}`);
for (const e of diffExamples) {
  say(`     e.g. a ${e.model} top at ${e.top.toFixed(3)} m, viewer `
    + `(${e.viewer[0]}, ${e.viewer[1]}) ${e.at} m away -- floor eye: buried, climbed eye: visible`);
}
say('   THE MECHANISM, because it is not obvious: a thing sitting ON something is');
say('   inside that thing\'s footprint, so every line to it must cross the thing.');
say('   To clear the crossing the line has to be above the top AT THE CROSSING,');
say('   which an eye at 0.36 CANNOT be for a 0.45 m counter and an eye at 0.81 CAN.');
say('   Climbing is therefore what makes a counter-top packet findable at all, and');
say('   that is the whole second half of the search.');
say('');

const json = {
  plan: { w: W, d: D, wallH: level.meta.wallH, eyeHeight: level.body.eyeHeight, step: level.meta.step, ceil },
  nav: { walkable: nav.walkableCount, regions: nav.components.length },
  equivalence: eq,
  raised,
  fixtures: { bathtub: bathV, desk: deskV, counter: counterV, wall: wallV },
  climb: {
    edge: plan.edge, step: plan.step, rate: CLIMB.rate,
    surfaces: plan.surfaces.length, reachable: reachByY.length,
    tallestReachable: Math.max(...reachByY.map((s) => s.y)),
    atOrAboveCeiling: wallOnLadder.length,
    byModel: [...models.entries()].map(([m, v]) => ({ model: m, top: v.y, points: v.n, reached: v.reached, via: [...v.via] })),
    buildMs: msPlan,
  },
  sight: { flatSame, flatDiff, pairs, slopeChangesAtFloorEye, climbOpensItUp, climbLosesIt, diffExamples },
  ms: { total: Date.now() - t0 },
};
fs.writeFileSync(OUT, JSON.stringify(json, null, 2));
say(`wrote ${path.relative(ROOT, OUT)}`);
