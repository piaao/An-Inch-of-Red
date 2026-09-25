/**
 * measure_surveil.mjs — re-measure §6 for the presets that MOVED.
 *
 * Why this file has to exist before config.js may quote a number.
 *
 * The difficulty menu now carries two dials that change the game:
 *
 *   surv   a multiplier on the guard's cone angle and range (监控扇区)
 *   prize  a multiplier on the 红包's own size
 *
 * `prize` is not cosmetic. `redCensus` gates "is that red thing noticeable"
 * on `noticeRange(prizeArea)`, and `runSearch` calls `redCensus` on the level
 * it is handed -- so shrinking the packet shrinks the AI's notice range too.
 * A preset whose prize is smaller is therefore a preset whose measured win
 * rate is OLDER, and quoting the old one would be the exact lie the menu was
 * written to avoid.
 *
 * So: run the §6 rig again, unchanged, for every configuration that moved,
 * including a CONTROL (blind / patrol at 120 s) that must reproduce the
 * number already printed in VERDICT §6. If the control moves, the rig moved
 * and none of the new numbers mean anything either.
 *
 * Usage: node scripts/measure_surveil.mjs [runs]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Rng } from '../game/core/rng.js';
import { buildNav } from '../game/core/nav.js';
import { placePrizes, defaultViewpoints, climbViewpoints, playerViewpoints } from '../game/core/place.js';
import { climbPlan } from '../game/core/climb.js';
import { buildPatrol, GUARD_MODES } from '../game/core/guard.js';
import { batch, WALKER } from '../game/core/sim.js';
import { noticeRange } from '../game/core/vision.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARENA = path.join(ROOT, 'game', 'arenas', 'room_scene.json');
const OUT = path.join(ROOT, 'work', 'surveil_eval.json');
const LOG = path.join(ROOT, 'work', '_measure_surveil.log');

const RUNS = Number(process.argv[2]) || 24;
const PRIZE_COUNT = 6;
const EXPLORE = 'nearest';
// EVERY BUDGET THE SHIPPED DIFFICULTY CARDS USE (game/play/config.js): 见习
// 240 s, 标准 180 s, 紧张 120 s, 硬核 120 s. The rig used to run 120/180 only,
// which meant the 见习 card's own budget was never measured -- a card quoting a
// number nobody took. Each preset is read at ITS OWN budget below.
const BUDGETS = [120, 180, 240];

const level = JSON.parse(fs.readFileSync(ARENA, 'utf8'));
const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const num = (v, n = 1) => (Number.isFinite(v) ? v.toFixed(n) : '--');

/** The nominal floor area the fan sweeps. Geometry, not a play measurement. */
export function fanArea(coneDeg, range) {
  return 0.5 * (coneDeg * Math.PI / 180) * range * range;
}

/** A copy of the level whose only difference is the size of the 红包. */
function withPrizeScale(src, scale) {
  if (scale === 1) return src;
  const size = src.collectible.size.map((v) => v * scale);
  return { ...src, collectible: { ...src.collectible, size } };
}

/**
 * The configurations to measure. `guard.scale` is applied to the BASE mode's
 * coneDeg and range exactly the way play.js will apply it.
 */
const CONFIGS = [
  // 1.15 IS the 见习 card's prizeScale (config.js). This row used 1.00 for
  // a while, which meant the card with the BIGGEST packet carried a win
  // rate measured on a packet 15 % smaller -- and `prizeScale` is not
  // cosmetic: it moves `noticeRange(prizeArea)`, which is what gates the
  // census. The easiest card is the worst place to quote a wrong number.
  { key: 'blind|none', label: 'blind / no guard   ', mode: 'blind', base: null, surv: null, prize: 1.15 },
  { key: 'blind|patrol', label: 'blind / patrol 74/4.2', mode: 'blind', base: 'patrol', surv: 1.00, prize: 1.00 },
  { key: 'blind|tight', label: 'blind / tight  88/5.0', mode: 'blind', base: 'patrol', surv: 1.19, prize: 0.85 },
  { key: 'blind|hunter', label: 'blind / hunter 96/6.0', mode: 'blind', base: 'hunter', surv: 1.00, prize: 0.70 },
];

function scaled(base, surv) {
  const b = GUARD_MODES[base];
  if (!b) return null;
  return { ...b, coneDeg: b.coneDeg * surv, range: b.range * surv };
}

/* ------------------------------------------------------------------- navs */
const playerNav = buildNav(level, {
  inflate: level.body.playerRadius, bodyHeight: level.body.playerHeight, step: level.meta.step,
});
const guardNav = buildNav(level, {
  inflate: level.body.guardRadius, bodyHeight: level.body.guardHeight, step: level.meta.step,
});
// WHICH VANTAGES THE PERSONA GETS IS THE WHOLE MEASUREMENT, so all three
// lists are built here and two of them survive as named controls.
//
//   playerVantages   what the headline table uses: one turn per room plus
//                    one standpoint per climbable model (place.js
//                    `playerViewpoints`). ~20 points, and the only one of
//                    the three that fits a 120 s budget.
//   floorVantages    the 0.5 m floor lattice, floor eye. Its climbed
//                    sibling is used to build the third list; the lattice
//                    itself is control A's OTHER half.
//   latticeVantages  floor + climbed lattice, 269 points. Control B, kept
//                    for one reason: it is the persona the OLD §6 numbers
//                    were measured with, and it collapses. 269 looks x
//                    2.2 s is 592 s of turning, so a lattice walker cannot
//                    cover this flat at ANY budget -- a fact about the
//                    harness, which is exactly why it must not be the
//                    headline.
const plan = climbPlan(level, playerNav);
const floorVantages = defaultViewpoints(level, playerNav);
const climbedVantages = climbViewpoints(level, playerNav, plan);
const latticeVantages = [...floorVantages, ...climbedVantages];
const playerVantages = playerViewpoints(level, playerNav, plan);
const vantages = playerVantages;

say(`measure_surveil  runs ${RUNS} x ${CONFIGS.length} configs x budgets ${BUDGETS.join('/')}s`);
const roomLooks = playerVantages.filter((v) => v.kind === 'room').length;
const climbedLooks = playerVantages.filter((v) => v.kind === 'climbed').length;
say(`   persona: ${playerVantages.length} look-points = ${roomLooks} room turns + `
  + `${climbedLooks} climbs, eye ${level.body.eyeHeight} m on the floor and y + eye on the furniture`);
say(`   controls: the same player without the climbs, and the ${latticeVantages.length}-point lattice`);
say('='.repeat(92));

const prizeSets = [];
for (let i = 0; i < RUNS; i++) {
  const rng = new Rng(`arena-${String(i).padStart(3, '0')}`);
  prizeSets.push(placePrizes(level, playerNav, rng.fork('place'), {
    count: PRIZE_COUNT, policy: 'spread',
  }).prizes);
}
const patrols = [];
for (let i = 0; i < RUNS; i++) {
  patrols.push(buildPatrol(level, guardNav, new Rng(`guard-${String(i).padStart(3, '0')}`), {}));
}

say('');
say('   config                 coneDeg  range m   fan m2   prize m      notice m');
for (const c of CONFIGS) {
  const cfg = c.base ? scaled(c.base, c.surv) : null;
  const size = level.collectible.size.map((v) => v * c.prize);
  const area = size[0] * size[2];
  say(`   ${pad(c.label, 22)} ${padl(cfg ? num(cfg.coneDeg, 1) : '--', 7)}`
    + ` ${padl(cfg ? num(cfg.range, 2) : '--', 8)}`
    + ` ${padl(cfg ? num(fanArea(cfg.coneDeg, cfg.range), 2) : '--', 8)}`
    + `  ${pad(`${size[0].toFixed(3)}x${size[2].toFixed(3)}`, 12)}`
    + ` ${padl(num(noticeRange(area), 2), 9)}`);
}

const table = {};
const t0 = Date.now();
for (const budget of BUDGETS) {
  for (const c of CONFIGS) {
    const cfg = c.base ? scaled(c.base, c.surv) : null;
    const runLevel = withPrizeScale(level, c.prize);
    table[`${budget}|${c.key}`] = batch(runLevel, playerNav, (i) => ({ prizes: prizeSets[i] }), {
      runs: RUNS,
      rngFor: (i) => new Rng(`walker-${c.key}-${i}`),
      mode: c.mode,
      explore: EXPLORE,
      vantages,
      guard: cfg ? { cfg, patrol: patrols[0] } : null,
      optsFor: (i) => (cfg ? { guard: { cfg, patrol: patrols[i] } } : {}),
      budget,
    });
  }
}
say(`   (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

say('');
say('   budget  config                  win%    collected   clock s        travel m   caught');
for (const budget of BUDGETS) {
  for (const c of CONFIGS) {
    const r = table[`${budget}|${c.key}`];
    say(`   ${padl(budget, 5)}s  ${pad(c.label, 22)} `
      + `${padl(pct(r.winRate), 6)}  ${padl(num(r.collected.mean, 2), 9)}/6  `
      + `${padl(num(r.clock.mean, 1), 6)} +-${padl(num(r.clock.sd, 1), 4)}  `
      + `${padl(num(r.travel.mean, 0), 8)}  ${padl(num(r.caught.mean, 2), 7)}`);
  }
  say('');
}

/* ------------------------------------------------------------- the cards */
// The four rows the difficulty card quotes. Each preset is read at ITS OWN
// budget, from config.js: 见习 240 s, 标准 180 s, 紧张 120 s, 硬核 120 s. This
// is deliberately a separate table from the budget sweep above -- the sweep
// answers "how does the budget move the odds", and this answers "what does the
// card promise", and conflating them is how a 240 s card ends up quoting a
// 180 s number.
const CARDS = [
  { preset: '见习  solo  ', key: 'blind|none', budget: 240 },
  { preset: '标准  patrol', key: 'blind|patrol', budget: 180 },
  { preset: '紧张  tight ', key: 'blind|tight', budget: 180 },
  { preset: '硬核  hunter', key: 'blind|hunter', budget: 180 },
];
say('§the ladder the cards quote — each preset at ITS OWN budget, no cross-reading');
say(`   ${pad('card', 16)}${padl('budget', 8)}${padl('win%', 7)}${padl('collected', 11)}`
  + `${padl('clock s', 9)}${padl('caught', 8)}`);
for (const c of CARDS) {
  const r = table[`${c.budget}|${c.key}`];
  say(`   ${pad(c.preset, 16)}${padl(c.budget, 8)}${padl(pct(r.winRate), 7)}`
    + `${padl(`${num(r.collected.mean, 2)}/6`, 11)}${padl(num(r.clock.mean, 1), 9)}`
    + `${padl(num(r.caught.mean, 2), 8)}`);
}
say('');

/* -------------------------------------------------------------- controls */
// The old §6 control ("the rig must reproduce 50.0 -> 33.3 %") can no longer
// hold, and saying why is more useful than dropping it. Those numbers came
// from a persona with NO climbing mechanic, in a flat whose walls did not
// block sight (fromLayout.js emitted `blocksSight: false` for every wall
// until this round), with the 红包 still ON THE FLOOR, at 2.1 m/s, on a
// 202-point lattice. Five premises, all of them since moved -- so those
// rows are not a baseline, they are a different game.
//
// Two controls replace it, each isolating ONE change.
//
//   A  the same player, same level, same budget, climbs removed: 6 room
//      turns instead of ~20 looks. If A and the headline row ever stop
//      differing, climbing has stopped mattering -- or the census stopped
//      reading at the body's own height, which is the bug this exists to
//      catch.
//   B  the 269-point lattice persona. Expected to collapse; the point is
//      that it collapses for a STATED reason (2.2 s a look against 269
//      look-points) instead of being quietly deleted when it stopped
//      producing a usable number.
const runWith = (key, vantageList, budget) => {
  const c = CONFIGS.find((x) => x.key === key);
  const cfg = c.base ? scaled(c.base, c.surv) : null;
  return batch(withPrizeScale(level, c.prize), playerNav, (i) => ({ prizes: prizeSets[i] }), {
    runs: RUNS, rngFor: (i) => new Rng(`walker-${key}-n${vantageList.length}-${i}`),
    mode: c.mode, explore: EXPLORE, vantages: vantageList,
    guard: cfg ? { cfg, patrol: patrols[0] } : null,
    optsFor: (i) => (cfg ? { guard: { cfg, patrol: patrols[i] } } : {}),
    budget,
  });
};

const FLOOR_EYE = ['blind|none', 'blind|patrol'];
const roomsOnly = playerVantages.filter((v) => v.kind !== 'climbed');
const floorTable = {};
const latticeTable = {};
for (const key of FLOOR_EYE) {
  floorTable[key] = runWith(key, roomsOnly, 180);
  latticeTable[key] = runWith(key, latticeVantages, 180);
}

say('§control A — 180 s, the SAME player with the climbed look-points taken out');
for (const key of FLOOR_EYE) {
  const c = CONFIGS.find((x) => x.key === key);
  const hl = table[`180|${key}`];
  say(`   ${pad(c.label, 22)} rooms only  ${padl(pct(floorTable[key].winRate), 6)}`
    + `, ${padl(num(floorTable[key].collected.mean, 2), 5)}/6 collected`
    + `   |   + climbs ${padl(pct(hl.winRate), 6)}`
    + `, ${padl(num(hl.collected.mean, 2), 5)}/6`);
}
say('');
say('§control B — 180 s, the 269-point LATTICE persona (what the old §6 measured)');
for (const key of FLOOR_EYE) {
  const c = CONFIGS.find((x) => x.key === key);
  const hl = table[`180|${key}`];
  say(`   ${pad(c.label, 22)} lattice     ${padl(pct(latticeTable[key].winRate), 6)}`
    + `, ${padl(num(latticeTable[key].collected.mean, 2), 5)}/6 collected`
    + `   |   player ${padl(pct(hl.winRate), 6)}`
    + `, ${padl(num(hl.collected.mean, 2), 5)}/6`);
}

const summary = {
  runs: RUNS, budgets: BUDGETS, walker: WALKER.speed,
  persona: {
    player: playerVantages.length,
    roomLooks,
    climbedLooks,
    lattice: latticeVantages.length,
    eye: 'standY + level.body.eyeHeight',
    controls: Object.fromEntries(FLOOR_EYE.map((k) => [k, {
      roomsOnly180: { win: floorTable[k].winRate, collected: floorTable[k].collected.mean },
      lattice180: { win: latticeTable[k].winRate, collected: latticeTable[k].collected.mean },
    }])),
  },
  // The card ladder, at each preset's own budget. See the §cards note.
  cards: CARDS.map((c) => {
    const r = table[`${c.budget}|${c.key}`];
    return { preset: c.preset.trim(), budget: c.budget, key: c.key,
      win: r.winRate, collected: r.collected.mean, clock: r.clock.mean,
      caught: r.caught.mean };
  }),
  configs: CONFIGS.map((c) => {
    const cfg = c.base ? scaled(c.base, c.surv) : null;
    const size = level.collectible.size.map((v) => v * c.prize);
    return {
      key: c.key, label: c.label, base: c.base, surv: c.surv, prize: c.prize,
      coneDeg: cfg ? cfg.coneDeg : null, range: cfg ? cfg.range : null,
      fanArea: cfg ? fanArea(cfg.coneDeg, cfg.range) : 0,
      prizeSize: size, prizeArea: size[0] * size[2],
      noticeRange: noticeRange(size[0] * size[2]),
      win: Object.fromEntries(BUDGETS.map((b) => [b, table[`${b}|${c.key}`].winRate])),
    };
  }),
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
fs.writeFileSync(LOG, lines.join('\n'));
say(`wrote ${path.relative(ROOT, OUT)}`);
