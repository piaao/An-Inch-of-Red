/**
 * diag_fridge.mjs — frame by frame, why does the second rung fail?
 *
 * hb5's ladder is floor -> drawer (0.45) -> fridge (0.92). Rung 1 works. Rung 2
 * ends with the body on the floor. This prints the arc: feetY, supportY under
 * the centre, what nav.clear allows at that height, and where the fridge's
 * footprint actually is.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCore } from '../game/play/boot.js';
import { Avatar } from '../game/play/avatar.js';
import { climbPlan } from '../game/core/climb.js';
import { supportY, containsXZ, climbCeilOf } from '../game/core/level.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const level = JSON.parse(fs.readFileSync(path.join(ROOT, 'game', 'arenas', 'room_scene.json'), 'utf8'));
const core = buildCore(level, { seed: process.argv[2] || '2026-09-25', count: 6 });
const { nav, prizes } = core;
const plan = climbPlan(level, nav);
const DT = 1 / 60;
const step = level.meta.step;
const ceil = climbCeilOf(level);
const p = prizes.find((x) => x.id === 'hb5');
const out = [];
const say = (s = '') => { out.push(s); console.log(s); };

const surf = plan.surfaces
  .filter((s) => Math.abs(s.y - p.stand.y) < 1e-6)
  .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
say(`packet hb5 @ (${p.x.toFixed(3)}, ${p.z.toFixed(3)}) y ${p.y}`);
say(`stand ${JSON.stringify(p.stand)}  pad ${JSON.stringify(p.pad)}`);
say(`surface ${surf ? surf.id : 'NONE'} host ${surf && surf.host} y ${surf && surf.y}`);
const host = level.solids.find((s) => s.id === (surf && surf.host));
if (host) {
  say(`host bbox x[${(host.x - host.hx).toFixed(3)}, ${(host.x + host.hx).toFixed(3)}] `
    + `z[${(host.z - host.hz).toFixed(3)}, ${(host.z + host.hz).toFixed(3)}] y1 ${host.y1}`);
}
// what is between the pad and the fridge?
const pad = p.pad;
say(`pad (${pad.x.toFixed(3)}, ${pad.z.toFixed(3)}) y ${pad.y}`);
say('solids whose footprint contains the fridge centre or lies on the line pad->fridge:');
const mid = { x: (pad.x + p.x) / 2, z: (pad.z + p.z) / 2 };
for (const s of level.solids) {
  const onMid = containsXZ(s, mid.x, mid.z);
  const onEnd = containsXZ(s, p.x, p.z);
  if (!onMid && !onEnd) continue;
  say(`   ${s.id.padEnd(26)} ${s.model.padEnd(24)} kind ${String(s.kind).padEnd(9)} `
    + `y ${s.y0.toFixed(2)}..${s.y1.toFixed(2)} blocksMove ${s.blocksMove} `
    + `containsMid ${onMid} containsFridge ${onEnd}`);
}
say('');

const av = new Avatar(level, nav, { x: level.spawn.x, z: level.spawn.z });
av.teleport(pad.x, pad.z);
av.update(DT, {});
// rung 1: hop onto the drawer
av.fromFacing(Math.atan2(pad.z - av.z, pad.x - av.x));
say(`start ground ${av.groundY.toFixed(3)} at (${av.x.toFixed(3)}, ${av.z.toFixed(3)})`);
av.fromFacing(Math.atan2(pad.z - av.z, pad.x - av.x));
av.update(DT, { fwd: 1, jump: 1 });
av.update(DT, { fwd: 1 });
for (let i = 0; i < 200 && av.airborne; i++) av.update(DT, { fwd: 1 });
say(`after rung 1: feet ${av.feetY.toFixed(3)} ground ${av.groundY.toFixed(3)} at (${av.x.toFixed(3)}, ${av.z.toFixed(3)})`);
say('');

say('-- rung 2: hop at the fridge centre ----------------------------------');
av.fromFacing(Math.atan2(p.z - av.z, p.x - av.x));
say(`   facing toward (${p.x.toFixed(2)}, ${p.z.toFixed(2)}), dist ${Math.hypot(p.x - av.x, p.z - av.z).toFixed(3)}`);
say('   frame   feetY    below   overHost  clearFwd   x        z');
av.update(DT, { fwd: 1, jump: 1 });
for (let f = 0; f <= 60; f++) {
  const below = supportY(level, av.x, av.z, av.feetY, step, ceil);
  const over = host ? containsXZ(host, av.x, av.z) : false;
  say(`   ${String(f).padStart(5)}  ${av.feetY.toFixed(3)}  ${below.toFixed(3)}   ${String(over).padEnd(7)}  `
    + `${String(nav.clear(av.x + 0.02, av.z, av.radius, av.feetY)).padEnd(8)} `
    + `${av.x.toFixed(3)}  ${av.z.toFixed(3)}${av.airborne ? '' : '   [landed]'}`);
  if (!av.airborne && f > 2) break;
  av.update(DT, { fwd: 1 });
}
say(`end feet ${av.feetY.toFixed(3)} ground ${av.groundY.toFixed(3)}`);

fs.writeFileSync(path.join(ROOT, 'work', '_diag_fridge.log'), out.join('\n') + '\n');
