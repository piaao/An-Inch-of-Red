/**
 * probe_passages.js — measure every opening in the building with the renderer.
 *
 * Two questions, one launch:
 *   A. For each wall MODEL, in isolation: where is the gap, and how wide?
 *   B. In the assembled apartment: which doorways are actually passable?
 *
 * WHY THE RENDERER AND NOT THE GLB
 * --------------------------------
 * The first attempt read the wall models' triangles directly in Python and
 * asked "is there material at this (x, y)". It reported the plain wall
 * correctly (solid across its full 1 m) and the window correctly (solid at
 * head height, which is what the game needs), but it reported the DOORWAY wall
 * as solid too -- and the assembled scene plainly disagrees.
 *
 * The cause is in the asset. Each of a wall model's three material primitives
 * points at ONE shared POSITION accessor, so a per-material census returns the
 * same shape three times and cannot resolve a hole; and one of the door models
 * exposes an accessor whose vertex count is not a multiple of three, which says
 * the accessor reading was wrong to begin with. Two independent signs that the
 * instrument, not the asset, was broken.
 *
 * So: stop guessing from bytes, and ask the thing that draws the picture, by
 * casting rays in the real scene with three.js's own Raycaster. It is the same
 * code path the player sees, it handles indices, node transforms and merged
 * geometry for free, and it costs one browser launch.
 *
 * Usage: node scripts/probe_passages.js
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { serve, launch, attach, killStrayChrome, sleep } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8782;
const DEBUG = 9229;
const OUT = path.join(ROOT, 'data', 'passages.json');

const KINDS = ['wall', 'wallHalf', 'wallWindow', 'wallWindowSlide',
               'wallDoorway', 'wallDoorwayWide', 'wallCorner', 'wallCornerRond',
               'doorwayOpen', 'doorway', 'doorwayFront'];
const HEIGHTS = [0.18, 0.36, 0.42, 0.60, 0.95, 1.20];
const STEP = 0.01;

async function main() {
  const report = { step: STEP, heights: HEIGHTS, kinds: {}, doorways: {}, controls: [] };
  await killStrayChrome();
  const server = await serve(ROOT, PORT);
  const browser = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_pass' });
  const sess = await attach({ port: DEBUG });

  try {
    await sess.viewport(1280, 800);
    await sess.goto(`http://127.0.0.1:${PORT}/index.html`, { settle: 1200 });
    const ready = await sess.evalAsync(`
      for (let i = 0; i < 200; i++) { if (window.__ready) return 'ready'; await new Promise(r => setTimeout(r, 100)); }
      return 'timeout';`);
    if (ready !== 'ready') throw new Error('scene never became ready: ' + ready);

    /* ---------------------------------------------------------------- A --- */
    //
    // Each model measured in its own normalised frame: footprint centre at the
    // origin, base at y = 0. Rays run along +Z, straight through the wall's
    // thickness, so "no hit" means you can walk and see through that point.
    const kindData = await sess.evalAsync(`
      const THREE = window.__app.THREE;
      const kit = window.__app.kit;
      const names = ${JSON.stringify(KINDS)};
      const heights = ${JSON.stringify(HEIGHTS)};
      const step = ${STEP};

      const out = {};
      for (const name of names) {
        let inst;
        try { inst = kit.instance(name); } catch (e) { out[name] = { error: String(e.message) }; continue; }
        const box = new THREE.Box3().setFromObject(inst);
        const size = box.getSize(new THREE.Vector3());
        const scene = new THREE.Scene();
        scene.add(inst);
        const rc = new THREE.Raycaster();
        const dir = new THREE.Vector3(0, 0, 1);

        const rows = [];
        const half = size.x / 2 + 0.03;
        for (const y of heights) {
          if (y > size.y + 1e-6) { rows.push({ y, above: true }); continue; }
          const marks = [];
          for (let x = -half; x <= half + 1e-9; x += step) {
            rc.set(new THREE.Vector3(x, y, box.min.z - 0.05), dir);
            rc.far = size.z + 0.1;
            marks.push(rc.intersectObject(scene, true).length > 0 ? 1 : 0);
          }
          // Turn the marks into solid runs, in the model's own coordinates.
          let runs = [];
          let start = null;
          for (let k = 0; k < marks.length; k++) {
            const x = -half + k * step;
            if (marks[k] && start === null) start = x;
            else if (!marks[k] && start !== null) { runs.push([r(start), r(x - step)]); start = null; }
          }
          if (start !== null) runs.push([r(start), r(marks.length * step - half)]);
          runs = runs.filter(v => v[1] - v[0] > 0.008);
          const gaps = [];
          for (let k = 0; k + 1 < runs.length; k++) gaps.push([r(runs[k][1]), r(runs[k + 1][0])]);
          rows.push({ y, solid: runs.map(v => [r(v[0]), r(v[1])]), gaps: gaps.map(v => [r(v[0]), r(v[1])]),
                      solidWidth: r(runs.reduce((a, v) => a + (v[1] - v[0]), 0)) });
        }
        out[name] = { size: [r(size.x), r(size.y), r(size.z)], spanZ: [r(box.min.z), r(box.max.z)], rows };
      }
      function r(v) { return Math.round(v * 1000) / 1000; }
      return out;`);

    if (typeof kindData === 'string') throw new Error('kind sweep failed: ' + kindData);
    report.kinds = kindData;

    console.log('=== A. wall models in isolation (local x, footprint centred) ===\n');
    for (const name of KINDS) {
      const k = kindData[name];
      if (!k || k.error) { console.log(`  ${name}: ${k ? k.error : 'missing'}`); continue; }
      console.log(`  ${name}   size ${k.size.join(' x ')}`);
      for (const row of k.rows) {
        if (row.above) { console.log(`      y=${row.y.toFixed(2)}  above the model`); continue; }
        const gaps = row.gaps.length ? '   GAPS ' + JSON.stringify(row.gaps) : '';
        console.log(`      y=${row.y.toFixed(2)}  solid=${row.solidWidth.toFixed(3)}  ${JSON.stringify(row.solid)}${gaps}`);
      }
      console.log('');
    }

    /* ---------------------------------------------------------------- B --- */
    const spec = await sess.evalAsync(`
      const L = await import('./js/layout.js');
      return { doors: L.DOORS, doors2: L.WALLS.filter(w => w.kinds) };`);
    if (typeof spec === 'string') throw new Error('layout read failed: ' + spec);

    const sweepScene = (axis, at, centre, side, y, span) => sess.evalAsync(`
      const THREE = window.__app.THREE;
      const scene = window.__app.apartment.structure;
      const rc = new THREE.Raycaster();
      const axisIsX = ${JSON.stringify(axis)} === 'x';
      const out = [];
      const from = ${centre} - ${span}, to = ${centre} + ${span};
      for (let u = from; u <= to + 1e-9; u += ${STEP}) {
        const crossA = ${at} - ${side} * 0.7, crossB = ${at} + ${side} * 0.7;
        const near = axisIsX ? new THREE.Vector3(u, ${y}, crossA) : new THREE.Vector3(crossA, ${y}, u);
        const far  = axisIsX ? new THREE.Vector3(u, ${y}, crossB) : new THREE.Vector3(crossB, ${y}, u);
        rc.set(near, far.clone().sub(near).normalize());
        rc.far = far.distanceTo(near) + 0.01;
        out.push({ u: Math.round(u * 1000) / 1000, open: rc.intersectObject(scene, true).length === 0 });
      }
      return out;`);

    const widest = (pts) => {
      let best = null, run = null;
      for (const p of pts) {
        if (p.open && run === null) run = p.u;
        else if (!p.open && run !== null) {
          if (!best || p.u - run > best.w) best = { from: +run.toFixed(3), to: +p.u.toFixed(3), w: +(p.u - run).toFixed(3) };
          run = null;
        }
      }
      if (run !== null) {
        const last = +(pts[pts.length - 1].u + STEP).toFixed(3);
        if (!best || last - run > best.w) best = { from: +run.toFixed(3), to: last, w: +(last - run).toFixed(3) };
      }
      return best;
    };

    console.log('=== B. doorways in the assembled apartment ===\n');
    for (const d of spec.doors) {
      // Which way does the WALL run? A door with r = 0 or 180 sits in an
      // east-west run and is crossed by a ray travelling along Z; a door turned
      // 90 or 270 sits in a north-south run and is crossed along X. Hard-coding
      // "doors live on the spine wall" got this wrong the moment a doorway was
      // added to a side wall, and reported that new doorway as solid.
      const alongZ = (((d.r || 0) % 360) + 360) % 360 !== 0
        && (((d.r || 0) % 360) + 360) % 360 !== 180;
      const axis = alongZ ? 'z' : 'x';
      const at = alongZ ? d.x : d.z;
      const centre = alongZ ? d.z : d.x;
      const entry = { model: d.m, x: d.x, z: d.z, r: d.r || 0, axis, note: d.note || '', rows: [] };
      for (const y of HEIGHTS) {
        const best = widest(await sweepScene(axis, at, centre, 1, y, 0.75));
        entry.rows.push({ y, clear: best });
      }
      const body = entry.rows.find((r) => r.y === 0.42).clear;
      const eye = entry.rows.find((r) => r.y === 0.36).clear;
      entry.passableWalk = !!(body && body.w >= 0.30);
      entry.passableSight = !!(eye && eye.w >= 0.10);
      report.doorways[`${d.m}@${d.x},${d.z}`] = entry;
      console.log(`  ${d.m.padEnd(14)} ${alongZ ? 'north-south' : 'east-west'} wall  at ${alongZ ? 'x=' + d.x : 'z=' + d.z}  ${entry.note}`);
      for (const row of entry.rows) {
        console.log(`      y=${row.y.toFixed(2)}  ${row.clear ? `open ${row.clear.from}..${row.clear.to} (w=${row.clear.w})` : 'SOLID'}`);
      }
      console.log(`      -> walker(0.30 wide) ${entry.passableWalk ? 'PASSES' : 'blocked'};  sight ${entry.passableSight ? 'sees through' : 'blocked'}`);
      console.log('');
    }

    console.log('=== C. controls: plain wall runs must be solid ===\n');
    const controls = [
      { id: 'spine x=1.5', axis: 'x', at: 3, side: 1, c: 1.5 },
      { id: 'spine x=6.5', axis: 'x', at: 3, side: 1, c: 6.5 },
      { id: 'bed|bath z=1.5', axis: 'z', at: 4, side: -1, c: 1.5 },
      { id: 'bath|kit z=1.5', axis: 'z', at: 6, side: -1, c: 1.5 },
      { id: 'living|east z=6.5', axis: 'z', at: 6, side: 1, c: 6.5 },
      { id: 'dine|study bay x=7.5', axis: 'x', at: 5, side: 1, c: 7.5 },
      { id: 'north envelope x=5', axis: 'x', at: 0, side: -1, c: 5 },
    ];
    for (const c of controls) {
      const best = widest(await sweepScene(c.axis, c.at, c.c, c.side, 0.36, 0.55));
      const solid = !best;
      report.controls.push({ id: c.id, clear: best, solid });
      console.log(`  ${c.id.padEnd(22)} ${solid ? 'solid at y=0.36' : `OPEN ${best.from}..${best.to} (w=${best.w})  <-- unexpected`}`);
    }

    if (!fs.existsSync(path.dirname(OUT))) fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1), 'utf8');

    const diag = sess.diagnostics();
    const real = diag.failedDetail.filter((f) => !f.canceled || f.status === null);
    console.log('\nCLEAN exceptions=%d http>=400=%d netFailed=%d consoleErrors=%d',
      diag.exceptions.length, diag.httpErrors.length, real.length, diag.consoleErrors.length);
    console.log('wrote', path.relative(ROOT, OUT));
  } finally {
    sess.close();
    browser.kill();
    await server.close();
    await sleep(150);
    await killStrayChrome();
  }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
