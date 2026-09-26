/**
 * verify_arrangement.mjs — P0's acceptance run, for the SECOND verdict.
 *
 *     node scripts/verify_arrangement.mjs
 *     node scripts/verify_arrangement.mjs --cli work/_ui_arr.json
 *
 * WHAT P0 PROMISED. Six countable questions about whether a generated floor is
 * a PLACE rather than merely a maze, wired into `game/procgen/pipeline.js` as a
 * verdict SEPARATE from playability, visible in the CLI and on the workbench.
 * The point of P0 is that the readings go red -- so this file must not assert
 * that anything is arranged.
 *
 * WHAT IT ASSERTS INSTEAD, and why each one is the only kind of evidence that
 * would be worth anything here:
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
 *   3 FALSIFIABLE  every single question has been OBSERVED RED on at least one
 *                  of the twelve sweep parameter sets. A checker that can only
 *                  ever agree is worse than no checker, and this project has
 *                  already shipped one of those.
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
 *                  agrees with the in-process pipeline for the same parameters.
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

const shipLayout = {
  WALL_H: SHIPPED.WALL_H, PLAN: SHIPPED.PLAN, ZONES: SHIPPED.ZONES,
  WALLS: SHIPPED.WALLS, CORNERS: SHIPPED.CORNERS, DOORS: SHIPPED.DOORS, ROOMS: SHIPPED.ROOMS,
};

console.log('');
console.log('='.repeat(78));
console.log('  arrangement — P0 acceptance (two axes, one implementation)');
console.log('='.repeat(78));

/* ------------------------------------------------------------- 1. shape */
console.log('');
console.log('-- 1. the six questions exist, in order -------------------------------');
{
  const a = auditArrangement(shipLayout, toResolvedLevel(shipLayout, { sizes, surfaces, passages }), { sizes });
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
  const a = auditArrangement(shipLayout, toResolvedLevel(shipLayout, { sizes, surfaces, passages, tag: 'js/layout.js' }), { sizes });
  const bad = a.checks.filter((c) => !c.pass);
  for (const c of a.checks) console.log(`   ${c.pass ? ' ok' : ' XX'}  ${c.id.padEnd(16)} ${c.detail}`);
  check('js/layout.js passes all six (a ruler that misjudges the reference is broken)',
    bad.length === 0, bad.length ? bad.map((c) => c.id).join(', ') : '6/6');
}

/* -------------------------------------------------- 3/4/5. the sweep */
console.log('');
console.log('-- 3. every question can FAIL, and 4/5. the two axes stay separate ----');
const observedRed = new Map(ARRANGEMENT_IDS.map((id) => [id, 0]));
const drift = [];
const shapeBad = [];
const playBad = [];
let readable = 0;

for (const s of SWEEP) {
  const p = { ...s.p, seed: 'procgen' };
  const gen = generateFloorplan(p, { sizes });
  const viaAudit = auditArrangement(gen.layout, toResolvedLevel(gen.layout, {
    sizes, surfaces, passages, tag: s.label,
  }), { sizes });
  const viaPipeline = validateLayout(gen, sizes, surfaces, passages, p.seed);

  if (!viaAudit.ready) { shapeBad.push(s.label); continue; }
  readable += 1;

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
}

console.log(`   readable ${readable}/${SWEEP.length} layouts`);
for (const id of ARRANGEMENT_IDS) {
  console.log(`   ${id.padEnd(16)} red on ${observedRed.get(id)}/${readable} sweep layouts`);
}

check('the ruler reads every sweep layout without crashing',
  readable === SWEEP.length, `${readable}/${SWEEP.length}`);
check('NOT VACUOUS — every one of the six has been observed red at least once',
  ARRANGEMENT_IDS.every((id) => observedRed.get(id) > 0),
  ARRANGEMENT_IDS.filter((id) => observedRed.get(id) === 0).join(', ') || 'all six have failed somewhere');
check('playability is still EXACTLY the same nine checks, in the same order',
  playBad.length === 0, playBad[0] || '9/9 on all twelve sets');
check('the two axes share no id',
  ARRANGEMENT_IDS.every((id) => !PLAYABILITY_IDS.includes(id)), ARRANGEMENT_IDS.join(','));
check('ONE SOURCE — auditArrangement and validateLayout agree on all twelve layouts',
  drift.length === 0, drift[0] || 'identical verdicts, 12/12');

/* --------------------------------------------------- 6. across processes */
console.log('');
console.log('-- 6. the CLI, from a separate process ---------------------------------');
{
  const argI = process.argv.indexOf('--cli');
  const rel = argI >= 0 && process.argv[argI + 1] ? process.argv[argI + 1] : 'work/_ui_arr.json';
  const p = { w: 13, d: 9, rooms: 8, items: 110, seed: 'pui' };
  const full = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    check(`the CLI's JSON (${rel}) is present — run scripts/procgen.mjs --json ${rel} first`,
      false, 'missing file');
  } else {
    const cli = readJSON(full).rows[0];
    const here = validateLayout(generateFloorplan(p, { sizes }), sizes, surfaces, passages, p.seed);
    const same = JSON.stringify(cli.arrangement.checks) === JSON.stringify(here.arrangement.checks);
    check('the CLI wrote the same arrangement verdict this process computes',
      same && cli.arrangement.checks.length === 6,
      `${cli.arrangement.checks.filter((c) => c.pass).length}/6 green in the file, `
      + `${here.arrangement.checks.filter((c) => c.pass).length}/6 here — ${same ? 'identical' : 'DIFFER'}`);
    check('and the CLI still calls the floor PLAYABLE while it is unarranged',
      cli.pass === true && cli.arrangement.pass === false,
      `playable ${cli.pass}, arranged ${cli.arrangement.pass}`);
  }
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
console.log(`  NOTE: the arrangement axis is expected to be RED in the product. This`);
console.log(`  suite asserts the ruler, not the layouts — see scripts/procgen.mjs,`);
console.log(`  where the second tally reads "arranged N/M checks green".`);
console.log('');

process.exit(failed === 0 ? 0 : 2);
