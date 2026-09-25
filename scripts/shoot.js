/**
 * shoot.js — render the apartment headlessly and prove it actually drew.
 *
 * Checks, in order:
 *   1. STATIC   — every JS module has paired block comments and its key
 *                 statements still present after comment-stripping. A single
 *                 stray `/*` can silently comment out a whole function while
 *                 still passing a syntax check, so this runs first.
 *   2. RUNTIME  — __ready, then object counts (meshes, rooms, draw calls).
 *   3. CLEAN    — zero exceptions, zero 4xx/5xx, zero failed requests.
 *   4. PIXELS   — one screenshot per view; sizes must differ across views.
 *
 * Screenshot failures are logged, not asserted, so a lost shot never masks
 * a numeric verdict.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { serve, launch, attach, killStrayChrome, sleep } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'renders');
// Deliberately NOT 8777. That is serve.py's default -- the port a person is
// most likely to already have the app open on -- and a suite that cannot run
// while somebody is using the thing it tests is a suite that stops being run.
// Measured: EADDRINUSE 8777 with start.bat open. First free one wins.
const PORTS = [8798, 8799, 8801, 8802];
let PORT = PORTS[0];
const DEBUG = 9224;

const VIEWS = [
  { id: 'overview', label: '全景', w: 1600, h: 1000 },
  { id: 'top', label: '俯视', w: 1200, h: 1000 },
  { id: 'living', label: '客厅', w: 1280, h: 900 },
  { id: 'bedroom', label: '卧室', w: 1280, h: 900 },
  { id: 'kitchen', label: '厨房', w: 1280, h: 900 },
  { id: 'dining', label: '餐厅', w: 1280, h: 900 },
  { id: 'study', label: '书房', w: 1280, h: 900 },
  { id: 'bath', label: '卫生间', w: 1280, h: 900 },
];

/* --------------------------------------------------------------- static */

function stripComments(src) {
  let out = '';
  let i = 0;
  let open = false;
  while (i < src.length) {
    if (!open && src[i] === '/' && src[i + 1] === '*') { open = true; i += 2; continue; }
    if (open && src[i] === '*' && src[i + 1] === '/') { open = false; i += 2; continue; }
    if (!open && src[i] === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (!open) out += src[i];
    else if (src[i] === '\n') out += '\n';
    i++;
  }
  if (open) out += '\n<<UNTERMINATED_COMMENT>>\n';
  return out;
}

/**
 * Each entry: file, and statements that must survive comment-stripping.
 * These are CODE substrings, never comment text — a JSDoc-only match would
 * certify a function whose body had been commented out.
 */
const REQUIRED = {
  // NOTE: these are CODE substrings. A JSDoc-only match would certify a
  // function whose body had been commented out, which is exactly the failure
  // this checker exists to catch. `SRGBColorSpace` and `CORNERS = []` are
  // regression locks: they pin the two fixes that were hardest to find.
  'js/kit.js': ['async load(name)', 'this.entries.set(name, entry)', 'static worldPieces(obj)',
                'SRGBColorSpace'],
  // `const L = layout || SHIPPED;` is a REGRESSION LOCK, not decoration: it is
  // the line that makes `buildApartment`'s layout argument real, and deleting it
  // silently reverts the builder to `js/layout.js` -- which is how a generated
  // 16x14 floor came to be drawn as the shipped 10x8 apartment.
  'js/build.js': ['function buildFloor(kit, L)', 'function wallRun(kit, w)',
                  'export async function buildApartment(kit, { onProgress, layout }',
                  'const L = layout || SHIPPED;'],
  'js/layout.js': ['export const WALLS =', 'export const ROOMS =', 'export function requiredModels()',
                   'export const CORNERS = [];'],
  'js/app.js': ['export async function boot()', 'function zoneView(z)', 'window.__ready = true',
                'zones: UI.ZONES,'],
  'js/env.js': ['export function createRenderer(canvas)', 'export function createLights', 'PMREMGenerator'],
  'js/ui.js': ['export function bindToolbar', 'export function updateLabels', 'export function bindHover'],
  // A CLASSIC script: no imports, no exports, and it has to keep working on the
  // one page where nothing else does. Pinned by the attribute name it reads and
  // the three things it writes, plus the withdraw path -- a guard that cannot
  // take its own warning back is worse than silence, because it teaches readers
  // to ignore the box. Registered rather than skipped: an unregistered module is
  // an unchecked module, and this file is shared by all three pages precisely so
  // the next page cannot be written without it.
  'js/open-guard.js': ['function installOpenGuard()', "me.getAttribute('data-needle')",
                       "window.addEventListener('error'", 'function withdraw()',
                       'globalThis[cfg.needle]'],
};

/**
 * Modules in `js/` that are OUTPUT, not source: `procgen.mjs --out-layout`
 * writes one here (see the README's command table for why that path is
 * relative to `js/`). They cannot carry needles -- their contents change with
 * every parameter set -- so they are named here and SKIPPED OUT LOUD.
 *
 * Named, because the check below is "a module nobody registered is a module
 * nobody checks": the failure it caught was real. But a file this checker
 * cannot pin must still be accounted for, or the next person to run the
 * documented generator command gets a red viewer suite and no idea why.
 * (Skipping is also what keeps a fresh clone -- where the file does not exist
 * yet -- and a working copy byte-identical in verdict.)
 */
const GENERATED = ['layout.gen.js'];

function staticChecks() {
  const failures = [];
  const files = fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js'));
  const skipped = [];
  let verified = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf-8');
    const opens = (src.match(/\/\*/g) || []).length;
    const closes = (src.match(/\*\//g) || []).length;
    if (opens !== closes) failures.push(`${f}: block comments ${opens} open vs ${closes} close`);
    const bare = stripComments(src);
    if (bare.includes('<<UNTERMINATED_COMMENT>>')) failures.push(`${f}: block comment never closed`);

    if (GENERATED.includes(f)) { skipped.push(f); continue; }

    const needles = REQUIRED['js/' + f];
    if (!needles) failures.push(`${f}: not registered in REQUIRED (checker would skip it)`);
    else for (const n of needles) {
      verified++;
      if (!bare.includes(n)) failures.push(`${f}: stripped source lost "${n}"`);
    }

    const decls = (bare.match(/\n(?:export )?(?:async )?function \w+/g) || []).length;
    const arrows = (bare.match(/\n(?:export )?const \w+ =/g) || []).length;
    if (decls + arrows === 0) failures.push(`${f}: no top-level declarations found`);
  }
  const unregistered = Object.keys(REQUIRED).filter((k) => !files.includes(k.replace('js/', '')));
  unregistered.forEach((k) => failures.push(`${k}: registered but missing on disk`));
  return { failures, files: files.length, symbolsVerified: verified, skipped };
}

/* -------------------------------------------------------------------- run */

(async () => {
  await killStrayChrome();
  fs.mkdirSync(OUT, { recursive: true });

  const stat = staticChecks();
  console.log(`STATIC     files=${stat.files}  failures=${stat.failures.length}`
    + (stat.skipped.length ? `  generated=${stat.skipped.join(',')}` : ''));
  stat.failures.forEach((f) => console.log('   FAIL ' + f));

  let server = null;
  for (const p of PORTS) {
    try { server = await serve(ROOT, p); PORT = p; break; }
    catch (err) { if (!(err && err.code === 'EADDRINUSE')) throw err; }
  }
  if (!server) throw new Error('no free port among ' + PORTS.join(', '));
  console.log('SERVER     port=' + PORT);
  const chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_room' });
  let sess;
  const report = { static: stat, shots: [], probe: null, diag: null };

  try {
    sess = await attach({ port: DEBUG });
    const renderer = await sess.glRenderer();
    console.log('WEBGL_RENDERER=' + renderer);

    await sess.viewport(1600, 1000);
    await sess.goto(`http://127.0.0.1:${PORT}/index.html`, { settle: 2500 });

    // ---- wait for the build ------------------------------------------
    let ready = null;
    for (let i = 0; i < 90; i++) {
      ready = await sess.evalJs('!!(window.__ready && window.__app)');
      if (ready === true) break;
      const msg = await sess.evalJs("(document.getElementById('load-msg')||{}).textContent");
      if (i % 10 === 9) console.log('   …waiting ' + (i + 1) + 's  ' + msg);
      await sleep(1000);
    }
    if (ready !== true) {
      const d = sess.diagnostics();
      console.log('NOT READY');
      console.log(JSON.stringify(d, null, 2).slice(0, 3000));
      report.diag = d;
      process.exitCode = 1;
      return;
    }

    // ---- assert on counts, never on __ready alone ---------------------
    const probeRaw = await sess.evalJs(`JSON.stringify((() => {
      const a = window.__app;
      const s = a.apartment.stats;
      let meshes = 0, tris = 0, visible = 0;
      a.apartment.root.traverse((o) => { if (o.isMesh) { meshes++; const g = o.geometry;
        tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
        if (o.visible) visible++; } });
      return {
        ready: window.__ready,
        stats: s,
        corners: s.corners,
        loadingHidden: (() => {
          const el = document.getElementById('loading');
          return el ? getComputedStyle(el).display === 'none' : null;
        })(),
        hintText: (document.getElementById('hint') || {}).textContent || '',
        modelsRequested: (a.models || []).length,
        modelsLoaded: (a.models || []).filter((n) => a.kit.entries.has(n)).length,
        countedMeshes: meshes,
        countedTris: Math.round(tris),
        visibleMeshes: visible,
        rooms: a.apartment.rooms.map(r => ({ id: r.id, items: r.items.length,
          meshes: r.group.children.length })),
        zoneBoxes: Object.keys(a.zoneBoxes).length,
        materials: a.kit.materials.size,
        filesLoaded: a.kit.stats.filesLoaded,
        labels: document.querySelectorAll('.zone-label').length,
        viewButtons: document.querySelectorAll('#views button').length,
        flagButtons: document.querySelectorAll('#flags button').length,
        renderCalls: a.renderer.info.render.calls,
        hasEnvMap: !!a.scene.environment,
        canRotate: !!a.controls.enableRotate,
        canZoom: !!a.controls.enableZoom,
        canPan: !!a.controls.enablePan,
        minDistance: a.controls.minDistance,
        maxDistance: a.controls.maxDistance,
      };
    })())`);

    if (typeof probeRaw !== 'string' || probeRaw.startsWith('<<EXC>>')) {
      console.log('PROBE FAILED: ' + probeRaw);
      process.exitCode = 1;
      return;
    }
    const probe = JSON.parse(probeRaw);
    report.probe = probe;

    const failures = [];
    const A = (cond, msg) => { if (!cond) failures.push(msg); };
    A(probe.stats.furniture >= 95, `furniture ${probe.stats.furniture} < 95`);
    A(probe.stats.floorTiles === 80, `floorTiles ${probe.stats.floorTiles} != 80`);
    A(probe.stats.wallSegments >= 40, `wallSegments ${probe.stats.wallSegments} < 40`);
    A(probe.countedMeshes >= 40 && probe.countedMeshes <= 240, `meshes ${probe.countedMeshes} outside 40..240`);
    A(probe.rooms.length === 6, `rooms ${probe.rooms.length} != 6`);
    A(probe.rooms.every((r) => r.items > 5), 'a room has <=5 items');
    A(probe.zoneBoxes === 6, `zoneBoxes ${probe.zoneBoxes} != 6`);
    A(probe.filesLoaded >= 40, `filesLoaded ${probe.filesLoaded} < 40`);
    A(probe.materials > 6 && probe.materials < 40, `materials ${probe.materials} outside 6..40`);
    A(probe.labels === 6, `labels ${probe.labels} != 6`);
    A(probe.viewButtons === 8, `view buttons ${probe.viewButtons} != 8`);
    A(probe.flagButtons === 5, `flag buttons ${probe.flagButtons} != 5`);
    A(probe.hasEnvMap, 'no environment map');
    A(probe.canRotate && probe.canZoom && probe.canPan, 'orbit controls incomplete');
    A(probe.corners === 0, `corners ${probe.corners} != 0 -- wallCorner flaps are back`);
    // The strongest available statement about asset loading: every model the
    // layout names is present in the kit. This is what makes it safe to treat
    // a canceled-after-200 fetch as noise instead of a bug -- if a fetch had
    // genuinely failed, a model would be missing and this assertion fires.
    A(probe.modelsLoaded === probe.modelsRequested,
      `only ${probe.modelsLoaded}/${probe.modelsRequested} layout models loaded`);
    A(probe.loadingHidden === true, 'the loading overlay is still displayed');
    A(probe.hintText.indexOf('旋转') >= 0 && probe.hintText.indexOf('缩放') >= 0,
      `hint line reads "${probe.hintText.slice(0, 40)}"`);

    // ---- camera rig: does every room shot face the wall it is about? -----
    // `aligned` is the cosine between the eye->focus direction and the zone's
    // declared `face`. A rig that has quietly been rotated (the bug this pass
    // fixes) shows up here as a negative number, not as a pretty screenshot.
    const rigRaw = await sess.evalJs(`JSON.stringify((() => {
      const a = window.__app;
      const WALL_H = 1.29;
      return (a.zones || []).map((z) => {
        const v = a.zoneView(z);
        if (!v || !v.position || !z.face) return { id: z.id, error: 'no rig' };
        a.jumpView(z.id);
        const eye = v.position;
        const landed = a.camera.position.distanceTo(eye);
        let dx = z.focus[0] - eye.x, dz = z.focus[2] - eye.z;
        const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
        const fl = Math.hypot(z.face[0], z.face[1]) || 1;
        const aligned = (dx * z.face[0] + dz * z.face[1]) / fl;
        return { id: z.id, landed: +landed.toFixed(4), aligned: +aligned.toFixed(3),
                 eyeY: +eye.y.toFixed(2), aboveWalls: eye.y > WALL_H };
      });
    })())`);

    let rig = [];
    if (typeof rigRaw !== 'string' || rigRaw.startsWith('<<EXC>>')) {
      failures.push('camera rig probe failed: ' + rigRaw);
    } else {
      rig = JSON.parse(rigRaw);
      A(rig.length === 6, `camera rig covers ${rig.length} zones, expected 6`);
      for (const r of rig) {
        A(!r.error, `${r.id}: rig unusable (${r.error || '?'})`);
        if (r.error) continue;
        A(r.aligned > 0.5, `${r.id}: shot faces ${r.aligned} vs its composed direction (needs > 0.5)`);
        A(r.aboveWalls, `${r.id}: eye y=${r.eyeY} is not above the 1.29 m walls`);
        A(r.landed < 0.05, `${r.id}: orbit clamping moved the eye by ${r.landed} m`);
      }
      console.log(`RIG        ${rig.map((r) => `${r.id} ${r.aligned}@y${r.eyeY}`).join('  ')}`);
    }

    console.log(`PROBE      furniture=${probe.stats.furniture} floors=${probe.stats.floorTiles} ` +
      `walls=${probe.stats.wallSegments} doors=${probe.stats.doors} meshes=${probe.countedMeshes} ` +
      `tris=${probe.countedTris} mats=${probe.materials} files=${probe.filesLoaded}`);
    console.log(`CONTROLS   rotate=${probe.canRotate} zoom=${probe.canZoom} pan=${probe.canPan} ` +
      `dist=${probe.minDistance}..${probe.maxDistance} drawCalls=${probe.renderCalls}`);
    console.log(`ROOMS      ${probe.rooms.map((r) => r.id + ':' + r.items).join('  ')}`);
    failures.forEach((f) => console.log('   FAIL ' + f));
    console.log(`ASSERTIONS failures=${failures.length}`);

    // ---- solid-top census ------------------------------------------------
    // 25 rays dropped straight down over each item's footprint must all land
    // on something solid. This is the physical form of "the tabletop is
    // there", and it guards the one silent failure mode in the build step:
    // mergeGeometries() returns null on mismatched attribute sets and
    // mergePlaced() then does `if (!list) continue`, dropping a whole material
    // group without an error. A dropped group reads here as rays falling
    // through to the floor.
    //
    // What it does NOT catch: a face the rasteriser culls but the raycaster
    // accepts. Those two derive winding from the same vertex order, so no such
    // case exists -- which is why the coffee table turned out to be a false
    // alarm (25/25 solid) and not a defect.
    const gridRaw = await sess.evalJs(`JSON.stringify((() => {
      const a = window.__app, T = a.THREE;
      const ray = new T.Raycaster();
      const down = new T.Vector3(0, -1, 0);
      const WANT = ['tableCoffee','tableCross','sideTable','sideTableDrawers','desk',
                    'bedDouble','kitchenCabinetDrawer','cabinetTelevisionDoors','bookcaseClosedWide'];
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
          let solid = 0, total = 0;
          for (let i = -2; i <= 2; i++) {
            for (let j = -2; j <= 2; j++) {
              const lx = (i / 2) * hw, lz = (j / 2) * hd;
              ray.set(new T.Vector3(it.x + lx * cs + lz * sn, 1.6, it.z - lx * sn + lz * cs), down);
              const hs = ray.intersectObject(a.apartment.furniture, true);
              total++;
              if (hs.length && hs[0].point.y > 0.04) solid++;
            }
          }
          out[it.m] = { solid, total, pct: +(solid / total).toFixed(2) };
        }
      }
      return out;
    })())`);

    if (typeof gridRaw !== 'string' || gridRaw.startsWith('<<EXC>>')) {
      failures.push('solid-top census failed: ' + gridRaw);
    } else {
      const grid = JSON.parse(gridRaw);
      const names = Object.keys(grid);
      A(names.length >= 9, `solid-top census covered only ${names.length} models`);
      for (const n of names) {
        const g = grid[n];
        A(!g.error, `${n}: ${g.error || '?'}`);
        if (!g.error) A(g.pct >= 0.96, `${n}: only ${g.solid}/${g.total} drop rays hit a solid top`);
      }
      const worst = names.map((n) => `${n} ${grid[n].pct}`).join('  ');
      console.log(`SOLIDTOP   ${names.length} models, worst pct = ` +
        `${Math.min(...names.map((n) => grid[n].pct))}   [${worst}]`);
    }

    // ---- screenshots --------------------------------------------------
    let shotOk = 0;
    const sizes = [];
    for (const v of VIEWS) {
      await sess.viewport(v.w, v.h);
      const ok = await sess.evalJs(`window.__app.jumpView(${JSON.stringify(v.id)})`);
      if (ok !== true) console.log(`   jumpView(${v.id}) returned ${ok}`);
      await sleep(700);
      const file = path.join(OUT, `view_${v.id}.png`);
      const r = await sess.shot(file);
      if (r.ok) { shotOk++; sizes.push(r.bytes); } else { console.log(`   [shot-failed] ${v.id}`); }
      console.log(`  shot ${v.id.padEnd(10)} ${v.label.padEnd(5)} ${r.ok ? (r.bytes / 1024).toFixed(0) + ' KB' : 'FAILED'}`);
    }
    report.shots = sizes;
    const distinct = new Set(sizes).size;
    console.log(`SHOTS      ok=${shotOk}/${VIEWS.length}  distinct sizes=${distinct}`);

    // ---- cleanliness --------------------------------------------------
    const diag = sess.diagnostics();
    report.diag = diag;
    const realHttp = diag.httpErrors.filter((e) => !e.includes('favicon'));

    // A fetch that ALREADY received 200 and was then canceled is three.js's
    // FileLoader handing the body to its own progress-reporting stream; Chrome
    // then marks the original request canceled even though every byte was read
    // and the model parsed. Not a guess -- probe_net.js shows the canceled .glb
    // changing run to run while kit.entries holds at a full 83/83, and
    // wallWindow.glb is 10,744 bytes on disk and renders fine. Counted
    // separately; the real guard is modelsLoaded === modelsRequested above,
    // which fires the instant a model genuinely fails to arrive.
    const benign = (f) => /ERR_ABORTED/.test(f.errorText) && f.status === 200;
    const failedNet = diag.failedDetail.filter((f) => !benign(f));
    const benignNet = diag.failedDetail.filter(benign);

    console.log(`CLEAN      exceptions=${diag.exceptions.length} http>=400=${realHttp.length} ` +
      `netFailed=${failedNet.length} canceled-after-200=${benignNet.length} ` +
      `consoleErrors=${diag.consoleErrors.length}`);
    diag.exceptions.slice(0, 6).forEach((e) => console.log('   EXC ' + e));
    realHttp.slice(0, 6).forEach((e) => console.log('   HTTP ' + e));
    failedNet.slice(0, 6).forEach((e) => console.log('   NET ' + e.errorText + ' [' + e.type + '] ' + e.url));
    benignNet.slice(0, 6).forEach((e) => console.log('   NET~ ' + e.errorText + ' after a ' + e.status + ' on ' + e.url));
    diag.consoleErrors.slice(0, 6).forEach((e) => console.log('   CONSOLE ' + e));

    const verdict = stat.failures.length + failures.length + diag.exceptions.length +
      realHttp.length + failedNet.length;
    console.log(`VERDICT    ${verdict === 0 ? 'PASS' : 'FAIL (' + verdict + ' problems)'}`);

    fs.writeFileSync(path.join(ROOT, 'work', 'verify_report.json'),
      JSON.stringify(report, null, 1), 'utf-8');
  } finally {
    if (sess) sess.close();
    chrome.kill();
    if (server) await server.close();
  }
})().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
