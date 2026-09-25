/**
 * app.js — bootstrap: renderer, camera, orbit controls, camera presets, loop.
 *
 * Everything the verification harness needs is exposed on `window` on purpose:
 * __ready, __stats, __scene, __camera, __controls, __zoneBoxes, __setView().
 * That turns "it looks wrong" into a countable fact.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createRenderer, createEnvironment, createLights, createGround, BG } from './env.js';
import { Kit } from './kit.js';
import { requiredModels, PLAN, WALL_H } from './layout.js';
import { buildApartment } from './build.js';
import * as UI from './ui.js';

const CENTRE = new THREE.Vector3(PLAN.w / 2, 0, PLAN.d / 2);

/**
 * Dollhouse hero angle: high enough to read the plan, low enough to feel 3D.
 *
 * The eye is 13.4 m out at a 32 degrees depression, which frames the 10x8 m
 * slab across roughly 78% of a 16:10 viewport. The first version sat 18.7 m
 * out on the identical bearing and left the apartment filling barely half the
 * frame; scaling the offset only, never the angle, is what fixes that.
 */
const OVERVIEW = { position: new THREE.Vector3(12.95, 7.61, 11.60), target: new THREE.Vector3(4.6, 0.45, 3.9) };
const TOP = { position: new THREE.Vector3(5.0, 17.5, 4.25), target: new THREE.Vector3(5.0, 0, 4.0) };

const state = {
  mode: 'orbit',
  frames: 0,
  fps: 0,
  lastT: performance.now(),
  fpsAcc: 0,
  fpsN: 0,
  tween: null,
};

/* ------------------------------------------------------------------ tween */

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function flyTo(camera, controls, { position, target }, ms = 900) {
  state.tween = {
    t0: performance.now(),
    ms,
    fromPos: camera.position.clone(),
    toPos: position.clone(),
    fromTgt: controls.target.clone(),
    toTgt: target.clone(),
  };
}

function stepTween(camera, controls, now) {
  const tw = state.tween;
  if (!tw) return;
  const k = Math.min(1, (now - tw.t0) / tw.ms);
  const e = easeInOut(k);
  camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
  controls.target.lerpVectors(tw.fromTgt, tw.toTgt, e);
  controls.update();
  if (k >= 1) state.tween = null;
}

/* -------------------------------------------------------------------- app */

export async function boot() {
  const canvas = document.getElementById('stage');
  const renderer = createRenderer(canvas);

  const scene = new THREE.Scene();
  createEnvironment(renderer, scene);
  const lights = createLights(scene, { w: PLAN.w, d: PLAN.d });
  createGround(scene);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 200);
  camera.position.copy(OVERVIEW.position);
  camera.lookAt(OVERVIEW.target);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.rotateSpeed = 0.85;
  controls.zoomSpeed = 0.9;
  controls.panSpeed = 0.7;
  controls.screenSpacePanning = true;
  controls.minDistance = 1.2;
  controls.maxDistance = 34;
  controls.minPolarAngle = 0.04;
  controls.maxPolarAngle = Math.PI / 2 - 0.035;   // never dip under the floor
  controls.target.copy(OVERVIEW.target);
  controls.autoRotateSpeed = 0.75;
  controls.update();

  /* ---------------------------------------------------------------- build */

  const kit = new Kit({ base: 'assets/models' });
  const names = requiredModels();
  UI.setLoading(true, '正在装载家具模型…', 0);

  for (let i = 0; i < names.length; i++) {
    await kit.load(names[i]);
    UI.setProgress((i + 1) / names.length, names[i]);
  }

  UI.setProgress(0.99, '正在拼装房间…');
  const apartment = await buildApartment(kit);
  scene.add(apartment.root);

  /* ---------------------------------------------------------- zone bounds */

  const zoneBoxes = {};
  apartment.root.updateMatrixWorld(true);
  for (const r of apartment.rooms) {
    const box = new THREE.Box3().setFromObject(r.group);
    zoneBoxes[r.id] = {
      min: box.min.clone(), max: box.max.clone(),
      name: r.name, count: r.items.length,
    };
  }

  /* ------------------------------------------------------------ picking */

  let lastZone = null;
  const hover = UI.bindHover({
    camera, scene, apartment,
    onZone: (id, x, y) => {
      if (id !== lastZone) {
        lastZone = id;
        hover.setBox(id ? zoneBoxes[id] : null);
      }
      UI.showZoneTip(id, zoneBoxes[id], x, y);
    },
    onLeave: () => {
      lastZone = null;
      hover.setBox(null);
    },
    onPick: (id) => {
      const z = UI.ZONES.find((v) => v.id === id);
      if (z) flyTo(camera, controls, zoneView(z));
    },
  });

  UI.bindToolbar({
    views: [{ id: 'overview', name: '全景' }, { id: 'top', name: '俯视' },
            ...UI.ZONES.map((z) => ({ id: z.id, name: z.name }))],
    onView: (id) => {
      if (id === 'overview') flyTo(camera, controls, OVERVIEW);
      else if (id === 'top') flyTo(camera, controls, TOP);
      else {
        const z = UI.ZONES.find((v) => v.id === id);
        if (z) flyTo(camera, controls, zoneView(z));
      }
    },
    flags: [
      { id: 'rotate', label: '自动旋转', on: false, apply: (v) => { controls.autoRotate = v; } },
      { id: 'structure', label: '墙体', on: true, apply: (v) => { apartment.structure.visible = v; } },
      { id: 'furniture', label: '家具', on: true, apply: (v) => { apartment.furniture.visible = v; } },
      { id: 'labels', label: '房名标签', on: true, apply: (v) => UI.setLabelsVisible(v) },
      { id: 'shadow', label: '阴影', on: true, apply: (v) => { renderer.shadowMap.enabled = v; scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; }); } },
    ],
  });

  UI.setLabels(UI.ZONES);
  UI.setStats(apartment.stats, kit);
  UI.setLoading(false);

  /* --------------------------------------------------------------- resize */

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  /* ----------------------------------------------------------------- loop */

  function tick(now) {
    requestAnimationFrame(tick);
    stepTween(camera, controls, now);
    controls.update();

    const dt = now - state.lastT;
    state.lastT = now;
    state.fpsAcc += dt;
    state.fpsN += 1;
    if (state.fpsAcc >= 420) {
      state.fps = Math.round(1000 / (state.fpsAcc / state.fpsN));
      state.fpsAcc = 0;
      state.fpsN = 0;
      UI.setPerf(state.fps, renderer.info.render.calls, renderer.info.render.triangles);
    }

    UI.updateLabels(camera, renderer);
    renderer.render(scene, camera);
    state.frames += 1;
  }
  requestAnimationFrame(tick);

  /* -------------------------------------------------------------- exports */

  const api = {
    THREE, scene, camera, controls, renderer, kit, apartment, state,
    zoneBoxes, OVERVIEW, TOP,
    zoneView,
    /** The zone table itself, so the harness can check the camera rig. */
    zones: UI.ZONES,
    /** Every model the layout asked for -- lets the harness prove all loaded. */
    models: names,
    lights,
    /** Live light tuning - lets the verifier sweep exposure in one session. */
    tune(opt = {}) {
      if (opt.exposure != null) renderer.toneMappingExposure = opt.exposure;
      if (opt.key != null) lights.key.intensity = opt.key;
      if (opt.hemi != null) lights.hemi.intensity = opt.hemi;
      if (opt.fill != null) lights.fill.intensity = opt.fill;
      if (opt.bounce != null) lights.bounce.intensity = opt.bounce;
      if (opt.env != null) kit.setEnvIntensity(opt.env);
      return { exposure: renderer.toneMappingExposure, key: lights.key.intensity,
               hemi: lights.hemi.intensity, fill: lights.fill.intensity,
               bounce: lights.bounce.intensity, env: kit.envIntensity };
    },
    setView(id) {
      if (id === 'overview') flyTo(camera, controls, OVERVIEW, 1);
      else if (id === 'top') flyTo(camera, controls, TOP, 1);
      else { const z = UI.ZONES.find((v) => v.id === id); if (z) flyTo(camera, controls, zoneView(z), 1); }
    },
    jumpView(id) {
      const v = id === 'overview' ? OVERVIEW : id === 'top' ? TOP : zoneView(UI.ZONES.find((z) => z.id === id));
      if (!v) return false;
      state.tween = null;
      camera.position.copy(v.position);
      controls.target.copy(v.target);
      controls.update();
      return true;
    },
    /** Top-down plan view framed to the whole slab — used for layout checks. */
    planView() {
      const a = PLAN.w / 2, b = PLAN.d / 2;
      state.tween = null;
      camera.position.set(a, 17.5, b + 0.001);
      controls.target.set(a, 0, b);
      controls.update();
      return true;
    },
  };
  window.__app = api;
  window.__ready = true;
  return api;
}

/**
 * Camera rig for a room.
 *
 * A zone with an `eye` is placed exactly there and aimed at `focus`: the shot
 * is composed, not computed. `face` records the intended plan direction so
 * shoot.js can assert the rig still points where it was composed to point --
 * which is the check that would have caught the living-room camera staring at
 * the back of the sofa.
 *
 * A zone without an eye falls back to the old radial rig, so adding a room
 * without hand-placing a camera still yields a sane view rather than nothing.
 */
function zoneView(z) {
  const target = new THREE.Vector3().fromArray(z.focus);
  if (z.eye) return { target, position: new THREE.Vector3().fromArray(z.eye) };

  const rx = z.focus[0], ry = z.focus[1], rz = z.focus[2];
  const dist = z.dist != null ? z.dist : 4.5;
  const phi = z.phi != null ? z.phi : 0.95;
  let dx = rx - CENTRE.x;
  let dz = rz - CENTRE.z;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  return {
    target,
    position: new THREE.Vector3(
      rx + dist * sinPhi * dx,
      ry + dist * cosPhi,
      rz + dist * sinPhi * dz,
    ),
  };
}

export { zoneView };
