/**
 * diag_sight.mjs — the flat sight test vs the sloped one, on the SAME anchors.
 *
 * diag_anchors showed 66 of 74 top anchors come back `cover = 0` -> `hidden`,
 * which empties three rooms and is why only three rooms ever hold a 红包. The
 * suspicion is that p50's sloped test (`targetY = anchor.y`) is not merely
 * stricter but self-blocking: the anchor sits ON its host's top face, so a ray
 * to it ENDS on the host and the host counts as "in the way" at t = 1.0.
 *
 * This prints, per anchor: the old flat cover, the new sloped cover, and WHICH
 * SOLID stopped it -- so the cause is named rather than inferred.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNav } from '../game/core/nav.js';
import { climbCeilOf } from '../game/core/level.js';
import { climbPlan } from '../game/core/climb.js';
import { topAnchors, defaultViewpoints, climbViewpoints } from '../game/core/place.js';
import { sightLine } from '../game/core/vision.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARENA = path.join(ROOT, 'game', 'arenas', 'room_scene.json');
const OUT = path.join(ROOT, 'work', '_diag_sight.json');

const lines = [];
const say = (s) => { lines.push(s); process.stdout.write(s + '\n'); };

const level = JSON.parse(fs.readFileSync(ARENA, 'utf8'));
const eyeY = level.body.eyeHeight;
const nav = buildNav(level, {
  inflate: level.body.playerRadius, bodyHeight: level.body.playerHeight, step: level.meta.step,
});
const plan = climbPlan(level, nav);
const floorVp = defaultViewpoints(level, nav);
const climbVp = climbViewpoints(level, nav, plan);
const all = [...floorVp, ...climbVp];

say('='.repeat(84));
say('diag_sight  --  flat (before p50) vs sloped (after p50), same anchors');
say('='.repeat(84));

/* ---------------------------------------------- what "blocks" even means */

const blocks = {};
for (const s of level.solids) {
  const b = s.blocksSight !== false;              // default true, checked below
  const key = `${s.kind}/${s.blocksSight === false ? 'false' : (s.blocksSight === true ? 'true' : 'unset')}`;
  blocks[key] = (blocks[key] || 0) + 1;
}
say('  blocksSight flags in the arena:');
for (const k of Object.keys(blocks).sort()) say(`     ${k.padEnd(28)} ${blocks[k]}`);
const explicit = level.solids.filter((s) => s.blocksSight !== undefined).length;
say(`   solids with the flag STATED: ${explicit} / ${level.solids.length}`
  + `   -> anything unstated blocks, because the test is \`!s.blocksSight\``);
say('');
const hosts = new Set(topAnchors(level, {}).map((a) => a.host));
const hostFlags = level.solids.filter((s) => hosts.has(s.id))
  .map((s) => `${s.model}=${s.blocksSight === false ? 'no-block' : 'BLOCKS'}`);
const uniqHostFlags = [...new Set(hostFlags)].sort();
say(`  the hosts that carry top anchors (${hosts.size} solids):`);
say(`     ${uniqHostFlags.join('  ')}`);
say('');

/* ------------------------------------------------------ the before / after */

function coverOf(anchor, vps, sloped) {
  let seen = 0;
  let total = 0;
  let by = null;
  for (const v of vps) {
    const d = Math.hypot(v.x - anchor.x, v.z - anchor.z);
    if (d > 6.0) continue;
    total += 1;
    const ve = v.eye != null ? v.eye : eyeY;
    const los = sloped
      ? sightLine(level, v, { x: anchor.x, z: anchor.z }, ve, anchor.y)
      : sightLine(level, v, { x: anchor.x, z: anchor.z }, ve);
    if (los.clear) { seen += 1; } else if (!by) { by = los.blockedBy; }
  }
  return { cover: total ? seen / total : 0, seen, total, blockedBy: by };
}

const tops = topAnchors(level, {});
const rows = [];
for (const a of tops) {
  const flat = coverOf(a, all, false);
  const sloped = coverOf(a, all, true);
  const slopedFloor = coverOf(a, floorVp, true);
  const slopedClimb = coverOf(a, climbVp, true);
  rows.push({ a, flat, sloped, slopedFloor, slopedClimb });
}

const flatAlive = rows.filter((r) => r.flat.cover > 0).length;
const slopedAlive = rows.filter((r) => r.sloped.cover > 0).length;
say(`  ${rows.length} top anchors:`);
say(`     with the FLAT test  (the pre-p50 rule): ${flatAlive} visible from somewhere, `
  + `${rows.length - flatAlive} hidden`);
say(`     with the SLOPED test (the p50 rule):    ${slopedAlive} visible from somewhere, `
  + `${rows.length - slopedAlive} hidden`);
say('');
say('  -- the ones the sloped test kills, and what stopped the line -------------');
const killed = rows.filter((r) => r.flat.cover > 0 && r.sloped.cover === 0);
say(`  ${killed.length} anchors lost this way (visible flat, hidden sloped):`);
const byBlocker = {};
for (const r of killed) {
  const key = r.sloped.blockedBy || '?';
  byBlocker[key] = (byBlocker[key] || 0) + 1;
}
const nameOf = (id) => {
  const s = level.solids.find((x) => x.id === id);
  return s ? `${s.model}(${s.id})` : id;
};
for (const [id, n] of Object.entries(byBlocker).sort((p, q) => q[1] - p[1]).slice(0, 8)) {
  say(`     blocked by ${nameOf(id).padEnd(38)} ${n} anchors`);
}
say('');
say('  -- and the self-blocking, isolated -------------------------------------');
const selfBlocked = killed.filter((r) => r.a.host === r.sloped.blockedBy);
say(`     of those, ${selfBlocked.length} are stopped by THEIR OWN HOST`
  + ` (the packet is sitting on the thing that blocks the view of it)`);
say('');
const sample = (killed.length ? killed : rows).slice(0, 6);
say('  sample rows   room       y      flat      sloped   flatBy');
for (const r of sample) {
  say(`     ${String(r.a.room).padEnd(10)} ${String(r.a.y.toFixed(3)).padStart(6)}`
    + `  ${r.flat.cover.toFixed(3).padStart(6)}  ${r.sloped.cover.toFixed(3).padStart(8)}`
    + `   ${r.flat.blockedBy ? nameOf(r.flat.blockedBy) : '-'}`);
}
say('');

const json = {
  eyeY,
  blocks,
  hostFlags: uniqHostFlags,
  totals: { top: rows.length, flatAlive, slopedAlive, killed: killed.length },
  killedBy: byBlocker,
  selfBlocked: selfBlocked.length,
  rows: rows.map((r) => ({
    model: r.a.model, room: r.a.room, y: +r.a.y.toFixed(3), host: r.a.host,
    flatCover: +r.flat.cover.toFixed(4), slopedCover: +r.sloped.cover.toFixed(4),
    slopedFloorCover: +r.slopedFloor.cover.toFixed(4),
    slopedClimbCover: +r.slopedClimb.cover.toFixed(4),
    flatBlockedBy: r.flat.blockedBy, slopedBlockedBy: r.sloped.blockedBy,
  })),
};
fs.writeFileSync(OUT, JSON.stringify(json, null, 2));
say(`wrote ${path.relative(ROOT, OUT)}`);
