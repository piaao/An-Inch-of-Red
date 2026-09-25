/**
 * procgen.mjs — generate floor plans by parameter, and TEST them.
 *
 *     node scripts/procgen.mjs                       a small sweep + a SVG contact sheet
 *     node scripts/procgen.mjs --w 12 --d 9 --rooms 7 --items 90 --seed flatA
 *     node scripts/procgen.mjs --sweep                the full parameter grid
 *     node scripts/procgen.mjs --count 8              eight seeds at the base params
 *     node scripts/procgen.mjs --out-layout js/layout.gen.js --arena game/arenas/gen.json
 *
 * `--arena` writes a snapshot that CARRIES the layout it was built from, so
 * `play.html?arena=<that file>` builds the floor it is about -- not the shipped
 * apartment. `--out-layout` writes a module for reading, diffing and review;
 * the game never loads it. scripts/verify_world.mjs holds both claims.
 *
 * WHAT "TESTED" MEANS HERE. A generated layout is not judged by how it looks.
 * `game/procgen/pipeline.js` runs it through the SAME pipeline the shipped
 * apartment goes through and returns seven countable verdicts -- structural,
 * adapter, walkable, rooms, reachable, prizes, boundary -- and that file is
 * where each one's rationale lives.
 *
 * The harness lives THERE rather than here because the browser playground
 * (procgen.html) generates floors too, and there should be exactly one
 * implementation of "is this layout playable". This script is the command-line
 * front end: it builds the parameter sets, prints the verdicts, writes the
 * artifacts.
 *
 * The SVG is a VERIFICATION artifact, not an illustration:
 * `game/procgen/draw.js` draws it from the built LEVEL (walls, doors and
 * furniture as the game sees them), not from the generator's intentions. If
 * those two ever disagree, the picture shows the disagreement instead of
 * hiding it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateFloorplan, DEFAULTS } from '../game/procgen/floorplan.js';
import { requiredModels } from '../game/procgen/required.js';
import { PRIZE_COUNT, validateLayout } from '../game/procgen/pipeline.js';
import { planSVG, contactSVG } from '../game/procgen/draw.js';
import { buildLevel } from '../game/arena/fromLayout.js';
import { buildWallOpenings, buildDoorStates } from '../game/arena/openings.js';
import { buildNav } from '../game/core/nav.js';
import { resolveRooms, applyRooms } from '../game/core/regions.js';
import * as SHIPPED from '../js/layout.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readJSON = (p, fallback = null) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback);
const num = (v, d) => (v == null || v === '' ? d : Number(v));

/* ------------------------------------------------------------------- argv */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

/* ------------------------------------------------------------------ sweep */

/**
 * The generator's own knobs, reachable from a shell.
 *
 * Without this the tool is a tool with one setting: everything in DEFAULTS was
 * settable in code and unreachable from a command line, which is the difference
 * between a batch generator and a script that runs the same flat twelve times.
 */
const KNOBS = ['minRoom', 'lane', 'gap', 'doorMargin', 'loopDoor', 'maxLoopDoors',
               'windowChance', 'roomCap', 'floorTries'];

function knobArgs(args) {
  const out = {};
  for (const k of KNOBS) if (args[k] != null) out[k] = Number(args[k]);
  return out;
}

function presetSets(args) {
  const knobs = knobArgs(args);
  if (args.sweep) {
    const base = { rooms: 6, items: 60 };
    return [
      { label: '10x8  6 rooms  60 items', p: { ...base } },
      { label: '8x6   4 rooms  40 items', p: { w: 8, d: 6, rooms: 4, items: 40 } },
      { label: '12x9  7 rooms  95 items', p: { w: 12, d: 9, rooms: 7, items: 95 } },
      { label: '14x10 9 rooms 130 items', p: { w: 14, d: 10, rooms: 9, items: 130 } },
      { label: '10x8  3 rooms 100 items', p: { w: 10, d: 8, rooms: 3, items: 100 } },
      { label: '6x6   4 rooms  35 items', p: { w: 6, d: 6, rooms: 4, items: 35 } },
      { label: '20x12 12 rooms 220 items', p: { w: 20, d: 12, rooms: 12, items: 220 } },
      { label: '16x14 10 rooms 160 items', p: { w: 16, d: 14, rooms: 10, items: 160 } },
      // 7 x 5 m holds TWO rooms of >= 2.4 m a side on the integer wall grid --
      // floor(7/3) * floor(5/3) = 2 -- so asking for three is asking for
      // something that does not exist, and `generateFloorplan` now says so
      // before it tries. The case stays in the sweep, at the number that fits.
      { label: '7x5   2 rooms  24 items', p: { w: 7, d: 5, rooms: 2, items: 24 } },
      { label: '24x16 16 rooms 300 items', p: { w: 24, d: 16, rooms: 16, items: 300 } },
      { label: '9x9   5 rooms  55 items', p: { w: 9, d: 9, rooms: 5, items: 55 } },
      { label: '11x7  6 rooms  70 items', p: { w: 11, d: 7, rooms: 6, items: 70 } },
    ].map((s) => ({ ...s, p: { ...s.p, ...knobs } }));
  }
  const base = {
    w: num(args.w, DEFAULTS.w),
    d: num(args.d, DEFAULTS.d),
    rooms: num(args.rooms, DEFAULTS.rooms),
    items: num(args.items, DEFAULTS.items),
  };
  const count = num(args.count, 1);
  const merged = { ...base, ...knobs };
  if (count <= 1) return [{ label: `${merged.w}x${merged.d} ${merged.rooms}r ${merged.items}i`, p: { ...merged, seed: args.seed || DEFAULTS.seed } }];
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ label: `${merged.w}x${merged.d} ${merged.rooms}r ${merged.items}i #${i + 1}`, p: { ...merged, seed: `${args.seed || 'procgen'}-${i + 1}` } });
  }
  return out;
}

/* ------------------------------------------------------------------- main */

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sizes = readJSON(path.join(ROOT, 'data', 'kit_three.json'));
  const surfaces = readJSON(path.join(ROOT, 'data', 'model_surfaces.json'), {});
  const passages = readJSON(path.join(ROOT, 'data', 'passages.json'));
  if (!sizes || !sizes.models) throw new Error('data/kit_three.json missing — run scripts/measure.js first');
  if (!passages) throw new Error('data/passages.json missing — run scripts/probe_passages.js first');

  const say = (s) => { if (!args.quiet) console.log(s); };

  /* --- the one duplication in this tool, CHECKED rather than trusted ---- */
  const shipLayout = { WALL_H: SHIPPED.WALL_H, PLAN: SHIPPED.PLAN, ZONES: SHIPPED.ZONES,
    WALLS: SHIPPED.WALLS, CORNERS: SHIPPED.CORNERS, DOORS: SHIPPED.DOORS, ROOMS: SHIPPED.ROOMS };
  const a = SHIPPED.requiredModels().join(',');
  const b = requiredModels(shipLayout).join(',');
  say(`requiredModels agrees with js/layout.js: ${a === b ? 'YES' : 'NO'}`);
  if (a !== b) {
    say('  js/layout.js : ' + a);
    say('  procgen/required.js : ' + b);
    return 3;
  }

  const sets = presetSets(args);
  const results = [];
  const t0 = Date.now();

  for (const set of sets) {
    const gen = generateFloorplan(set.p, { sizes });
    // A crashed harness is a FAILED LAYOUT, not a crashed sweep. One bad seed
    // in a 12-layout grid must not hide the other eleven.
    let v;
    try {
      v = validateLayout(gen, sizes, surfaces, passages, String(set.p.seed || DEFAULTS.seed));
    } catch (err) {
      v = {
        level: null, nav: null, placement: { prizes: [], report: { roomsUsed: 0, roomsTotal: 0, anchorsScored: 0 } },
        checks: [{ id: 'harness', label: 'pipeline threw', pass: false, detail: String(err && err.message || err) }],
      };
    }
    const fails = v.checks.filter((c) => !c.pass);
    results.push({ ...set, ...v, fails, gen });
    say(`${fails.length ? 'FAIL' : 'PASS'}  ${set.label.padEnd(26)} `
      + `rooms ${String(gen.report.rooms).padStart(2)}  `
      + `items ${String(gen.report.items.placed).padStart(3)}/${gen.report.items.wanted}  `
      + `climbTops ${String(gen.report.climbTops).padStart(3)}  `
      + `free ${(gen.report.freeFraction * 100).toFixed(0)}%  `
      + `prizes ${v.placement.prizes.length}/${PRIZE_COUNT}`);
    for (const f of fails) say(`        ! ${f.label}: ${f.detail}`);
  }

  /* ------------------------------------------------------------- summary */
  const pass = results.filter((r) => !r.fails.length).length;
  say('');
  say('='.repeat(78));
  say(`generated ${results.length} layouts in ${((Date.now() - t0) / 1000).toFixed(1)} s   `
    + `${pass}/${results.length} PASS`);

  const allRejected = {};
  for (const r of results) for (const [k, v] of Object.entries(r.gen.report.rejected)) allRejected[k] = (allRejected[k] || 0) + v;
  say('placement rejections (why the generator said no): '
    + Object.entries(allRejected).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));

  const totItems = results.reduce((a, r) => a + r.gen.report.items.placed, 0);
  const totWant = results.reduce((a, r) => a + r.gen.report.items.wanted, 0);
  say(`items placed ${totItems}/${totWant} (${(totItems / totWant * 100).toFixed(0)}%)   `
    + `climbable tops ${results.reduce((a, r) => a + r.gen.report.climbTops, 0)}   `
    + `doors ${results.reduce((a, r) => a + r.gen.report.doors.total, 0)}`);
  say('='.repeat(78));

  /* The plan-boundary reading used to be printed HERE, as a note, because the
   * tool could not make it pass. It is now check 7 of every layout -- see
   * `edgeLeaks` for the measurement and for why it moved. */

  /* --------------------------------------------------------------- write */
  const reportsDir = path.join(ROOT, 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  // WHICH FILE THE PLAN GOES TO. `--svg` says it outright; failing that it
  // FOLLOWS `--report` (same stem, .svg). That is not a convenience: a caller
  // which redirects its LOG into work/ and leaves its DRAWING in reports/ is a
  // caller that will eventually overwrite the committed twelve-floor contact
  // sheet with one floor. Measured, not imagined -- verify_playground.mjs's
  // second parameter set passed --report without --svg, and every run of that
  // suite left a 31,927-byte single-plan SVG where the 323,000-byte sweep
  // evidence had been. Two outputs, one destination decision: they travel
  // together, so there is no second flag to forget.
  const svgPath = path.resolve(ROOT, typeof args.svg === 'string' ? args.svg
    : typeof args.report === 'string'
      ? path.join(path.dirname(args.report),
        path.basename(args.report).replace(/\.[^.]*$/, '') + '.svg')
      : path.join('reports', 'procgen.svg'));
  const scale = num(args.scale, results.length > 4 ? 34 : 62);
  const drawable = results.filter((r) => r.level);
  const items = drawable.map((r) => ({
    ...r, scale,
    label: r.label,
    sub: `${r.gen.report.rooms} rooms · ${r.gen.report.items.placed} items · `
      + `${r.gen.report.climbTops} climbable tops · ${(r.gen.report.freeFraction * 100).toFixed(0)}% free`,
  }));
  if (!items.length) {
    say('nothing to draw: every layout failed before a level existed');
  } else if (items.length === 1) {
    fs.writeFileSync(svgPath, planSVG(items[0], { scale, showLabels: true }), 'utf8');
  } else {
    fs.writeFileSync(svgPath,
      contactSVG(items, Math.min(4, Math.max(2, Math.ceil(Math.sqrt(items.length))))), 'utf8');
  }
  if (items.length) say(`wrote ${path.relative(ROOT, svgPath).replace(/\\/g, '/')}`);

  if (args.json) {
    const jp = path.resolve(ROOT, String(args.json));
    const rows = results.map((r) => ({
      label: r.label, params: r.gen.params, pass: !r.fails.length,
      checks: r.checks, report: { ...r.gen.report, rects: undefined },
      prizes: r.placement.prizes.map((p) => ({ x: +p.x.toFixed(3), z: +p.z.toFixed(3), y: +p.y.toFixed(3), room: p.room, tier: p.tier })),
      prizeReport: { ...r.placement.report, covers: undefined, stats: undefined },
    }));
    fs.writeFileSync(jp, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 1), 'utf8');
    say(`wrote ${path.relative(ROOT, jp).replace(/\\/g, '/')}`);
  }

  // INSPECTION ONLY -- the game does not load the module written here. The
  // `--arena` snapshot carries its own copy of the layout, because a floor
  // generated in a browser has no file for a path to point at and a path is a
  // second truth waiting to disagree with the first. This exists so a layout
  // can be read as source.
  if (typeof args['out-layout'] === 'string') {
    const lp = path.resolve(ROOT, args['out-layout']);
    const r = results[0];
    const head = `/**\n * GENERATED by scripts/procgen.mjs -- do not edit by hand.\n`
      + ` *\n * params: ${JSON.stringify(r.gen.params)}\n`
      + ` * ${r.gen.report.rooms} rooms, ${r.gen.report.items.placed} items, `
      + `${r.gen.report.climbTops} climbable tops, ${r.fails.length ? r.fails.length + ' FAILED CHECK(S)' : 'all checks pass'}.\n`
      + ` *\n * Same schema as js/layout.js, so fromLayout.js and the viewer read it unchanged.\n`
      + ` *\n * FOR INSPECTION. The game never loads this file: an arena snapshot carries\n`
      + ` * its own copy of the layout (see game/arena/fromLayout.js), so the floor\n`
      + ` * you see is the floor you play.\n */\n`
      + `import { requiredModels as _requiredModels } from '../game/procgen/required.js';\n\n`;
    const body = `export const WALL_H = ${r.gen.layout.WALL_H};\n\n`
      + `export const PLAN = ${JSON.stringify(r.gen.layout.PLAN)};\n\n`
      + `export const ZONES = ${JSON.stringify(r.gen.layout.ZONES, null, 1)};\n\n`
      + `export const WALLS = ${JSON.stringify(r.gen.layout.WALLS, null, 1)};\n\n`
      + `export const CORNERS = [];\n\n`
      + `export const DOORS = ${JSON.stringify(r.gen.layout.DOORS, null, 1)};\n\n`
      + `export const ROOMS = ${JSON.stringify(r.gen.layout.ROOMS, null, 1)};\n\n`
      + `export function requiredModels() {\n`
      + `  return _requiredModels({ WALL_H, PLAN, ZONES, WALLS, CORNERS, DOORS, ROOMS });\n`
      + `}\n`;
    fs.writeFileSync(lp, head + body, 'utf8');
    say(`wrote ${path.relative(ROOT, lp).replace(/\\/g, '/')}`);
  }

  if (typeof args.arena === 'string') {
    const ap = path.resolve(ROOT, args.arena);
    const r = results[0];
    const { wallOpenings } = buildWallOpenings(passages, sizes);
    const { doorClosed } = buildDoorStates(passages, r.gen.layout.DOORS);
    const level = buildLevel({
      layout: r.gen.layout, sizes, surfaces, wallOpenings,
      options: { id: 'procgen', name: '生成户型', source: 'procgen', doorClosed },
    });
    const regionNav = buildNav(level, {
      inflate: level.body.playerRadius, bodyHeight: level.body.playerHeight,
      step: level.meta.step, sealOpenings: true,
    });
    applyRooms(level, resolveRooms(level, regionNav).rooms);
    level.meta.provenance = { generatedBy: 'scripts/procgen.mjs', params: r.gen.params };
    fs.writeFileSync(ap, JSON.stringify(level), 'utf8');
    say(`wrote ${path.relative(ROOT, ap).replace(/\\/g, '/')}  ${(fs.statSync(ap).size / 1024).toFixed(0)} KB`);
  }

  const logLines = [];
  for (const r of results) {
    logLines.push(`${r.fails.length ? 'FAIL' : 'PASS'}  ${r.label}`);
    logLines.push(`   params ${JSON.stringify(r.gen.params)}`);
    logLines.push(`   rooms ${r.gen.report.rooms} (${r.gen.report.roomIds.join(', ')})  doors ${r.gen.report.doors.total}`
      + `  walls ${r.gen.report.walls.runs} runs / ${r.gen.report.walls.segments} segments`);
    logLines.push(`   items ${r.gen.report.items.placed}/${r.gen.report.items.wanted}  climbTops ${r.gen.report.climbTops}`
      + `  free ${(r.gen.report.freeFraction * 100).toFixed(1)}%  rejections ${JSON.stringify(r.gen.report.rejected)}`);
    for (const c of r.checks) logLines.push(`   [${c.pass ? 'ok' : 'XX'}] ${c.label}${c.detail ? '  -- ' + c.detail : ''}`);
    for (const t of r.gen.report.trace) logLines.push(`   .. ${t}`);
    logLines.push('');
  }
  // The text log is COMMITTED EVIDENCE -- the README's headline claim points at
  // this file -- so any caller running the generator on its own behalf must be
  // able to redirect it. Hardcoding it meant the acceptance suites silently
  // overwrote the sweep log they were quoting: verify_gen_play did it, then
  // verify_playground, then verify_live, each leaving ONE layout's log standing
  // in for twelve. --report is how a harness keeps its own mess out of the repo.
  const reportPath = path.resolve(ROOT, typeof args.report === 'string'
    ? args.report : path.join('reports', 'procgen.txt'));
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, logLines.join('\n'), 'utf8');

  return pass === results.length ? 0 : 2;
}

process.exit(main());
