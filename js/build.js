/**
 * build.js — turn the layout data into a scene graph.
 *
 * Strategy: the floor and every wall run are merged into a handful of meshes
 * (they are hundreds of identical tiles, and 80+44 separate meshes would be
 * pure waste). Furniture is merged per room per material, which keeps each
 * room a small, independently toggleable cluster of ~5-9 meshes while staying
 * under ~60 draw calls for the whole apartment.
 *
 * WHICH LAYOUT. `buildApartment(kit, { layout })` builds the layout it is
 * GIVEN. It used to read `js/layout.js` at module scope, which was correct for
 * the one hand-written apartment this file was written for and wrong for every
 * generated floor after it -- see `game/arena/fromLayout.js` on why the arena
 * now carries its own copy. With no argument it falls back to `js/layout.js`,
 * which is what `js/app.js` (the viewer) still wants, so the viewer is
 * unchanged and its measurements stay valid.
 */
import * as THREE from 'three';
import { Kit, mergePlaced } from './kit.js';
import * as SHIPPED from './layout.js';

const deg = THREE.MathUtils.degToRad;

/** Place one layout item as a transformable group. */
function place(kit, it) {
  const g = kit.instance(it.m);
  g.position.set(it.x, it.y || 0, it.z);
  g.rotation.y = deg(it.r || 0);
  if (it.s && it.s !== 1) g.scale.setScalar(it.s);
  return g;
}

/* --------------------------------------------------------------- structure */

function buildFloor(kit, L) {
  const objs = [];
  for (let i = 0; i < L.PLAN.w; i++) {
    for (let j = 0; j < L.PLAN.d; j++) {
      const g = kit.instance('floorFull');
      // Floor slab is 0.05 thick with its top face at local y=0.05; sink it so
      // the walking surface is exactly y = 0 and furniture needs no lift.
      g.position.set(i + 0.5, -0.05, j + 0.5);
      objs.push(g);
    }
  }
  return { group: mergePlaced(objs, { name: 'floor', castShadow: false }), count: objs.length };
}

/**
 * Lay one wall run. Wall thickness is 0.05 and is placed OUTSIDE the room, so
 * a run at `at` with side -1 has its body in [at-0.05, at] and the room's
 * usable edge stays at `at`. Positioning is centre-anchored (the loader's
 * convention), hence the ±0.025.
 */
function wallRun(kit, w) {
  const out = [];
  const len = w.to - w.from;
  const whole = Math.floor(len + 1e-9);

  const emit = (modelName, from, length) => {
    if (!modelName) return null;
    const g = kit.instance(modelName);
    const mid = from + length / 2;
    if (w.axis === 'x') {
      g.position.set(mid, 0, w.at + w.side * 0.025);
      g.rotation.y = w.side < 0 ? 0 : Math.PI;
    } else {
      g.position.set(w.at + w.side * 0.025, 0, mid);
      g.rotation.y = w.side < 0 ? Math.PI / 2 : -Math.PI / 2;
    }
    out.push(g);
    return g;
  };

  for (let k = 0; k < whole; k++) {
    const i = w.from + k;
    const kind = w.kinds && Object.prototype.hasOwnProperty.call(w.kinds, i) ? w.kinds[i] : undefined;
    if (kind === null) continue;              // deliberate opening
    emit(kind || 'wall', i, 1);
  }
  if (len - whole > 0.01) emit('wallHalf', w.from + whole, len - whole);

  return out;
}

function buildWalls(kit, L) {
  const objs = [];
  const perRun = {};
  for (const w of L.WALLS) {
    const list = wallRun(kit, w);
    perRun[w.id] = list.length;
    objs.push(...list);
  }
  return {
    group: mergePlaced(objs, { name: 'walls' }),
    count: objs.length,
    perRun,
  };
}

/**
 * Corner brackets. CORNERS is empty by design (see layout.js); the zero case is
 * handled explicitly so `structure` always receives a real group to toggle and
 * nothing downstream has to special-case an empty merge.
 */
function buildCorners(kit, L) {
  const objs = L.CORNERS.map((c) => {
    const g = kit.instance(c.m);
    g.position.set(c.x, 0, c.z);
    g.rotation.y = deg(c.r);
    return g;
  });
  if (!objs.length) {
    const empty = new THREE.Group();
    empty.name = 'corners';
    return { group: empty, count: 0 };
  }
  return { group: mergePlaced(objs, { name: 'corners' }), count: objs.length };
}

function buildDoors(kit, L) {
  const objs = L.DOORS.map((d) => {
    const g = kit.instance(d.m);
    g.position.set(d.x, 0, d.z);
    g.rotation.y = deg(d.r);
    return g;
  });
  return { group: mergePlaced(objs, { name: 'doors' }), count: objs.length };
}

/* --------------------------------------------------------------- furniture */

function buildRoom(kit, room) {
  const objs = [];
  const items = [];
  for (const it of room.items) {
    if (it.skip) continue;
    const g = place(kit, it);
    objs.push(g);
    items.push(it);
  }
  const merged = mergePlaced(objs, { name: 'room:' + room.id });
  merged.userData.zone = room.id;
  return { group: merged, count: objs.length, items };
}

/* ------------------------------------------------------------------- entry */

export async function buildApartment(kit, { onProgress, layout } = {}) {
  const L = layout || SHIPPED;
  const t0 = performance.now();
  const root = new THREE.Group();
  root.name = 'apartment';

  // --- structure ---------------------------------------------------------
  const floor = buildFloor(kit, L);
  const walls = buildWalls(kit, L);
  const corners = buildCorners(kit, L);
  const doors = buildDoors(kit, L);

  const structure = new THREE.Group();
  structure.name = 'structure';
  structure.add(floor.group, walls.group, corners.group, doors.group);
  root.add(structure);

  // --- furniture ---------------------------------------------------------
  const furniture = new THREE.Group();
  furniture.name = 'furniture';
  const rooms = [];
  let furnitureCount = 0;
  for (let i = 0; i < L.ROOMS.length; i++) {
    const r = buildRoom(kit, L.ROOMS[i]);
    furniture.add(r.group);
    rooms.push({ id: L.ROOMS[i].id, name: L.ROOMS[i].name, group: r.group, items: r.items });
    furnitureCount += r.count;
    if (onProgress) onProgress((i + 1) / L.ROOMS.length, L.ROOMS[i].name);
  }
  root.add(furniture);

  // --- statistics --------------------------------------------------------
  let meshes = 0;
  let tris = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    meshes += 1;
    const g = o.geometry;
    tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
  });

  const stats = {
    floorTiles: floor.count,
    wallSegments: walls.count,
    wallPerRun: walls.perRun,
    corners: corners.count,
    doors: doors.count,
    furniture: furnitureCount,
    meshes,
    tris: Math.round(tris),
    buildMs: Math.round(performance.now() - t0),
  };

  return { root, structure, furniture, rooms, stats, floor };
}

export { place };
