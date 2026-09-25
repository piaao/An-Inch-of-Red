/**
 * probe_ladder.mjs — can a BODY really take every 红包, across many seeds?
 *
 * `place.js` promises every packet has a standpoint; `lift` (0.55) means a
 * packet on a 0.92 m fridge top cannot be taken from the floor, so the player
 * must climb. This drives the declared ladder with the real Avatar and real
 * inputs, and reports every packet the body could NOT take -- with the numbers
 * that explain why.
 *
 * It is the evidence for (or against) the rung-to-rung horizontal limit in
 * `climb.js`: `climbPlan` is a fixpoint over HEIGHTS, and heights alone cannot
 * say whether the body can cross the gap before it falls back down.
 *
 * Note the driver walks to the rung's own centre first: the body has to be able
 * to STAND where the graph says it can stand, not merely be placed there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCore } from '../game/play/boot.js';
import { Avatar } from '../game/play/avatar.js';
import { climbPlan } from '../game/core/climb.js';
import { WALKER } from '../game/core/sim.js';
import { MOVE } from '../game/play/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARENA = path.join(ROOT, 'game', 'arenas', 'room_scene.json');
const DT = 1 / 60;
const SEEDS = Number(process.argv[2] || 20);
const BASE = process.argv[3] || '2026-09-25';

const level = JSON.parse(fs.readFileSync(ARENA, 'utf8'));
const reach = level.collectible.pickup;
const lift = WALKER.lift;
const step = level.meta.step;
const out = [];
const say = (s = '') => { out.push(s); console.log(s); };

const takeable = (av, p) => Math.hypot(p.x - av.x, p.z - av.z) <= reach
  && (p.y - av.feetY) <= lift;

/** Walk straight at a plan point; stop when close, blocked, or out of frames. */
function walkTo(av, tx, tz, frames = 240) {
  let stall = 0;
  for (let i = 0; i < frames; i++) {
    if (Math.hypot(tx - av.x, tz - av.z) < 0.12) break;
    av.fromFacing(Math.atan2(tz - av.z, tx - av.x));
    const bx = av.x, bz = av.z;
    av.update(DT, { fwd: 1 });
    if (Math.hypot(av.x - bx, av.z - bz) < 1e-5) { stall += 1; if (stall > 6) break; }
    else stall = 0;
  }
  return Math.hypot(tx - av.x, tz - av.z);
}

/** One hop aimed at a plan point; fly until the arc ends. */
function hopToward(av, tx, tz) {
  av.fromFacing(Math.atan2(tz - av.z, tx - av.x));
  av.update(DT, { fwd: 1, jump: 1 });
  av.update(DT, { fwd: 1 });
  for (let i = 0; i < 200 && av.airborne; i++) av.update(DT, { fwd: 1 });
}

/** The rung chain under a standpoint: [basePad, rung1, rung2, ...]. */
function ladderOf(plan, stand) {
  if (!stand) return null;
  if (stand.y <= step) return [{ x: stand.x, z: stand.z, y: 0 }];
  const surf = plan.surfaces
    .filter((s) => Math.abs(s.y - stand.y) < 1e-6
      && Math.hypot(s.x - stand.x, s.z - stand.z) < 1e-6)
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!surf) return null;
  const chain = [{ x: surf.x, z: surf.z, y: surf.y }];
  let cur = surf;
  const seen = new Set();
  while (cur && !seen.has(cur.id) && chain.length < 6) {
    seen.add(cur.id);
    const acc = plan.reached.get(cur.id);
    if (!acc) return null;
    if (acc.pad.y <= step) { chain.unshift({ x: acc.pad.x, z: acc.pad.z, y: 0 }); break; }
    const host = plan.surfaces.find((s) => Math.abs(s.y - acc.pad.y) < 1e-6
      && Math.hypot(s.x - acc.pad.x, s.z - acc.pad.z) < 1e-6);
    if (!host) { chain.unshift({ x: acc.pad.x, z: acc.pad.z, y: acc.pad.y }); break; }
    chain.unshift({ x: host.x, z: host.z, y: host.y });
    cur = host;
  }
  return chain;
}

say(`jump peak ${(MOVE.jumpVel ** 2 / (2 * MOVE.gravity)).toFixed(3)} m, step ${step}, `
  + `reach ${reach} horizontal, lift ${lift} vertical`);
say(`seeds ${SEEDS} from ${BASE}`);
say('');

const fails = [];
let total = 0, taken = 0, noLadder = 0, chained = 0;

for (let s = 0; s < SEEDS; s++) {
  const seed = s === 0 ? BASE : `${BASE}#${s}`;
  const core = buildCore(level, { seed, count: 6 });
  const plan = climbPlan(level, core.nav);
  for (const p of core.prizes) {
    total += 1;
    if (p.stand && p.stand.y > step) {
      // how did the graph get up there: from the floor, or from another rung?
      const surf = plan.surfaces.find((x) => Math.abs(x.y - p.stand.y) < 1e-6
        && Math.hypot(x.x - p.stand.x, x.z - p.stand.z) < 1e-6);
      const acc = surf && plan.reached.get(surf.id);
      if (acc && acc.pad.y > step) chained += 1;
    }
    const chain = ladderOf(plan, p.stand);
    if (!chain) { noLadder += 1; fails.push({ seed, id: p.id, why: 'no ladder', stand: p.stand }); continue; }
    const av = new Avatar(level, core.nav, { x: level.spawn.x, z: level.spawn.z });
    av.teleport(chain[0].x, chain[0].z);
    for (let i = 1; i < chain.length; i++) {
      walkTo(av, chain[i].x, chain[i].z);
      hopToward(av, chain[i].x, chain[i].z);
    }
    walkTo(av, p.stand.x, p.stand.z, 120);
    av.update(DT, {});
    if (takeable(av, p)) taken += 1;
    else {
      const rungs = chain.map((c) => c.y);
      let detail = '';
      for (let i = 1; i < chain.length; i++) {
        detail += ` rung${i} d=${Math.hypot(chain[i].x - chain[i - 1].x, chain[i].z - chain[i - 1].z).toFixed(3)}`
          + ` dh=${(chain[i].y - chain[i - 1].y).toFixed(3)}`;
      }
      fails.push({
        seed, id: p.id, why: 'climb failed', standY: p.stand.y, padY: p.pad && p.pad.y,
        rungs, detail, dh: Math.hypot(av.x - p.x, av.z - p.z), dv: p.y - av.feetY,
      });
    }
  }
}

say(`packets ${total}   taken by a real body ${taken}   failures ${fails.length}`);
say(`packets whose standpoint needs a rung-from-a-rung: ${chained}`);
say(`packets with no ladder at all: ${noLadder}`);
say('');
if (fails.length) {
  say('failures:');
  for (const f of fails) {
    say(`   seed ${f.seed} ${f.id} ${f.why} standY ${f.standY} padY ${f.padY} `
      + `rungs [${(f.rungs || []).join(' -> ')}]${f.detail || ''}`
      + (f.dh != null ? `  ended dh ${f.dh.toFixed(3)} dv ${f.dv.toFixed(3)}` : ''));
  }
  say('');
}
say(`VERDICT: ${fails.length === 0 ? 'PASS' : 'FAIL'} — a real body took ${taken}/${total}`);

fs.writeFileSync(path.join(ROOT, 'work', '_ladder.log'), out.join('\n') + '\n');
