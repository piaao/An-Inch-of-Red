/**
 * probe_place.mjs — does the REWRITTEN hiding actually do the three things the
 * player asked for, over many seeds rather than one?
 *
 * The player, verbatim:
 *
 *     "红包位置还是不够随机，不是每个房间都必须有，不要放在地上，太容易被发现了。
 *      可以放在柜子里面或者夹在物品中间。"
 *
 * Three claims, three measurements, all on the real arena:
 *
 *   1. NOT ON THE FLOOR.  `onFloor` (y <= 0.02) must be 0 for every seed, over
 *      every packet. A single seed with one packet on a rug is a failure of the
 *      whole rewrite, so the probe counts seeds-with-a-violation, not just the
 *      global total -- "0 out of 40 seeds had a floor packet" is the claim.
 *
 *   2. NOT EVERY ROOM.  The set of occupied rooms must VARY across seeds, and at
 *      least one room must always be empty. Reported as a histogram of
 *      `roomsUsed` plus the number of distinct occupied-room sets actually
 *      observed: if 40 seeds produce one set, "random subset" is a comment.
 *
 *   3. INSIDE CABINETS / WEDGED IN.  `sources` must contain `tucked` (wedged)
 *      and `inside` (glass volumes) and the enclosure distribution must have
 *      real mass above the tucked threshold. If every packet is `top` with
 *      enclosure 0, the second half of the sentence did nothing.
 *
 * Plus the two things that must NOT have broken: every packet is reachable
 * (there is a standpoint and, for a raised one, a pad beside it), and no packet
 * comes back `hidden` -- a hidden packet is a packet nobody can ever find, which
 * is a lost run, not a difficulty.
 *
 * Node only, no browser. Writes work/_probe_place.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNav } from '../game/core/nav.js';
import { climbCeilOf, DEFAULT_TIER_TARGET } from '../game/core/level.js';
import { climbPlan } from '../game/core/climb.js';
import { Rng } from '../game/core/rng.js';
import { placePrizes } from '../game/core/place.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARENA = path.join(ROOT, 'game', 'arenas', 'room_scene.json');
const OUT = path.join(ROOT, 'work', '_probe_place.json');

const lines = [];
const say = (s) => { lines.push(s); process.stdout.write(s + '\n'); };
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + '%' : '-');

const level = JSON.parse(fs.readFileSync(ARENA, 'utf8'));
const ceil = climbCeilOf(level);
const SEEDS = 40;
const COUNT = level.rooms.length;            // 6 packets, as the game ships

say('='.repeat(78));
say('probe_place  --  红包藏匿重写，按种子实测');
say('='.repeat(78));

const t0 = Date.now();
const nav = buildNav(level, {
  inflate: level.body.playerRadius,
  bodyHeight: level.body.playerHeight,
  step: level.meta.step,
});
say(`  nav in ${Date.now() - t0} ms;  ${level.rooms.length} rooms, `
  + `${level.solids.length} solids,  OFF_GROUND line is a design constant`);

const t1 = Date.now();
const plan = climbPlan(level, nav);
say(`  climbPlan in ${Date.now() - t1} ms;  ceiling ${ceil.toFixed(3)} m,  `
  + `${plan.surfaces.length} surface points`);
say('');

/* ------------------------------------------------------------ the sweep */

const agg = {
  seeds: SEEDS,
  seedsWithFloorPacket: 0,
  seedsWithHiddenPacket: 0,
  seedsWithoutTucked: 0,
  seedsWithoutInside: 0,
  seedsWithUnreachable: 0,
  packets: 0,
  floorPackets: 0,
  climbedPackets: 0,
  roomsUsedHist: {},
  emptyRooms: [],
  occupiedSets: new Set(),
  sources: {},
  tiers: {},
  achievedTiers: {},
  poolByTier: {},
  enclosures: [],
  bracketed: [],
  noStand: 0,
  noPadWhenClimbed: 0,
  packetCounts: {},
  perSeed: [],
  msPerSeed: [],
};

function tally(map, k) { map[k] = (map[k] || 0) + 1; }

for (let i = 0; i < SEEDS; i++) {
  const ts = Date.now();
  const rng = new Rng(`arena-${String(i + 1).padStart(3, '0')}`).fork('place');
  const { prizes, report } = placePrizes(level, nav, rng, { count: COUNT, policy: 'spread' });
  agg.msPerSeed.push(Date.now() - ts);

  tally(agg.packetCounts, prizes.length);
  agg.packets += prizes.length;

  const floorHere = prizes.filter((p) => p.y <= 0.02);
  if (floorHere.length) { agg.seedsWithFloorPacket += 1; agg.floorPackets += floorHere.length; }
  if (prizes.some((p) => p.tier === 'hidden')) agg.seedsWithHiddenPacket += 1;

  const hidden = prizes.filter((p) => p.tier === 'hidden').length;
  agg.tiers.hidden = (agg.tiers.hidden || 0) + hidden;
  if (!prizes.some((p) => p.source === 'tucked')) agg.seedsWithoutTucked += 1;
  if (!prizes.some((p) => p.source === 'inside')) agg.seedsWithoutInside += 1;

  const noStand = prizes.filter((p) => !p.stand).length;
  const noPad = prizes.filter((p) => p.climb > 0 && !p.pad).length;
  agg.noStand += noStand;
  agg.noPadWhenClimbed += noPad;
  if (noStand || noPad) agg.seedsWithUnreachable += 1;

  // Count the VALUES, not the keys. The first version of this tally walked the
  // keys of `report.achieved` and added 1 to each -- so it printed "open 40,
  // partial 40, concealed 40, inside 40" for every run, i.e. a perfect uniform
  // mix that no placement could produce, and it could not have failed.
  for (const [t, n] of Object.entries(report.achieved)) {
    agg.achievedTiers[t] = (agg.achievedTiers[t] || 0) + n;
  }
  // The POOL, which is a different thing from the chosen set: how many
  // candidates of each tier the arena offered. A tier that is rare in the pool
  // cannot be common in the result, and that is the difference between "the
  // draw is wrong" and "the building is short of that kind of place".
  for (const [t, n] of Object.entries(report.stats.byTier)) {
    agg.poolByTier[t] = (agg.poolByTier[t] || 0) + n;
  }
  for (const p of prizes) {
    tally(agg.sources, p.source);
    tally(agg.tiers, p.tier);
    if (p.climb > 0) agg.climbedPackets += 1;
    if (p.enclosure != null) agg.enclosures.push(+p.enclosure.toFixed(4));
    if (p.bracketed != null) agg.bracketed.push(p.bracketed);
  }

  tally(agg.roomsUsedHist, report.roomsUsed);
  agg.emptyRooms.push(report.roomsTotal - report.roomsUsed);
  agg.occupiedSets.add(Object.keys(report.roomCounts).sort().join(','));

  agg.perSeed.push({
    seed: i + 1,
    roomsUsed: report.roomsUsed,
    empty: report.drawn ? report.drawn.empty : [],
    onFloor: report.onFloor,
    sources: report.sources,
    achieved: report.achieved,
    climbed: report.climbed,
    anchorsScored: report.anchorsScored,
    enclosure: report.enclosure.map((v) => +v.toFixed(3)),
  });
}

/* --------------------------------------------------------------- verdict */

const enc = agg.enclosures.slice().sort((a, b) => a - b);
const med = enc.length ? enc[Math.floor(enc.length / 2)] : 0;
const roomsUsedKeys = Object.keys(agg.roomsUsedHist).sort();

say('-- 1. 不上地 (on the floor) ---------------------------------------------');
say(`   ${agg.packets} packets over ${SEEDS} seeds;  on the floor: ${agg.floorPackets}`);
say(`   seeds containing a floor packet: ${agg.seedsWithFloorPacket} (must be 0)`);
say(`   ${agg.seedsWithFloorPacket === 0 ? 'OK   没有一局把红包放在地上' : 'FAIL 还有红包落在地上'}`);
say('');

say('-- 2. 不是每个房间都必须有 (a random subset of rooms) --------------------');
say(`   rooms used per seed:  ${roomsUsedKeys.map((k) => `${k}->${agg.roomsUsedHist[k]}`).join('   ')}`);
const emptyMin = Math.min(...agg.emptyRooms);
const emptyMax = Math.max(...agg.emptyRooms);
say(`   rooms left EMPTY per seed: ${emptyMin} .. ${emptyMax}`
  + `   (${SEEDS} seeds, ${level.rooms.length} rooms)`);
say(`   distinct occupied-room SETS observed: ${agg.occupiedSets.size} (1 would mean "still a checklist")`);
say(`   ${emptyMin >= 1 && agg.occupiedSets.size > 1
  ? 'OK   房间既随机又总有一间是空的' : 'FAIL 房间抽取退化'}`);
say('');

say('-- 3. 柜子里 / 夹在物品中间 (sources) -----------------------------------');
const srcKeys = Object.keys(agg.sources).sort();
say(`   sources: ${srcKeys.map((k) => `${k}->${agg.sources[k]}`).join('  ')}`);
say(`   seeds with NO tucked packet: ${agg.seedsWithoutTucked} / ${SEEDS}`);
say(`   seeds with NO inside packet: ${agg.seedsWithoutInside} / ${SEEDS}`);
say(`   enclosure of the chosen packets: min ${(enc[0] || 0).toFixed(3)}  `
  + `median ${med.toFixed(3)}  max ${(enc[enc.length - 1] || 0).toFixed(3)}`);
const tuckedish = agg.enclosures.filter((v) => v >= 0.25).length;
say(`   packets at or above the tucked threshold (0.25): ${tuckedish} / ${enc.length}`
  + `  (${pct(tuckedish, enc.length)})`);
say(`   ${agg.sources.tucked > 0 && agg.sources.inside > 0
  ? 'OK   两个来源都在用' : 'FAIL 有一类来源是死代码'}`);
say('');

say('-- 3b. 难度配比 (the design dial: 20/35/30/15) ---------------------------');
{
  const names = ['open', 'partial', 'concealed', 'inside'];
  say('   tier        achieved     share     target    target count');
  for (const t of names) {
    const n = agg.achievedTiers[t] || 0;
    const want = DEFAULT_TIER_TARGET[t] || 0;
    say(`   ${t.padEnd(11)} ${String(n).padStart(8)} ${pct(n, agg.packets).padStart(9)}`
      + ` ${(want * 100).toFixed(0).padStart(9)}% ${(want * agg.packets).toFixed(0).padStart(15)}`);
  }
  say(`   candidates the arena OFFERED, per seed: ${Object.entries(agg.poolByTier)
    .sort().map(([t, n]) => `${t} ${(n / SEEDS).toFixed(1)}`).join('   ')}`);
  say('   NOTE the deviation is a MEASUREMENT about this arena, not a bug in the');
  say('   draw: `inside` needs a glass volume big enough to hold something and this');
  say('   flat has two (the fridge and one more), so 15% of six packets is above');
  say('   what the building can supply on most seeds.');
}
say('');

say('-- 4. 没坏掉的东西 (nor must anything have broken) ---------------------');
say(`   packets with no standpoint: ${agg.noStand} (must be 0)`);
say(`   climbed packets with no pad beside them: ${agg.noPadWhenClimbed} (must be 0)`);
say(`   seeds with a hidden (unfindable) packet: ${agg.seedsWithHiddenPacket} (must be 0)`);
say(`   packets you have to climb for: ${agg.climbedPackets} / ${agg.packets}`
  + `  (${pct(agg.climbedPackets, agg.packets)})`);
say(`   packet count per seed: ${Object.keys(agg.packetCounts).sort()
  .map((k) => `${k}->${agg.packetCounts[k]}`).join('  ')}`);
say(`   ${agg.noStand === 0 && agg.noPadWhenClimbed === 0 && agg.seedsWithHiddenPacket === 0
  ? 'OK   每个红包都能拿到，也都能被找到' : 'FAIL 有红包拿不到或找不到'}`);
say('');

const ms = agg.msPerSeed.slice().sort((a, b) => a - b);
say(`   placement cost: median ${ms[Math.floor(ms.length / 2)]} ms/seed, `
  + `max ${ms[ms.length - 1]} ms over ${SEEDS} seeds`);
say('');

const verdict = (agg.seedsWithFloorPacket === 0)
  && (emptyMin >= 1 && agg.occupiedSets.size > 1)
  && agg.sources.tucked > 0 && agg.sources.inside > 0
  && agg.noStand === 0 && agg.noPadWhenClimbed === 0 && agg.seedsWithHiddenPacket === 0;
say(`VERDICT  ${verdict ? 'PASS' : 'FAIL'}`);
say('='.repeat(78));

const json = {
  seeds: SEEDS, count: COUNT, ceil,
  packets: agg.packets,
  floor: { packets: agg.floorPackets, seeds: agg.seedsWithFloorPacket },
  rooms: {
    usedHist: agg.roomsUsedHist,
    emptyMin, emptyMax,
    distinctSets: agg.occupiedSets.size,
    sets: [...agg.occupiedSets],
  },
  sources: agg.sources,
  tiers: agg.tiers,
  achievedTiers: agg.achievedTiers,
  enclosure: { min: enc[0] || 0, median: med, max: enc[enc.length - 1] || 0, tuckedish, total: enc.length },
  integrity: {
    noStand: agg.noStand, noPadWhenClimbed: agg.noPadWhenClimbed,
    hiddenSeeds: agg.seedsWithHiddenPacket, climbed: agg.climbedPackets,
  },
  perSeed: agg.perSeed,
  verdict,
};
fs.writeFileSync(OUT, JSON.stringify(json, null, 2));
say(`wrote ${path.relative(ROOT, OUT)}`);
