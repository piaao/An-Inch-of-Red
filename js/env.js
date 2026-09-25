/**
 * env.js — renderer, image-based environment, and lighting.
 *
 * The kit is flat-coloured low-poly, so almost all of the "materiality" comes
 * from the environment and one strong key light. Two decisions worth noting:
 *
 *  - The environment is a hand-built equirect gradient (warm sky, muted ground,
 *    three soft window blobs) fed through PMREMGenerator. It costs nothing,
 *    needs no external HDR, and gives the metal and glass something to reflect.
 *  - The apartment has no ceiling — it is a cutaway — so a steep key light rakes
 *    across the rooms and throws the long interior shadows that sell the depth.
 */
import * as THREE from 'three';

export const BG = 0x2b3441;          // deep slate, the kit's own presentation tone
export const GROUND = 0x232a36;

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  return renderer;
}

/** A tiny equirect canvas -> PMREM. No external assets, deterministic. */
function gradientEnvironment(renderer) {
  const W = 256;
  const H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');

  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0.00, '#dce8f6');
  sky.addColorStop(0.42, '#f0ece2');
  sky.addColorStop(0.52, '#b9ae9c');
  sky.addColorStop(1.00, '#5f574c');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);

  // Soft window highlights — these are what you actually see in the specular.
  const blobs = [
    [0.18, 0.34, 0.30, 'rgba(255,246,226,0.95)'],
    [0.52, 0.28, 0.22, 'rgba(255,238,205,0.75)'],
    [0.82, 0.40, 0.26, 'rgba(226,238,255,0.70)'],
  ];
  for (const [fx, fy, fr, col] of blobs) {
    const r = fr * H;
    const rg = g.createRadialGradient(fx * W, fy * H, 0, fx * W, fy * H, r);
    rg.addColorStop(0, col);
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, W, H);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const rt = pmrem.fromEquirectangular(tex);
  pmrem.dispose();
  tex.dispose();
  return rt.texture;
}

export function createEnvironment(renderer, scene) {
  const env = gradientEnvironment(renderer);
  scene.environment = env;
  scene.background = new THREE.Color(BG);
  scene.backgroundIntensity = 1.0;
  return env;
}

export function createLights(scene, { w = 10, d = 8 } = {}) {
  const group = new THREE.Group();
  group.name = 'lights';

  // Sky/ground wash — keeps the shadowed sides from going to mud.
  const hemi = new THREE.HemisphereLight(0xdfe9f5, 0x8a7f6d, 0.55);
  hemi.position.set(0, 12, 0);
  group.add(hemi);

  // Key light. Steep and offset so walls cast long raking shadows inside.
  const key = new THREE.DirectionalLight(0xfff1d8, 1.50);
  key.position.set(w * 0.72, 9.5, d * 0.95);
  key.target.position.set(w * 0.48, 0, d * 0.46);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const span = Math.max(w, d) * 0.82;
  const cam = key.shadow.camera;
  cam.left = -span;
  cam.right = span;
  cam.top = span;
  cam.bottom = -span;
  cam.near = 1.0;
  cam.far = 34;
  cam.updateProjectionMatrix();
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.022;
  key.shadow.radius = 2.2;
  group.add(key);
  group.add(key.target);

  // Cool fill from the opposite side so the shadow side reads as blue, not black.
  const fill = new THREE.DirectionalLight(0xbcd2ee, 0.35);
  fill.position.set(-w * 0.5, 5.0, -d * 0.45);
  fill.target.position.set(w * 0.5, 0.4, d * 0.5);
  group.add(fill);
  group.add(fill.target);

  // A whisper of warm bounce from the floor.
  const bounce = new THREE.DirectionalLight(0xffd9a8, 0.14);
  bounce.position.set(w * 0.3, -3.0, d * 0.3);
  bounce.target.position.set(w * 0.3, 1.2, d * 0.3);
  group.add(bounce);
  group.add(bounce.target);

  scene.add(group);
  return { group, key, hemi, fill, bounce };
}

/** A wide matte site plane under the slab — it is what the wall shadows land on. */
export function createGround(scene, size = 46) {
  const geo = new THREE.PlaneGeometry(size, size);
  const mat = new THREE.MeshStandardMaterial({
    color: GROUND,
    roughness: 0.95,
    metalness: 0.0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.062;
  mesh.receiveShadow = true;
  mesh.name = 'site';
  scene.add(mesh);
  return mesh;
}
