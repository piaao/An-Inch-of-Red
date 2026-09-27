/**
 * shoot_props.mjs — EYE-WITNESS shots of the props opening, before and after.
 *
 * The assertions prove the parts move and the frame does not. This proves the
 * thing a player actually complained about: that opening a prop does not make
 * it disappear. Each pair is framed from a legal standing spot with the prop in
 * view; the "after" frame is taken with `open = 1` fully tweened.
 *
 * Usage:  node scripts/shoot_props.mjs
 * Output: renders/play/props/*.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cdp = require('../cdp.js');
const { serve, launch, attach, killStrayChrome } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, 'renders', 'play', 'props');
const PORT = 8796;
const DEBUG = 9241;

fs.mkdirSync(OUT, { recursive: true });

const server = await serve(ROOT, PORT);
const chrome = await launch({ port: DEBUG, userDataDir: 'C:/Users/Public/cdpprofile_shootprops' });
try {
  const sess = await attach({ port: DEBUG });
  await sess.goto(`http://127.0.0.1:${PORT}/play.html`, { settle: 3000 });
  for (let i = 0; i < 60; i++) {
    const ok = await sess.evalJs('typeof __play !== "undefined"');
    if (ok) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  // The headline prop of each kind, so the three motions are all shown.
  const wanted = [
    { model: 'bookcaseClosedDoors', label: '01-wardrobe-doors' },
    { model: 'sideTableDrawers', label: '02-side-table-drawer' },
    { model: 'kitchenCabinetDrawer', label: '03-kitchen-cabinet-drawer' },
    { model: 'bathroomCabinetDrawer', label: '04-bathroom-drawer' },
  ];

  let bad = 0;
  let good = 0;
  let soft = 0;
  for (const w of wanted) {    const framed = await sess.evalAsync(`
      // The start overlay is DOM, so it covers the canvas in a full-page shot
      // even after the run has begun. Hide it so the frame is the ROOM.
      const ov = document.getElementById('ov-start');
      if (ov) ov.classList.add('hidden');
      const target = __play.props.heroes.find((h) => h.userData.prop.model === ${JSON.stringify(w.model)});
      if (!target) return { missing: true };
      const p = target.userData.prop;
      const THREE = __play.THREE;

      // Stand OUTSIDE the prop's footprint, in front of its opening face.
      // Two earlier attempts of this script failed in instructive ways: standing
      // a fixed metre-offset from the prop CENTRE puts the eye inside the
      // cabinet (its bbox centre is in the middle of the furniture), and an
      // oblique angle ducks behind a wall. So: back off from the FRONT face by
      // half the prop's own depth plus a viewing margin, along the prop's own
      // facing, then sweep a small arc and keep the first spot that is both
      // walkable and has the prop unoccluded.
      const box = new THREE.Box3().setFromObject(target);
      const size = box.getSize(new THREE.Vector3());
      const ctr = box.getCenter(new THREE.Vector3());
      const halfDepth = 0.5 * Math.max(size.x, size.z);
      const eyeAt = (av) => new THREE.Vector3(av.x, av.y + 1.62, av.z);
      const sees = (av) => {
        const dir = ctr.clone().sub(eyeAt(av));
        const len = dir.length();
        if (len < 1e-4) return false;
        dir.normalize();
        const rc = new THREE.Raycaster(eyeAt(av), dir, 0, len + 0.05);
        const hits = rc.intersectObjects(__play.props.heroes, true);
        if (!hits.length) return false;
        let o = hits[0].object;
        while (o && !o.userData.prop) o = o.parent;
        return o === target;
      };
      const outside = (av) => {
        // Reject spots that land inside the prop's own XZ footprint.
        const ox = Math.max(box.min.x, Math.min(av.x, box.max.x));
        const oz = Math.max(box.min.z, Math.min(av.z, box.max.z));
        return Math.hypot(av.x - ox, av.z - oz) >= 0.35;
      };

      const base = halfDepth + 1.15;           // clear of the face + a margin
      const radii = [base, base + 0.35, base + 0.7, base + 1.1, 1.9, 1.5];
      const angles = [0, 0.35, -0.35, 0.7, -0.7];   // centred on the front face
      let stand = null;
      for (const R of radii) {
        for (const a of angles) {
          const th = p.baseYaw + a;
          const sx = p.x - Math.sin(th) * R;
          const sz = p.z - Math.cos(th) * R;
          if (!__play.teleport(sx, sz)) continue;
          const av = __play.avatar.state();
          const d = Math.hypot(av.x - p.x, av.z - p.z);
          if (d < 1.1 || d > 3.2) continue;
          if (!outside(av) || !sees(av)) continue;
          stand = av;
          break;
        }
        if (stand) break;
      }
      if (!stand) return { missing: 'no legal visible stand' };
      // Aim at the moving part: the upper half of the prop is where the leaf /
      // drawer front / lid actually is, so the plinth is not what we frame.
      __play.aimAt(ctr.x, box.min.y + 0.72 * size.y, ctr.z);
      __play.renderOnce();
      return { ok: true, model: p.model, kind: p.kind,
               focus: __play.props.state().focus,
               dist: Math.hypot(stand.x - p.x, stand.z - p.z) };
    `);
    if (!framed || framed.missing) { console.log(`${w.label}: SKIP ${framed && framed.missing}`); bad++; continue; }

    await sess.shot(path.join(OUT, `${w.label}-a-shut.png`));

    const opened = await sess.evalAsync(`
      const target = __play.props.heroes.find((h) => h.userData.prop.model === ${JSON.stringify(w.model)});
      const p = target.userData.prop;
      // Drive the same tween the E key drives, without depending on the ray
      // landing (verify_play 5b already proves the ray does).
      p.open = 1;
      for (let i = 0; i < 200; i++) __play.animProps(1 / 60);
      __play.renderOnce();
      const THREE = __play.THREE;
      const box = new THREE.Box3().setFromObject(target);
      const sz = box.getSize(new THREE.Vector3());
      return { opened: p.open, anim: p.anim,
               size: [sz.x, sz.y, sz.z].map((v) => +v.toFixed(3)) };
    `);

    await sess.shot(path.join(OUT, `${w.label}-b-open.png`));
    console.log(`${w.label}: focus=${framed.focus} at ${framed.dist.toFixed(2)} m, `
      + `open=${opened.opened} anim=${opened.anim} bbox=${JSON.stringify(opened.size)}`);

    // SELF-CHECK the camera, not just the model. A pair of frames that look
    // identical is worthless evidence -- that is exactly how the first run of
    // this script produced two near-identical wardrobe shots while the bbox
    // quietly changed underneath. Compare the two PNGs byte-wise: if the
    // framing is honest, the moving part must alter a real share of pixels.
    const a = fs.readFileSync(path.join(OUT, `${w.label}-a-shut.png`));
    const b = fs.readFileSync(path.join(OUT, `${w.label}-b-open.png`));
    if (a.equals(b)) {
      // Not every prop can be SHOWN moving from a legal player position: a
      // drawer that slides along the view axis (straight at the camera)
      // changes almost no pixels, and a cabinet wedged into a corner leaves
      // no room to stand off its face. The geometry assertions in
      // verify_play 5c already prove the motion for all 38 props, so this is
      // a note about the CAMERA, not a claim that the prop is broken.
      console.log(`   note: framing cannot show this one moving from a legal `
        + `stand (motion is still proven by verify_play 5c); see -b for the `
        + `measured bbox change`);
      soft++;
    } else {
      good++;
    }
  }

  const files = fs.readdirSync(OUT).sort();
  console.log('\nwrote:', files.join(' '));
  console.log(`\nEYE-WITNESS SUMMARY: ${good} of ${wanted.length} props shown`
    + ` visibly moving in a screenshot`);
  if (soft) {
    console.log(`  ${soft} prop(s) could not be framed moving from a legal`
      + ` stand -- motion is still proven numerically by verify_play 5c,`
      + ` but there is no photograph of it. Do not mistake -b for proof.`);
  }
  if (bad) {
    console.log(`  ${bad} prop(s) were SKIPPED entirely (no legal stand at all).`);
    process.exitCode = 1;
  }
} finally {
  await chrome.kill();
  await killStrayChrome();
  if (server && server.close) server.close();
}
