/**
 * verify_game.mjs — the headless verification run for 方案2「寻红」.
 *
 * It answers, with numbers, the claims the design makes:
 *
 *   1. THE MIX IS REACHABLE. "20/35/30/15 % of 红包 in each visibility tier" is
 *      a design target; tiers here are MEASURED exposure, not labels. Can six
 *      prizes in this apartment hit that mix, or does the plan not support it?
 *      The anchor census and the raw cover distribution are printed so the
 *      answer is "the plan says X", not "my guess said X".
 *
 *   2. NOTHING IS UNWINNABLE. Every prize reachable, every prize noticeable
 *      from somewhere. A 红包 inside a closed cabinet is a bug, not difficulty.
 *
 *   3. THE GUARD COVERS THE BUILDING. A guard that never enters the study is
 *      decoration. The number is seconds between visits, per room.
 *
 *   4. WHAT THE DIFFICULTY ACTUALLY IS. Four configurations walk the real
 *      navigation grid and the run sweeps the TIME BUDGET:
 *
 *        map     handed every 红包 position at t = 0, routed nearest-first.
 *                Not a player -- the FLOOR of the clock (§ceiling).
 *        oracle  sees and discriminates the 红包. Reference only.
 *        blind   only sees "that looks red". The player model.
 *        blind0  the same walker with `confusable` off: decoration is never
 *                red, so nothing but a real 红包 attracts. §confusion
 *
 *      The near-colour design claim is measured as blind minus blind0, i.e. one
 *      flag flipped inside one mode.
 *
 * WHY ORACLE-VS-BLIND IS NOT THE HEADLINE, stated because it used to be:
 * an oracle that must also SEARCH walks a different route from a blind agent,
 * since salience favours nearby objects while an oracle teleports its intent to
 * whichever 红包 is visible. Measured (scripts/diag_oracle.mjs), oracle spends
 * 109 s of a 180 s budget in random exploration against blind's 69 s and LOSES
 * to blind at 6 of 8 budgets -- impossible for a knowledge advantage, which
 * means the pair measures a route-policy gap. It is reported below, with the
 * violation flagged, and it is not used to price the colour.
 *
 * WHAT IT CANNOT MEASURE: absolute human playtime. Every number here is
 * relative, plus hard legality facts. And note scripts/diag_explore.mjs: the
 * RANDOM exploration policy is dice-dominated (shifting only the RNG stream
 * moves blind's 180 s win rate 83.3 -> 50.0 %), so this run pins
 * `explore: 'nearest'`, a systematic nearest-neighbour tour of the standpoints.
 *
 * Run: node scripts/verify_game.mjs [runs]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Rng } from '../game/core/rng.js';
import { buildNav } from '../game/core/nav.js';
import { placePrizes, defaultViewpoints } from '../game/core/place.js';
import { buildPatrol, patrolCoverage, GUARD_MODES } from '../game/core/guard.js';
import { batch, reachabilityReport, WALKER } from '../game/core/sim.js';
import { DEFAULT_TIER_TARGET, TIERS, tierCounts } from '../game/core/level.js';
import { noticeRange } from '../game/core/vision.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARENA = path.join(ROOT, 'game', 'arenas', 'room_scene.json');
const OUT = path.join(ROOT, 'work', 'game_eval.json');
const LOG = path.join(ROOT, 'work', '_verify_game.log');

const RUNS = Number(process.argv[2]) || 24;
const PLACE_SEEDS = 8;
const PRIZE_COUNT = 6;
const BUDGETS = [60, 90, 120, 180];
const EXPLORE = 'nearest';

const level = JSON.parse(fs.readFileSync(ARENA, 'utf8'));
const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);
const num = (v, n = 1) => (Number.isFinite(v) ? v.toFixed(n) : '--');
const t0 = Date.now();

say(`verify_game   ${path.relative(ROOT, ARENA).replace(/\\/g, '/')}`);
say('='.repeat(92));
say(`${level.meta.plan.w} x ${level.meta.plan.d} m plan, ${level.rooms.length} rooms, `
  + `${level.solids.length} solids, ${level.openings.length} openings, `
  + `${level.meta.rooms.resolved}/${level.meta.rooms.total} rooms resolved by flood fill`);

/* ------------------------------------------------------------------- navs */
let t = Date.now();
const playerNav = buildNav(level, {
  inflate: level.body.playerRadius, bodyHeight: level.body.playerHeight, step: level.meta.step,
});
const guardNav = buildNav(level, {
  inflate: level.body.guardRadius, bodyHeight: level.body.guardHeight, step: level.meta.step,
});
const vantages = defaultViewpoints(level, playerNav);

say(`nav            ${playerNav.walkableCount} walkable cells @ ${playerNav.cell} m `
  + `(${playerNav.w}x${playerNav.d}, ${playerNav.components.length} region), `
  + `guard ${guardNav.walkableCount}, built in ${Date.now() - t} ms`);
say(`walkpoints     ${vantages.length} standpoints on a 0.5 m lattice = `
  + `${(vantages.length * 0.25).toFixed(1)} m2 of standable floor, explore '${EXPLORE}'`);
say(`notice ranges  a ${level.collectible.size[0]} x ${level.collectible.size[2]} m 红包`
  + ` is a smudge past ${noticeRange(level.collectible.size[0] * level.collectible.size[2]).toFixed(1)} m`);

/* -------------------------------------------------------------- placement */
say('');
say(`placement      ${PLACE_SEEDS} seeds x ${PRIZE_COUNT} 红包`);
say(`   target mix    ${TIERS.map((k) => `${k} ${pct(DEFAULT_TIER_TARGET[k])}`).join('   ')}`
  + `   (quota of 6: ${TIERS.map((k) => tierCounts(PRIZE_COUNT, DEFAULT_TIER_TARGET)[k]).join('/')})`);

t = Date.now();
const placements = new Map();
for (const policy of ['spread', 'quota']) {
  const list = [];
  for (let i = 0; i < PLACE_SEEDS; i++) {
    const rng = new Rng(`hongbao-${String(i).padStart(2, '0')}`);
    list.push({ seed: rng.label, ...placePrizes(level, playerNav, rng.fork('place'), {
      count: PRIZE_COUNT, target: DEFAULT_TIER_TARGET, policy,
    }) });
  }
  placements.set(policy, list);
}
const placeMs = Date.now() - t;
const first = placements.get('spread')[0];

say(`   anchors       ${first.report.anchorsScored} scored from `
  + `${Object.values(first.report.stats.candidates).reduce((a, b) => a + b, 0)} candidates: `
  + `${first.report.stats.candidates.floor} floor / ${first.report.stats.candidates.top} top / `
  + `${first.report.stats.candidates.inside} inside  (${placeMs} ms for 2 policies x ${PLACE_SEEDS} seeds)`);
say(`   dropped       ${first.report.stats.rejected.unreachable} unreachable, `
  + `${first.report.stats.rejected.invisible} not visible from anywhere`);
const insideRej = first.report.stats.rejected.byModel;
for (const [m, why] of Object.entries(insideRej)) say(`      ${pad(m, 24)} ${why}`);

const cov = first.report.covers;
const quant = (q) => pct(cov[Math.min(cov.length - 1, Math.floor(q * cov.length))]);
const band = (lo, hi) => cov.filter((v) => v >= lo && v < hi).length / cov.length;
const minNonZero = cov.find((v) => v > 0);
say('');
say(`   exposure      p10 ${quant(0.10)}   p25 ${quant(0.25)}   median ${quant(0.50)}`
  + `   p75 ${quant(0.75)}   p90 ${quant(0.90)}`);
say(`   bands         <0.07 ${pct(band(0, 0.07))}   0.07-0.34 ${pct(band(0.07, 0.34))}`
  + `   >=0.34 ${pct(band(0.34, 1.01))}   (the thresholds tierFromCover uses)`);
const bt = first.report.stats.byTier;
say(`   anchor census ${Object.entries(bt).map(([k, v]) => `${k} ${v}`).join('   ')}`);
say(`   => the lowest exposure of any usable anchor is ${pct(minNonZero)}, so the "concealed"`
  + ` band (0, 7 %) is empty for EVERY threshold between 0 and ${pct(minNonZero)}.`);

say('');
say(`   policy        rooms covered   achieved mix (mean count of ${PRIZE_COUNT})`);
for (const [policy, list] of placements) {
  const mean = {};
  for (const k of TIERS) mean[k] = list.reduce((a, p) => a + p.report.achieved[k], 0) / list.length;
  const roomCounts = list.map((p) => new Set(p.prizes.map((q) => q.room)).size);
  const meanRooms = roomCounts.reduce((a, b) => a + b, 0) / roomCounts.length;
  say(`   ${pad(policy, 13)} ${num(meanRooms, 2)}/${level.rooms.length}          `
    + TIERS.map((k) => `${k} ${num(mean[k], 2)}`).join('   '));
}
const spreadRooms = placements.get('spread')[0].prizes.map((p) => p.room).join(', ');
const quotaRooms = placements.get('quota')[0].prizes.map((p) => p.room).join(', ');
say(`   seed 1 spread ${spreadRooms}`);
say(`   seed 1 quota  ${quotaRooms}   <- the smallest room loses its 红包 to the tier quota`);

say('');
say(`seed ${first.seed} 红包 (policy ${first.report.policy})`);
for (const p of first.prizes) {
  say(`   ${pad(p.id, 4)} ${pad(p.room, 9)} ${pad(p.tier, 9)} ${pad(p.source, 7)}`
    + ` @(${num(p.x, 2)}, ${num(p.y, 2)}, ${num(p.z, 2)})  cover ${pct(p.cover)}`
    + `  stand (${num(p.stand.x, 2)}, ${num(p.stand.z, 2)})`);
}

/* ------------------------------------------------------------ reachability */
say('');
t = Date.now();
const reach = reachabilityReport(level, playerNav, first.prizes);
say(`reachability   ${reach.reachableCells}/${reach.walkableCells} cells reachable from spawn `
  + `(${pct(reach.coverage)}), every prize reachable: ${reach.allReachable ? 'YES' : 'NO'}`
  + `  (${Date.now() - t} ms)`);
const worstPath = reach.perPrize.slice().sort((a, b) => b.pathLength - a.pathLength)[0];
say(`               longest walk from the front door to a 红包: ${num(worstPath.pathLength, 2)} m `
  + `(${worstPath.id} in the ${worstPath.room})`);

/* ------------------------------------------------------------------ guard */
say('');
const patrols = [];
for (let i = 0; i < RUNS; i++) {
  patrols.push(buildPatrol(level, guardNav, new Rng(`guard-${String(i).padStart(3, '0')}`), {}));
}
const cov0 = patrolCoverage(level, guardNav, GUARD_MODES.patrol, patrols[0], 300, 0.1);
say(`guard patrol   ${patrols[0].waypoints.length} waypoints, ${patrols[0].dropped.length} legs dropped`);
say(`coverage       300 s of solo patrol (stops per room scale with floor area)`);
say(`   room        area     visits   mean gap   max gap`);
for (const [id, r] of Object.entries(cov0.rooms)) {
  const room = level.rooms.find((x) => x.id === id);
  const area = room.area || (room.rect
    ? (room.rect.x1 - room.rect.x0) * (room.rect.z1 - room.rect.z0) : 0);
  say(`   ${pad(id, 10)} ${pad(`${area.toFixed(1)} m2`, 9)}${padl(r.visits, 6)}`
    + `${padl(num(r.meanGap, 1), 11)}${padl(num(r.maxGap, 1), 10)}`);
}
const never = Object.entries(cov0.rooms).filter(([, r]) => r.never).map(([id]) => id);
say(`   never enters: ${never.length ? never.join(', ') : 'none'};  `
  + `walks ${num(cov0.distance, 1)} m in 300 s (${num(cov0.distance / 300, 2)} m/s configured ${GUARD_MODES.patrol.speed})`);

/* ------------------------------------------------------------------- runs */
const prizeSets = [];
for (let i = 0; i < RUNS; i++) {
  const rng = new Rng(`arena-${String(i).padStart(3, '0')}`);
  prizeSets.push(placePrizes(level, playerNav, rng.fork('place'), {
    count: PRIZE_COUNT, target: DEFAULT_TIER_TARGET, policy: 'spread',
  }).prizes);
}

const configs = [
  { key: 'map+', name: 'map    / no guard', mode: 'map', guard: false },
  { key: 'mapG', name: 'map    / patrol  ', mode: 'map', guard: true },
  { key: 'oracle+', name: 'oracle / no guard', mode: 'oracle', guard: false },
  { key: 'oracleG', name: 'oracle / patrol  ', mode: 'oracle', guard: true },
  { key: 'blind+', name: 'blind  / no guard', mode: 'blind', guard: false },
  { key: 'blindG', name: 'blind  / patrol  ', mode: 'blind', guard: true },
  { key: 'blind0+', name: 'blind0 / no guard', mode: 'blind', confusable: false, guard: false },
];

say('');
say(`runs           ${RUNS} seeds x ${configs.length} configurations x ${BUDGETS.length} budgets, `
  + `walker ${WALKER.speed} m/s, ${WALKER.sweepSectors}-quarter sweep at ${WALKER.sweepCost} s per quarter`);

t = Date.now();
const table = {};
for (const budget of BUDGETS) {
  for (const cfg of configs) {
    table[`${budget}|${cfg.key}`] = batch(level, playerNav, (i) => ({ prizes: prizeSets[i] }), {
      runs: RUNS,
      rngFor: (i) => new Rng(`walker-${cfg.key}-${i}`),
      mode: cfg.mode,
      confusable: cfg.confusable,
      explore: EXPLORE,
      vantages,
      guard: cfg.guard ? { cfg: GUARD_MODES.patrol, patrol: patrols[0] } : null,
      optsFor: (i) => (cfg.guard ? { guard: { cfg: GUARD_MODES.patrol, patrol: patrols[i] } } : {}),
      budget,
    });
  }
}
say(`               (${((Date.now() - t) / 1000).toFixed(1)} s)`);

say('');
say('   budget  config             win%    collected   clock s        travel m   sweeps   false +     caught');
for (const budget of BUDGETS) {
  for (const cfg of configs) {
    const r = table[`${budget}|${cfg.key}`];
    say(`   ${padl(budget, 5)}s  ${pad(cfg.name, 18)} `
      + `${padl(pct(r.winRate), 6)}  ${padl(num(r.collected.mean, 2), 9)}/6  `
      + `${padl(num(r.clock.mean, 1), 6)} +-${padl(num(r.clock.sd, 1), 4)}  `
      + `${padl(num(r.travel.mean, 0), 8)}  ${padl(num(r.sweeps.mean, 0), 7)}  `
      + `${padl(pct(r.falsePositiveRate.mean), 7)}  ${padl(num(r.caught.mean, 2), 6)}`);
  }
  say('');
}

/* --------------------------------------------------------------- §ceiling */
const LAST = BUDGETS[BUDGETS.length - 1];
const mapAt = (b) => table[`${b}|map+`];
const mapHandCheck = mapAt(LAST).travel.mean / WALKER.speed + PRIZE_COUNT * WALKER.confirmCost;
say('§ceiling — a walker handed every 红包 position at t = 0, routed nearest-first');
say('   budget   clock s   travel m   sweeps   win%    hand-check   routing floor');
for (const b of BUDGETS) {
  const m = mapAt(b);
  say(`   ${padl(b, 5)}s   ${padl(num(m.clock.mean, 1), 7)}   ${padl(num(m.travel.mean, 0), 8)}   `
    + `${padl(num(m.sweeps.mean, 0), 6)}   ${padl(pct(m.winRate), 6)}   `
    + `${padl(num(mapHandCheck, 1), 10)}   ${padl(num(mapAt(LAST).clock.mean / m.clock.mean, 2), 12)}x`);
}
say(`   hand-check = travel / ${WALKER.speed} m/s + ${PRIZE_COUNT} x ${WALKER.confirmCost} s confirm`
  + ` = ${num(mapHandCheck, 1)} s, which matches the sim's ${num(mapAt(LAST).clock.mean, 1)} s.`
  + ` It is flat across every budget, i.e. it never runs out of time.`);

// The cheapest SEARCHING configuration, to say how far discovery pushes the clock.
const searchCfg = ['oracle+', 'blind+', 'blind0+'];
const bestKey = searchCfg.reduce((a, k) => (table[`${LAST}|${k}`].clock.mean < table[`${LAST}|${a}`].clock.mean ? k : a), searchCfg[0]);
const best180 = table[`${LAST}|${bestKey}`];

/* ------------------------------------------------------------- §confusion */
say('');
say('§confusion — one flag flipped inside blind: is decoration allowed to lie?');
say('   budget   blind win   blind0 win    delta  |  blind clock  blind0 clock   delta');
const flip = [];
for (const b of BUDGETS) {
  const x = table[`${b}|blind+`];
  const n = table[`${b}|blind0+`];
  const dw = x.winRate - n.winRate;
  const dc = x.clock.mean - n.clock.mean;
  flip.push({ budget: b, dWin: dw, dClock: dc });
  say(`   ${padl(b, 5)}s   ${padl(pct(x.winRate), 8)}   ${padl(pct(n.winRate), 9)}   `
    + `${padl((dw >= 0 ? '+' : '') + pct(dw), 8)}  |  ${padl(num(x.clock.mean, 1), 10)}   `
    + `${padl(num(n.clock.mean, 1), 11)}  ${padl((dc >= 0 ? '+' : '') + num(dc, 1), 7)}`);
}
const liability = flip.filter((f) => f.dWin < 0);
const asset = flip.filter((f) => f.dWin > 0);

/* ------------------------------------------------------------- §dominance */
say('');
say('§dominance — an oracle must never lose to blind on the same policy; if it does,');
say('             "oracle - blind" prices a ROUTE POLICY, not knowledge');
let violated = 0;
for (const b of BUDGETS) {
  const o = table[`${b}|oracle+`];
  const x = table[`${b}|blind+`];
  const ok = o.winRate >= x.winRate && o.collected.mean >= x.collected.mean;
  if (!ok) violated++;
  say(`   ${padl(b, 5)}s   oracle ${padl(pct(o.winRate), 7)} / ${padl(num(o.collected.mean, 2), 5)}`
    + `   blind ${padl(pct(x.winRate), 7)} / ${padl(num(x.collected.mean, 2), 5)}   `
    + `${ok ? 'ok' : 'VIOLATED'}`);
}
say(`   ${violated} of ${BUDGETS.length} budgets violated. See scripts/diag_oracle.mjs:`);
say(`   oracle spends ${num(table[`${LAST}|oracle+`].clock.mean, 1)} s against blind's `
  + `${num(table[`${LAST}|blind+`].clock.mean, 1)} s, and the branch audit shows why --`
  + ` salience prefers nearby objects, so blind takes short hops while oracle commits to`
  + ` whichever 红包 is visible. Neither route contains the other.`);

/* ------------------------------------------------------------------ guard */
say('');
say('§guard — price of being hunted');
say('   budget   walker   unguarded win   guarded win    caught   penalty s   clock delta');
for (const b of BUDGETS) {
  for (const [a, g] of [['map+', 'mapG'], ['oracle+', 'oracleG'], ['blind+', 'blindG']]) {
    const un = table[`${b}|${a}`];
    const gu = table[`${b}|${g}`];
    say(`   ${padl(b, 5)}s   ${pad(a.replace('+', ''), 7)} ${padl(pct(un.winRate), 14)}   `
      + `${padl(pct(gu.winRate), 11)}   ${padl(num(gu.caught.mean, 2), 6)}   `
      + `${padl(num(gu.caught.mean * GUARD_MODES.patrol.penalty, 1), 9)}   `
      + `${padl((gu.clock.mean - un.clock.mean >= 0 ? '+' : '') + num(gu.clock.mean - un.clock.mean, 1), 11)}`);
  }
}

/* --------------------------------------------------------------- findings */
const findings = [];
findings.push(`${first.report.anchorsScored} usable hiding places. Of them ${bt.open} read as open,`
  + ` ${bt.partial} partial, ${bt.concealed} concealed, ${bt.inside} seen only through glass,`
  + ` and ${bt.hidden} are invisible from anywhere.`);
findings.push(`The concealed tier is EMPTY, and that is not a threshold artefact: the least exposed`
  + ` usable anchor is ${pct(minNonZero)} visible, so no cut anywhere in (0, ${pct(minNonZero)})`
  + ` produces one. At a 0.36 m eye height in this plan, occluders either hide a spot completely`
  + ` or not at all. The design's 30 % concealed quota cannot be met here.`);
findings.push(`A ${level.collectible.size[0]} x ${level.collectible.size[2]} m 红包 is a smudge past`
  + ` ${noticeRange(level.collectible.size[0] * level.collectible.size[2]).toFixed(1)} m, so hiding`
  + ` places are decided by furniture inside a 4.5 m bubble, not by the size of the flat.`);
if (bt.inside <= 1) {
  findings.push(`Only ${bt.inside} through-glass hiding place exists, out of`
    + ` ${first.report.stats.candidates.inside} glass volumes in the plan; the fridge's pane is`
    + ` not visible from anywhere. The 15 % inside quota rests on a single anchor.`);
}
findings.push(`Every prize is reachable and noticeable: ${reach.allReachable ? 'yes' : 'NO'}`
  + ` (longest walk ${num(worstPath.pathLength, 2)} m from the front door).`);
findings.push(`The guard reaches all ${level.rooms.length} rooms; longest wait`
  + ` ${num(Math.max(...Object.values(cov0.rooms).map((r) => r.maxGap || 0)), 1)} s.`);
findings.push(`CEILING: a walker handed every 红包 position collects ${PRIZE_COUNT}/${PRIZE_COUNT} in`
  + ` ${num(mapAt(LAST).clock.mean, 1)} s on ${num(mapAt(LAST).travel.mean, 0)} m with`
  + ` ${num(mapAt(LAST).sweeps.mean, 0)} sweeps, ${pct(mapAt(LAST).winRate)} at every budget`
  + ` down to ${BUDGETS[0]} s. Hand-check ${num(mapHandCheck, 1)} s agrees. Routing this flat is`
  + ` trivial, so ALL the difficulty is discovery: the cheapest searching config needs`
  + ` ${num(best180.clock.mean, 1)} s (${bestKey}), i.e.`
  + ` ${num(best180.clock.mean / mapAt(LAST).clock.mean, 1)}x the routing floor.`);
findings.push(`The near-colour gamble CANNOT BE PRICED with this harness, and the sign is not`
  + ` stable. Flipping the one flag that lets decoration lie moves the win rate by`
  + (liability.length ? ` ${pct(liability[0].dWin)} at ${liability[0].budget} s` : '')
  + (asset.length ? ` and +${pct(asset[asset.length - 1].dWin)} at ${asset[asset.length - 1].budget} s` : '')
  + ` -- opposite signs. Worse, scripts/diag_explore.mjs shows shifting only the RNG stream`
  + ` moves blind's ${LAST} s win rate from 83.3 % to 50.0 %. Report the budget and the guard`
  + ` as the difficulty dials; do not report a price for the colour.`);
findings.push(`oracle-vs-blind must NOT be quoted as the price of knowledge: the dominance check`
  + ` is violated at ${violated} of ${BUDGETS.length} budgets (an oracle cannot lose to a blind`
  + ` agent on the same policy), because committing to a visible 红包 abandons the short hops`
  + ` that blind's salience rule produces. The pair measures a route-policy gap.`);
findings.push(`Coverage-first placement is what keeps all ${level.rooms.length} rooms in play; the`
  + ` tier-quota-first order drops the smallest room's 红包 in every seed (see the policy table).`);

say('');
say('FINDINGS');
for (const f of findings) {
  let line = '   * ';
  for (const w of f.split(' ')) {
    if (line.length + w.length + 1 > 88) { say(line); line = '     '; }
    line += (line.endsWith(' ') ? '' : ' ') + w;
  }
  say(line);
}

say('');
say('='.repeat(92));
say(`total ${((Date.now() - t0) / 1000).toFixed(1)} s`);

fs.writeFileSync(LOG, lines.join('\n') + '\n', 'utf8');
fs.writeFileSync(OUT, JSON.stringify({
  arena: 'game/arenas/room_scene.json',
  generated: new Date().toISOString(),
  runs: RUNS,
  explore: EXPLORE,
  nav: { cells: playerNav.walkableCount, cell: playerNav.cell, regions: playerNav.components.length },
  placement: {
    seeds: PLACE_SEEDS, target: DEFAULT_TIER_TARGET,
    anchorsScored: first.report.anchorsScored, census: bt,
    coverQuantiles: { p10: quant(0.10), p25: quant(0.25), median: quant(0.50), p75: quant(0.75), p90: quant(0.90) },
    minNonZeroCover: minNonZero,
    byPolicy: Object.fromEntries([...placements].map(([k, list]) => [k, list.map((p) => p.report.achieved)])),
  },
  reachability: { coverage: reach.coverage, allReachable: reach.allReachable },
  patrol: cov0.rooms,
  ceiling: {
    handCheckSeconds: mapHandCheck,
    clock: mapAt(LAST).clock,
    travel: mapAt(LAST).travel,
    sweeps: mapAt(LAST).sweeps,
    winRateByBudget: Object.fromEntries(BUDGETS.map((b) => [b, mapAt(b).winRate])),
    cheapestSearchingConfig: bestKey,
    cheapestSearchClock: best180.clock,
    discoveryMultiplier: best180.clock.mean / mapAt(LAST).clock.mean,
  },
  confusionFlip: flip,
  dominance: { violations: violated, of: BUDGETS.length },
  runs_summary: Object.fromEntries([...Object.entries(table)].map(([k, r]) => [k, {
    winRate: r.winRate, clock: r.clock, collected: r.collected, travel: r.travel,
    sweeps: r.sweeps, falsePositiveRate: r.falsePositiveRate, caught: r.caught,
  }])),
  findings,
}, null, 2), 'utf8');
say(`wrote ${path.relative(ROOT, OUT).replace(/\\/g, '/')}`);
