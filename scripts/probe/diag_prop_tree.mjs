/**
 * diag_prop_tree.mjs — print the actual object tree of one hero prop.
 *
 * Two hypotheses have been wrong already, so stop guessing and dump the tree:
 * type, name, isMesh, parent chain, and how `Box3.setFromObject` responds.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cdp = require('../cdp.js');
const { serve, launch, attach, killStrayChrome } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8793;
const DEBUG = 9238;

const server = await serve(ROOT, PORT);
const chrome = await launch({ port: DEBUG, userDataDir: 'C:/Users/Public/cdpprofile_diagtree' });
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
    const h = __play.props.heroes.find((x) => x.userData.prop.model === 'bookcaseClosedDoors');
    const p = h.userData.prop;
    const lines = [];
    const walk = (o, d) => {
      lines.push('  '.repeat(d) + [
        o === h ? 'HERO' : (o.isMesh ? 'Mesh' : (o.isGroup ? 'Group' : o.type)),
        JSON.stringify(o.name),
        'children=' + o.children.length,
        'pos=' + [o.position.x, o.position.y, o.position.z].map((v) => v.toFixed(3)).join(','),
      ].join(' '));
      for (const c of o.children) walk(c, d + 1);
    };
    walk(h, 0);
    // Every mesh, its world box centre, before and after the swing.
    const meshes = [];
    h.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const before = meshes.map((o) => { box.setFromObject(o); return box.getCenter(new V()); });
    const geo = meshes.map((o) => {
      o.geometry.computeBoundingBox();
      const g = o.geometry.boundingBox;
      return [g.min.x, g.min.y, g.min.z, g.max.x, g.max.y, g.max.z].map((v) => v.toFixed(3)).join(',');
    });
    p.open = 1;
    for (let i = 0; i < 200; i++) __play.animProps(1 / 60);
    h.updateMatrixWorld(true);
    const after = meshes.map((o) => { box.setFromObject(o); return box.getCenter(new V()); });
    const moverNames = (p.movers || []).map((m) => m.obj.name);
    return {
      lines,
      moverNames,
      rows: meshes.map((o, i) => ({
        name: o.name, isMesh: o.isMesh, children: o.children.length,
        childMeshes: o.children.filter((c) => c.isMesh).length,
        childGroups: o.children.filter((c) => c.isGroup).length,
        travel: +before[i].distanceTo(after[i]).toFixed(5),
        geo: geo[i],
      })),
    };
  `);

  console.log(out.lines.join('\n'));
  console.log('\nmovers:', JSON.stringify(out.moverNames));
  console.log('\nmesh rows:');
  for (const r of out.rows) console.log(JSON.stringify(r));
} finally {
  await chrome.kill();
  await killStrayChrome();
  if (server && server.close) server.close();
}
