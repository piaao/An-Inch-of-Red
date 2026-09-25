/** What the ladder actually looks like: every standable surface, its height, and
 *  whether the graph reaches it from the FLOOR or from another rung. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCore } from '../game/play/boot.js';
import { climbPlan } from '../game/core/climb.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const level = JSON.parse(fs.readFileSync(path.join(ROOT, 'game', 'arenas', 'room_scene.json'), 'utf8'));
const core = buildCore(level, { seed: process.argv[2] || '2026-09-25', count: 6 });
const plan = climbPlan(level, core.nav);
const step = level.meta.step;

const rows = [];
for (const s of plan.surfaces) {
  const acc = plan.reached.get(s.id);
  rows.push({
    y: s.y, model: s.model, room: s.room,
    reached: !!acc,
    fromFloor: !!(acc && !acc.via),
    via: acc ? acc.via : null,
  });
}
rows.sort((a, b) => (a.y - b.y) || String(a.model).localeCompare(String(b.model)));

const byModel = new Map();
for (const r of rows) {
  if (!byModel.has(r.model)) byModel.set(r.model, { y: r.y, n: 0, floor: 0, chain: 0, none: 0 });
  const m = byModel.get(r.model);
  m.n += 1;
  if (!r.reached) m.none += 1;
  else if (r.fromFloor) m.floor += 1;
  else m.chain += 1;
}
const out = [];
out.push(`surfaces ${rows.length}   reached ${rows.filter((r) => r.reached).length}`);
out.push(`  from a FLOOR pad   ${rows.filter((r) => r.fromFloor).length}`);
out.push(`  from ANOTHER rung  ${rows.filter((r) => r.reached && !r.fromFloor).length}`);
out.push(`  not reached        ${rows.filter((r) => !r.reached).length}`);
out.push('');
out.push('model                      y      points  floor  chain  none');
for (const [model, v] of [...byModel.entries()].sort((a, b) => b[1].y - a[1].y)) {
  out.push(`${String(model).padEnd(26)} ${v.y.toFixed(3)}  ${String(v.n).padStart(6)}`
    + `  ${String(v.floor).padStart(5)}  ${String(v.chain).padStart(5)}  ${String(v.none).padStart(5)}`);
}
out.push('');
out.push('every chained (rung-from-a-rung) surface:');
for (const r of rows.filter((x) => x.reached && !x.fromFloor)) {
  out.push(`   ${r.model} @ ${r.y.toFixed(3)} m  via ${r.via}`);
}
console.log(out.join('\n'));
fs.writeFileSync(path.join(ROOT, 'work', '_ladder_plan.log'), out.join('\n') + '\n');
