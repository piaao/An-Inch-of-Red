/**
 * probe_guard_sight.mjs — why does the guard not see a player 0.9 m in front?
 *
 * verify_play's guard check reports `guard enters alert when it sees you` FAIL
 * after phase A (60 s of unobserved patrol) runs first. The old version of that
 * check ran the detection ladder on a FRESH run and passed. So something about
 * the long patrol changes the answer, and "the guard is blind" and "the test is
 * putting the player somewhere else" look identical from the outside.
 *
 * This prints, per iteration: guard pos/facing, where the player actually
 * ended up after teleport, the distance and bearing offset, and what the core's
 * own `Guard.look()` says -- so the answer is the core's, not a re-derivation.
 *
 * Usage: node scripts/probe_guard_sight.mjs [secondsOfPatrolFirst]
 */
import cdp from './cdp.js';

const { serve, launch, attach, killStrayChrome, sleep } = cdp;

const PORT = 8783;
const DEBUG = 9228;
const PATROL_FIRST = Number(process.argv[2] ?? 60);

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };

let server = null;
let chrome = null;
let sess = null;

async function main() {
  await killStrayChrome();
  server = await serve(process.cwd(), PORT);
  chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_probe' });
  sess = await attach({ port: DEBUG });
  await sess.viewport(1280, 720);
  await sess.goto(`http://127.0.0.1:${PORT}/play.html`, { settle: 1500 });

  let ready = false;
  for (let i = 0; i < 240; i++) {
    if (await sess.evalJs('!!(window.__ready && window.__play)')) { ready = true; break; }
    const err = await sess.evalJs('window.__playError || null');
    if (err) { say(`boot threw: ${err}`); break; }
    await sleep(500);
  }
  say(`ready=${ready}`);

  const r = await sess.evalAsync(`
    await __play.begin('patrol');

    const roomOf = (p) => {
      for (const rr of __play.level.rooms) {
        const b = rr.rect;
        if (p.x >= b.x0 && p.x <= b.x1 && p.z >= b.z0 && p.z <= b.z1) return rr.id;
      }
      return null;
    };

    const rows = [];
    const probe = (tag) => {
      const g = __play.guard.state();
      const pl = __play.avatar.pos();
      const d = Math.hypot(pl.x - g.pos.x, pl.z - g.pos.z);
      const bearing = Math.atan2(pl.z - g.pos.z, pl.x - g.pos.x);
      const wrap = (a) => { while (a > Math.PI) a -= 2*Math.PI; while (a < -Math.PI) a += 2*Math.PI; return a; };
      const look = __play.guard.look(pl);
      rows.push({ tag, mode: g.mode, suspicion: Math.round(g.suspicion*1000)/1000,
        gx: +g.pos.x.toFixed(3), gz: +g.pos.z.toFixed(3), gf: +g.facing.toFixed(3),
        px: +pl.x.toFixed(3), pz: +pl.z.toFixed(3),
        d: +d.toFixed(3), off: +Math.abs(wrap(bearing - g.facing)).toFixed(3),
        proom: roomOf(pl), groom: roomOf(g.pos),
        seen: !!look.seen, why: look.seen ? 'ok' : look.reason,
        blockedBy: look.blockedBy || null });
    };

    // Phase A: patrol with the player parked BEHIND the guard, exactly as
    // verify_play does, for PATROL_FIRST seconds.
    const A = Math.round(${PATROL_FIRST} * 60);
    for (let i = 0; i < A; i++) {
      const g = __play.guard.state();
      __play.teleport(g.pos.x - Math.cos(g.facing) * 2.2, g.pos.z - Math.sin(g.facing) * 2.2);
      __play.step(1/60, 1);
    }
    probe('after-patrol');

    // Phase B: put it 0.9 m in front and watch 12 iterations.
    for (let i = 0; i < 12; i++) {
      const g = __play.guard.state();
      __play.teleport(g.pos.x + Math.cos(g.facing) * 0.9, g.pos.z + Math.sin(g.facing) * 0.9);
      __play.step(1/60, 6);
      probe('in-front-' + i);
    }

    return { rows, catches: __play.info().catches,
             phase: __play.info().phase, elapsed: __play.info().elapsed };`);

  say(`catches ${r.catches}   phase ${r.phase}   elapsed ${r.elapsed}`);
  say('');
  say('tag              mode    susp   guard(x,z)          face    player(x,z)         d      off    proom      groom      seen  why');
  for (const q of r.rows) {
    say(`${String(q.tag).padEnd(16)} ${String(q.mode).padEnd(7)} ${String(q.suspicion).padEnd(6)}`
      + ` (${String(q.gx).padStart(6)},${String(q.gz).padStart(6)}) ${String(q.gf).padStart(6)}`
      + `  (${String(q.px).padStart(6)},${String(q.pz).padStart(6)})`
      + ` ${String(q.d).padStart(6)} ${String(q.off).padStart(6)}`
      + `  ${String(q.proom).padEnd(9)} ${String(q.groom).padEnd(9)}`
      + `  ${q.seen ? 'YES' : 'no '}   ${q.why}${q.blockedBy ? ' ' + q.blockedBy : ''}`);
  }
}

main()
  .catch((e) => say('HARNESS ERROR: ' + (e && e.stack ? e.stack : e)))
  .finally(async () => {
    try { if (sess) sess.close(); } catch { /* */ }
    try { if (chrome) chrome.kill(); } catch { /* */ }
    try { if (server) await server.close(); } catch { /* */ }
    await killStrayChrome();
  });
