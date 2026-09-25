/**
 * probe_guard_render.mjs — does the guard actually reach the framebuffer?
 *
 * A screenshot is a log, not an assertion: it can be opened on a machine that
 * happens to render differently, and it cannot be read by a script. The claim
 * under test here is narrower and countable:
 *
 *   "with `begin('patrol')` running, the guard's own scene group paints pixels
 *    at the guard's world position."
 *
 * Method: render the SAME camera pose twice, once with the guard group visible
 * and once hidden, and diff the two grab() buffers. If the guard renders at all,
 * a cluster of pixels changes and its centroid sits where the guard projects.
 * If it does not, the diff is empty no matter how good the screenshot looks.
 *
 * Two poses, because one can lie: an eye-level pose can be standing inside a
 * wall (0 changed pixels for the wrong reason), so it is cross-checked by a
 * top-down pose 2.2 m over the guard's head, which cannot be occluded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cdp from './cdp.js';

const { serve, launch, attach, killStrayChrome, sleep } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORK = path.join(ROOT, 'work');
const PORT = 8784;
const DEBUG = 9229;

async function main() {
  await killStrayChrome();
  const server = await serve(ROOT, PORT);
  const chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_guardprobe' });
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
    await __play.begin('patrol');
    __play.step(1 / 60, 150);                 // 2.5 s: the guard leaves its start
    const S = __play.scene, C = __play.camera, T = __play.THREE;
    const cv = __play.renderer.domElement;
    const W = cv.width, H = cv.height;
    const grp = S.getObjectByName('guard');
    const g = __play.guard.state();

    const grab = () => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(cv, 0, 0);
      return x.getImageData(0, 0, W, H).data;
    };

    const ab = (pose) => {
      __play.freeCam(pose);
      __play.renderOnce();
      const A = grab();
      const vis = grp.visible;
      grp.visible = false;
      __play.renderOnce();
      const B = grab();
      grp.visible = true;
      let changed = 0, sx = 0, sy = 0;
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let i = 0; i < A.length; i += 4) {
        const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
        if (d > 24) {
          changed++;
          const p = i >> 2;
          const px = p % W, py = (p / W) | 0;
          sx += px; sy += py;
          if (px < x0) x0 = px; if (px > x1) x1 = px;
          if (py < y0) y0 = py; if (py > y1) y1 = py;
        }
      }
      const v = new T.Vector3(g.pos.x, 0.25, g.pos.z).project(C);
      const pjx = (v.x * 0.5 + 0.5) * W, pjy = (1 - (v.y * 0.5 + 0.5)) * H;
      return {
        visibleAtStart: vis, changed, changedFrac: changed / (W * H),
        centroid: changed ? { x: Math.round(sx / changed), y: Math.round(sy / changed) } : null,
        bbox: x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 },
        projected: { x: Math.round(pjx), y: Math.round(pjy), ndcZ: Number(v.z.toFixed(4)),
                     inFrame: v.x >= -1 && v.x <= 1 && v.y >= -1 && v.y <= 1 && v.z < 1 },
        size: { w: W, h: H },
      };
    };

    const pose1 = {
      x: g.pos.x - Math.cos(g.facing) * 2.0 - Math.sin(g.facing) * 0.7, y: 0.75,
      z: g.pos.z - Math.sin(g.facing) * 2.0 + Math.cos(g.facing) * 0.7,
      tx: g.pos.x + Math.cos(g.facing) * 1.1, ty: 0.2,
      tz: g.pos.z + Math.sin(g.facing) * 1.1,
    };
    const pose2 = { x: g.pos.x, y: 2.2, z: g.pos.z + 0.001, tx: g.pos.x, ty: 0.2, tz: g.pos.z };

    const r1 = ab(pose1);
    const r2 = ab(pose2);
    __play.freeCam(null);

    let meshes = 0, sprites = 0, lights = 0;
    grp.traverse((o) => { if (o.isMesh) meshes++; if (o.isSprite) sprites++; if (o.isPointLight) lights++; });

    return {
      r1, r2,
      info: {
        phase: __play.info().phase, mode: g.mode, facing: Number(g.facing.toFixed(4)),
        guardPos: { x: Number(g.pos.x.toFixed(3)), z: Number(g.pos.z.toFixed(3)) },
        groupPos: grp.position.toArray().map((n) => Number(n.toFixed(3))),
        groupVisible: grp.visible, meshes, sprites, lights,
        guardEye: __play.level.body.guardEye, guardHeight: __play.level.body.guardHeight,
      },
    };
  `);

  fs.writeFileSync(path.join(WORK, '_guard_render.json'), JSON.stringify(out, null, 2));
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
