/**
 * diag_world.mjs — WHAT WOULD THIS SNAPSHOT BE BUILT AS?
 *
 *     node scripts/diag_world.mjs
 *     node scripts/diag_world.mjs --arena game/arenas/gen.json --arena work/x.json
 *
 * THE PUZZLE THIS WAS WRITTEN FOR. A generated floor plan passed every check in
 * this repo and then, in the browser, was the SHIPPED apartment: the plan said
 * 16 x 14 m and ten rooms, the scene graph said 10.14 x 8.15 m and six. Nothing
 * was broken -- `play.js` built its renderer from `js/layout.js` at module scope
 * and had never heard of an arena, so it built the only apartment it knew. What
 * was missing was the MEASUREMENT: every existing tool asked about the level, and
 * none of them asked what got drawn.
 *
 * So this prints the three numbers that disagree when it happens -- the plan the
 * core plays, the bounding box of the apartment in the scene, and the room ids
 * on each side -- for any snapshot you point it at. `scripts/verify_world.mjs`
 * is the same measurement with PASS/FAIL attached and three arenas to hold it
 * to; this is the tool you reach for when a floor looks wrong and you want to
 * know WHICH floor it became.
 *
 * A snapshot with no `layout` prints NOTHING TO BUILD and the page's refusal,
 * which is the intended answer: `play.html` will not guess.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cdp from './cdp.js';

const { serve, launch, attach, killStrayChrome, sleep } = cdp;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8793;
const DEBUG = 9229;

function args(name) {
  const out = [];
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === '--' + name) out.push(process.argv[i + 1]);
  }
  return out;
}
const ARENAS = args('arena').length
  ? args('arena')
  : ['game/arenas/room_scene.json', 'game/arenas/gen.json'];

/** Everything the page can tell us about the world it built. */
const MEASURE = `(() => {
  const T = __play.THREE;
  const apt = __play.apartment;
  const box = new T.Box3().setFromObject(apt.root);
  const size = box.getSize(new T.Vector3());
  const fur = apt.root.getObjectByName('furniture');
  const zones = fur ? fur.children.map((c) => c.userData.zone || '(none)').sort() : [];
  const lvl = __play.level;
  return {
    plan: lvl.meta.plan,
    world: { x: +size.x.toFixed(3), z: +size.z.toFixed(3), y: +size.y.toFixed(3) },
    rendered: zones,
    level: lvl.rooms.map((r) => r.id).sort(),
    stats: apt.stats,
    solids: {
      doors: lvl.solids.filter((s) => s.kind === 'door').length,
      furniture: lvl.solids.filter((s) => s.kind === 'furniture').length,
      floors: lvl.floors.length,
    },
    hasLayout: !!lvl.layout,
  };
})()`;

async function main() {
  await killStrayChrome();
  const server = await serve(ROOT, PORT);
  const chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_world' });
  const sess = await attach({ port: DEBUG });

  const lines = [];
  const say = (s = '') => { lines.push(s); console.log(s); };

  for (const arena of ARENAS) {
    say('='.repeat(76));
    say('arena  ' + arena);
    await sess.goto(`http://127.0.0.1:${PORT}/play.html?arena=./${arena}`, { settle: 1200 });
    let ready = false;
    for (let i = 0; i < 240; i++) {
      if (await sess.evalJs('!!(window.__ready && window.__play)') === true) { ready = true; break; }
      const err = await sess.evalJs('window.__playError || null');
      if (err) { say('  the page refused it: ' + String(err).slice(0, 150)); break; }
      await sleep(500);
    }
    if (!ready) { say('  VERDICT  nothing to walk into'); continue; }

    const m = await sess.evalJs(MEASURE);
    const p = m.plan;
    say(`  plan the core plays   ${p.w} x ${p.d} m   (${m.level.length} rooms: ${m.level.join(', ')})`);
    say(`  world actually drawn  ${m.world.x.toFixed(2)} x ${m.world.z.toFixed(2)} m`
      + `   (${m.rendered.length} rooms: ${m.rendered.join(', ')})`);
    say(`  world height          ${m.world.y.toFixed(2)} m`);
    say(`  tiles/doors/furniture ${m.stats.floorTiles}/${m.solids.floors}`
      + `  ${m.stats.doors}/${m.solids.doors}  ${m.stats.furniture}/${m.solids.furniture}`);
    say(`  carries its layout    ${m.hasLayout ? 'yes' : 'NO'}`);
    const fit = Math.abs(m.world.x - p.w) < 0.75 && Math.abs(m.world.z - p.d) < 0.75;
    const rooms = m.rendered.join() === m.level.join();
    say(`  VERDICT  ${fit && rooms ? 'the world IS the floor'
      : 'THE WORLD IS NOT THE FLOOR -- the plan above is not what was built'}`);
  }

  const dir = path.join(ROOT, 'work');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_diag_world.log'), lines.join('\n') + '\n', 'utf8');
  sess.close();
  chrome.kill();
  await server.close();
  process.exit(0);
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
