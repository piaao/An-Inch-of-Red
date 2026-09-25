/**
 * probe_climb_play.mjs — does the PLAYER actually get onto the furniture?
 *
 * The player asked for it in so many words:
 *
 *     "跳跃+移动要能达到物品上方，比如能跳到桌子上面或者浴缸里面。"
 *
 * This drives the real `Avatar` -- the same class the browser instantiates, no
 * copy -- with a scripted input: stand near the thing, face it, jump once, and
 * hold forward for 1.2 s at 60 Hz. Then it reads `groundY`, which is the
 * surface the body came to rest on.
 *
 * THREE CLAIMS, and the third is the one that must NOT pass:
 *
 *   1. you CAN end up standing on the bathtub (0.42 m) and the desk;
 *   2. while up there the eye is still below the wall top, so six rooms stay
 *      six rooms -- the ceiling in `climbCeilOf` is doing its job;
 *   3. you canNOT end up on a wall, even asked directly with the feet
 *      teleported to 2 m. That is the assertion that would have failed if the
 *      avatar's ground query had kept its default `ceil = Infinity`.
 *
 * Also checks that walking OFF the thing is a fall back to the floor, because a
 * one-way trip onto the counter would be its own bug.
 *
 * Node only: `game/play/avatar.js` and `game/play/config.js` import nothing
 * from the DOM, which is what makes this possible.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNav } from '../game/core/nav.js';
import { supportY, climbCeilOf, containsXZ } from '../game/core/level.js';
import { Avatar } from '../game/play/avatar.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARENA = path.join(ROOT, 'game', 'arenas', 'room_scene.json');
const OUT = path.join(ROOT, 'work', '_probe_climb_play.json');

const lines = [];
const say = (s) => { lines.push(s); process.stdout.write(s + '\n'); };

const level = JSON.parse(fs.readFileSync(ARENA, 'utf8'));
const ceil = climbCeilOf(level);
const nav = buildNav(level, {
  inflate: level.body.playerRadius, bodyHeight: level.body.playerHeight, step: level.meta.step,
});

say('='.repeat(78));
say('probe_climb_play  --  跳到桌子上面 / 浴缸里面');
say('='.repeat(78));
say(`  ceiling ${ceil.toFixed(3)} m   jump peak would be `
  + `${((2.30 * 2.30) / (2 * 6.00)).toFixed(3)} m at the shipped numbers`);
say('');

const results = [];
const FPS = 60;
const DT = 1 / FPS;

/** Stand near `s`, face it, jump once, hold forward. Return what we ended on. */
function attempt(s, label) {
  const start = nav.nearestWalkable(s.x, s.z, Math.max(s.hx, s.hz) + 0.45);
  if (!start) { say(`  ${label}: SKIP (no walkable cell near it)`); return null; }
  if (containsXZ(s, start.x, start.z)) {
    say(`  ${label}: SKIP (the launch cell is inside the solid)`);
    return null;
  }
  const av = new Avatar(level, nav, { x: start.x, z: start.z, yaw: 0 });
  av.reset({ x: start.x, z: start.z, yaw: 0 });
  av.lookAt(s.x, s.z);

  let peak = av.feetY;
  let landedAt = null;
  const startFeet = av.feetY;
  for (let i = 0; i < 4 * FPS; i++) {
    av.update(DT, { fwd: 1, side: 0, jump: i === 0 });
    peak = Math.max(peak, av.feetY);
    if (!av.airborne && i > 6 && landedAt == null && av.feetY > startFeet + 0.05) {
      landedAt = av.feetY;
    }
  }
  const onIt = containsXZ(s, av.x, av.z);
  const eye = av.eye();
  const out = {
    label, model: s.model, top: s.y1,
    launch: { x: +start.x.toFixed(3), z: +start.z.toFixed(3), feet: startFeet },
    peak: +peak.toFixed(3),
    landedAt: landedAt == null ? null : +landedAt.toFixed(3),
    end: { x: +av.x.toFixed(3), z: +av.z.toFixed(3), groundY: +av.groundY.toFixed(3), feetY: +av.feetY.toFixed(3) },
    onFootprint: onIt,
    eyeY: +eye.y.toFixed(3),
    standsOnTop: Math.abs(av.groundY - s.y1) < 0.02 && onIt,
    eyeUnderWall: eye.y < level.meta.wallH,
  };
  results.push(out);
  say(`-- ${label}  (${s.model}, top ${s.y1.toFixed(3)} m) ------------------------`);
  say(`   launch (${out.launch.x}, ${out.launch.z}) feet ${startFeet.toFixed(3)}`);
  say(`   peak feetY ${out.peak.toFixed(3)}   landed ${out.landedAt == null ? '-' : out.landedAt.toFixed(3)}`
    + `   final groundY ${out.end.groundY.toFixed(3)}`);
  say(`   ends on the footprint? ${onIt ? 'yes' : 'no'}`
    + `   -> standing ON TOP: ${out.standsOnTop ? 'YES' : 'no'}`);
  say(`   eye at ${out.eyeY.toFixed(3)} m vs wall ${level.meta.wallH} m: `
    + `${out.eyeUnderWall ? 'still under it · OK' : 'SEEING OVER · BUG'}`);
  say('');
  return out;
}

const bath = level.solids.find((s) => s.model === 'bathtub');
const desk = level.solids.find((s) => s.model === 'desk');
const counter = level.solids.find((s) => s.model === 'kitchenCabinetDrawer');
const fridge = level.solids.find((s) => s.model === 'kitchenFridge');
const bathR = attempt(bath, 'the bathtub');
const deskR = attempt(desk, 'the desk');
const counterR = attempt(counter, 'the kitchen counter');
const fridgeR = attempt(fridge, 'the fridge (too tall for one jump)');

/* -------------------------------------------- walking off is a fall, not a glide */

say('-- and getting down again -------------------------------------------------');
{
  // Put the body on the tub by hand, then walk it off. The position has to be
  // assigned AFTER construction: `reset`/`teleport` snap a body out of a solid
  // it is illegally inside of (which is correct, and which is why the first
  // version of this block read groundY 0.000 and printed a misleading FAIL).
  const near = nav.nearestWalkable(bath.x, bath.z, Math.max(bath.hx, bath.hz) + 0.45);
  const av = new Avatar(level, nav, { x: near.x, z: near.z, yaw: 0 });
  av.x = bath.x;
  av.z = bath.z;
  av.feetY = bath.y1;
  av.airborne = false;
  av.settleVertical();
  const onTub = av.groundY;
  av.lookAt(near.x, near.z);
  let sawAirborne = false;
  for (let i = 0; i < 3 * FPS; i++) {
    av.update(DT, { fwd: 1 });
    if (av.airborne) sawAirborne = true;
  }
  say(`   put the body at feet ${bath.y1.toFixed(3)} on the tub: groundY reads ${onTub.toFixed(3)}`
    + ` ${Math.abs(onTub - bath.y1) < 0.02 ? 'OK' : 'FAIL'}`);
  say(`   walked off: went airborne at some point? ${sawAirborne ? 'yes' : 'NO -- it glided'}`
    + `   final groundY ${av.groundY.toFixed(3)}`);
  say(`   ${sawAirborne && av.groundY < 0.1 ? 'OK   walking off is a fall back to the floor'
    : 'FAIL the fall is not handled'}`);
  results.push({ label: 'walk off the tub', onTub, sawAirborne, finalGroundY: av.groundY });
}
say('');

/* ------------------------------------------------------------- the wall ceiling */

say('-- the wall, asked directly -----------------------------------------------');
{
  const wall = level.solids.find((s) => s.kind === 'wall');
  const withCeil = supportY(level, wall.x, wall.z, 2.0, level.meta.step, ceil);
  const withoutCeil = supportY(level, wall.x, wall.z, 2.0, level.meta.step);
  say(`   supportY over the wall with feet at 2.0 m:`);
  say(`      WITHOUT the ceiling (the avatar's old call): ${withoutCeil.toFixed(3)} m`);
  say(`      WITH    the ceiling (the avatar's new call): ${withCeil.toFixed(3)} m`);
  say(`   ${withCeil < ceil ? 'OK   the wall is not a surface' : 'FAIL the wall is standable'}`);
  results.push({ label: 'wall support', withCeil, withoutCeil, wallTop: wall.y1 });
}
say('');

const canBath = !!(bathR && bathR.standsOnTop);
const canDesk = !!(deskR && deskR.standsOnTop);
const eyeOk = results.filter((r) => r.eyeUnderWall != null)
  .every((r) => r.eyeUnderWall);
const wallOk = results.find((r) => r.label === 'wall support');
const wallNotStandable = wallOk && wallOk.withCeil < ceil;
const fallOk = results.find((r) => r.label === 'walk off the tub');
const fallsBack = !!(fallOk && fallOk.sawAirborne && fallOk.finalGroundY < 0.1);

say('-- 结论 -------------------------------------------------------------------');
say(`   能站到浴缸上:      ${canBath ? 'YES' : 'NO'}`);
say(`   能站到桌子上:      ${canDesk ? 'YES' : 'NO'}`);
say(`   站上去后眼仍在墙下: ${eyeOk ? 'YES' : 'NO'}`);
say(`   墙不可站:          ${wallNotStandable ? 'YES' : 'NO'}`);
say(`   走下来会掉回地面:   ${fallsBack ? 'YES' : 'NO'}`);
const verdict = canBath && canDesk && eyeOk && wallNotStandable && fallsBack;
say('');
say(`VERDICT  ${verdict ? 'PASS' : 'FAIL'}`);
say('='.repeat(78));

fs.writeFileSync(OUT, JSON.stringify({
  ceil, jumpPeak: (2.30 * 2.30) / (2 * 6.00),
  results, verdict,
}, null, 2));
say(`wrote ${path.relative(ROOT, OUT)}`);
