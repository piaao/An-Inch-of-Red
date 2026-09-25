/**
 * diag_explore.mjs — is "looking costs 97 s" a fact about the DESIGN or about
 * my search AI?
 *
 * diag_oracle.mjs put every agent that lacks red landmarks at ~109 s of random
 * jumping. Random jumping is a straw man, and sim.js says so in its own header:
 * the numbers are RELATIVE. So this runs the same four configurations under two
 * exploration policies -- 'random' (jump anywhere un-stood) and 'nearest'
 * (systematic nearest-neighbour tour of the standpoints) -- and reports the gap.
 *
 * If 'nearest' collapses the clock, the earlier "cost of looking" was mostly a
 * harness artefact. If it does not, then discovery really is the whole game.
 *
 * Run: node scripts/diag_explore.mjs [runs] [budgets,...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Rng } from '../game/core/rng.js';
import { buildNav } from '../game/core/nav.js';
import { placePrizes, defaultViewpoints } from '../game/core/place.js';
import { batch, runSearch, WALKER } from '../game/core/sim.js';
import { DEFAULT_TIER_TARGET } from '../game/core/level.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARENA = path.join(ROOT, 'game', 'arenas', 'room_scene.json');
const OUT = path.join(ROOT, 'work', 'diag_explore.json');

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

const CONFIGS = [
  { key: 'map', mode: 'map', confusable: false, label: 'map' },
  { key: 'blind/random', mode: 'blind', confusable: true, explore: 'random', label: 'blind random ' },
  { key: 'blind/nearest', mode: 'blind', confusable: true, explore: 'nearest', label: 'blind nearest' },
  { key: 'noconf/random', mode: 'blind', confusable: false, explore: 'random', label: 'noconf random' },
  { key: 'noconf/nearest', mode: 'blind', confusable: false, explore: 'nearest', label: 'noconf nearest' },
];

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };

say(`diag_explore   ${RUNS} seeds x ${CONFIGS.length} configs x ${BUDGETS.length} budgets, no guard,`);
say(`               vantage lattice ${vantages.length} standpoints, minHop ${1.5} m`);
say('='.repeat(96));
say(`   ${pad('budget  config', 26)}${padl('win%', 7)}${padl('collected', 11)}${padl('clock', 9)}`
  + `${padl('travel', 8)}${padl('sweeps', 8)}${padl('explore s', 11)}`);
const table = {};
for (const budget of BUDGETS) {
  for (const cfg of CONFIGS) {
    table[`${budget}|${cfg.key}`] = batch(level, nav, (i) => ({ prizes: prizeSets[i] }), {
      runs: RUNS,
      rngFor: (i) => new Rng(`walker-${cfg.key}-${i}`),
      mode: cfg.mode, confusable: cfg.confusable, explore: cfg.explore,
      vantages, budget,
    });
  }
}
for (const budget of BUDGETS) {
  for (const cfg of CONFIGS) {
    const r = table[`${budget}|${cfg.key}`];
    say(`   ${pad(`${String(budget).padStart(3)}s  ${cfg.label}`, 26)}${padl(pct(r.winRate), 7)}`
      + `${padl(num(r.collected.mean, 2), 11)}${padl(num(r.clock.mean, 1), 9)}`
      + `${padl(num(r.travel.mean, 0), 8)}${padl(num(r.sweeps.mean, 0), 8)}`
      + `${padl('--', 11)}`);
  }
  say('');
}

// Branch accounting for 180 s, per config, to see WHERE a policy wins or loses.
say('where the time goes at 180 s (branch seconds, averaged over runs)');
say(`   ${pad('config', 14)}${padl('explore', 10)}${padl('chase-prize', 13)}${padl('chase-decoy', 13)}`
  + `${padl('clock', 8)}`);
const branch = {};
for (const cfg of CONFIGS) {
  const summed = { explore: 0, 'chase-prize': 0, 'chase-decoy': 0 };
  let clock = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = runSearch(level, nav, new Rng(`walker-${cfg.key}-${i}`), prizeSets[i], {
      mode: cfg.mode, confusable: cfg.confusable, explore: cfg.explore, vantages, budget: 180,
    });
    clock += r.clock;
    for (let k = 0; k < r.trace.length; k++) {
      const t = r.trace[k];
      const next = k + 1 < r.trace.length ? r.trace[k + 1].t : r.clock;
      summed[t.kind] += Math.max(0, next - t.t);
    }
  }
  branch[cfg.key] = Object.fromEntries(Object.entries(summed).map(([k, v]) => [k, v / RUNS]));
  branch[cfg.key].clock = clock / RUNS;
  say(`   ${pad(cfg.label.trim(), 14)}${padl(num(branch[cfg.key].explore), 10)}`
    + `${padl(num(branch[cfg.key]['chase-prize']), 13)}`
    + `${padl(num(branch[cfg.key]['chase-decoy']), 13)}${padl(num(branch[cfg.key].clock), 8)}`);
}

say('');
const bR = table['180|blind/random'];
const bN = table['180|blind/nearest'];
say(`   blind  random ${num(bR.clock.mean, 1)} s / ${pct(bR.winRate)}   ->   nearest `
  + `${num(bN.clock.mean, 1)} s / ${pct(bN.winRate)}`);
const cR = table['180|noconf/random'];
const cN = table['180|noconf/nearest'];
say(`   noconf random ${num(cR.clock.mean, 1)} s / ${pct(cR.winRate)}   ->   nearest `
  + `${num(cN.clock.mean, 1)} s / ${pct(cN.winRate)}`);
const map = table['180|map'];
say(`   ceiling map-hack ${num(map.clock.mean, 1)} s; best searching config`
  + ` ${num(Math.min(bR.clock.mean, bN.clock.mean, cR.clock.mean, cN.clock.mean), 1)} s`
  + ` => discovery costs at least`
  + ` ${num(Math.min(bR.clock.mean, bN.clock.mean, cR.clock.mean, cN.clock.mean) / map.clock.mean, 1)}x routing.`);
const gapR = cR.clock.mean - bR.clock.mean;
const gapN = cN.clock.mean - bN.clock.mean;
say(`   confusion bill: random ${gapR >= 0 ? '+' : ''}${num(gapR, 1)} s,`
  + ` nearest ${gapN >= 0 ? '+' : ''}${num(gapN, 1)} s  (positive = confusion is a liability)`);

fs.writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString(), runs: RUNS, budgets: BUDGETS, minHop: 1.5,
  vantageCount: vantages.length,
  runs_summary: Object.fromEntries(Object.entries(table).map(([k, r]) => [k, {
    winRate: r.winRate, clock: r.clock, collected: r.collected, travel: r.travel,
    sweeps: r.sweeps, confirmations: r.confirmations,
  }])),
  branch, confusionBill: { random: gapR, nearest: gapN },
}, null, 2), 'utf8');
say(`wrote ${path.relative(ROOT, OUT).replace(/\\/g, '/')}`);
