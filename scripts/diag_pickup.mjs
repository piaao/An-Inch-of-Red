/**
 * diag_pickup.mjs — how close can a player actually STAND to a 红包?
 *
 * The arena declares `collectible.pickup = 0.42`, but nothing in the verified
 * pipeline ever enforced that number: `placePrizes` proved reachability with
 * `reachable(...)`'s 0.55 m default, and `runSearch` "collects" as soon as A*
 * reaches the target, with no radius test at all. A play layer that grabs the
 * declared 0.42 would silently make some 红包 unpickable -- the design's own
 * "a 红包 nobody can grab is a bug, not a challenge".
 *
 * So measure it: for every prize, the distance to the nearest standable cell.
 * The largest of those is the reach the play layer MUST offer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rng } from '../game/core/rng.js';
import { buildNav } from '../game/core/nav.js';
import { placePrizes, defaultViewpoints } from '../game/core/place.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const level = JSON.parse(fs.readFileSync(
  path.join(HERE, '..', 'game', 'arenas', 'room_scene.json'), 'utf8'));

const nav = buildNav(level, {
  inflate: level.body.playerRadius, bodyHeight: level.body.playerHeight, step: level.meta.step,
});

const SEEDS = ['hongbao-01', 'hongbao-02', 'hongbao-03', 'hongbao-04',
               'hongbao-05', 'hongbao-06', '2026-09-25', 'hongbao-07'];

function minStandGap(prize) {
  let best = Infinity;
  let at = null;
  const r = 1.2;
  const j0 = Math.max(0, Math.floor((prize.z - r) / nav.cell));
  const j1 = Math.min(nav.d - 1, Math.ceil((prize.z + r) / nav.cell));
  const i0 = Math.max(0, Math.floor((prize.x - r) / nav.cell));
  const i1 = Math.min(nav.w - 1, Math.ceil((prize.x + r) / nav.cell));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (!nav.walkable[j * nav.w + i]) continue;
      const c = nav.centreOf(i, j);
      const d = Math.hypot(c.x - prize.x, c.z - prize.z);
      if (d < best) { best = d; at = c; }
    }
  }
  return { gap: best, at };
}

const out = [];
const say = (s) => { out.push(s); console.log(s); };

let worst = 0;
let worstAt = '';
const perTier = new Map();

for (const seed of SEEDS) {
  const { prizes } = placePrizes(level, nav, new Rng(seed).fork('place'),
    { count: 6, policy: 'spread', viewpoints: defaultViewpoints(level, nav) });
  say(`seed ${seed}`);
  for (const p of prizes) {
    const { gap } = minStandGap(p);
    const lift = p.y;                       // standing on the floor, feet at 0
    if (gap > worst) { worst = gap; worstAt = `${seed}/${p.id} ${p.room} ${p.tier}`; }
    if (!perTier.has(p.tier)) perTier.set(p.tier, []);
    perTier.get(p.tier).push(gap);
    say(`   ${p.id} ${p.room.padEnd(8)} ${p.tier.padEnd(9)} `
      + `stand gap ${gap.toFixed(3)} m   lift ${lift.toFixed(3)} m`);
  }
}

say('');
say(`declared collectible.pickup = ${level.collectible.pickup} m`);
say(`WORST stand gap over ${SEEDS.length} seeds x 6 = ${SEEDS.length * 6} prizes: `
  + `${worst.toFixed(3)} m  (${worstAt})`);
for (const [tier, list] of perTier) {
  const mx = Math.max(...list);
  say(`   max by tier: ${tier.padEnd(9)} ${mx.toFixed(3)} m over ${list.length}`);
}
say('');
say(worst <= level.collectible.pickup
  ? `VERDICT: the declared 0.42 m reach is SUFFICIENT for every placed 红包.`
  : `VERDICT: the declared 0.42 m reach is TOO SMALL -- ${worst.toFixed(3)} m is needed.`);

fs.writeFileSync(path.join(HERE, '..', 'work', '_pickup.log'), out.join('\n') + '\n');
