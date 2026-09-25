/**
 * diag_census.mjs — is the RED CENSUS broken in the core, or only in play.js?
 *
 * Everything redCensus needs is pure, so the whole mechanic can be asked in
 * Node. Two questions:
 *   A. From the exact spot verify_play's section 4 uses, what does the census
 *      return?
 *   B. Swept over the whole walkable floor, what is the BEST census any spot
 *      can produce? A max of 0 means the core is broken; a healthy max means
 *      the play layer is feeding it something wrong.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCore } from '../game/play/boot.js';
import { redCensus } from '../game/core/vision.js';
import { WALKER } from '../game/core/sim.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARENA = path.join(ROOT, 'game', 'arenas', 'room_scene.json');
const SEED = process.argv[2] || '2026-09-25';

const level = JSON.parse(fs.readFileSync(ARENA, 'utf8'));
const core = buildCore(level, { seed: SEED, count: 6 });
const { nav, prizes } = core;

const eyeH = level.body.eyeHeight;
const range = WALKER.sightRange;
const prizeArea = level.collectible.size[0] * level.collectible.size[2];
const out = [];
const say = (s = '') => { out.push(s); console.log(s); };

say(`level.body.eyeHeight ${eyeH}   WALKER.sightRange ${range}   prizeArea ${prizeArea.toFixed(4)}`);
say(`reds declared on solids: ${level.solids.filter((s) => s.red).length}`);
say(`solids total ${level.solids.length}, blocksSight true: ${level.solids.filter((s) => s.blocksSight).length}`);
say('');

const pool = () => prizes.map((p) => ({ id: p.id, x: p.x, z: p.z, y: p.y }));

/* ---- A. the seat verify_play's section 4 takes ----------------------- */
say('-- A. from verify_play section 4\'s viewpoint -------------------------');
const p0 = prizes[0];
const ang = Math.atan2(1, 1);
const wantX = p0.x + Math.cos(ang) * 1.6;
const wantZ = p0.z + Math.sin(ang) * 1.6;
const seat = nav.clear(wantX, wantZ, level.body.playerRadius)
  ? { x: wantX, z: wantZ }
  : nav.nearestWalkable(wantX, wantZ, 1.5);
say(`prize[0] ${p0.id} @ (${p0.x.toFixed(2)}, ${p0.z.toFixed(2)}) y ${p0.y.toFixed(2)} tier ${p0.tier}`);
say(`want    (${wantX.toFixed(2)}, ${wantZ.toFixed(2)}) -> seat (${seat ? seat.x.toFixed(2) + ', ' + seat.z.toFixed(2) : 'NONE'})`);

const a = redCensus(level, seat, { eyeY: eyeH, range, prizes: pool(), prizeArea });
say(`reds ${a.reds.length}  prizes ${a.prizes.length}  eyeY ${a.eyeY}`);
for (const r of a.reds.slice(0, 6)) {
  say(`   red ${r.id} room ${r.room} d ${r.dist.toFixed(2)} area ${r.area.toFixed(3)} sal ${r.salience.toFixed(4)}`);
}
for (const r of a.prizes) say(`   PRZ ${r.id} d ${r.dist.toFixed(2)} sal ${r.salience.toFixed(4)}`);

/* ---- A2. eyeY = NaN -> what does the census do? ---------------------- */
const n = redCensus(level, seat, { eyeY: NaN, range, prizes: pool(), prizeArea });
say(`[sanity] eyeY NaN -> reds ${n.reds.length} prizes ${n.prizes.length}  (NaN must NOT read as "all visible")`);

/* ---- B. sweep every walkable cell ----------------------------------- */
say('');
say('-- B. swept over the walkable floor ----------------------------------');
let bestR = { n: -1, x: 0, z: 0 }, bestP = { n: -1, x: 0, z: 0 };
let cells = 0, anyRed = 0, anyPrize = 0;
const step = 4;                       // every 4th cell = 20 cm
for (let gz = 0; gz < nav.d; gz += step) {
  for (let gx = 0; gx < nav.w; gx += step) {
    const k = nav.index(gx, gz);
    if (k < 0 || !nav.walkable[k]) continue;
    const cell = nav.centreOf(gx, gz);
    if (!nav.clear(cell.x, cell.z, level.body.playerRadius)) continue;
    cells += 1;
    const c = redCensus(level, cell, { eyeY: eyeH, range, prizes: pool(), prizeArea });
    if (c.reds.length) anyRed += 1;
    if (c.prizes.length) anyPrize += 1;
    if (c.reds.length > bestR.n) bestR = { n: c.reds.length, x: cell.x, z: cell.z };
    if (c.prizes.length > bestP.n) bestP = { n: c.prizes.length, x: cell.x, z: cell.z };
  }
}
say(`cells sampled ${cells}`);
say(`cells with >=1 red   ${anyRed}  (${(100 * anyRed / cells).toFixed(1)} %)`);
say(`cells with >=1 prize ${anyPrize}  (${(100 * anyPrize / cells).toFixed(1)} %)`);
say(`best reds  ${bestR.n} at (${bestR.x.toFixed(2)}, ${bestR.z.toFixed(2)})`);
say(`best prize ${bestP.n} at (${bestP.x.toFixed(2)}, ${bestP.z.toFixed(2)})`);

const verdict = bestR.n > 0 && bestP.n > 0
  ? 'CORE OK — the census works; the play layer is feeding it wrong'
  : 'CORE BROKEN — the census returns nothing anywhere';
say('');
say(`VERDICT: ${verdict}`);

fs.writeFileSync(path.join(ROOT, 'work', '_diag_census.log'), out.join('\n') + '\n');
fs.writeFileSync(path.join(ROOT, 'work', '_diag_census.json'),
  JSON.stringify({ a: { reds: a.reds.length, prizes: a.prizes.length }, bestR, bestP, cells, anyRed, anyPrize }, null, 2));
