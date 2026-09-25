/**
 * probe_doorways.js — ask the renderer, not my arithmetic, whether the
 * doorways are actually open.
 *
 * Why this exists: the level needs to know where a body and a sight line can
 * get through a wall. I first tried to read that out of the GLB's triangles,
 * and it went badly -- the wall models build every material primitive on ONE
 * shared POSITION accessor, so a per-material silhouette census just returns
 * the same shape three times and cannot see a hole at all. Rather than keep
 * debugging an instrument I did not trust, this asks the thing that draws the
 * picture: the assembled scene, with three.js's own raycaster.
 *
 * It is also the check that ties the abstract level to the visible building.
 * If the arena says "there is a passage at x = 2.5" and this probe says the
 * wall is solid, the arena is wrong and every guard path through it is a lie.
 *
 * Usage: node scripts/probe_doorways.js
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { serve, launch, attach, killStrayChrome, sleep } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8781;
const DEBUG = 9228;
const OUT = path.join(ROOT, 'work', 'doorways.json');

/** Heights to probe, in the design's units. */
const HEIGHTS = [0.18, 0.36, 0.42, 0.60, 0.95];
/** How finely to sweep across the wall, in metres. */
const STEP = 0.02;
const SPAN = 0.62;

async function main() {
  const report = { heights: HEIGHTS, step: STEP, span: SPAN, doors: [], controls: [] };
  await killStrayChrome();
  const server = await serve(ROOT, PORT);
  const browser = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_doors' });
  const sess = await attach({ port: DEBUG });

  try {
    await sess.viewport(1280, 800);
    await sess.goto(`http://127.0.0.1:${PORT}/index.html`, { settle: 1200 });

    const ready = await sess.evalAsync(`
      for (let i = 0; i < 200; i++) {
        if (window.__ready) return 'ready';
        await new Promise(r => setTimeout(r, 100));
      }
      return 'timeout';`);
    console.log('page:', ready);
    if (ready !== 'ready') throw new Error('scene never became ready');

    // Doors and wall runs, read from the page's own copy of layout.js so this
    // probe cannot drift from what was built.
    const spec = await sess.evalAsync(`
      const L = await import('./js/layout.js');
      return { doors: L.DOORS, walls: L.WALLS.map(w => ({ id: w.id, axis: w.axis, at: w.at, from: w.from, to: w.to, kinds: w.kinds || {} })) };`);
    if (typeof spec === 'string') throw new Error('layout read failed: ' + spec);

    // The ray-cast sweep. One page-side function, called per probe line.
    const sweep = async (axis, at, centre, side, y) => sess.evalAsync(`
      const THREE = window.__app.THREE;
      const scene = window.__app.apartment.structure;   // floor + walls + doors
      const rc = new THREE.Raycaster();
      const near = new THREE.Vector3(), far = new THREE.Vector3();
      const axisIsX = ${JSON.stringify(axis)} === 'x';
      const out = [];
      const from = ${centre} - ${SPAN}, to = ${centre} + ${SPAN};
      for (let u = from; u <= to + 1e-9; u += ${STEP}) {
        // Cast across the wall band: from 0.6 m before it to 0.6 m after.
        const crossA = ${at} - ${side} * 0.6, crossB = ${at} + ${side} * 0.6;
        if (axisIsX) { near.set(u, ${y}, crossA); far.set(u, ${y}, crossB); }
        else { near.set(crossA, ${y}, u); far.set(crossB, ${y}, u); }
        const dir = far.clone().sub(near).normalize();
        const dist = far.distanceTo(near);
        rc.set(near, dir);
        rc.far = dist + 0.01;
        const hits = rc.intersectObject(scene, true);
        out.push({ u: Math.round(u * 1000) / 1000, open: hits.length === 0,
                   hits: hits.length, first: hits[0] ? Math.round(hits[0].distance * 1000) / 1000 : null });
      }
      return out;`);

    const clearRun = (pts) => {
      let best = null;
      let run = null;
      for (const p of pts) {
        if (p.open && run === null) run = p.u;
        else if (!p.open && run !== null) { if (!best || p.u - run > best.w) best = { from: run, to: p.u, w: +(p.u - run).toFixed(3) }; run = null; }
      }
      if (run !== null) {
        const last = pts[pts.length - 1].u + STEP;
        if (!best || last - run > best.w) best = { from: run, to: last, w: +(last - run).toFixed(3) };
      }
      return best;
    };

    console.log('\n--- doors (a clear run means a body can pass) ---');
    for (const d of spec.doors) {
      const onSouthWall = d.z >= 7.5;
      const axis = 'x';
      const at = onSouthWall ? 8 : 3;
      const side = 1;
      const entry = { model: d.m, x: d.x, z: d.z, note: d.note || '', at: [], clear: {} };
      for (const y of HEIGHTS) {
        const pts = await sweep(axis, at, d.x, side, y);
        const best = clearRun(pts);
        entry.at.push({ y, clear: best });
        if (y === 0.36 || y === 0.42) entry.clear[y] = best;
      }
      report.doors.push(entry);
      const cel = entry.clear[0.36];
      console.log(`  ${String(d.m).padEnd(14)} x=${entry.x}  ${entry.note}`);
      for (const a of entry.at) {
        console.log(`      y=${a.y.toFixed(2)}  ${a.clear ? `open ${a.clear.from.toFixed(2)}..${a.clear.to.toFixed(2)} (w=${a.clear.w})` : 'SOLID'}`);
      }
    }

    console.log('\n--- controls: plain wall segments must be SOLID ---');
    const controls = [
      { id: 'spine @ x=1.5', axis: 'x', at: 3, side: 1, centre: 1.5 },
      { id: 'spine @ x=6.5', axis: 'x', at: 3, side: 1, centre: 6.5 },
      { id: 'bed|bath @ z=1.5', axis: 'z', at: 4, side: -1, centre: 1.5 },
      { id: 'living|east @ z=6.5', axis: 'z', at: 6, side: 1, centre: 6.5 },
    ];
    for (const c of controls) {
      const pts = await sweep(c.axis, c.at, c.centre, c.side, 0.36);
      const best = clearRun(pts);
      report.controls.push({ id: c.id, clear: best });
      console.log(`  ${c.id.padEnd(22)} ${best ? `OPEN ${best.from.toFixed(2)}..${best.to.toFixed(2)} (w=${best.w})  <-- unexpected` : 'solid at y=0.36'}`);
    }

    if (!fs.existsSync(path.dirname(OUT))) fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1), 'utf8');

    const diag = sess.diagnostics();
    console.log('\nCLEAN exceptions=%d http>=400=%d netFailed=%d consoleErrors=%d',
      diag.exceptions.length, diag.httpErrors.length,
      diag.failedDetail.filter((f) => !f.canceled || f.status === null).length,
      diag.consoleErrors.length);
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
