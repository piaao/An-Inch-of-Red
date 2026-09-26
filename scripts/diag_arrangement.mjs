/**
 * diag_arrangement.mjs — is a generated floor plan ARRANGED like a designed one?
 *
 *     node scripts/diag_arrangement.mjs [seeds]
 *     node scripts/diag_arrangement.mjs 12 --quiet
 *
 * READ-ONLY. Writes nothing; prints a table. Safe to run next to the committed
 * reports/ evidence.
 *
 * WHY THIS EXISTS. `scripts/procgen.mjs` answers "is this floor PLAYABLE" --
 * nav, rooms, prizes, boundary. Twelve of twelve layouts pass every one of
 * those, and the floors still do not look like the hand-made apartment. That is
 * not a contradiction: every playability check is about the level as a MAZE,
 * and none of them is about the level as a PLACE. A floor can be perfectly
 * connected, fully reachable and prize-complete while opening its front door
 * into a bathroom.
 *
 * THIS SCRIPT IS A VIEW, NOT A SECOND RULER. The questions, the bounds and the
 * derivations all live in `game/procgen/arrangement.js`, which `pipeline.js`
 * calls for every layout it judges. This file only puts the two hands side by
 * side: `js/layout.js` (designed) and `game/procgen/floorplan.js` (generated)
 * through ONE function, and the numbers land in one table. A metric that only
 * flatters the design is not a metric.
 *
 * It also calibrates the ruler on every run, which is the check that would have
 * caught the first version of it. That version probed 0.35 m either side of
 * every door and asked `nav.componentAt()` -- which is how a player would
 * answer it -- and the shipped apartment's bathroom door has a 0.31 m trashcan
 * 0.29 m inside it, so the probe landed on furniture and the audit reported the
 * DESIGNED bathroom as having no door at all. A second version read only
 * `DOORS`, and so reported the designed study as a room no doorway reaches
 * (it is entered through a 1 m open bay in a wall, which is a hole rather than
 * a door). Both times the tell was the same: THE REFERENCE FAILED. So the
 * reference is now asserted, out loud, every run.
 *
 * AND IT GATES ONE THING. The six questions say whether a floor is a PLACE.
 * The composition readings say whether the furniture in it reads as
 * furniture, and for one release they were printed with the footnote
 * "measured now, gated in the next stage". They are gated now: see the
 * verdict at the bottom of this file, which is also where the bounds and
 * their provenance are written down. A reading that is never allowed to fail
 * is a decoration.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateFloorplan } from '../game/procgen/floorplan.js';
import { auditArrangement, toResolvedLevel, ARRANGEMENT_IDS } from '../game/procgen/arrangement.js';
import * as SHIPPED from '../js/layout.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const sizes = readJSON(path.join(ROOT, 'data', 'kit_three.json'));
const surfaces = readJSON(path.join(ROOT, 'data', 'model_surfaces.json'));
const passages = readJSON(path.join(ROOT, 'data', 'passages.json'));

/* -------------------------------------------------------------- the table */

const shipLayout = {
  WALL_H: SHIPPED.WALL_H, PLAN: SHIPPED.PLAN, ZONES: SHIPPED.ZONES,
  WALLS: SHIPPED.WALLS, CORNERS: SHIPPED.CORNERS, DOORS: SHIPPED.DOORS, ROOMS: SHIPPED.ROOMS,
};

const OPT = { sizes, surfaces, passages };
const designed = auditArrangement(
  shipLayout, toResolvedLevel(shipLayout, { ...OPT, tag: 'js/layout.js' }), { sizes });

const N = Number(process.argv[2] || 12);
const quiet = process.argv.includes('--quiet') || process.argv.includes('-q');
const base = { w: 10, d: 8, rooms: 6, items: 60 };
const gens = [];
for (let i = 0; i < N; i++) {
  const p = { ...base, seed: `procgen-${i + 1}` };
  try {
    const gen = generateFloorplan(p, { sizes });
    gens.push({ tag: p.seed, a: auditArrangement(gen.layout, toResolvedLevel(gen.layout, { ...OPT, tag: p.seed }), { sizes }) });
  } catch (err) {
    gens.push({ tag: p.seed, crash: String((err && err.message) || err) });
  }
}

const ok = gens.filter((g) => !g.crash && g.a && g.a.ready);
const share = (n, d) => `${d ? Math.round((n / d) * 100) : 0}%`;
const avg = (f) => (ok.length ? ok.reduce((s, g) => s + f(g.a), 0) / ok.length : 0);
const dRead = designed.readings;
const row = (label, a, b) => `  ${label.padEnd(34)} ${String(a).padEnd(22)} ${b}`;
const check = (a, id) => a.checks.find((c) => c.id === id);

if (!quiet) {
  console.log('');
  console.log('='.repeat(96));
  console.log(`ARRANGEMENT AUDIT   designed = js/layout.js   generated = ${ok.length}/${N} seeds `
    + `at ${base.w}x${base.d} m, ${base.rooms} rooms, ${base.items} items`);
  console.log('   (the questions and their bounds live in game/procgen/arrangement.js)');
  console.log('='.repeat(96));

  /* ---------------------------------------------------------- calibration */
  const dFails = designed.checks.filter((c) => !c.pass);
  console.log('');
  console.log('0. CALIBRATION — the reference flat must pass its own ruler');
  console.log(`  designed ${designed.checks.length - dFails.length}/${designed.checks.length}`
    + `  ->  ${dFails.length ? 'BROKEN RULER: ' + dFails.map((c) => c.id).join(', ') : 'OK'}`);
  if (dFails.length) for (const c of dFails) console.log(`      ${c.id}: ${c.detail}`);

  /* -------------------------------------------------------------- the six */
  for (const id of ARRANGEMENT_IDS) {
    const dc = check(designed, id);
    const gs = ok.map((g) => check(g.a, id));
    const pass = gs.filter((c) => c.pass).length;
    const na = gs.filter((c) => c.applicable === false).length;
    console.log('');
    console.log(`${ARRANGEMENT_IDS.indexOf(id) + 1}. ${dc.label}`);
    console.log(row('designed', dc.pass ? (dc.applicable === false ? 'pass (n/a)' : 'pass') : 'FAIL',
      `${pass}/${ok.length} = ${share(pass, ok.length)}${na ? `  (${na} n/a)` : ''}`));
    if (!dc.pass) console.log(`     designed detail: ${dc.detail}`);
    const worst = gs.filter((c) => !c.pass).slice(0, 2);
    for (const c of worst) console.log(`     e.g. ${c.detail}`);
  }

  /* ------------------------------------------------------------ the numbers */
  const hist = (f) => {
    const h = {};
    for (const g of ok) { const k = JSON.stringify(f(g.a)); h[k] = (h[k] || 0) + 1; }
    return Object.entries(h).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join('   ');
  };
  console.log('');
  console.log('7. WHERE THE FRONT DOOR OPENS (and the rest of the readings)');
  console.log(row('entry role', dRead.entryRole, hist((a) => a.readings.entryRole)));
  console.log(row('entry room is the hub', dRead.entryIsHub, hist((a) => a.readings.entryIsHub)));
  console.log(row('door-hops to the furthest room', dRead.maxDepth, hist((a) => a.readings.maxDepth)));
  console.log(row('bathroom doors', dRead.bathDoors.join(','), hist((a) => a.readings.bathDoors)));
  console.log(row('bath reached without a bedroom', dRead.bathReachable, hist((a) => a.readings.bathReachable)));
  console.log(row('kitchen opens onto dining', dRead.kitchenDining, hist((a) => a.readings.kitchenDining)));
  console.log(row('rooms with no window', dRead.windowlessRooms.length, avg((a) => a.readings.windowlessRooms.length).toFixed(2) + ' avg'));
  console.log(row('rooms with an outside wall', dRead.exteriorRooms.length, avg((a) => a.readings.exteriorRooms.length).toFixed(2) + ' avg'));

  /* ------------------------------------------------- furniture composition */
  const t = dRead.totals;
  console.log('');
  console.log('8. FURNITURE COMPOSITION  (0-3 items budgeted below; the bounds are in the verdict)');
  console.log(row('furniture pieces per group', t.piecesPerGroup.toFixed(2), avg((a) => a.readings.totals.piecesPerGroup).toFixed(2)));
  console.log(row('lone items / all furniture', share(t.singletons, t.measured), avg((a) => a.readings.totals.loneShare).toFixed(3)));
  console.log(row('objects on open floor', t.floating, avg((a) => a.readings.totals.floating).toFixed(2) + ' avg'));
  console.log(row('biggest group in one room', t.biggestGroup, avg((a) => a.readings.totals.biggestGroup).toFixed(1) + ' avg'));
  console.log(row('smallest room area (m2)', t.smallest.toFixed(2), avg((a) => a.readings.totals.smallest).toFixed(2)));
  console.log(row('largest room area (m2)', t.biggest.toFixed(2), avg((a) => a.readings.totals.biggest).toFixed(2)));
  console.log(row('largest / smallest room', t.sizeRatio.toFixed(2), avg((a) => a.readings.totals.sizeRatio).toFixed(2)));
  console.log(row('items placed / measured', `${t.items} / ${t.measured}`, avg((a) => a.readings.totals.items).toFixed(1)));

  /* --------------------------------------------------------------- per seed */
  console.log('');
  console.log('-------------------------------------------------------------- per seed');
  console.log(`  ${''.padEnd(16)}${ARRANGEMENT_IDS.map((s) => s.slice(0, 4)).join(' ')}`);
  for (const g of gens) {
    if (g.crash) { console.log(`  ${g.tag.padEnd(16)} CRASH ${g.crash}`); continue; }
    const marks = ARRANGEMENT_IDS.map((id) => {
      const c = check(g.a, id);
      return c.applicable === false ? ' n/a' : c.pass ? '   .' : '   X';
    }).join('');
    const r = g.a.readings;
    console.log(`  ${g.tag.padEnd(16)}${marks}   entry->${String(r.entryRole).padEnd(8)}`
      + ` hops ${r.maxDepth}  bath ${JSON.stringify(r.bathDoors)}  `
      + `pieces/group ${r.totals.piecesPerGroup.toFixed(2)}  lone ${r.totals.loneShare.toFixed(2)}  floor ${r.totals.floating}`);
  }
}

/* ------------------------------------------------- P2: the composition gate */

/*
 * THE THREE NUMBERS P2 PROMISED, GATED HERE.
 *
 * They are readings about the furniture, not questions about the plan, so they
 * do not belong in `arrangement.js` beside the six -- that file answers "is
 * this floor a PLACE", and these answer "does the furniture in it read as
 * furniture". The two are independent and stay separate: the six are green on
 * a flat whose every chair stands alone in the middle of a room.
 *
 * THE BOUND IS ON THE FAMILY, NOT ON ONE LAYOUT, and that is a measurement
 * rather than a convenience. Over six parameter families x eight seeds the
 * worst single layout reads 2.13 pieces/group, on a 2-room 24-item flat where
 * one misplaced wardrobe moves the ratio by 0.2; a per-layout bound of 2.50
 * would fail a layout that is not wrong. So the promise is gated where it is
 * made -- averaged over the seeds -- and the WORST SINGLE LAYOUT is printed
 * beside it, so that a pass cannot hide a disaster.
 *
 * `floating` is the exception: "no more than two objects alone on open floor"
 * is a claim about ONE flat, so it is gated per flat.
 *
 * Provenance of the bounds is the designed flat, measured by the same ruler on
 * the same run: 3.61 pieces/group, 13 % lone, 1 on open floor. The bounds are
 * deliberately LOOSER than the reference and not tuned to the generator's own
 * reading -- 2.50 is below every family average ever measured here, and a bound
 * set to whatever the code happens to print is not a bound.
 */
const comp = {
  pieces: avg((a) => a.readings.totals.piecesPerGroup),
  lone: avg((a) => a.readings.totals.loneShare),
  worstPieces: Math.min(...ok.map((g) => g.a.readings.totals.piecesPerGroup)),
  worstLone: Math.max(...ok.map((g) => g.a.readings.totals.loneShare)),
  mostFloor: Math.max(...ok.map((g) => g.a.readings.totals.floating)),
};
const compGate = [
  ['pieces per group, averaged over the seeds', comp.pieces.toFixed(2), comp.pieces >= 2.5, '>= 2.50'],
  ['lone items / all furniture, averaged', comp.lone.toFixed(3), comp.lone <= 0.25, '<= 0.250'],
  ['objects alone on open floor, worst single flat', String(comp.mostFloor), comp.mostFloor <= 2, '<= 2'],
];
const compBad = compGate.filter((g) => !g[2]);

/* ------------------------------------------------------------- the verdict */

const allGreen = ok.filter((g) => g.a.checks.every((c) => c.pass)).length;
const green = ok.reduce((s, g) => s + g.a.checks.filter((c) => c.pass).length, 0);
const total = ok.length * designed.checks.length;
const dFails = designed.checks.filter((c) => !c.pass).length;
const worstId = ARRANGEMENT_IDS
  .map((id) => ({ id, n: ok.filter((g) => !check(g.a, id).pass).length }))
  .sort((a, b) => b.n - a.n)[0];

console.log('');
console.log('='.repeat(96));
console.log(`arrangement  ${green}/${total} checks green   ${allGreen}/${ok.length} layouts arranged end to end`);
console.log(`   weakest question: ${worstId.id} (${worstId.n}/${ok.length} layouts fail it)`);
console.log(`   reference flat:   ${designed.checks.length - dFails}/${designed.checks.length}`
  + `${dFails ? '   BROKEN RULER — on ' + designed.checks.filter((c) => !c.pass).map((c) => c.id).join(', ') : ''}`);
console.log(`composition  pieces/group ${comp.pieces.toFixed(2)} (worst seed ${comp.worstPieces.toFixed(2)})`
  + `   lone ${comp.lone.toFixed(3)} (worst seed ${comp.worstLone.toFixed(3)})`
  + `   open floor ${comp.mostFloor} max   ${compBad.length ? 'FAIL' : 'PASS'}`);
for (const [label, got, , want] of compBad) console.log(`   FAIL  ${label}: ${got}, wants ${want}`);
console.log('='.repeat(96));
console.log('');

// A ruler that cannot pass the reference is not evidence about anything else,
// and a composition promise the generator misses is a second, separate failure
// -- two exit codes, because they are two different things to go and fix.
process.exit(dFails ? 2 : compBad.length ? 3 : 0);
