/**
 * diag_prop_frame.mjs — which non-mover mesh moved 0.1 m, and why?
 *
 * The 5c assertion "opening the door does not move its FRAME" reads the world
 * centre of every mesh that is NOT a registered mover. One of them travelled
 * 0.1 m. Either a frame mesh is being written (a real bug), or the prop's own
 * position shifted (a push), or the measurement includes a prop whose movers
 * set is empty and therefore treats the whole body as "frame".
 *
 * Print the offending mesh names, their travel, and the hero's position delta.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cdp = require('../cdp.js');
const { serve, launch, attach, killStrayChrome } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8792;
const DEBUG = 9237;

const server = await serve(ROOT, PORT);
const chrome = await launch({ port: DEBUG, userDataDir: 'C:/Users/Public/cdpprofile_diagframe' });
try {
  const sess = await attach({ port: DEBUG });
  await sess.goto(`http://127.0.0.1:${PORT}/play.html`, { settle: 3000 });
  for (let i = 0; i < 60; i++) {
    const ok = await sess.evalJs('typeof __play !== "undefined"');
    if (ok) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const out = await sess.evalAsync(`
    await __play.begin('patrol');
    __play.release();
    const THREE = __play.THREE;
    const V = THREE.Vector3;
    const box = new THREE.Box3();
    const centre = (o) => { box.setFromObject(o); return box.getCenter(new V()); };
    const bad = [];
    for (const h of __play.props.heroes) {
      const p = h.userData.prop;
      if (!p) continue;
      const movers = p.movers || [];
      const moverSet = new Set(movers.map((m) => m.obj));
      const all = [];
      h.traverse((o) => { if (o.isMesh) all.push(o); });
      const baseC = new Map(all.map((o) => [o, centre(o)]));
      const hp0 = [h.position.x, h.position.y, h.position.z];
      p.open = 1;
      for (let i = 0; i < 200; i++) __play.animProps(1 / 60);
      h.updateMatrixWorld(true);
      const hp1 = [h.position.x, h.position.y, h.position.z];
      const hd = Math.hypot(hp1[0] - hp0[0], hp1[1] - hp0[1], hp1[2] - hp0[2]);
      for (const o of all) {
        if (moverSet.has(o)) continue;
        const t = baseC.get(o).distanceTo(centre(o));
        if (t > 1e-6) bad.push({
          model: p.model, kind: p.kind, nMovers: movers.length,
          mesh: o.name, travel: +t.toFixed(5), heroPosDelta: +hd.toFixed(5),
          pushed: p.pushed, pushedAnim: +p.pushedAnim.toFixed(4),
        });
      }
      // also report the hero itself, even if no mesh flagged
      if (hd > 1e-6 && !bad.some((b) => b.model === p.model)) {
        bad.push({ model: p.model, kind: p.kind, nMovers: movers.length,
          mesh: '(hero moved but no mesh flagged)', travel: 0,
          heroPosDelta: +hd.toFixed(5), pushed: p.pushed,
          pushedAnim: +p.pushedAnim.toFixed(4) });
      }
      p.open = 0;
      for (let i = 0; i < 200; i++) __play.animProps(1 / 60);
      __play.props.reset();
    }
    return bad;
  `);

  if (!out.length) console.log('no non-mover mesh moved');
  for (const b of out) console.log(JSON.stringify(b));
} finally {
  await chrome.kill();
  await killStrayChrome();
  if (server && server.close) server.close();
}
