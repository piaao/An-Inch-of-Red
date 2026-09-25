/**
 * probe_guard_light.mjs — does the guard's spotlight reach the framebuffer,
 * and is it strong enough to be worth asserting on?
 *
 * The verify_play assertion read 0 changed pixels with the light "on" vs
 * "off", which is either "the light does nothing" or "the instrument is
 * blind". Those two are not the same bug and they have opposite fixes, so
 * measure both ends:
 *
 *   A  the working recipe      full-res grab, willReadFrequently, renderOnce
 *                              outside the grab, threshold 24 -- the exact
 *                              shape of probe_guard_render.mjs, which DID
 *                              find 8669 pixels for the guard body
 *   B  intensity sweep         0 / 2.6 / 12 / 40 candela, max per-channel
 *                              delta and how many pixels cross 4 / 12 / 24
 *   C  a pose that cannot lie  straight down from above the guard, so the
 *                              pool is the whole frame if it exists at all
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cdp from './cdp.js';

const { serve, launch, attach, killStrayChrome, sleep } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORK = path.join(ROOT, 'work');
const PORT = 8786;
const DEBUG = 9231;

async function main() {
  await killStrayChrome();
  const server = await serve(ROOT, PORT);
  const chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_guardlight' });
  const sess = await attach({ port: DEBUG });
  await sess.viewport(1600, 900);

  await sess.goto(`http://127.0.0.1:${PORT}/play.html`, { settle: 1500 });
  let ready = false;
  for (let i = 0; i < 240; i++) {
    if (await sess.evalJs('!!(window.__ready && window.__play)') === true) { ready = true; break; }
    await sleep(500);
  }
  console.log(`ready=${ready}`);
  if (!ready) { await cleanup(chrome, server); return; }

  const out = await sess.evalAsync(`
    await __play.begin('hunter');
    __play.step(1 / 60, 90);
    const S = __play.scene, C = __play.camera, T = __play.THREE;
    const cv = __play.renderer.domElement;
    const W = cv.width, H = cv.height;
    const grp = S.getObjectByName('guard');
    const g = __play.guard.state();

    let spot = null, meshes = 0, lights = 0;
    grp.traverse((o) => {
      if (o.isSpotLight) spot = o;
      if (o.isMesh) meshes++;
      if (o.isLight) lights++;
    });

    const grab = () => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(cv, 0, 0);
      return x.getImageData(0, 0, W, H).data;
    };

    // The pose the failing assertion used, and a top-down one that cannot be
    // blocked by anything.
    const behind = {
      x: g.pos.x - Math.cos(g.facing) * 0.5, y: 1.05,
      z: g.pos.z - Math.sin(g.facing) * 0.5,
      tx: g.pos.x + Math.cos(g.facing) * 3.5, ty: 0.05,
      tz: g.pos.z + Math.sin(g.facing) * 3.5,
    };
    const above = { x: g.pos.x, y: 2.6, z: g.pos.z + 0.001, tx: g.pos.x, ty: 0, tz: g.pos.z };

    const diff = (A, B) => {
      let n4 = 0, n12 = 0, n24 = 0, max = 0;
      for (let i = 0; i < A.length; i += 4) {
        const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
        if (d > max) max = d;
        if (d > 4) n4++;
        if (d > 12) n12++;
        if (d > 24) n24++;
      }
      return { n4, n12, n24, max, total: (W * H), frac24: n24 / (W * H) };
    };

    const sweep = (pose) => {
      __play.freeCam(pose);
      const rows = [];
      // A: the recipe that worked for the guard body -- visible toggle, d 24.
      __play.renderOnce();
      const on = grab();
      const vis = spot.visible;
      spot.visible = false;
      __play.renderOnce();
      const off = grab();
      spot.visible = true;
      rows.push({ how: 'visible toggle (intensity ' + spot.intensity.toFixed(2) + ')', ...diff(on, off) });

      // B: intensity sweep, so "the light is 0.4 % of the frame" is separated
      // from "the light does not exist".
      const saved = spot.intensity;
      let base = null;
      for (const iv of [0, 2.6, 12, 40]) {
        spot.intensity = iv;
        __play.renderOnce();
        const px = grab();
        if (iv === 0) { base = px; rows.push({ how: 'intensity 0 (baseline)', ...diff(px, px) }); continue; }
        rows.push({ how: 'intensity ' + iv + ' vs 0', ...diff(px, base) });
      }
      spot.intensity = saved;
      return { visible: vis, rows };
    };

    const rBehind = sweep(behind);
    const rAbove = sweep(above);
    __play.freeCam(null);

    const wp = spot.getWorldPosition(new T.Vector3());
    const tp = spot.target.getWorldPosition(new T.Vector3());
    return {
      behind: rBehind, above: rAbove,
      spot: {
        visible: spot.visible, intensity: spot.intensity, distance: spot.distance,
        angleDeg: spot.angle * 360 / Math.PI, penumbra: spot.penumbra, decay: spot.decay,
        color: spot.color.getHexString(),
        worldPos: wp.toArray().map((n) => Number(n.toFixed(3))),
        targetPos: tp.toArray().map((n) => Number(n.toFixed(3))),
        targetInScene: !!tp,
        targetParent: spot.target.parent ? spot.target.parent.name : null,
      },
      guard: { x: Number(g.pos.x.toFixed(3)), z: Number(g.pos.z.toFixed(3)), facing: Number(g.facing.toFixed(4)) },
      group: { visible: grp.visible, meshes, lights },
      canvas: { w: W, h: H, dpr: __play.renderer.getPixelRatio() },
      colours: { toneMapping: __play.renderer.toneMapping, exposure: __play.renderer.toneMappingExposure },
    };
  `);

  fs.writeFileSync(path.join(WORK, '_guard_light.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));

  await cleanup(chrome, server);
}

async function cleanup(chrome, server) {
  try { if (chrome) chrome.kill(); } catch { /* ignore */ }
  try { if (server) server.close(); } catch { /* ignore */ }
  await sleep(300);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
