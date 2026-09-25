/**
 * kit.js — load Kenney furniture GLBs and turn them into scene-ready pieces.
 *
 * Two facts drive everything here, both measured from the assets themselves:
 *
 *  1. Every model declares `KHR_materials_unlit`. GLTFLoader therefore hands
 *     back MeshBasicMaterial, which ignores lights entirely. Rendering that
 *     as-is gives a flat poster, not a lit room. So we rebuild every material
 *     as MeshStandardMaterial while keeping the original base colour.
 *
 *  2. The kit only uses 15 flat colours with semantic names (wood / metal /
 *     metalDark / carpet / lamp / glass …). That means the rebuilt materials
 *     collapse into one small shared palette, which is both prettier and far
 *     cheaper than one material per mesh.
 *
 *  3. Colour space is the one place where the spec and the asset disagree --
 *     and this kit sides with neither. glTF says `baseColorFactor` is LINEAR.
 *     Read the authored numbers that way and the sofa comes out #F9A29D, a
 *     bleached pink, and the whole apartment looks faded. Read the same numbers
 *     as sRGB and it is #F05E57, the vivid red in Kenney's own preview render.
 *     So they are sRGB-in-a-linear-field, and we re-encode on the way in. See
 *     material() below; getting this wrong is the difference between a poster
 *     and a room.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* ------------------------------------------------------------------ palette */

// glTF colours are authored linear; these are the kit's semantic slots.
const L = (r, g, b) => [r, g, b];

const WOOD = L(0.896, 0.602, 0.393);
const WOOD_DARK = L(0.678, 0.456, 0.299);
const WOOD_MID = L(0.647, 0.459, 0.298);
const METAL = L(0.741, 0.823, 0.84);
const METAL_LIGHT = L(0.937, 0.98, 0.957);
const METAL_MED = L(0.369, 0.467, 0.467);
const METAL_DARK = L(0.306, 0.388, 0.388);
const CARPET = L(0.943, 0.367, 0.343);
const CARPET_DARK = L(0.608, 0.298, 0.285);
const CARPET_BLUE = L(0.356, 0.517, 0.868);
const GREEN = L(0.182, 0.821, 0.576);
const WHITE = L(1, 1, 1);
const WHITE_2 = L(0.973, 1, 1);
const LAMP = L(1, 0.914, 0.588);
const GLASS = L(0.698, 0.827, 0.769);

const key = (c) => c.map((v) => v.toFixed(3)).join(',');

/** Per-colour surface response. Keys are the authored linear triples. */
const SURFACE = new Map([
  [key(WOOD), { roughness: 0.66, metalness: 0.0 }],
  [key(WOOD_DARK), { roughness: 0.7, metalness: 0.0 }],
  [key(WOOD_MID), { roughness: 0.68, metalness: 0.0 }],
  [key(METAL), { roughness: 0.42, metalness: 0.05 }],
  [key(METAL_LIGHT), { roughness: 0.34, metalness: 0.05 }],
  [key(METAL_MED), { roughness: 0.46, metalness: 0.18 }],
  [key(METAL_DARK), { roughness: 0.5, metalness: 0.16 }],
  [key(CARPET), { roughness: 0.88, metalness: 0.0 }],
  [key(CARPET_DARK), { roughness: 0.88, metalness: 0.0 }],
  [key(CARPET_BLUE), { roughness: 0.88, metalness: 0.0 }],
  [key(GREEN), { roughness: 0.78, metalness: 0.0 }],
  [key(WHITE), { roughness: 0.5, metalness: 0.0 }],
  [key(WHITE_2), { roughness: 0.48, metalness: 0.0 }],
  // Lampshades glow — this is what makes the table lamps read as "on".
  [key(LAMP), { roughness: 0.7, metalness: 0.0, emissive: 0xffd98a, emissiveIntensity: 0.5 }],
]);

const GLASS_KEY = key(GLASS);

/** Models whose dark face is a display; we let the screen glow faintly. */
const SCREENS = new Set(['televisionModern', 'televisionVintage', 'computerScreen', 'laptop']);
const SCREEN_GLOW = { emissive: 0x2c4f6b, emissiveIntensity: 0.75 };

/** Polished surfaces get a mirror-ish response instead of the default pane. */
const MIRRORS = new Set(['bathroomMirror']);

/**
 * Wall pieces are two-sided panels: the +Z face is painted `_defaultMat`
 * (white interior finish) and the outward face `metalDark`. Measured by
 * per-primitive normal/area census - `wall` is +Z 1.290 m2 white against
 * -Z 1.290 m2 metalDark. Authored that way the outside of the building
 * renders as a near-black double, so orbit around and the dollhouse reads
 * as a dark box. We re-tint only that outward slot, and only for wall
 * pieces, leaving every legitimate dark accent elsewhere untouched.
 */
const WALL_MODELS = new Set([
  'wall', 'wallHalf', 'wallDoorway', 'wallDoorwayWide',
  'wallWindow', 'wallWindowSlide', 'wallCorner', 'wallCornerRond',
]);
const EXTERIOR_TINT = [0.90, 0.885, 0.86];   // warm off-white, sRGB

/* -------------------------------------------------------------------- kit */

class Kit {
  constructor({ base = 'assets/models' } = {}) {
    this.base = base.replace(/\/+$/, '');
    this.loader = new GLTFLoader();
    this.entries = new Map();
    this.materials = new Map();
    this.envIntensity = 0.80;
    this.stats = { filesLoaded: 0, meshes: 0, tris: 0 };
  }

  /**
   * Build (or reuse) one shared material for an authored colour.
   *
   * COLOUR SPACE — measured, not assumed. The kit writes its palette into
   * glTF `baseColorFactor`, which the spec says is LINEAR. Read that way the
   * sofa colour (0.943, 0.367, 0.343) becomes sRGB #F9A29D — a washed-out
   * pink, and the whole apartment looks bleached. Read the same numbers as
   * sRGB they become #F05E57, which is exactly the vivid red in Kenney's own
   * preview render. So the kit is authored sRGB-in-a-linear-field and we
   * re-encode on the way in. Getting this wrong is the difference between a
   * poster and a room.
   */
  material(rawColor, { transparent = false, opacity = 1, glass = false, mirror = false,
                       screen = null, override = null } = {}) {
    const rk = key([rawColor.r, rawColor.g, rawColor.b]);
    const ck = rk + (override ? '>' + override.join(',') : '') +
      (glass ? '|glass' : '') + (mirror ? '|mirror' : '') + (screen ? '|screen' : '');
    if (this.materials.has(ck)) return this.materials.get(ck);

    const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
    const color = override
      ? srgb(override[0], override[1], override[2])
      : srgb(rawColor.r, rawColor.g, rawColor.b);

    let m;
    if (glass && !mirror) {
      const gc = srgb(GLASS[0], GLASS[1], GLASS[2]);
      m = new THREE.MeshStandardMaterial({
        color: gc,
        roughness: 0.08,
        metalness: 0.0,
        transparent: true,
        opacity: Math.min(opacity, 0.42),
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    } else if (mirror) {
      m = new THREE.MeshStandardMaterial({
        color: srgb(0.88, 0.92, 0.93),
        roughness: 0.04,
        metalness: 0.95,
        envMapIntensity: 1.6,
      });
    } else {
      const s = SURFACE.get(rk) || { roughness: 0.6, metalness: 0.0 };
      m = new THREE.MeshStandardMaterial({
        color,
        roughness: s.roughness,
        metalness: s.metalness,
        emissive: new THREE.Color(s.emissive || 0x000000),
        emissiveIntensity: s.emissiveIntensity || 0,
      });
      if (screen) {
        m.emissive = new THREE.Color(screen.emissive);
        m.emissiveIntensity = screen.emissiveIntensity;
      }
      if (transparent) {
        m.transparent = true;
        m.opacity = opacity;
      }
    }
    if (m.envMapIntensity === undefined || m.envMapIntensity === 1) m.envMapIntensity = this.envIntensity;
    m.name = 'kit:' + ck;
    this.materials.set(ck, m);
    return m;
  }

  /** Live-adjust IBL strength across the whole palette (used for light tuning). */
  setEnvIntensity(v) {
    this.envIntensity = v;
    for (const m of this.materials.values()) {
      if (m.metalness > 0.9) continue;      // leave the mirror alone
      m.envMapIntensity = v;
      m.needsUpdate = true;
    }
  }

  /** Load one model, rebuild its materials, and normalise its origin.
   *  After this the returned group's origin sits at (footprint centre, floor). */
  async load(name) {
    if (this.entries.has(name)) return this.entries.get(name);

    const gltf = await this.loader.loadAsync(`${this.base}/${name}.glb`);
    this.stats.filesLoaded += 1;
    const root = gltf.scene;
    const mirror = MIRRORS.has(name);
    const screen = SCREENS.has(name) ? SCREEN_GLOW : null;
    const tint = WALL_MODELS.has(name) ? EXTERIOR_TINT : null;

    root.traverse((o) => {
      if (!o.isMesh) return;
      this.stats.meshes += 1;
      const g = o.geometry;
      this.stats.tris += g.index ? g.index.count / 3
        : (g.attributes.position ? g.attributes.position.count / 3 : 0);

      const src = o.material;
      const srcList = Array.isArray(src) ? src : [src];
      const rebuilt = srcList.map((s) => {
        const slot = key([s.color.r, s.color.g, s.color.b]);
        const isGlass = s.transparent || s.opacity < 1 || slot === GLASS_KEY;
        const dark = slot === key(METAL_DARK);
        return this.material(s.color, {
          transparent: !!s.transparent,
          opacity: s.opacity != null ? s.opacity : 1,
          glass: isGlass,
          mirror: mirror && isGlass,
          override: (tint && dark) ? tint : null,
          // Only the glow-carrying slot of a screen model lights up.
          screen: (screen && dark) ? screen : null,
        });
      });
      o.material = Array.isArray(src) ? rebuilt : rebuilt[0];
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = true;
    });

    // Normalise: origin -> footprint centre, base -> y 0.
    const box = new THREE.Box3().setFromObject(root);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const wrapper = new THREE.Group();
    wrapper.name = name;
    root.position.set(-c.x, -box.min.y, -c.z);
    wrapper.add(root);

    const entry = { name, source: wrapper, size, raw: { min: box.min.clone(), max: box.max.clone() } };
    this.entries.set(name, entry);
    return entry;
  }

  async loadAll(names) {
    const out = [];
    for (const n of names) out.push(await this.load(n));
    return out;
  }

  /** A fresh, independently transformable copy (geometry + material shared). */
  instance(name) {
    const e = this.entries.get(name);
    if (!e) throw new Error(`kit: "${name}" was never loaded`);
    return e.source.clone(true);
  }

  /** All mesh geometries of `obj` baked into world space, tagged by material. */
  static worldPieces(obj) {
    obj.updateMatrixWorld(true);
    const pieces = [];
    obj.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      // Drop attributes mergeGeometries would choke on if they differ.
      for (const a of Object.keys(g.attributes)) {
        if (a !== 'position' && a !== 'normal' && a !== 'uv') g.deleteAttribute(a);
      }
      if (!g.attributes.uv) {
        g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      }
      if (!g.attributes.normal) g.computeVertexNormals();
      pieces.push({ geometry: g, material: o.material });
    });
    return pieces;
  }
}

/** Collapse a list of placed objects into as few meshes as possible.
 *  Glass is kept as its own mesh so transparency sorting stays sane. */
function mergePlaced(objects, { name = 'merged', castShadow = true, receiveShadow = true } = {}) {
  const byMaterial = new Map();
  for (const obj of objects) {
    for (const p of Kit.worldPieces(obj)) {
      const m = p.material;
      if (!byMaterial.has(m)) byMaterial.set(m, []);
      byMaterial.get(m).push(p.geometry);
    }
  }
  const group = new THREE.Group();
  group.name = name;
  let tris = 0;
  for (const [material, geoms] of byMaterial) {
    const list = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
    if (!list) continue;
    const mesh = new THREE.Mesh(list, material);
    mesh.castShadow = castShadow && !material.transparent;
    mesh.receiveShadow = receiveShadow;
    if (material.transparent) mesh.renderOrder = 2;
    group.add(mesh);
    tris += list.index ? list.index.count / 3 : list.attributes.position.count / 3;
  }
  group.userData.tris = Math.round(tris);
  return group;
}

export { Kit, mergePlaced, SURFACE, SCREENS, GLASS, key };
