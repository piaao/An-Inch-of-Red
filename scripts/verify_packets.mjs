/**
 * verify_packets.mjs — the GARRISON and the PACKETS, checked against the core.
 *
 *     node scripts/verify_packets.mjs
 *     node scripts/verify_packets.mjs --log work/_mut_A1.log
 *
 * `--log` exists because of a real accident. A mutation run feeds this file a
 * deliberately broken tree and runs it -- which makes THIS tool overwrite its
 * own `work/verify_packets.log` with a FAILED transcript. Reverting the source
 * afterwards does not revert the log, so `work/verify_packets.log` sat there
 * claiming a failure that never happened to any real code. Redirectable logs
 * fix it at the source; "remember to restore the log" would not.
 *
 * ONE Node process. No Chrome, no child processes. That is not a compromise
 * here, it is the right shape: "how many guards does this preset build, how
 * many packets, are the two patrols actually different" are questions about
 * `game/play/` and `game/core/`, both of which are portable by design. The
 * browser suites (`verify_play.mjs` and friends) answer the different question
 * of whether the picture matches -- and they need a browser.
 *
 * WHAT IT EXISTS TO CATCH. Three things that are easy to get wrong and that
 * nothing else was watching:
 *
 *   1. THE PACKET SIZE HAS TWO COPIES. `game/arena/fromLayout.js` builds the
 *      level; `game/arenas/room_scene.json` is the snapshot the game actually
 *      loads. Change one and not the other and the design document and the
 *      game disagree about how big a 红包 is -- silently, because both are
 *      valid numbers. Check `snapshot === DEFAULTS` is the whole cure.
 *   2. A SECOND GUARD IS NOT A RENAME. Two guards built from the same RNG
 *      stream would walk the same route, i.e. be one guard with extra
 *      geometry. The streams are derived BY NAME (`guard-<seed>` /
 *      `guard2-<seed>`), and the same discipline as `prizeRng` applies: adding
 *      the second stream must not move the first. Both are asserted.
 *   3. THE DESIGN RULE "NOTHING IS LEFT ON THE FLOOR" IS A COUNT, NOT A
 *      FEELING. It is counted at the largest packet count on the ladder,
 *      because that is where it is most likely to break.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCore } from '../game/play/boot.js';
import { DEFAULTS } from '../game/arena/fromLayout.js';
import { DIFFICULTIES, guardCountFor, prizeCountFor, prizeAreaOf, noticeRangeOf }
  from '../game/play/config.js';

const ROOT = new URL('..', import.meta.url);
const level = JSON.parse(fs.readFileSync(new URL('game/arenas/room_scene.json', ROOT), 'utf8'));

const log = [];
const say = (s = '') => { log.push(s); console.log(s); };

const checks = [];
const ok = (cond, label, detail = '') => {
  checks.push({ ok: !!cond, label, detail });
  say(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  -- ' + detail : ''}`);
  return !!cond;
};

let exitCode = 0;
try {
  /* ------------------------------------------------------------------ 1 */
  say('== the 红包 the shipped arena promised ==');
  const size = level.collectible.size;
  say(`  snapshot collectible.size ${JSON.stringify(size)}`);
  const area = prizeAreaOf(level.collectible);
  const range = noticeRangeOf(area);
  const OLD_AREA = 0.0160;
  say(`  area ${area.toFixed(5)} m2 -> notice range ${range.toFixed(2)} m`
    + `  (was ${OLD_AREA} m2 -> 4.47 m)`);

  ok(Math.abs(size[1] - 0.006) < 1e-9,
    'the packet is 6 mm thick -- thin to the point of being a slip of paper',
    `${(size[1] * 1000).toFixed(1)} mm`);

  // The thickness is decoration; the PLAN is the difficulty. State both, so a
  // future reader cannot mistake "thinner" for "harder".
  ok(area < OLD_AREA * 0.55,
    'the plan area fell by more than 45 % (this is the part that moves difficulty)',
    `${(area / OLD_AREA * 100).toFixed(1)} % of the old area`);
  ok(range < 4.47,
    'and the notice range fell with it -- thinner did NOT do this, smaller did',
    `${range.toFixed(2)} m vs 4.47 m, ratio ${(range / 4.47).toFixed(2)}x`);

  const snap = JSON.stringify(size);
  const def = JSON.stringify(DEFAULTS.collectible.size);
  ok(snap === def,
    'the snapshot and fromLayout.DEFAULTS still say the same size (one fact, two copies)',
    snap === def ? def : `snapshot ${snap} vs DEFAULTS ${def}`);

  /* ------------------------------------------------------------------ 2 */
  say('\n== the preset table ==');
  for (const d of DIFFICULTIES) {
    say(`  ${d.name.padEnd(3)} ${d.id.padEnd(7)} guards=${guardCountFor(d)}`
      + ` prizes=${prizeCountFor(d)} surveil=${d.surveil} prizeScale=${d.prizeScale}`);
  }
  const [solo, patrol, tight, hunter] = DIFFICULTIES;
  ok(guardCountFor(solo) === 1,
    '见习 has a guard -- it used to have NONE (a rung with nothing on it)');
  ok(guardCountFor(patrol) === 1, '标准 has one guard');
  ok(guardCountFor(tight) === 2 && prizeCountFor(tight) === 12,
    '紧张 has two guards and twelve packets');
  ok(guardCountFor(hunter) === 2 && prizeCountFor(hunter) === 24,
    '硬核 has two guards and twenty-four packets');

  const rooms = level.rooms.length;
  const starved = DIFFICULTIES.filter((d) => prizeCountFor(d) < rooms);
  ok(starved.length === 0,
    `every preset hides at least one packet per room (>= ${rooms})`,
    starved.length ? starved.map((d) => `${d.id}=${prizeCountFor(d)}`).join(', ')
      : DIFFICULTIES.map((d) => prizeCountFor(d)).join('/'));

  /* ------------------------------------------------------------------ 3 */
  say('\n== what the core actually builds ==');
  const SEED = 'p4-ruler';
  const builds = {};
  for (const count of [6, 12, 24]) {
    const t0 = performance.now();
    const core = buildCore(level, { seed: SEED, count });
    const ms = performance.now() - t0;
    builds[count] = core;
    const hit = new Set(core.prizes.map((p) => p.room));
    say(`  count=${String(count).padStart(2)}  placed=${core.prizes.length}`
      + `  rooms ${hit.size}/${rooms}`
      + `  anchors ${core.placement.report.anchorsScored}`
      + `  patrols ${core.patrols.length}`
      + `  waypoints ${core.patrols.map((p) => p.waypoints.length).join('/')}`
      + `  ${ms.toFixed(0)} ms`);
    ok(core.prizes.length === count, `count ${count} places exactly ${count} packets`,
      `${core.prizes.length} placed`);
    ok(core.patrols.length === 2, `count ${count} builds two patrols`);
  }

  const big = builds[24];
  const onFloor = big.prizes.filter((p) => p.y <= 0.02).length;
  ok(onFloor === 0,
    'none of the 24 packets ended up on the floor (the design rule, at max count)',
    `${onFloor} of ${big.prizes.length}`);

  /* ------------------------------------------------------------------ 4 */
  say('\n== the two guards walk two different walks ==');
  const w0 = builds[6].patrols[0].waypoints.map((w) => `${w.x.toFixed(3)},${w.z.toFixed(3)}`);
  const w1 = builds[6].patrols[1].waypoints.map((w) => `${w.x.toFixed(3)},${w.z.toFixed(3)}`);
  const identical = w0.length === w1.length && w0.every((s, i) => s === w1[i]);
  say(`  patrol 0: ${w0.length} waypoints;  patrol 1: ${w1.length}`);
  ok(!identical, 'the second guard does not walk the first one\'s route',
    identical ? 'IDENTICAL -- the second guard would be a shadow' : 'routes differ');

  // The same claim `prizeRng` makes, and for the same reason: the second stream
  // is derived BY NAME, so whether it exists must not move the first. If this
  // ever fails, every guard reading ever taken under one guard is void.
  const lone = buildCore(level, { seed: SEED, count: 6, guards: 1 });
  const a = lone.patrols[0].waypoints.map((w) => `${w.x.toFixed(6)},${w.z.toFixed(6)}`);
  const b = builds[6].patrols[0].waypoints.map((w) => `${w.x.toFixed(6)},${w.z.toFixed(6)}`);
  ok(a.length === b.length && a.every((s, i) => s === b[i]),
    'patrol[0] is bit-for-bit the same whether or not patrol[1] is built',
    `${a.length} vs ${b.length} waypoints`);
} catch (err) {
  say('');
  say('HARNESS ERROR: ' + (err && err.stack ? err.stack : err));
  exitCode = 2;
}

const passed = checks.filter((c) => c.ok).length;
say('');
say('='.repeat(72));
say(`  ${passed}/${checks.length} checks passed`);
for (const c of checks) if (!c.ok) say(`   FAILED: ${c.label} — ${c.detail || ''}`);
say('='.repeat(72));
const verdict = checks.length > 0 && passed === checks.length && exitCode === 0;
say(verdict ? '  VERDICT: PASS' : '  VERDICT: FAIL');

// Redirectable, so a mutation run cannot leave a FAILED transcript sitting in
// the canonical slot. See the header.
const argI = process.argv.indexOf('--log');
const here = fileURLToPath(ROOT);
const logPath = argI >= 0 && process.argv[argI + 1]
  ? path.resolve(process.argv[argI + 1])
  : path.join(here, 'work', 'verify_packets.log');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, log.join('\n') + '\n');
// Forward slashes, always: this line lands in committed evidence, and a
// `work\verify_packets.log` reads as a different path from `work/verify_packets.log`
// on every machine that is not Windows.
say(`  log: ${(path.relative(here, logPath) || logPath).replace(/\\/g, '/')}`);

if (!verdict) exitCode = 1;
process.exit(exitCode);
