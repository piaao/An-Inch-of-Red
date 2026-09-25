/**
 * probe_climb_reach.mjs — can a BODY (not a teleport) actually take every 红包?
 *
 * §3 of verify_play used to snap the body to the packet's own XZ and then
 * require a pickup. That only ever worked while every packet stood on the
 * floor: the snap cannot put you ON a surface, because `teleport` resolves its
 * ground from feetY = 0, and a 0.45 m counter top is above one step.
 *
 * So this probe drives the climb the way a player does -- aim at the packet,
 * hop, land, repeat -- against the real Avatar, in Node (avatar.js imports only
 * core + config, so no browser is needed). If a driver here cannot take the
 * packets, a browser driver will not either, and the placement's guarantee is
 * the thing that is wrong.
 *
 * Reports, per packet: its standpoint, the climb it declares, and what the
 * driver actually managed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCore } from '../game/play/boot.js';
import { Avatar } from '../game/play/avatar.js';
import { MOVE } from '../game/play/config.js';
import { WALKER } from '../game/core/sim.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARENA = path.join(ROOT, 'game', 'arenas', 'room_scene.json');
const SEED = process.argv[2] || '2026-09-25';
const DT = 1 / 60;

const level = JSON.parse(fs.readFileSync(ARENA, 'utf8'));
const core = buildCore(level, { seed: SEED, count: 6 });
const { nav, prizes } = core;

const reach = level.collectible.pickup;
const lift = WALKER.lift;
const out = [];
const say = (s = '') => { out.push(s); console.log(s); };

function takeable(av, p) {
  return Math.hypot(p.x - av.x, p.z - av.z) <= reach && (p.y - av.feetY) <= lift;
}

/** Aim at the packet and hop until it is taken or `hops` are spent. */
function climbTo(av, p, hops = 5) {
  let used = 0;
  for (let h = 0; h < hops; h++) {
    if (takeable(av, p)) break;
    av.fromFacing(Math.atan2(p.z - av.z, p.x - av.x));
    av.update(DT, { fwd: 1, jump: 1 });
    av.update(DT, { fwd: 1 });
    for (let i = 0; i < 100; i++) {
      av.update(DT, { fwd: takeable(av, p) ? 0 : 1 });
      if (!av.airborne && i > 4) break;
    }
    used += 1;
  }
  av.update(DT, {});
  return used;
}

say(`reach ${reach} m horizontal, lift ${lift} m vertical, speed ${MOVE.speed}`);
say('');
say('seed ' + SEED);
say('id    room      tier        y      stand(x,z,y)            pad(x,z,y)              climb  kind');
for (const p of prizes) {
  const st = p.stand;
  const pd = p.pad;
  say(`${p.id.padEnd(5)} ${String(p.room).padEnd(9)} ${String(p.tier).padEnd(11)} `
    + `${p.y.toFixed(2).padStart(5)}  `
    + `${st ? `(${st.x.toFixed(2)},${st.z.toFixed(2)},${st.y.toFixed(2)})`.padEnd(22) : 'NONE'.padEnd(22)} `
    + `${pd ? `(${pd.x.toFixed(2)},${pd.z.toFixed(2)},${(pd.y || 0).toFixed(2)})`.padEnd(22) : '-'.padEnd(22)} `
    + `${String(p.climb).padStart(5)}  ${p.standKind}`);
}
say('');

/* ---- the driver, from two different starts ---------------------------- */
const spawn = { x: level.spawn.x, z: level.spawn.z, yaw: level.spawn.yaw || 0 };

function run(startOf, label) {
  say(`-- driver: ${label} ------------------------------------------------`);
  const rows = [];
  for (const p of prizes) {
    const av = new Avatar(level, nav, spawn);
    const start = startOf(p);
    if (!start) { rows.push({ id: p.id, ok: false, why: 'no start' }); continue; }
    av.teleport(start.x, start.z);
    const beforeX = av.x, beforeZ = av.z, beforeGround = av.groundY;
    const used = climbTo(av, p);
    const ok = takeable(av, p);
    rows.push({
      id: p.id, ok, used,
      from: { x: beforeX, z: beforeZ, ground: beforeGround },
      end: { x: av.x, z: av.z, feet: av.feetY, ground: av.groundY },
      dh: Math.hypot(av.x - p.x, av.z - p.z),
      dv: p.y - av.feetY,
      snapped: Math.hypot(av.x - beforeX, av.z - beforeZ),
    });
  }
  for (const r of rows) {
    if (r.why) { say(`   ${r.id}  FAIL  ${r.why}`); continue; }
    say(`   ${r.id}  ${r.ok ? 'TAKE' : 'MISS'}  hops ${r.used}  `
      + `from (${r.from.x.toFixed(2)},${r.from.z.toFixed(2)}) ground ${r.from.ground.toFixed(2)} -> `
      + `(${r.end.x.toFixed(2)},${r.end.z.toFixed(2)}) feet ${r.end.feet.toFixed(2)} `
      + `ground ${r.end.ground.toFixed(2)}  dh ${r.dh.toFixed(3)} dv ${r.dv.toFixed(3)}`);
  }
  const n = rows.filter((r) => r.ok).length;
  say(`   ${n} / ${rows.length} taken`);
  say('');
  return n;
}

const a = run((p) => (p.stand ? { x: p.stand.x, z: p.stand.z } : null),
  'start at the core standpoint XZ (teleport, floor-resolved)');
const b = run((p) => (p.pad ? { x: p.pad.x, z: p.pad.z } : null),
  'start at the declared launch pad XZ');
const c = run((p) => ({ x: p.x, z: p.z }),
  'start at the packet XZ (what verify §3 did)');

const best = Math.max(a, b, c);
say(`VERDICT: ${best === prizes.length
  ? 'PASS — a real body can take every packet'
  : `FAIL — best driver takes only ${best}/${prizes.length}`}`);

fs.writeFileSync(path.join(ROOT, 'work', '_climb_reach.log'), out.join('\n') + '\n');
