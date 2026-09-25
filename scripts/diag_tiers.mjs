/**
 * diag_tiers.mjs — the tier thresholds were tuned in a building with no walls.
 *
 * `tierFromCover` splits the pool at cover 0.34 / 0.07, and the design target is
 * 20/35/30/15. After patch_p52 made walls block sight, the achievable cover of
 * everything fell (a cross-room viewpoint no longer counts), and the pool now
 * offers only ~2 `open` anchors a seed against ~26 `concealed` -- so the target
 * mix is unreachable and the game is accidentally harder than designed.
 *
 * This measures the pool's cover distribution and prints the thresholds that
 * would reproduce the target mix, so the retune is a reading rather than taste.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNav } from '../game/core/nav.js';
import { climbPlan } from '../game/core/climb.js';
import { topAnchors, insideAnchors, measureExposure, defaultViewpoints, climbViewpoints } from '../game/core/place.js';
import { reachable } from '../game/core/vision.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const level = JSON.parse(fs.readFileSync(path.join(ROOT, 'game', 'arenas', 'room_scene.json'), 'utf8'));

const lines = [];
const say = (s) => { lines.push(s); process.stdout.write(s + '\n'); };

const nav = buildNav(level, {
  inflate: level.body.playerRadius, bodyHeight: level.body.playerHeight, step: level.meta.step,
});
const plan = climbPlan(level, nav);
const viewpoints = [...defaultViewpoints(level, nav), ...climbViewpoints(level, nav, plan)];

const scored = [];
let inside = 0;
for (const a of [...topAnchors(level, {}), ...insideAnchors(level, {}).anchors]) {
  const exp = measureExposure(level, nav, a, { viewpoints });
  if (exp.tier === 'hidden') continue;
  if (exp.tier === 'inside') { inside += 1; continue; }
  const reach = reachable(level, nav, a, { plan });
  if (!reach.ok) continue;
  scored.push({ cover: exp.cover, tier: exp.tier, room: a.room, model: a.model });
}

say('='.repeat(78));
say('diag_tiers  --  the cover distribution of the pool, and where to cut it');
say('='.repeat(78));
say(`  ${scored.length} scored non-glass anchors, plus ${inside} glass ones`);
say('');

const covers = scored.map((s) => s.cover).sort((a, b) => a - b);
const q = (p) => covers[Math.min(covers.length - 1, Math.max(0, Math.round(p * (covers.length - 1))))];
say('  quantiles of cover in the pool:');
const marks = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
say('     ' + marks.map((m) => `p${(m * 100).toFixed(0)}=${q(m).toFixed(3)}`).join('  '));
say('');

// The current cuts, and what they actually produce.
const cur = { open: 0, partial: 0, concealed: 0 };
for (const c of covers) {
  if (c >= 0.34) cur.open += 1;
  else if (c >= 0.07) cur.partial += 1;
  else cur.concealed += 1;
}
say('  with the SHIPPED cuts (0.34 / 0.07):');
for (const k of ['open', 'partial', 'concealed']) {
  say(`     ${k.padEnd(10)} ${String(cur[k]).padStart(4)}  ${(100 * cur[k] / covers.length).toFixed(1)}%`);
}
say('');

// The target, normalised over the non-glass tiers. The published target is a
// fraction of the WHOLE six (20/35/30/15); with 15% going to glass, the other
// three share the remaining 85%, i.e. 23.5/41.2/35.3 of the non-glass pool.
const T = { open: 0.20, partial: 0.35, concealed: 0.30, inside: 0.15 };
const rest = T.open + T.partial + T.concealed;
const want = {
  open: T.open / rest, partial: T.partial / rest, concealed: T.concealed / rest,
};
say('  the target, renormalised over the non-glass pool:');
say(`     open ${(want.open * 100).toFixed(1)}%   partial ${(want.partial * 100).toFixed(1)}%`
  + `   concealed ${(want.concealed * 100).toFixed(1)}%`);
say('');

// A `concealed` anchor has cover > 0 but is very hard to spot, `open` is easy.
// So the cuts are the (1 - want.open) and (want.concealed) quantiles.
const openCut = q(1 - want.open);
const concCut = q(want.concealed);
say('  the cuts that reproduce it on THIS pool:');
say(`     open      cover >= ${openCut.toFixed(3)}`);
say(`     partial   cover >= ${concCut.toFixed(3)}`);
say(`     concealed cover >  0`);
say('');

const check = { open: 0, partial: 0, concealed: 0 };
for (const c of covers) {
  if (c >= openCut) check.open += 1;
  else if (c >= concCut) check.partial += 1;
  else check.concealed += 1;
}
say('  which yields:');
for (const k of ['open', 'partial', 'concealed']) {
  say(`     ${k.padEnd(10)} ${String(check[k]).padStart(4)}  ${(100 * check[k] / covers.length).toFixed(1)}%`);
}
say('');
say('  Read this as a MEASUREMENT about this arena under the current sight model,');
say('  not as a licence to keep moving the cuts: the cuts say where the tiers are,');
say('  and the tiers are the difficulty dial. A different flat would want');
say('  different cuts, which is why they live next to `tierFromCover` and not in a');
say('  config file.');
say('');

fs.writeFileSync(path.join(ROOT, 'work', '_diag_tiers.json'), JSON.stringify({
  scored: scored.length, inside, covers,
  shipped: { cuts: [0.34, 0.07], counts: cur },
  proposed: { openCut, concCut, counts: check },
}, null, 2));
say('wrote work/_diag_tiers.json');
