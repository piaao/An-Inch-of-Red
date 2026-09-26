/**
 * verify_arrangement.mjs — the SECOND verdict's acceptance run.
 *
 *     node scripts/verify_arrangement.mjs
 *     node scripts/verify_arrangement.mjs --cli work/_cli_arr.json
 *
 * First run `node scripts/procgen.mjs` once to write the cross-process artifact
 * (the exact command is printed below if it is missing). This environment
 * cannot create a child process, so that single step is out of band.
 *
 * WHAT P0 PROMISED. Six countable questions about whether a generated floor is
 * a PLACE rather than merely a maze, wired into `game/procgen/pipeline.js` as a
 * verdict SEPARATE from playability, visible in the CLI and on the workbench.
 * P0 deliberately changed no generation logic, so the point of P0's run was
 * that the readings went RED.
 *
 * WHAT P1 PROMISED. That the generator GUARANTEE the bound instead of merely
 * being measured against it: a band plan, a room programme that decides roles
 * and doors together, an entry that is a most-connected room by construction.
 * P1's acceptance is `72/72 arrangement checks green, 12/12 layouts arranged end
 * to end` over `scripts/procgen.mjs --sweep`, and `--strict-arrangement`
 * exiting 0.
 *
 * ------------------------------------------------------- WHY THIS FILE CHANGED
 *
 * P0's evidence that the ruler could FAIL was: "every one of the six has been
 * observed red on at least one of the twelve sweep parameter sets". That is
 * true exactly as long as the generator is bad, and P1 made it false -- all six
 * went green on all twelve sets, and the assertion went red while the ruler was
 * still perfectly able to fail. An assertion whose truth is hostage to the
 * quality of the thing it measures is not an assertion about the ruler.
 *
 * So non-vacuity is now demonstrated by MUTATION. For each of the six there is
 * a counter-example -- a minimal, physical edit to the designed flat -- that
 * turns that question red, and the edit is declared to turn red exactly the
 * questions it is declared to turn red. It also answers a second question for
 * free, and this is the load-bearing one: every counter-example leaves all nine
 * PLAYABILITY checks green, so the two axes are shown to move independently
 * rather than being two severities of one fact.
 *
 * ----------------------------------------------------------------- THE SEVEN
 *
 *   1 SHAPE        six questions, in order, each with an id -- so a question
 *                  that silently stops being asked is a failure, not a shorter
 *                  report.
 *   2 CALIBRATION  the REFERENCE FLAT passes all six. This is the assertion
 *                  that would have caught BOTH broken versions of the ruler:
 *                  the nav-probe one reported the designed bathroom as having
 *                  no door, and the doors-only one reported the designed study
 *                  as unreachable (it is entered through a 1 m open bay). Both
 *                  times the tell was the same -- the reference failed.
 *   3 FALSIFIABLE  every one of the six has a counter-example that turns it red,
 *                  and NO counter-example moves a playability check. Two facts,
 *                  asserted separately: see the table below.
 *   4 DISJOINT     no arrangement id collides with a playability id, and
 *                  playability is still EXACTLY nine checks. Two facts, not one
 *                  boolean.
 *   5 ONE SOURCE   `auditArrangement(layout, toResolvedLevel(...))` and
 *                  `validateLayout(...).arrangement` return the SAME verdict for
 *                  the same layout, on all twelve sets. There are two entry
 *                  points into this measurement -- the tools that only want to
 *                  look, and the harness the game's own pipeline calls -- and
 *                  this is what stops them becoming two different measurements.
 *   6 CROSS-PROCESS  the CLI's own JSON, written by a SEPARATE node process,
 *                  agrees with the in-process pipeline for the same parameters
 *                  -- AND was produced by this source tree. The second half is
 *                  new and is a scar: this check once read a file left behind by
 *                  an older generator and reported the AGE of the file as a
 *                  disagreement between two live measurements. See
 *                  `scripts/fingerprint.mjs`.
 *   7 WIRED        the workbench has the slots and writes them. STATIC, and
 *                  labelled as such below, because a browser cannot be launched
 *                  from this environment (see the note in check 7).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateFloorplan } from '../game/procgen/floorplan.js';
import { validateLayout } from '../game/procgen/pipeline.js';
import {
  auditArrangement, toResolvedLevel, ARRANGEMENT_IDS,
} from '../game/procgen/arrangement.js';
import {
  verdictFingerprint, reachableSources, VERDICT_SOURCES, VERDICT_ENTRIES, VERDICT_DATA,
} from './fingerprint.mjs';
import * as SHIPPED from '../js/layout.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const sizes = readJSON(path.join(ROOT, 'data', 'kit_three.json'));
const surfaces = readJSON(path.join(ROOT, 'data', 'model_surfaces.json'));
const passages = readJSON(path.join(ROOT, 'data', 'passages.json'));

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1; else failed += 1;
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

/* The nine playability check ids, named here so "playability did not change"
 * is an assertion rather than a hope. If a tenth is added to `pipeline.js`,
 * this line fails and the arrangement axis is not silently re-counted. */
const PLAYABILITY_IDS = ['plan', 'structural', 'adapter', 'walkable', 'world',
  'rooms', 'reachable', 'prizes', 'boundary'];

const SWEEP = [
  { label: '10x8  6r  60i', p: { w: 10, d: 8, rooms: 6, items: 60 } },
  { label: '8x6   4r  40i', p: { w: 8, d: 6, rooms: 4, items: 40 } },
  { label: '12x9  7r  95i', p: { w: 12, d: 9, rooms: 7, items: 95 } },
  { label: '14x10 9r 130i', p: { w: 14, d: 10, rooms: 9, items: 130 } },
  { label: '10x8  3r 100i', p: { w: 10, d: 8, rooms: 3, items: 100 } },
  { label: '6x6   4r  35i', p: { w: 6, d: 6, rooms: 4, items: 35 } },
  { label: '20x12 12r 220i', p: { w: 20, d: 12, rooms: 12, items: 220 } },
  { label: '16x14 10r 160i', p: { w: 16, d: 14, rooms: 10, items: 160 } },
  { label: '7x5   2r  24i', p: { w: 7, d: 5, rooms: 2, items: 24 } },
  { label: '24x16 16r 300i', p: { w: 24, d: 16, rooms: 16, items: 300 } },
  { label: '9x9   5r  55i', p: { w: 9, d: 9, rooms: 5, items: 55 } },
  { label: '11x7  6r  70i', p: { w: 11, d: 7, rooms: 6, items: 70 } },
];

const shipped = () => ({
  WALL_H: SHIPPED.WALL_H, PLAN: structuredClone(SHIPPED.PLAN),
  ZONES: structuredClone(SHIPPED.ZONES), WALLS: structuredClone(SHIPPED.WALLS),
  CORNERS: structuredClone(SHIPPED.CORNERS), DOORS: structuredClone(SHIPPED.DOORS),
  ROOMS: structuredClone(SHIPPED.ROOMS),
});

/* ------------------------------------------------------------ the mutations */
/*
 * Each counter-example is a small, physical edit to the DESIGNED flat -- move a
 * door onto another outside wall, take a window out, hang a second door on the
 * bathroom. Nothing is faked through the audit's own inputs: every edit goes
 * through the same `WALLS` / `DOORS` / `ZONES` a designer writes, and the
 * verdict is then read by the same ruler the generator is judged by.
 *
 * `flips` is DECLARED and asserted, not reported. A counter-example whose
 * collateral changes over time is a counter-example that has stopped testing
 * one thing -- and the two couplings below are real design facts worth naming
 * rather than hiding: a room you enter through its only door is both private
 * and a dead end, so the physical `entry-public` edit cannot avoid moving
 * `entry-hub` too. The role edit isolates it instead.
 *
 * `label` is what is MISSING from the flat, because that is the readable name
 * of a counter-example: you do not describe a bug by its fix.
 */
const wallOf = (L, id) => L.WALLS.find((x) => x.id === id);
const openDoors = (L) => L.DOORS.filter((d) => d.m === 'doorwayOpen');
const frontDoor = (L) => L.DOORS.find((d) => d.m === 'doorwayFront');
const swapZones = (L, a, b) => {
  for (const z of L.ZONES) { if (z.id === a) z.id = b; else if (z.id === b) z.id = a; }
};

const MUTATIONS = [
  {
    id: 'entry-public',
    made: 'the front door moved onto the bedroom\'s outside wall',
    flips: ['entry-public', 'entry-hub'],
    make: (L) => {
      wallOf(L, 'north').kinds = { 2: 'wallWindow', 3: 'wallDoorway', 7: 'wallWindow' };
      wallOf(L, 'south').kinds = { 4: 'wallWindow', 8: 'wallWindow' };   // its doorway leaves with the door
      const d = frontDoor(L); d.x = 3.5; d.z = -0.025; d.r = 0;
    },
  },
  {
    id: 'entry-public',
    made: 'the arrival room used as a bedroom',
    flips: ['entry-public'],
    make: (L) => swapZones(L, 'living', 'bedroom'),
  },
  {
    id: 'entry-hub',
    made: 'the front door moved onto the study\'s outside wall',
    flips: ['entry-hub'],
    make: (L) => {
      wallOf(L, 'south').kinds = { 4: 'wallWindow', 8: 'wallDoorway' };
      const d = frontDoor(L); d.x = 8.5; d.z = 8.025; d.r = 180;
    },
  },
  {
    id: 'door-hops',
    made: 'the living|dining leaf hung 0.6 m out of its frame',
    flips: ['door-hops'],
    make: (L) => { openDoors(L)[2].x = 6.6; },   // [bedroom, bath, living|east, kitchen]
  },
  {
    id: 'bath',
    made: 'the bathroom also opened off the bedroom (an ensuite)',
    flips: ['bath'],
    make: (L) => {
      wallOf(L, 'bed|bath').kinds = { 1: 'wallDoorway' };
      L.DOORS.push({ m: 'doorwayOpen', x: 4.025, z: 1.5, r: 90, note: 'bedroom-bath second door' });
    },
  },
  {
    id: 'bath',
    made: 'the bathroom entered through an open bay instead of a door',
    flips: ['bath'],
    make: (L) => {
      wallOf(L, 'spine').kinds = { 2: 'wallDoorway', 4: null, 8: 'wallDoorway' };
      L.DOORS = L.DOORS.filter((d) => !(d.z === 3.025 && d.x === 4.5));
    },
  },
  {
    id: 'kitchen-dining',
    made: 'a kitchen that opens off the living room instead of the dining room',
    flips: ['kitchen-dining'],
    make: (L) => swapZones(L, 'living', 'dining'),
  },
  {
    id: 'bedroom-window',
    made: 'a bedroom outside wall with no window in it',
    flips: ['bedroom-window'],
    make: (L) => { wallOf(L, 'north').kinds = { 7: 'wallWindow' }; },
  },
];

console.log('');
console.log('='.repeat(78));
console.log(`  arrangement — acceptance (two axes, one implementation)   [${process.version}]`);
console.log('='.repeat(78));

/* ------------------------------------------------------------- 1. shape */
console.log('');
console.log('-- 1. the six questions exist, in order -------------------------------');
{
  const L = shipped();
  const a = auditArrangement(L, toResolvedLevel(L, { sizes, surfaces, passages }), { sizes });
  const ids = a.checks.map((c) => c.id);
  console.log(`   ${a.checks.length} checks: ${ids.join(', ')}`);
  check('the module is readable and returns a verdict', a.ready === true, `ready=${a.ready}`);
  check('it asks exactly the six questions it documents, in order',
    ids.length === ARRANGEMENT_IDS.length
      && ids.every((id, i) => id === ARRANGEMENT_IDS[i]),
    `${ids.length}/${ARRANGEMENT_IDS.length}`);
  check('every question carries a verdict AND a reading', a.readings && a.checks.every(
    (c) => typeof c.pass === 'boolean' && c.label && c.detail !== undefined),
    `readings keys ${Object.keys(a.readings || {}).length}`);
}

/* --------------------------------------------------- 2. calibration */
console.log('');
console.log('-- 2. CALIBRATION: the reference flat must pass its own ruler ----------');
{
  const L = shipped();
  const a = auditArrangement(L, toResolvedLevel(L, { sizes, surfaces, passages, tag: 'js/layout.js' }), { sizes });
  const bad = a.checks.filter((c) => !c.pass);
  for (const c of a.checks) console.log(`   ${c.pass ? ' ok' : ' XX'}  ${c.id.padEnd(16)} ${c.detail}`);
  check('js/layout.js passes all six (a ruler that misjudges the reference is broken)',
    bad.length === 0, bad.length ? bad.map((c) => c.id).join(', ') : '6/6');
}

/* -------------------------------------------------- 3. the mutations */
console.log('');
console.log('-- 3. FALSIFIABLE: each of the six has a counter-example --------------');
console.log('   (and no counter-example is allowed to move a playability check)');
const unflipped = [];
const collateral = [];
const wrong = [];
for (const m of MUTATIONS) {
  const L = shipped();
  let flips; let playBad;
  try {
    m.make(L);
    const level = toResolvedLevel(L, { sizes, surfaces, passages, tag: m.id });
    const a = auditArrangement(L, level, { sizes });
    flips = a.ready ? a.checks.filter((c) => !c.pass).map((c) => c.id).sort() : ['<unreadable>'];
    const v = validateLayout({ layout: L, report: { problems: [] } }, sizes, surfaces, passages, 'mutation');
    playBad = v.checks.filter((c) => !c.pass).map((c) => c.id);
  } catch (e) {
    flips = [`<threw: ${e.message}>`];
    playBad = ['<build failed>'];
  }
  const want = [...m.flips].sort();
  const ok = flips.length === want.length && flips.every((f, i) => f === want[i]);
  if (!ok) wrong.push(`${m.id} via "${m.made}": got [${flips.join(',')}], declared [${want.join(',')}]`);
  if (!flips.includes(m.id)) unflipped.push(m.id);
  if (playBad.length) collateral.push(`${m.id}: ${playBad.join(',')}`);
  console.log(`   ${ok ? ' ok' : ' XX'}  ${m.id.padEnd(15)} ${flips.join(',').padEnd(24)} `
    + `playability ${playBad.length ? 'RED ' + playBad.join(',') : 'still 9/9'}`);
  console.log(`         what the flat is missing: ${m.made}`);
}
check('every one of the six can be turned red — no question is un-falsifiable',
  unflipped.length === 0, unflipped.join(', ') || `all six, over ${MUTATIONS.length} counter-examples`);
check('each counter-example turns red exactly the questions it declares (and nothing else)',
  wrong.length === 0, wrong[0] || `${MUTATIONS.length}/${MUTATIONS.length} as declared`);
check('THE TWO AXES ARE INDEPENDENT — no counter-example moves a playability check',
  collateral.length === 0, collateral[0] || 'playability 9/9 green under all of them');

/* -------------------------------------------------- 4/5. the sweep */
console.log('');
console.log('-- 4/5. the sweep: two axes stay separate, two entry points agree -----');
const observedRed = new Map(ARRANGEMENT_IDS.map((id) => [id, 0]));
const drift = [];
const shapeBad = [];
const playBad = [];
const claimMismatch = [];
const bandBad = [];
let readable = 0;
let arrangedEndToEnd = 0;

for (const s of SWEEP) {
  const p = { ...s.p, seed: 'procgen' };
  const gen = generateFloorplan(p, { sizes });
  const viaAudit = auditArrangement(gen.layout, toResolvedLevel(gen.layout, {
    sizes, surfaces, passages, tag: s.label,
  }), { sizes });
  const viaPipeline = validateLayout(gen, sizes, surfaces, passages, p.seed);

  if (!viaAudit.ready) { shapeBad.push(s.label); continue; }
  readable += 1;
  if (viaAudit.checks.every((c) => c.pass)) arrangedEndToEnd += 1;

  for (const c of viaAudit.checks) if (!c.pass) observedRed.set(c.id, observedRed.get(c.id) + 1);

  // 5. one source: the two entry points must return the same verdict.
  if (JSON.stringify(viaAudit.checks) !== JSON.stringify(viaPipeline.arrangement?.checks)) {
    const a = JSON.stringify(viaAudit.checks);
    const b = JSON.stringify(viaPipeline.arrangement?.checks);
    let at = 0;
    while (at < Math.min(a.length, b.length) && a[at] === b[at]) at += 1;
    drift.push(`${s.label} @char ${at}: audit ${a.slice(at, at + 40)} vs pipeline ${b.slice(at, at + 40)}`);
  }

  // 4. playability is untouched: exactly nine, and the same nine.
  const ids = viaPipeline.checks.map((c) => c.id);
  if (ids.length !== 9 || !PLAYABILITY_IDS.every((id, i) => ids[i] === id)) {
    playBad.push(`${s.label}: ${ids.join(',')}`);
  }

  /* 8. the plan's OWN claim about its circulation, held against the ruler's.
   * The two are independent computations of one fact and neither consults the
   * other: `planCirculation` reasons about the rectangles and the door tree it
   * just built, `auditArrangement` reads the co-ordinates of the level that
   * came out the far end. A divergence is a finding, not a formatting slip. */
  const claim = gen.report.circulation || {};
  for (const [field, says, measures] of [
    ['entry', claim.entry, viaAudit.readings.entry],
    ['entryRole', claim.entryRole, viaAudit.readings.entryRole],
    ['entryDegree', claim.entryDegree, viaAudit.readings.entryDegree],
    ['maxDegree', claim.maxDegree, viaAudit.readings.maxDegree],
    ['hops', claim.hops, viaAudit.readings.maxDepth],
  ]) {
    if (says !== measures) {
      claimMismatch.push(`${s.label} ${field}: plan says ${says}, ruler measures ${measures}`);
    }
  }
  // ...and the one claim the ruler answers with a VERDICT rather than a number.
  const blindClaim = (claim.blindBedrooms || 0) === 0;
  const blindRuled = viaAudit.checks.find((c) => c.id === 'bedroom-window').pass;
  if (blindClaim !== blindRuled) {
    claimMismatch.push(`${s.label} blindBedrooms: plan says ${claim.blindBedrooms}, `
      + `ruler's bedroom-window check is ${blindRuled ? 'green' : 'red'}`);
  }
  // The band plan's own shape, which nothing else reads. `rows[0].z1 === plan.d`
  // is the P1 design promise: the band the front door is on is the FIRST row,
  // and it is the one cut into few, wide cells so the entry owns neighbours.
  const rows = claim.rows || [];
  const cover = rows.reduce((a, r) => a + (r.z1 - r.z0), 0);
  if (rows.length !== claim.bands || Math.abs(cover - gen.report.plan.d) > 1e-9
      || Math.abs((rows[0] ? rows[0].z1 : -1) - gen.report.plan.d) > 1e-9) {
    bandBad.push(`${s.label}: ${rows.length} row(s) for ${claim.bands} band(s), `
      + `covering ${cover} of ${gen.report.plan.d} m, front row ends at ${rows[0] ? rows[0].z1 : 'n/a'}`);
  }
}

console.log(`   readable ${readable}/${SWEEP.length} layouts`);
for (const id of ARRANGEMENT_IDS) {
  console.log(`   ${id.padEnd(16)} red on ${observedRed.get(id)}/${readable} sweep layouts`);
}
console.log(`   P0 reading, kept for the record: all six were red on 12/12 sets, because`);
console.log(`   P0 changed no generation logic. P1 is the release that made this tally`);
console.log(`   uninteresting — the assertion over it lives in scripts/procgen.mjs,`);
console.log(`   which is where the exit code is ("arranged 72/72, 12/12 end to end").`);
check('the ruler reads every sweep layout without crashing',
  readable === SWEEP.length, `${readable}/${SWEEP.length}`);
check('playability is still EXACTLY the same nine checks, in the same order',
  playBad.length === 0, playBad[0] || '9/9 on all twelve sets');
check('the two axes share no id',
  ARRANGEMENT_IDS.every((id) => !PLAYABILITY_IDS.includes(id)), ARRANGEMENT_IDS.join(','));
check('ONE SOURCE — auditArrangement and validateLayout agree on all twelve layouts',
  drift.length === 0, drift[0] || 'identical verdicts, 12/12');

/* ------------------------------------- 8. the plan, held to its own claim */
console.log('');
console.log('-- 8. RECONCILIATION: what the plan says about itself, vs what is there -');
{
  const fields = ['entry', 'entryRole', 'entryDegree', 'maxDegree', 'hops'];
  console.log(`   ${readable} layouts, ${fields.length} claimed numbers + 1 claimed verdict + the band shape`);
  console.log(`   generator claims, ruler measures: ${fields.join(',')}, blindBedrooms`);
  check("the plan's own circulation claim agrees with the ruler's measurement, 12/12",
    claimMismatch.length === 0,
    claimMismatch[0] || 'every claimed number equals the measured one');
  check('the band plan tiles the plan exactly, and the front band is the first row',
    bandBad.length === 0, bandBad[0] || 'rows[0].z1 === plan.d and the rows cover 12/12 plans');
}

/* --------------------------------------------------- 6. across processes */
console.log('');
console.log('-- 6. the CLI, from a separate process --------------------------------');
{
  const argI = process.argv.indexOf('--cli');
  const rel = argI >= 0 && process.argv[argI + 1] ? process.argv[argI + 1] : 'work/_cli_arr.json';
  const p = { w: 13, d: 9, rooms: 8, items: 110, seed: 'pui' };
  const full = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const how = `node scripts/procgen.mjs --w ${p.w} --d ${p.d} --rooms ${p.rooms} `
    + `--items ${p.items} --seed ${p.seed} --json ${rel} --report work/_cli_arr.txt`;

  if (!fs.existsSync(full)) {
    check(`the CLI's JSON (${rel}) is present`, false, `run: ${how}`);
  } else {
    const obj = readJSON(full);
    const cli = obj.rows[0];
    const here = validateLayout(generateFloorplan(p, { sizes }), sizes, surfaces, passages, p.seed);
    const same = JSON.stringify(cli.arrangement.checks) === JSON.stringify(here.arrangement.checks);

    // The assertion that would have caught the stale artifact this check once
    // read. `fingerprint.mjs` explains the scar.
    const now = verdictFingerprint();
    check('the CLI\'s JSON was produced by THIS source tree, not by an older one',
      obj.fingerprint === now,
      obj.fingerprint
        ? (obj.fingerprint === now ? `sha256 ${now.slice(0, 16)}…` : `STALE: file ${obj.fingerprint.slice(0, 16)}… vs tree ${now.slice(0, 16)}… — re-run: ${how}`)
        : 'the file carries no fingerprint at all (written before scripts/fingerprint.mjs)');

    check('the CLI wrote the same arrangement verdict this process computes',
      same && cli.arrangement.checks.length === 6,
      `${cli.arrangement.checks.filter((c) => c.pass).length}/6 green in the file, `
      + `${here.arrangement.checks.filter((c) => c.pass).length}/6 here — ${same ? 'identical' : 'DIFFER'}`);

    // Flipped by P1. Under P0 the interesting reading was "playable and
    // UNARRANGED"; the two-axis separation it demonstrated is now carried by
    // the mutations in check 3, and what is left for the CLI to show is that a
    // separate process agrees on BOTH axes.
    check('and the CLI returns both axes green for this parameter set',
      cli.pass === true && cli.arrangement.pass === true,
      `playable ${cli.pass}, arranged ${cli.arrangement.pass}`);
  }
}

/* ------------------------------------------- 6b. the fingerprint is complete */
console.log('');
console.log('-- 6b. the fingerprint list is a checked list, not a remembered one --');
{
  const reach = reachableSources(VERDICT_ENTRIES);
  const missing = reach.filter((r) => !VERDICT_SOURCES.includes(r));
  console.log(`   import closure of ${VERDICT_ENTRIES.length} verdict modules: ${reach.length} files`);
  console.log(`   VERDICT_SOURCES ${VERDICT_SOURCES.length} modules + ${VERDICT_DATA.length} data file(s)`);
  check('every module the verdict is computed from is covered by the fingerprint',
    missing.length === 0,
    missing.length ? `MISSING from VERDICT_SOURCES: ${missing.join(', ')}` : 'closure fully covered');
  check('and each data file listed really exists (a name that has moved is a lie)',
    VERDICT_DATA.every((d) => fs.existsSync(path.join(ROOT, d))), VERDICT_DATA.join(', '));
}

/* ----------------------------------------------------------- 7. wired */
console.log('');
console.log('-- 7. the workbench has the slots, and writes them -------------------');
console.log('   (STATIC: this environment cannot create a child process, so no browser');
console.log('    can be launched here. The render itself is held by');
console.log('    scripts/verify_playground.mjs, which asserts the painted strip against');
console.log('    Node\'s answer — run it from a normal terminal.)');
{
  const html = fs.readFileSync(path.join(ROOT, 'procgen.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'game', 'procgen', 'playground.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'css', 'procgen.css'), 'utf8');
  const slots = ['verdict-arr', 'arrhead', 'arrchecks'];
  check('procgen.html declares all three slots', slots.every((s) => html.includes(`id="${s}"`)),
    slots.filter((s) => !html.includes(`id="${s}"`)).join(', ') || slots.join(', '));
  check('playground.js writes all three (an unwritten slot is a lie on screen)',
    slots.every((s) => js.includes(`$('${s}')`)),
    slots.filter((s) => !js.includes(`$('${s}')`)).join(', ') || 'all three');
  check('css styles the second strip', css.includes('#verdict-arr') && css.includes('#arrchecks'));
  check('and the harness API exposes the second axis to the acceptance run',
    /arrangement: last\.v\.arrangement \?/.test(js));
}

console.log('');
console.log('='.repeat(78));
console.log(`  ${passed}/${passed + failed} checks passed`);
console.log('='.repeat(78));
console.log(`  VERDICT: ${failed === 0 ? 'PASS' : 'FAIL'}`);
console.log('');
console.log(`  NOTE: this suite asserts the RULER -- that the six questions are asked,`);
console.log(`  that the reference passes them, that each one CAN fail, and that the two`);
console.log(`  entry points and the two axes stay separate. Whether a given layout IS`);
console.log(`  arranged is a different assertion, and it lives where the exit code is:`);
console.log(`  scripts/procgen.mjs --strict-arrangement ("arranged N/M checks green").`);
console.log('');

process.exit(failed === 0 ? 0 : 2);
