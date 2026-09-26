/**
 * verify_minimap.mjs — the thumbnail: fog, and the two markers on top of it.
 *
 *     node scripts/verify_minimap.mjs
 *     node scripts/verify_minimap.mjs --log work/_mut_B1.log
 *
 * `--log` exists because of a real accident, shared with `verify_packets.mjs`.
 * A mutation run feeds this file a deliberately broken tree and runs it -- which
 * makes THIS tool overwrite its own `work/verify_minimap.log` with a FAILED
 * transcript. Reverting the source afterwards does not revert the log.
 * Redirectable logs fix it at the source; "remember to restore the log" would not.
 *
 * ONE Node process, driving the REAL `game/play/minimap.js` with a canvas that
 * records draw calls. No Chrome: the questions here -- how many cells get
 * fogged, in what ORDER the layers go down, what the marker geometry is -- are
 * answerable from the calls.
 *
 * WHAT IT IS NOT: a pixel test. The stub records CALLS, so it proves the map is
 * DRAWN the way the code says, not that the result LOOKS right. The pixel half
 * lives in `verify_play.mjs` (blob centroid vs `project()`) and needs a
 * browser. Saying which half you measured is part of the measurement.
 *
 * THE THREE THINGS THIS IS HERE TO CATCH:
 *
 *   1. A FOG LAYER THAT EATS THE MARKERS. The fog is opaque (alpha .94) and it
 *      covers the floor. If it were painted after the player/guard triangles,
 *      a guard standing in an unexplored room would simply VANISH from the map
 *      -- in the one game whose whole point is "where is it". This is asserted
 *      as a CALL ORDER, which is the only thing the stub can see.
 *   2. A MARKER MADE "MORE VISIBLE" BY MAKING IT BIGGER. `verify_play.mjs`
 *      bounds the marker blob at 12 CSS px, so prominence has to come from
 *      CONTRAST (a dark ground ring, a white edge, a solid centre dot) rather
 *      than size. The bound is re-derived here from the recorded geometry.
 *   3. A ONE-GUARD CALL THAT QUIETLY STOPPED WORKING. `draw({guard})` is the
 *      old signature and `draw({guards})` is the new one; a rename that forgot
 *      the old caller draws no guard at all, and nothing would say so.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.window = { devicePixelRatio: 1 };

const { Minimap } = await import('../game/play/minimap.js');

const ROOT = new URL('..', import.meta.url);
const level = JSON.parse(fs.readFileSync(new URL('game/arenas/room_scene.json', ROOT), 'utf8'));

/* ------------------------------------------------------------ the stub */
function makeStub() {
  let n = 0;                       // global call order, across every array
  const calls = { fillRect: [], paths: [], arcs: [], texts: [], order: () => n++ };
  let cur = null;
  const style = { fill: '', stroke: '', lineWidth: 1 };
  const ctx = {
    set fillStyle(v) { style.fill = v; }, get fillStyle() { return style.fill; },
    set strokeStyle(v) { style.stroke = v; }, get strokeStyle() { return style.stroke; },
    set lineWidth(v) { style.lineWidth = v; }, get lineWidth() { return style.lineWidth; },
    font: '', textAlign: '', textBaseline: '',
    setTransform() {}, clearRect() {}, strokeRect() {},
    fillRect(x, y, w, h) {
      calls.fillRect.push({ n: n++, x, y, w, h, fill: style.fill });
    },
    beginPath() { cur = { pts: [] }; },
    moveTo(x, y) { if (cur) cur.pts.push([x, y]); },
    lineTo(x, y) { if (cur) cur.pts.push([x, y]); },
    closePath() {},
    fill() { if (cur) cur.fill = style.fill; },
    stroke() {
      // PUSH A COPY, WITH ITS OWN CALL NUMBER. One path is stroked TWICE -- a
      // dark ground ring and then the white edge -- and pushing `cur` itself
      // would leave two records of the SECOND style: the stub would erase its
      // own evidence, and that is a bug this file already had once.
      if (cur) {
        calls.paths.push({
          n: n++, pts: cur.pts.slice(), stroke: style.stroke, strokeW: style.lineWidth,
        });
      }
    },
    arc(x, y, r, a0, a1) {
      calls.arcs.push({ n: n++, x, y, r, stroke: style.stroke, fill: style.fill, w: style.lineWidth });
    },
    fillText(t, x, y) { calls.texts.push({ n: n++, t, x, y, fill: style.fill }); },
    measureText(t) { return { width: t.length * 7 }; },
  };
  const canvas = { style: {}, width: 0, height: 0, getContext() { return ctx; } };
  return { canvas, ctx, calls };
}

const log = [];
const say = (s = '') => { log.push(s); console.log(s); };
const checks = [];
const ok = (cond, label, detail = '') => {
  checks.push({ ok: !!cond, label, detail });
  say(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  -- ' + detail : ''}`);
  return !!cond;
};

let exitCode = 0;
try {
  const stub = makeStub();
  const M = new Minimap(stub.canvas, level);
  const m = M.metrics();
  say('== the plan ==');
  say(`  canvas ${m.cssW} x ${m.cssD} CSS px, scale ${m.scale.toFixed(2)} px/m, `
    + `${m.rooms} rooms, ${m.doors} doors`);

  const FG = 'rgba(6,8,12,.94)';       // INK_FOG
  const OUT = 'rgba(255,255,255,.92)'; // OUTLINE
  const player = { x: 2.2, z: 5.9, facing: 0.3 };
  const guard = { x: 7.9, z: 4.1, facing: -1.2, mode: 'patrol' };
  const fogRects = () => stub.calls.fillRect.filter((r) => r.fill === FG);
  const tris = () => stub.calls.paths.filter((p) => p.pts.length === 3);
  const reset = () => { [stub.calls.fillRect, stub.calls.paths, stub.calls.arcs].forEach((a) => (a.length = 0)); };

  /* ---------------------------------------- 1. no fog means NO fog layer */
  say('\n== handed no fog, the map draws whole ==');
  reset();
  M.draw({ player, guards: [guard] });
  ok(fogRects().length === 0, 'zero fog rectangles without a fog argument',
    `${fogRects().length}`);

  /* ---------------------------------------- 2. all-dark = every cell dark */
  say('\n== an unexplored map is a black card ==');
  const cols = Math.ceil(m.planW / 1), rows = Math.ceil(m.planD / 1);
  const fog = { cols, rows, cell: 1, x0: 0, z0: 0, seen: new Uint8Array(cols * rows) };
  reset();
  M.draw({ player, guards: [guard], fog });
  ok(fogRects().length === cols * rows, 'every unexplored cell is painted',
    `${fogRects().length} of ${cols * rows} cells (${cols} x ${rows} on a ${m.planW} x ${m.planD} m plan)`);

  /* --------------------------------- 3. seen cells are the ONLY unpainted */
  say('\n== walking opens the map, cell by cell ==');
  fog.seen[0] = 1; fog.seen[1] = 1; fog.seen[cols] = 1;
  reset();
  M.draw({ player, guards: [guard], fog });
  ok(fogRects().length === cols * rows - 3, 'exactly the seen cells go unpainted',
    `${fogRects().length} painted, 3 cells marked seen`);

  /* ------------------------- 4. FOG UNDER MARKERS: the call-order assertion */
  say('\n== the fog is a floor, not a lid ==');
  const lastFog = fogRects().reduce((a, r) => Math.max(a, r.n), -1);
  const firstMark = tris().reduce((a, p) => Math.min(a, p.n), Infinity);
  const firstArc = stub.calls.arcs.reduce((a, p) => Math.min(a, p.n), Infinity);
  ok(lastFog < firstMark && lastFog < firstArc,
    'every fog cell is painted BEFORE the first player/guard marker',
    `last fog call #${lastFog}, first marker #${Math.min(firstMark, firstArc)}`
      + ` -- a guard in an unexplored room still shows on the map`);

  /* -------------------------------------------- 5. the markers stand out */
  say('\n== the markers, and the 12 CSS px blob the suite bounds ==');
  reset();
  M.draw({ player, guards: [guard], fog });
  const whiteEdged = tris().filter((p) => p.stroke === OUT).length;
  const dots = stub.calls.arcs.filter((a) => Math.abs(a.r - 1.9) < 1e-9).length;
  const rings = stub.calls.arcs.filter((a) => Math.abs(a.r - 3.6) < 1e-9).length;
  ok(whiteEdged === 2 && tris().length === 4,
    'two heading triangles, each stroked twice (dark ground ring, then white edge)',
    `${tris().length} strokes, ${whiteEdged} of them white`);
  ok(dots === 2, 'both markers carry a solid centre dot at the position', `${dots}`);
  ok(rings === 1, 'ONLY the guard gets the outer ring -- friend and threat differ by shape',
    `${rings}`);

  let worst = 0;
  for (const t of tris()) {
    const xs = t.pts.map((p) => p[0]);
    const ys = t.pts.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    // + the ground ring, centred on the path: it sticks out by half its width,
    // and `blob` in verify_play measures the OUTER extent.
    worst = Math.max(worst, Math.max(w, h) + t.strokeW);
  }
  ok(worst <= 12, 'the widest marker blob still fits the suite\'s 12 px bound',
    `${worst.toFixed(2)} px (bar is 12; the old single-stroke marker was ~9)`);

  /* ------------------------------- 6. multi-guard and single-guard callers */
  say('\n== a second guard is an addition, not a rename ==');
  const whiteCount = () => stub.calls.paths.filter(
    (p) => p.pts.length === 3 && p.stroke === OUT).length;
  reset();
  M.draw({ player, guard });                        // the OLD single-guard shape
  ok(whiteCount() === 2, 'the single-guard call `{guard}` still draws both markers',
    `${whiteCount()}`);
  reset();
  M.draw({ player, guards: [guard, { x: 1, z: 1, facing: 0, mode: 'chase' }] });
  ok(whiteCount() === 3, 'two guards draw three markers (player + 2)', `${whiteCount()}`);

  /* ------------------------------------ 7. the run actually wires it in */
  say('\n== the run passes what this needs ==');
  const src = fs.readFileSync(new URL('game/play/play.js', ROOT), 'utf8');
  ok(/minimap\.draw\(\{[\s\S]{0,400}?fog,/.test(src), 'play.js hands the map its fog');
  ok(/guards: guards\.map\(/.test(src), 'play.js hands the map the whole garrison');
  ok(/updateFog\(\)/.test(src) && /sightLine\(level, here/.test(src),
    'exploration is opened through the CORE\'s own sightLine');
} catch (err) {
  say('');
  say('HARNESS ERROR: ' + (err && err.stack ? err.stack : err));
  exitCode = 2;
}

const passed = checks.filter((c) => c.ok).length;
say('');
say('='.repeat(72));
say(`  ${passed}/${checks.length} checks passed`);
for (const c of checks) if (!c.ok) say(`   FAILED: ${c.label} — ${c.detail || ''}`);
say('='.repeat(72));
const verdict = checks.length > 0 && passed === checks.length && exitCode === 0;
say(verdict ? '  VERDICT: PASS' : '  VERDICT: FAIL');

// Redirectable -- see the header. A mutation run must not be able to leave a
// FAILED transcript in the canonical slot.
const argI = process.argv.indexOf('--log');
const here = fileURLToPath(ROOT);
const logPath = argI >= 0 && process.argv[argI + 1]
  ? path.resolve(process.argv[argI + 1])
  : path.join(here, 'work', 'verify_minimap.log');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, log.join('\n') + '\n');
// Forward slashes, always -- this line lands in committed evidence. See the
// same note in verify_packets.mjs.
say(`  log: ${(path.relative(here, logPath) || logPath).replace(/\\/g, '/')}`);

if (!verdict) exitCode = 1;
process.exit(exitCode);
