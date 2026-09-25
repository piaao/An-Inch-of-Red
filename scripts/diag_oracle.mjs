/**
 * diag_oracle.mjs — auditing the oracle/blind comparison, and finding the
 * comparison that is actually clean.
 *
 * THE PROBLEM. design "寻红" claims the near-colour red decoration has a real
 * cost, measured as oracle - blind. But an oracle that must also *find* the
 * 红包 by walking is not a counterfactual for "knows which red thing is real";
 * see the numbers below. Choosing the prize instead of a nearby decoy changes
 * the whole trajectory, because salience is area/(1 + d^2 * 0.06) and therefore
 * prefers NEARBY objects: blind makes short productive hops, oracle makes long
 * trips to distant visible prizes. Neither is a superset of the other.
 *
 * THE CLEAN EXPERIMENT. Flip ONE flag inside the SAME mode: `confusable`.
 *
 *   blind, confusable = true    reds in view are candidates -> the player
 *   blind, confusable = false   only real 红包 attract    -> "the decoration
 *                               is not red", same body, same route rule
 *
 * Same policy rule, same fallback, same mode; the only change is whether the
 * decoration lies to you. That difference IS the price of the near-colour
 * gamble, unconfounded.
 *
 * Run: node scripts/diag_oracle.mjs [runs] [budgets,...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Rng } from '../game/core/rng.js';
import { buildNav } from '../game/core/nav.js';
import { placePrizes, defaultViewpoints } from '../game/core/place.js';
import { runSearch, batch, WALKER } from '../game/core/sim.js';
import { DEFAULT_TIER_TARGET } from '../game/core/level.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARENA = path.join(ROOT, 'game', 'arenas', 'room_scene.json');
const OUT = path.join(ROOT, 'work', 'diag_oracle.json');

const RUNS = Number(process.argv[2]) || 12;
const BUDGETS = (process.argv[3] || '60,90,120,180').split(',').map(Number);

const level = JSON.parse(fs.readFileSync(ARENA, 'utf8'));
const nav = buildNav(level, {
  inflate: level.body.playerRadius, bodyHeight: level.body.playerHeight, step: level.meta.step,
});
const vantages = defaultViewpoints(level, nav);

const prizeSets = [];
for (let i = 0; i < RUNS; i++) {
  prizeSets.push(placePrizes(level, nav, new Rng(`arena-${String(i).padStart(3, '0')}`).fork('place'), {
    count: 6, target: DEFAULT_TIER_TARGET, policy: 'spread',
  }).prizes);
}

const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);
const num = (v, n = 1) => (Number.isFinite(v) ? v.toFixed(n) : '--');
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const mean = (list, f) => list.reduce((a, b) => a + f(b), 0) / (list.length || 1);

const CONFIGS = [
  { key: 'map', mode: 'map', confusable: false, label: 'map      (handed the positions)     ' },
  { key: 'oracle', mode: 'oracle', confusable: true, label: 'oracle   (same fallback, better eyes)' },
  { key: 'blind', mode: 'blind', confusable: true, label: 'blind    (reds lie to you)          ' },
  { key: 'noconf', mode: 'blind', confusable: false, label: 'blind\'-  (decoration never red)    ' },
];

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };

say(`diag_oracle   ${RUNS} seeds x ${CONFIGS.length} configs x ${BUDGETS.length} budgets, no guard`);
say('='.repeat(92));
say(`   ${pad('budget  config', 32)}${padl('win%', 7)}${padl('collected', 11)}${padl('clock', 8)}`
  + `${padl('travel', 8)}${padl('sweeps', 8)}${padl('decoy trips', 13)}`);
const table = {};
for (const budget of BUDGETS) {
  for (const cfg of CONFIGS) {
    const r = batch(level, nav, (i) => ({ prizes: prizeSets[i] }), {
      runs: RUNS,
      rngFor: (i) => new Rng(`walker-${cfg.key}-${i}`),
      mode: cfg.mode,
      confusable: cfg.confusable,
      vantages,
      budget,
    });
    table[`${budget}|${cfg.key}`] = r;
    say(`   ${pad(`${String(budget).padStart(3)}s  ${cfg.label}`, 32)}`
      + `${padl(pct(r.winRate), 7)}${padl(num(r.collected.mean, 2), 11)}`
      + `${padl(num(r.clock.mean, 1) + '+-' + num(r.clock.sd, 1), 8)}`
      + `${padl(num(r.travel.mean, 0), 8)}${padl(num(r.sweeps.mean, 0), 8)}`
      + `${padl(num(r.confirmations.mean, 2), 13)}`);
  }
  say('');
}

/* ------------------------------------------------ the unconfounded headline */
say('the price of the near-colour gamble — within-blind, one flag flipped');
say('   budget   blind win   blind\' win    delta  |  blind clock  blind\' clock   delta');
const deltas = [];
for (const budget of BUDGETS) {
  const b = table[`${budget}|blind`];
  const n = table[`${budget}|noconf`];
  const dw = b.winRate - n.winRate;
  const dc = b.clock.mean - n.clock.mean;
  deltas.push({ budget, dw, dc, decoyClock: b.confirmations.mean * WALKER.confirmCost });
  say(`   ${padl(budget, 5)}s   ${padl(pct(b.winRate), 8)}   ${padl(pct(n.winRate), 9)}   `
    + `${padl((dw >= 0 ? '+' : '') + pct(dw), 8)}  |  ${padl(num(b.clock.mean, 1), 10)}   `
    + `${padl(num(n.clock.mean, 1), 11)}  ${padl((dc >= 0 ? '+' : '') + num(dc, 1), 7)}`);
}

/* ------------------------------------------------------- dominance reporting */
say('');
say('dominance check (an oracle must never lose to blind on the same policy)');
let dominated = 0;
for (const budget of BUDGETS) {
  const o = table[`${budget}|oracle`];
  const b = table[`${budget}|blind`];
  const ok = o.winRate >= b.winRate && o.collected.mean >= b.collected.mean;
  if (!ok) dominated++;
  say(`   ${padl(budget, 5)}s   oracle ${padl(pct(o.winRate), 7)} / ${padl(num(o.collected.mean, 2), 5)}`
    + `   blind ${padl(pct(b.winRate), 7)} / ${padl(num(b.collected.mean, 2), 5)}   `
    + `${ok ? 'ok' : 'VIOLATED  <- not a knowledge gap, a route-policy gap'}`);
}

/* ---------------------------------------------------------- branch accounting */
say('');
say('what each configuration actually does (single run per seed, branch seconds)');
say(`   ${pad('config', 10)}${padl('explore', 10)}${padl('chase-prize', 12)}${padl('chase-decoy', 12)}`);
const branch = {};
for (const cfg of CONFIGS) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    runs.push(runSearch(level, nav, new Rng(`walker-${cfg.key}-${i}`), prizeSets[i], {
      mode: cfg.mode, confusable: cfg.confusable, vantages, budget: 180,
    }));
  }
  const summed = { explore: 0, 'chase-prize': 0, 'chase-decoy': 0 };
  for (const r of runs) {
    for (let k = 0; k < r.trace.length; k++) {
      const t = r.trace[k];
      const next = k + 1 < r.trace.length ? r.trace[k + 1].t : r.clock;
      summed[t.kind] += Math.max(0, next - t.t);
    }
  }
  branch[cfg.key] = Object.fromEntries(Object.entries(summed).map(([k, v]) => [k, v / runs.length]));
  say(`   ${pad(cfg.key, 10)}${padl(num(branch[cfg.key].explore), 10)}`
    + `${padl(num(branch[cfg.key]['chase-prize']), 12)}`
    + `${padl(num(branch[cfg.key]['chase-decoy']), 12)}`);
}

say('');
const b180 = table['180|blind'];
const n180 = table['180|noconf'];
const confirmBill = b180.confirmations.mean * WALKER.confirmCost;
say(`   as a share of its ${num(b180.clock.mean, 1)} s clock that is`
  + ` ${pct(b180.falsePositiveRate.mean)} of all investigations, and the`
  + ` ${num(confirmBill, 1)} s of ` + '`confirmCost`' + ` is only ${pct(confirmBill / b180.clock.mean)} of the clock.`);
say(`   the real bill is the TRIPS: ${num(branch.blind['chase-decoy'], 1)} s of walking over to`
  + ` look at decoration.`);
say(`   a map-hack collects 6/6 in ${num(table['60|map'].clock.mean, 1)} s on`
  + ` ${num(table['60|map'].travel.mean, 0)} m with ${num(table['60|map'].sweeps.mean, 0)} sweeps.`
  + ` Having to LOOK is ${num(b180.clock.mean / table['60|map'].clock.mean, 1)}x the clock`
  + ` and ${num(b180.travel.mean / table['60|map'].travel.mean, 1)}x the distance.`);
say(`   flipping the single ` + '`confusable`' + ` flag at 180 s moves the win rate by`
  + ` ${(n180.winRate - b180.winRate >= 0 ? '+' : '')}${pct(n180.winRate - b180.winRate)}.`);

// Where does the confusion stop being a liability? Below the crossover the
// decoy trips are dead weight a tight clock cannot absorb; above it the very
// same trips are the coverage heuristic. The design has to pick a side, and the
// budget is the dial that picks it.
say('');
const flip = BUDGETS.map((b) => ({
  b, d: table[`${b}|blind`].winRate - table[`${b}|noconf`].winRate,
}));
const liability = flip.filter((v) => v.d < 0);
const asset = flip.filter((v) => v.d > 0);
const cross = flip.findIndex((v, i) => i > 0 && flip[i - 1].d < 0 && v.d > 0);
say('   the near-colour confusion is a LIABILITY at: '
  + (liability.map((v) => `${v.b}s (${pct(v.d)})`).join(', ') || 'no budget tested'));
say('   the near-colour confusion is an ASSET    at: '
  + (asset.map((v) => `${v.b}s (+${pct(v.d)})`).join(', ') || 'no budget tested'));
if (cross > 0) {
  say(`   => the sign flips between ${flip[cross - 1].b} s and ${flip[cross].b} s:`
    + ` under ${flip[cross - 1].b} s the decoy trips are dead weight, over`
    + ` ${flip[cross].b} s the same trips are the search heuristic.`);
} else if (liability.length && !asset.length) {
  say('   => at every budget tested, removing the confusion would HELP the searcher.');
}

fs.writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString(), runs: RUNS, budgets: BUDGETS,
  runs_summary: Object.fromEntries(Object.entries(table).map(([k, r]) => [k, {
    winRate: r.winRate, clock: r.clock, collected: r.collected, travel: r.travel,
    sweeps: r.sweeps, confirmations: r.confirmations, falsePositiveRate: r.falsePositiveRate,
  }])),
  branch, gambleDelta: deltas, dominanceViolations: dominated, confusionFlip: flip,
  rows: Object.fromEntries(CONFIGS.map((c) => [c.key, table[`180|${c.key}`].rows])),
}, null, 2), 'utf8');
say(`wrote ${path.relative(ROOT, OUT).replace(/\\/g, '/')}`);
