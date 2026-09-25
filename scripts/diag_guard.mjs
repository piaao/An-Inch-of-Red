/**
 * diag_guard.mjs — does the guard stay inside the building?
 *
 * `Guard.step()` moves in a STRAIGHT LINE toward its current target. In chase
 * mode that target is an A* path node, so the line is legal. In patrol mode it
 * is a waypoint from `buildPatrol`'s stitched, RDP-thinned path -- and a chord
 * between two thinned points is only *usually* inside the corridor. Near a
 * 0.44 m doorway a chord can cut the jamb.
 *
 * Nothing in the guard checks `nav.clear`, so a guard that cuts a corner is a
 * guard standing inside a wall -- or outside the building, from which it can
 * never come back, because every subsequent move is another straight line.
 *
 * This measures it instead of arguing about it: how much of a 600 s shift is
 * spent outside the plan, inside a solid, and how long the worst excursion is.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rng } from '../game/core/rng.js';
import { buildNav } from '../game/core/nav.js';
import { buildPatrol, Guard, GUARD_MODES } from '../game/core/guard.js';
import { roomOfPoint } from '../game/core/level.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const level = JSON.parse(fs.readFileSync(
  path.join(HERE, '..', 'game', 'arenas', 'room_scene.json'), 'utf8'));

const nav = buildNav(level, {
  inflate: level.body.guardRadius, bodyHeight: level.body.guardHeight, step: level.meta.step,
});

const SEEDS = ['guard-2026-09-25', 'guard-000', 'guard-001', 'guard-002'];
const SECONDS = 600;
const DT = 0.05;
const L = level.meta.plan;

const out = [];
const say = (s) => { out.push(s); console.log(s); };

say(`guard nav ${nav.walkableCount} cells, guardRadius ${level.body.guardRadius}, `
  + `plan ${L.w} x ${L.d}`);
say('');

let anyLeak = false;
for (const seed of SEEDS) {
  const patrol = buildPatrol(level, nav, new Rng(seed), {});
  const g = new Guard(level, nav, GUARD_MODES.patrol, patrol);
  const dummy = { x: -999, z: -999 };

  let outside = 0, inSolid = 0, steps = 0;
  let run = 0, worstRun = 0, worstAt = null;
  let escapes = 0, wasInside = true;
  const rooms = new Map(level.rooms.map((r) => [r.id, 0]));
  let lastRoom = null;

  for (let t = 0; t < SECONDS; t += DT) {
    g.update(DT, dummy);
    steps += 1;
    const p = g.pos;
    const inPlan = p.x >= 0 && p.x <= L.w && p.z >= 0 && p.z <= L.d;
    if (!inPlan) {
      outside += 1;
      run += 1;
      if (run > worstRun) { worstRun = run; worstAt = { t: Math.round(t), x: +p.x.toFixed(2), z: +p.z.toFixed(2) }; }
      if (wasInside) escapes += 1;
    } else {
      run = 0;
    }
    wasInside = inPlan;
    if (inPlan && !nav.clear(p.x, p.z, level.body.guardRadius)) inSolid += 1;

    const rid = inPlan ? roomOfPoint(level, p.x, p.z) : null;
    if (rid && rid !== lastRoom) { rooms.set(rid, rooms.get(rid) + 1); lastRoom = rid; }
  }

  const leaked = outside > 0 || inSolid > 0;
  anyLeak = anyLeak || leaked;
  say(`seed ${seed}`);
  say(`   distance          ${(g.stats.distance).toFixed(1)} m`);
  say(`   outside the plan  ${(outside / steps * 100).toFixed(2)} % of ${SECONDS} s`
    + `   (${escapes} separate escapes, worst stretch ${(worstRun * DT).toFixed(1)} s`
    + `${worstAt ? ` at t=${worstAt.t} (${worstAt.x}, ${worstAt.z})` : ''})`);
  say(`   inside a solid    ${(inSolid / steps * 100).toFixed(2)} %`);
  say(`   room entries      ${[...rooms.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`);
  say(`   => ${leaked ? 'LEAKS' : 'stays legal'}`);
  say('');
}

say(anyLeak
  ? 'VERDICT: the guard can leave the building. Movement has no collision test.'
  : 'VERDICT: the guard never leaves the building and never stands in a solid.');

fs.writeFileSync(path.join(HERE, '..', 'work', '_guard.log'), out.join('\n') + '\n');
