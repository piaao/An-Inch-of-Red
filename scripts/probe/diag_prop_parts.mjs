/**
 * diag_prop_parts.mjs — why did the leaf-travel assertion read 0?
 *
 * One question, one answer, printed: for every hero prop that HAS a leaf mover,
 * what does the leaf's world-box centre do between open=0 and open=1, and what
 * is the group doing at the same time? If the mover is real but its centre does
 * not move, the transform is being written to a different object than the one
 * being measured -- or `_apply` is never reached.
 *
 * Usage:  node scripts/diag_prop_parts.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cdp = require('../cdp.js');
const { serve, launch, attach, killStrayChrome } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8791;
const DEBUG = 9236;

const server = await serve(ROOT, PORT);
const chrome = await launch({ port: DEBUG, userDataDir: 'C:/Users/Public/cdpprofile_diagparts' });
try {
  const sess = await attach({ port: DEBUG });
  await sess.goto(`http://127.0.0.1:${PORT}/play.html`, { settle: 3000 });
  // __play appears once the boot finishes; poll for it.
  for (let i = 0; i < 60; i++) {
    const ok = await sess.evalJs('typeof __play !== "undefined"');
    if (ok) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const out = await sess.evalAsync(`
    await __play.begin('patrol');
    __play.release();
    const THREE = __play.THREE;
    const box = new THREE.Box3();
    const V = THREE.Vector3;
    const centre = (o) => { box.setFromObject(o); return box.getCenter(new V()); };
    const rows = [];
    for (const h of __play.props.heroes) {
      const p = h.userData.prop;
      if (!p) continue;
      const movers = p.movers || [];
      if (!movers.length) continue;
      const inTree = new Set();
      h.traverse((o) => { if (o.isMesh) inTree.add(o); });
      const isChild = movers.every((m) => inTree.has(m.obj));
      const base = movers.map((m) => centre(m.obj));
      const rotBefore = movers.map((m) => m.obj.rotation.y);
      p.open = 1;
      for (let i = 0; i < 200; i++) __play.animProps(1 / 60);
      h.updateMatrixWorld(true);
      const now = movers.map((m) => centre(m.obj));
      const travel = base.map((c, i) => c.distanceTo(now[i]));
      rows.push({
        model: p.model, kind: p.kind, role: movers[0].role,
        nMovers: movers.length, isChild,
        travel: travel.map((t) => +t.toFixed(5)),
        rotY: movers.map((m, i) => [+rotBefore[i].toFixed(4), +m.obj.rotation.y.toFixed(4),
          +m.baseRot.y.toFixed(4)]),
        baseYaw: +p.baseYaw.toFixed(4),
        anim: +p.anim.toFixed(4),
        name: movers.map((m) => m.obj.name),
      });
      p.open = 0;
      for (let i = 0; i < 200; i++) __play.animProps(1 / 60);
      __play.props.reset();
    }
    return rows;
  `);

  console.log('props with movers:', out.length);
  for (const r of out) {
    console.log(`${r.model.padEnd(26)} ${r.role.padEnd(5)} n=${r.nMovers} child=${r.isChild} `
      + `anim=${r.anim} travel=${JSON.stringify(r.travel)}`);
    console.log(`${''.padEnd(26)}   rotY[before,after,base]=${JSON.stringify(r.rotY)} `
      + `baseYaw=${r.baseYaw} names=${JSON.stringify(r.name)}`);
  }
} finally {
  await chrome.kill();
  await killStrayChrome();
  if (server && server.close) server.close();
}
