/**
 * diag_edges.mjs — ask the nav WHY an edge is blocked.
 *
 * The snapshot tells you a cell belongs to no room. It cannot tell you which
 * solid did it. This walks the same arithmetic the nav does, for one cell, and
 * prints every solid that kills a neighbour edge, at the exact sample point
 * where it fails.
 *
 * Run: node scripts/diag_edges.mjs 5.5 3.5 [5.5 2.5 ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNav } from '../game/core/nav.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const level = JSON.parse(fs.readFileSync(path.join(ROOT, 'game', 'arenas', 'room_scene.json'), 'utf8'));

const cell = level.meta.cell;
const nav = buildNav(level, {
  inflate: level.body.playerRadius,
  bodyHeight: level.body.playerHeight,
  step: level.meta.step,
  sealOpenings: true,
});
const plain = buildNav(level, {
  inflate: level.body.playerRadius,
  bodyHeight: level.body.playerHeight,
  step: level.meta.step,
});

/** Every solid that would stop a disc of `r` at (x, z), in nav's own terms. */
function whoBlocks(x, z, r) {
  const out = [];
  for (const s of level.solids.concat(level.openings.map((o) => ({ ...o, blocksMove: true })))) {
    if (s.blocksMove === false) continue;
    if (s.y1 <= level.meta.step) continue;
    if (s.y0 >= level.body.playerHeight) continue;
    const a = -(s.rot * Math.PI) / 180;
    const dx = x - s.x;
    const dz = z - s.z;
    const lx = dx * Math.cos(a) - dz * Math.sin(a);
    const lz = dx * Math.sin(a) + dz * Math.cos(a);
    const qx = Math.max(Math.abs(lx) - s.hx, 0);
    const qz = Math.max(Math.abs(lz) - s.hz, 0);
    if (qx * qx + qz * qz <= r * r) out.push({ id: s.id, kind: s.kind, model: s.model, dist: Math.sqrt(qx * qx + qz * qz).toFixed(3) });
  }
  return out;
}

const args = process.argv.slice(2).map(Number);

/** No coordinates given: dump every region of both navs, cell by cell. */
if (!args.length) {
  for (const [label, n] of [['player (doors open)', plain], ['region (doors sealed)', nav]]) {
    console.log('='.repeat(70));
    console.log(`${label}: ${n.components.length} region(s), ${n.walkableCount} walkable cells`);
    const rooms = level.rooms;
    for (const c of n.components) {
      const ids = rooms.filter((r) => c.cells.some((cc) => cc.i === Math.floor(r.seed[0] / cell) && cc.j === Math.floor(r.seed[1] / cell)));
      const tag = ids.length ? 'seed: ' + ids.map((r) => r.id).join(',') : 'NO SEED';
      console.log(`   region ${String(c.id).padStart(2)}  cells=${String(c.cells.length).padStart(2)}  area=${c.area
        } m2  @(${c.cx.toFixed(1)}, ${c.cz.toFixed(1)})  ${tag}`);
      console.log('      ' + c.cells.map((cc) => `${cc.i},${cc.j}`).join(' '));
    }
  }
  process.exit(0);
}

for (let k = 0; k + 1 < args.length; k += 2) {
  const [x, z] = [args[k], args[k + 1]];
  console.log('='.repeat(70));
  console.log(`cell centre (${x}, ${z})   walkable(sealed)=${nav.clear(x, z)}  walkable(plain)=${plain.clear(x, z)}`);
  const hit = whoBlocks(x, z, level.body.playerRadius);
  if (hit.length) console.log('   INSIDE a blocker: ' + JSON.stringify(hit));
  for (const [dx, dz, name] of [[1, 0, 'E'], [-1, 0, 'W'], [0, 1, 'S'], [0, -1, 'N']]) {
    const nx = x + dx * cell;
    const nz = z + dz * cell;
    const wSealed = nav.clear(nx, nz);
    const wPlain = plain.clear(nx, nz);
    const edgeSealed = nav.los(x, z, nx, nz);
    const edgePlain = plain.los(x, z, nx, nz);
    let why = '';
    if (!edgeSealed) {
      const n = Math.max(2, Math.ceil(cell / 0.05));
      for (let s = 0; s <= n; s++) {
        const t = s / n;
        const px = x + (nx - x) * t;
        const pz = z + (nz - z) * t;
        const blockers = whoBlocks(px, pz, level.body.playerRadius);
        if (blockers.length) {
          why = ` blocked at (${px.toFixed(3)}, ${pz.toFixed(3)}) by ` + blockers.map((b) => `${b.model}/${b.kind}`).join(',');
          break;
        }
      }
      if (!why) why = ' no single-point blocker found (radius sampling)';
    }
    console.log(`   ${name} -> (${nx}, ${nz})  walkSealed=${wSealed ? 1 : 0} walkPlain=${wPlain ? 1 : 0}`
      + `  edgeSealed=${edgeSealed ? 1 : 0} edgePlain=${edgePlain ? 1 : 0}${why}`);
  }
}
