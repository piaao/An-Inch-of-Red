/**
 * probe_closeup.js — forensic close-ups of individual pieces.
 *
 * The verification renders are wide shots; the living-room coffee table read
 * as a hollow frame there, and a wide shot cannot tell you whether that is the
 * model, the merge step, or the viewing angle. So this takes tight shots of
 * named items, and -- the part that matters -- renders the SAME model twice:
 * once where the room merge baked it (in place) and once as a fresh
 * `kit.instance()` dropped on the bare ground outside the building.
 *
 * If those two disagree, the merge is at fault. If they agree, the model is.
 *
 * SIDE=front|double|back forces every kit material to that side before
 * shooting, and writes to work/closeups/<mode>/, so two runs can be compared
 * without one overwriting the other's evidence.
 *
 * It also runs a "drop-ray" census: a 5x5 grid of rays dropped straight down
 * over each item's footprint, counting how many land on something solid rather
 * than passing through to the floor. A tabletop with half its triangles wound
 * backwards reads as ~50%; a sound one reads as ~100%. A single ray through
 * the centre does NOT catch this -- the centre sits on the surviving half.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { serve, launch, attach, killStrayChrome, sleep } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8779;
const DEBUG = 9226;

/** SIDE=double flips every kit material to DoubleSide before shooting, so the
 *  fix for a winding-damaged asset can be seen before it is committed. */
const FORCE_SIDE = (process.env.SIDE || '').toLowerCase();
const SIDE_ENUM = { front: 'FrontSide', double: 'DoubleSide', back: 'BackSide' };
const MODE = SIDE_ENUM[FORCE_SIDE] ? FORCE_SIDE : 'as-shipped';
const OUT = path.join(ROOT, 'work', 'closeups', MODE);

/** Stand-ins parked on the bare ground east of the slab (x 12). */
const STANDALONE = [
  { id: 'standalone_coffee', model: 'tableCoffee', x: 12.0, z: 3.4 },
];

const SHOTS = [
  // in-room coffee table, three angles
  { id: 'coffee_high', target: [1.40, 0.12, 6.74], eye: [0.05, 1.60, 5.30] },
  { id: 'coffee_low', target: [1.40, 0.12, 6.74], eye: [0.30, 0.52, 5.55] },
  { id: 'coffee_even', target: [1.40, 0.12, 6.74], eye: [1.40, 0.30, 5.70] },
  // neighbours, for context
  { id: 'ottoman', target: [2.58, 0.20, 6.98], eye: [1.35, 1.35, 5.75] },
  { id: 'tvwall', target: [1.90, 0.60, 7.84], eye: [1.90, 1.05, 5.40] },
  // dining table, the other single-material table in the kit
  { id: 'tableCross', target: [7.90, 0.40, 4.05], eye: [7.90, 2.15, 3.05] },
  // the standalone copy, same angle family as the in-room ones
  { id: 'standalone_coffee', target: [12.0, 0.12, 3.4], eye: [10.85, 1.60, 2.00] },
];

/** Items whose footprint should be solid from above. */
const GRID_MODELS = [
  'tableCoffee', 'tableCross', 'sideTable', 'sideTableDrawers', 'desk',
  'bedDouble', 'kitchenCabinetDrawer', 'cabinetTelevisionDoors', 'bookcaseClosedWide',
];

const GRID_PROBE = `JSON.stringify((() => {
  const a = window.__app, T = a.THREE;
  const ray = new T.Raycaster();
  const down = new T.Vector3(0, -1, 0);
  const WANT = ${JSON.stringify(GRID_MODELS)};
  const out = {};
  for (const r of a.apartment.rooms) {
    for (const it of r.items) {
      if (WANT.indexOf(it.m) < 0 || out[it.m]) continue;
      const e = a.kit.entries.get(it.m);
      if (!e) { out[it.m] = { error: 'not loaded' }; continue; }
      const s = it.s || 1;
      const hw = (e.size.x / 2) * s * 0.6;
      const hd = (e.size.z / 2) * s * 0.6;
      const rot = (it.r || 0) * Math.PI / 180;
      const cs = Math.cos(rot), sn = Math.sin(rot);
      let solid = 0, total = 0, sumY = 0;
      for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
          const lx = (i / 2) * hw, lz = (j / 2) * hd;
          const x = it.x + lx * cs + lz * sn;
          const z = it.z - lx * sn + lz * cs;
          ray.set(new T.Vector3(x, 1.6, z), down);
          const hs = ray.intersectObject(a.apartment.furniture, true);
          total++;
          if (hs.length && hs[0].point.y > 0.04) { solid++; sumY += hs[0].point.y; }
        }
      }
      out[it.m] = { solid, total, pct: +(solid / total).toFixed(2),
                    topY: +(sumY / Math.max(1, solid)).toFixed(2) };
    }
  }
  return out;
})())`;

(async () => {
  await killStrayChrome();
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve(ROOT, PORT);
  const chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_close' });
  let sess;
  try {
    sess = await attach({ port: DEBUG });
    await sess.viewport(1100, 800);
    await sess.goto(`http://127.0.0.1:${PORT}/index.html`, { settle: 3000 });
    for (let i = 0; i < 60; i++) {
      if (await sess.evalJs('!!window.__ready') === true) break;
      await sleep(1000);
    }
    console.log('MODE=%s  ready=%s', MODE, await sess.evalJs('!!window.__ready'));

    // Strip every overlay so the frame contains the geometry and nothing else.
    await sess.evalJs(`(() => {
      ['#hud','#stats','#perf','#rstack','#views','#flags','#hint','#labels','#zone-tip','#loading']
        .forEach((s) => { const e = document.querySelector(s); if (e) e.style.display = 'none'; });
      return true;
    })()`);

    // Park the standalone copies outside the building.
    const parked = await sess.evalJs(`JSON.stringify((() => {
      const a = window.__app;
      const out = [];
      for (const s of ${JSON.stringify(STANDALONE)}) {
        const g = a.kit.instance(s.model);
        g.position.set(s.x, 0, s.z);
        g.name = 'standalone:' + s.model;
        a.scene.add(g);
        out.push(s.id);
      }
      a.scene.updateMatrixWorld(true);
      return out;
    })())`);
    console.log('parked: %s', parked);

    console.log('drop-grid BEFORE: %s', await sess.evalJs(GRID_PROBE));

    // Optional: force a material side across the whole shared palette, so the
    // same camera can be compared with and without the candidate fix.
    if (SIDE_ENUM[FORCE_SIDE]) {
      const changed = await sess.evalJs(`(() => {
        const a = window.__app;
        const S = a.THREE.${SIDE_ENUM[FORCE_SIDE]};
        let n = 0;
        a.kit.materials.forEach((m) => { m.side = S; m.needsUpdate = true; n++; });
        return n;
      })()`);
      console.log('forced %d materials -> %s', changed, SIDE_ENUM[FORCE_SIDE]);
      console.log('drop-grid AFTER : %s', await sess.evalJs(GRID_PROBE));
    }

    for (const s of SHOTS) {
      await sess.evalJs(`(() => {
        const a = window.__app;
        a.state.tween = null;
        a.camera.position.set(${s.eye[0]}, ${s.eye[1]}, ${s.eye[2]});
        a.controls.target.set(${s.target[0]}, ${s.target[1]}, ${s.target[2]});
        a.controls.update();
        return true;
      })()`);
      await sleep(450);
      const file = path.join(OUT, s.id + '.png');
      const r = await sess.shot(file);
      console.log('  %s  %s', s.id.padEnd(22), r.ok ? (r.bytes / 1024).toFixed(0) + ' KB' : 'FAILED');
    }

    const diag = sess.diagnostics();
    console.log('exceptions=%d consoleErrors=%d', diag.exceptions.length, diag.consoleErrors.length);
    diag.consoleErrors.slice(0, 5).forEach((e) => console.log('  CONSOLE ' + e));
  } finally {
    if (sess) sess.close();
    chrome.kill();
    await server.close();
  }
})().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
