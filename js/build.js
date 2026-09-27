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

/**
 * Which models are HERO PROPS: kept OUT of the per-room merge so the player can
 * interact with them.
 *
 * WHY THIS LIST EXISTS AT ALL. `mergePlaced` collapses a room's furniture into
 * a handful of meshes by material -- cheap, and it is why the whole flat is a
 * few dozen draw calls. The cost is that an individual cupboard stops being a
 * scene object: there is nothing left to rotate, slide or highlight. Opening a
 * drawer is therefore not "animate a mesh", it is "choose, at BUILD time, the
 * handful of props worth a draw call each". Everything not listed here keeps
 * merging exactly as before, so the flat's draw-call budget is untouched.
 *
 * WHAT BELONGS HERE: things a person actually opens in a home -- doors with a
 * leaf (`doorway`, `doorwayFront`), cabinets, bookcases, dressers, drawers,
 * fridges, and the two containers that read as "search me" (`cardboardBox*`).
 * WHAT DOES NOT: tables, sofas, rugs, plants -- they are scenery, and a hero
 * slot spent on a sofa is a draw call that buys nothing.
 *
 * THE MODEL NAMES ARE DATA, read from `room.items[].m`; adding one here is the
 * only change needed to make a new prop interactive -- `buildApartment` splits
 * them automatically and `play.js` finds them by `userData.prop`.
 */
export const HERO_MODELS = new Set([
  'doorway', 'doorwayFront',
  'cabinetTelevision', 'cabinetTelevisionDoors',
  'cabinetBed', 'cabinetBedDrawer', 'cabinetBedDrawerTable',
  'bookcaseClosed', 'bookcaseClosedDoors', 'bookcaseClosedWide',
  'bookcaseOpen', 'bookcaseOpenLow',
  'bathroomCabinet', 'bathroomCabinetDrawer',
  'kitchenCabinet', 'kitchenCabinetDrawer', 'kitchenCabinetUpper',
  'kitchenCabinetUpperDouble', 'kitchenCabinetUpperCorner',
  'cardboardBoxClosed', 'cardboardBoxOpen',
  'fridge', 'fridgeBuiltin', 'hoodLarge', 'hoodModern',
  'washer', 'dryer',
  // The four in the shipped flat that a player will actually walk up to.
  'sideTableDrawers', 'sideTable', 'trashcan', 'coatRackStanding',
]);

/**
 * Build one room's furniture.
 *
 * Two passes: hero props become their own group (so a caller can move them),
 * everything else merges as before. A hero group is placed EXACTLY like a
 * merged piece -- `place()` is shared -- so whether a model is hero or merged
 * is invisible to the render until someone touches it.
 */
function buildRoom(kit, room) {
  const objs = [];
  const items = [];
  const heroes = [];
  for (const it of room.items) {
    if (it.skip) continue;
    const g = place(kit, it);
    items.push(it);
    if (HERO_MODELS.has(it.m)) {
      // A copy for the hero slot; the ORIGINAL instance is not reused because
      // `mergePlaced` bakes geometry in world space and would consume it.
      g.userData.prop = {
        model: it.m,
        room: room.id,
        kind: propKindOf(it.m),
        x: it.x, y: it.y || 0, z: it.z, r: it.r || 0, s: it.s || 1,
        open: 0,                 // 0 shut .. 1 open; driven by the play layer
        baseYaw: deg(it.r || 0),
      };
      heroes.push(g);
    } else {
      objs.push(g);
    }
  }
  const merged = mergePlaced(objs, { name: 'room:' + room.id });
  merged.userData.zone = room.id;
  const heroGroup = new THREE.Group();
  heroGroup.name = 'props:' + room.id;
  heroGroup.userData.zone = room.id;
  for (const h of heroes) heroGroup.add(h);
  return { group: merged, heroGroup, count: objs.length, items, heroes: heroes.length };
}

/**
 * What KIND of motion a prop does when opened. Derived from the model name so
 * the same list drives both the build and the animation -- a drawer slides, a
 * door swings, a box lifts its lid.
 *
 * This is deliberately a LOOKUP, not a per-instance flag: `room.items` is
 * layout data and has no room for an animation hint, and adding one would mean
 * touching every generated floor. The name is already there and already
 * specific (`cabinetBedDrawer` vs `cabinetBed`), so it is used.
 */
function propKindOf(model) {
  const m = model.toLowerCase();
  if (m.startsWith('doorway')) return 'swing';
  if (m.includes('drawer')) return 'slide';
  if (m.includes('box')) return 'lid';
  if (m.includes('hood')) return 'none';
  return 'swing';
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
  // Hero props live in their own group so the play layer can walk them without
  // touching the merged scenery -- and so hiding/showing props is one toggle.
  const props = new THREE.Group();
  props.name = 'props';
  const rooms = [];
  const heroes = [];
  let furnitureCount = 0;
  for (let i = 0; i < L.ROOMS.length; i++) {
    const r = buildRoom(kit, L.ROOMS[i]);
    furniture.add(r.group);
    props.add(r.heroGroup);
    for (const h of r.heroGroup.children) heroes.push(h);
    rooms.push({
      id: L.ROOMS[i].id, name: L.ROOMS[i].name,
      group: r.group, items: r.items, heroes: r.heroes,
    });
    furnitureCount += r.count;
    if (onProgress) onProgress((i + 1) / L.ROOMS.length, L.ROOMS[i].name);
  }
  root.add(furniture, props);

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
    heroProps: heroes.length,
    meshes,
    tris: Math.round(tris),
    buildMs: Math.round(performance.now() - t0),
  };

  return { root, structure, furniture, props, heroes, rooms, stats, floor };
}

export { place };
