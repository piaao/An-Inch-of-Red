/**
 * probe_grab_recipe.mjs — which part of the grab recipe is blind?
 *
 * probe_guard_light.mjs settled one question: with `spot.visible` toggled, the
 * guard's light changes 87k pixels (6.1 % of the frame) from a camera behind
 * the guard. So the light works. The intensity sweep in that probe read 0 for
 * a different and now understood reason: `GuardActor.update()` re-derives
 * `spot.intensity = 2.6 + 3.4 * heat` on every `render()`, so a hand-set
 * intensity is overwritten before it can be drawn. Dead end, discarded.
 *
 * That leaves the real puzzle: verify_play.mjs runs the SAME toggle and reads
 * 0 changed pixels. Two recipes, one works, one does not. The difference is
 * not a judgement call, it is four concrete switches:
 *
 *   size      1600x900 (native) vs 400x240 (downscaled drawImage)
 *   ctx       2d context with vs without `willReadFrequently`
 *   when      renderOnce() outside the grab vs inside it
 *   cut       delta threshold 24 vs 12
 *
 * This probe runs the toggle under each combination in ONE page session and
 * reports, per recipe, how many pixels move and by how much `max` -- because
 * "0 px above 12" and "0 px above 24" are not the same reading, and only a
 * `max` that is itself ~0 says the buffer is genuinely identical.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cdp from './cdp.js';

const { serve, launch, attach, killStrayChrome, sleep } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORK = path.join(ROOT, 'work');
const PORT = 8787;
const DEBUG = 9232;

async function main() {
  await killStrayChrome();
  const server = await serve(ROOT, PORT);
  const chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_grab' });
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
    __play.release();
    const S = __play.scene;
    const grp = S.getObjectByName('guard');
    let spot = null;
    grp.traverse((o) => { if (o.isSpotLight) spot = o; });
    const cv = __play.renderer.domElement;

    // The pose the failing assertion used: just behind the guard, looking down
    // its own facing, so the frame IS the sector.
    const poseFor = (k) => {
      const g = __play.guard.state();
      return {
        x: g.pos.x - Math.cos(g.facing) * 0.5, y: 1.05,
        z: g.pos.z - Math.sin(g.facing) * 0.5,
        tx: g.pos.x + Math.cos(g.facing) * 3.5, ty: 0.05,
        tz: g.pos.z + Math.sin(g.facing) * 3.5, k,
      };
    };
    const pose0 = poseFor(0);

    /**
     * One on/off pair. w and h are the readback canvas size, wrf adds
     * willReadFrequently, outside moves renderOnce() out of the grab (so the
     * draw and the render are not interleaved), and we always report both
     * thresholds plus the raw max channel-sum delta.
     */
    const pair = (label, w, h, wrf, outside) => {
      __play.freeCam({ x: pose0.x, y: pose0.y, z: pose0.z, tx: pose0.tx, ty: pose0.ty, tz: pose0.tz });
      const grab = () => {
        if (!outside) __play.renderOnce();
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const x = wrf ? c.getContext('2d', { willReadFrequently: true }) : c.getContext('2d');
        x.drawImage(cv, 0, 0, w, h);
        return x.getImageData(0, 0, w, h).data;
      };
      if (outside) __play.renderOnce();
      spot.visible = true;
      const on = grab();
      spot.visible = false;
      const off = grab();
      spot.visible = true;
      let n8 = 0, n12 = 0, n24 = 0, max = 0;
      for (let i = 0; i < on.length; i += 4) {
        const d = Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1])
          + Math.abs(on[i + 2] - off[i + 2]);
        if (d > max) max = d;
        if (d > 8) n8++;
        if (d > 12) n12++;
        if (d > 24) n24++;
      }
      return {
        label, size: w + 'x' + h, willReadFrequently: wrf, renderOnceOutside: outside,
        n8, n12, n24, max, total: w * h, frac12: Number((n12 / (w * h)).toFixed(5)),
      };
    };

    const native = { w: cv.width, h: cv.height };
    const rows = [];
    // The exact failing recipe.
    rows.push(pair('verify_play as written', 400, 240, false, false));
    // One switch at a time off that recipe.
    rows.push(pair('+ willReadFrequently', 400, 240, true, false));
    rows.push(pair('+ renderOnce outside', 400, 240, false, true));
    rows.push(pair('+ both, still downscaled', 400, 240, true, true));
    rows.push(pair('downscaled, threshold 24', 400, 240, false, false));
    // Native size, which is what the guard-body probe used.
    rows.push(pair('native, as guard-body probe', native.w, native.h, true, true));
    rows.push(pair('native, no willReadFrequently', native.w, native.h, false, false));

    // A sanity check that the sensor itself sees an obvious change: hide the
    // WHOLE guard group (meshes + lights) instead of the light alone, under the
    // failing recipe. If even that reads 0, the recipe is blind, full stop.
    const whole = (() => {
      __play.freeCam({ x: pose0.x, y: pose0.y, z: pose0.z, tx: pose0.tx, ty: pose0.ty, tz: pose0.tz });
      const grab = () => {
        __play.renderOnce();
        const c = document.createElement('canvas');
        c.width = 400; c.height = 240;
        const x = c.getContext('2d');
        x.drawImage(cv, 0, 0, 400, 240);
        return x.getImageData(0, 0, 400, 240).data;
      };
      grp.visible = true; const A = grab();
      grp.visible = false; const B = grab();
      grp.visible = true;
      let n12 = 0, max = 0;
      for (let i = 0; i < A.length; i += 4) {
        const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
        if (d > max) max = d;
        if (d > 12) n12++;
      }
      return { label: 'whole group hidden, failing recipe', n12, max, total: 400 * 240 };
    })();

    __play.freeCam(null);
    const info = __play.info();
    return {
      rows, whole,
      pose: { x: Number(pose0.x.toFixed(3)), z: Number(pose0.z.toFixed(3)) },
      guard: (() => {
        const g = __play.guard.state();
        const o = { mode: g.mode };
        if (typeof g.facing === 'number') o.facing = Number(g.facing.toFixed(4));
        for (const k of Object.keys(g)) {
          if (typeof g[k] === 'number' && /heat|susp/i.test(k)) o[k] = Number(g[k].toFixed(4));
        }
        o.fields = Object.keys(g).join(',');
        return o;
      })(),
      phase: info.phase,
      canvas: { ...native, dpr: __play.renderer.getPixelRatio() },
      spot: { visible: spot.visible, intensity: spot.intensity, distance: spot.distance, angleDeg: spot.angle * 360 / Math.PI },
    };
  `);

  fs.writeFileSync(path.join(WORK, '_grab_recipe.json'), JSON.stringify(out, null, 2));
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
