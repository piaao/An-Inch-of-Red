/**
 * probe_hud.js — pixel-exact crops of the HUD furniture.
 *
 * The wide renders suggested the header credit line and the bottom hint were
 * doubled or ghosted. The DOM says otherwise (the loading overlay is
 * display:none, the hint text is exactly the expected string), so the question
 * is purely what the pixels look like. `Page.captureScreenshot` takes a clip
 * rectangle and a scale, so this crops each HUD region at 3x and writes it out
 * for inspection instead of squinting at a 1080px-wide render.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { serve, launch, attach, killStrayChrome, sleep } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'work', 'hud');
const PORT = 8793;
const DEBUG = 9227;

/** x, y, w, h in CSS pixels at the 1600x1000 viewport. */
const REGIONS = [
  { id: 'header', x: 10, y: 8, w: 320, h: 100 },
  { id: 'rightstack', x: 1200, y: 8, w: 390, h: 170 },
  { id: 'hint', x: 8, y: 930, w: 430, h: 60 },
];

(async () => {
  await killStrayChrome();
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve(ROOT, PORT);
  const chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_hud' });
  let sess;
  try {
    sess = await attach({ port: DEBUG });
    await sess.viewport(1600, 1000);
    await sess.goto(`http://127.0.0.1:${PORT}/index.html`, { settle: 3000 });
    for (let i = 0; i < 60; i++) {
      if (await sess.evalJs('!!window.__ready') === true) break;
      await sleep(1000);
    }
    await sess.evalJs('window.__app.jumpView("overview")');
    await sleep(600);

    // Report the computed styles that decide how these lines are painted.
    const css = await sess.evalJs(`JSON.stringify((() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const s = getComputedStyle(el);
        return { text: (el.textContent || '').trim().slice(0, 48), display: s.display,
                 fontSize: s.fontSize, color: s.color, textShadow: s.textShadow,
                 zIndex: s.zIndex, position: s.position };
      };
      return { hint: pick('#hint'), credit: pick('#hud .credit'), hud: pick('#hud'),
               stats: pick('#stats'), loading: pick('#loading') };
    })())`);
    console.log('computed styles:');
    console.log(css);

    // Anything else painting near the bottom-left?
    const stacked = await sess.evalJs(`JSON.stringify((() => {
      const out = [];
      document.querySelectorAll('body *').forEach((el) => {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return;
        if (r.bottom > 920 && r.left < 460 && r.top > 880) {
          out.push({ tag: el.tagName + (el.id ? '#' + el.id : '') +
                     (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''),
                     rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
                     opacity: s.opacity });
        }
      });
      return out;
    })())`);
    console.log('elements intersecting the bottom-left band: ' + stacked);

    for (const g of REGIONS) {
      const r = await sess.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: g.x, y: g.y, width: g.w, height: g.h, scale: 3 },
      });
      const data = r.result && r.result.data;
      if (!data) { console.log('  %s FAILED', g.id); continue; }
      const file = path.join(OUT, g.id + '.png');
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      console.log('  ' + g.id.padEnd(14) + fs.statSync(file).size + ' bytes -> ' + file);
    }
  } finally {
    if (sess) sess.close();
    chrome.kill();
    await server.close();
  }
})().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
