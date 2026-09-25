/**
 * measure.js — load every GLB in a real browser and record true Box3 sizes.
 *
 * Writes data/kit_three.json. This is the authoritative size source: my own
 * glTF matrix maths is a re-implementation and must not be trusted over the
 * loader the scene itself uses.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { serve, launch, attach, killStrayChrome, sleep } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8801;
const DEBUG_PORT = 9223;

(async () => {
  await killStrayChrome();
  const server = await serve(ROOT, PORT);
  const chrome = await launch({ port: DEBUG_PORT, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_measure' });
  let sess;
  try {
    sess = await attach({ port: DEBUG_PORT });
    await sess.viewport(1200, 800);

    const renderer = await sess.glRenderer();
    console.log('WEBGL_RENDERER=' + renderer);

    await sess.goto(`http://127.0.0.1:${PORT}/tools/measure.html`, { settle: 1500 });

    // Wait for the page to finish measuring (all 140 loads).
    let ready = false;
    for (let i = 0; i < 60; i++) {
      ready = await sess.evalJs('!!window.__ready');
      if (ready === true) break;
      await sleep(1000);
    }
    if (ready !== true) {
      const diag = sess.diagnostics();
      console.log('FAILED to become ready');
      console.log(JSON.stringify(diag, null, 2).slice(0, 3000));
      process.exitCode = 1;
      return;
    }

    const result = await sess.evalJs('JSON.stringify(window.__result)');
    if (typeof result !== 'string' || result.startsWith('<<EXC>>')) {
      console.log('probe failed: ' + result);
      process.exitCode = 1;
      return;
    }
    const data = JSON.parse(result);

    const dest = path.join(ROOT, 'data', 'kit_three.json');
    fs.writeFileSync(dest, JSON.stringify(data, null, 1), 'utf-8');

    console.log(`measured   : ${data.count} models`);
    console.log(`total tris : ${data.totalTris}`);
    console.log(`errors     : ${data.errors.length}`);
    if (data.errors.length) data.errors.forEach((e) => console.log('   ' + e));

    const diag = sess.diagnostics();
    console.log(`exceptions : ${diag.exceptions.length}`);
    console.log(`http >=400 : ${diag.httpErrors.length}`);
    console.log(`net failed : ${diag.failedRequests.length}`);
    if (diag.exceptions.length) diag.exceptions.slice(0, 5).forEach((e) => console.log('   EXC ' + e));
    if (diag.httpErrors.length) diag.httpErrors.slice(0, 5).forEach((e) => console.log('   HTTP ' + e));
    if (diag.failedRequests.length) diag.failedRequests.slice(0, 5).forEach((e) => console.log('   NET ' + e));

    // Spot-check a few against the sample PNG naming to make sure sizes are sane.
    const show = ['bedDouble', 'chair', 'desk', 'loungeSofa', 'wall', 'floorFull', 'bathtub', 'kitchenCabinet'];
    for (const k of show) {
      const m = data.models[k];
      if (m) console.log(`  ${k.padEnd(18)} ${m.size.map((v) => v.toFixed(3).padStart(7)).join(' x ')}  tris ${m.tris}  min.y ${m.min[1].toFixed(4)}`);
    }
    console.log('wrote ' + dest);
  } finally {
    if (sess) sess.close();
    chrome.kill();
    await server.close();
  }
})().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
