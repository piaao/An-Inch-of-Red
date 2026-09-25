/**
 * scene.js — everything the player SEES.
 *
 * The apartment itself is built by the existing viewer (`js/kit.js` +
 * `js/build.js`) with zero changes, which is the point: the game did not fork
 * the scene, it stands on it. What this file adds is the four things a game
 * needs and a viewer does not:
 *
 *   prizes    the 红包 themselves, at the exact anchors `placePrizes` chose
 *   guard     a readable little sentry, with a vision fan on the floor
 *   glints    "there is something RED over there" -- the only affordance,
 *             and it is applied IDENTICALLY to 红包 and to decoration
 *   shadow    a soft blob under the player, so 36 cm of eye height feels
 *             like standing somewhere rather than floating
 *
 * COLOUR HONESTY. The 红包 is #C8102E and the kit's own carpet red is #F05E57 --
 * ΔE 19.6 apart, which is exactly the design's claim. Nothing here may help the
 * player tell them apart: no emissive on the prize, no glow, no outline. The
 * glint marker is computed from `redCensus` output, and `redCensus` scores the
 * prize at its own real area with the same salience formula and the same notice
 * gate it applies to a rug. If the marker were special-cased the game would be
 * lying about its own central mechanic.
 */
import * as THREE from 'three';
import { sightLine } from '../core/vision.js';
import { LOOP } from './config.js';

/* ------------------------------------------------------------------ glints */

/**
 * A soft radial dot, tinted at use time. Same texture for every marker, which
 * is what keeps the affordance honest: only opacity and position differ, and
 * opacity is driven by `colourConfidence` -- the same 0.55^n the model uses.
 */
function dotTexture() {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  rg.addColorStop(0.00, 'rgba(255,255,255,1)');
  rg.addColorStop(0.35, 'rgba(255,255,255,0.72)');
  rg.addColorStop(0.72, 'rgba(255,255,255,0.16)');
  rg.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A small "already checked, nothing here" ring. */
function ringTexture() {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 7;
  g.beginPath();
  g.arc(S / 2, S / 2, S / 2 - 8, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.moveTo(S * 0.32, S * 0.68);
  g.lineTo(S * 0.68, S * 0.32);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * The marker pool. Size is fixed so nothing allocates during play; anything
 * past the pool is dropped, and `dropped` is reported rather than swallowed
 * (a silently truncated affordance would read as "the game forgot to tell me").
 */
export class GlintField {
  constructor(scene, max = 28) {
    this.scene = scene;
    this.dot = dotTexture();
    this.ring = ringTexture();
    this.red = [];
    this.done = [];
    for (let i = 0; i < max; i++) {
      const m = new THREE.SpriteMaterial({
        map: this.dot, color: 0xff5a4d, transparent: true, opacity: 0,
        depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
      });
      const s = new THREE.Sprite(m);
      s.visible = false;
      s.renderOrder = 4;
      scene.add(s);
      this.red.push(s);

      const dm = new THREE.SpriteMaterial({
        map: this.ring, color: 0x9fb0c4, transparent: true, opacity: 0,
        depthWrite: false, depthTest: true,
      });
      const ds = new THREE.Sprite(dm);
      ds.visible = false;
      ds.renderOrder = 3;
      scene.add(ds);
      this.done.push(ds);
    }
    this.dropped = 0;
    this.drawn = 0;
    this.seenRed = 0;
    this.seenPrize = 0;
  }

  /**
   * @param noticed  `redCensus` output: { reds, prizes }. Both lists are
   *                 "red things in sight" and are drawn the SAME WAY.
   * @param cleared  Set of solid ids the player has already walked up to.
   * @param camDist  viewer distance, only used for a tiny size falloff.
   *
   * `seenRed` / `seenPrize` report how many of each kind were NOTICED, and
   * `drawn` how many sprites that put on screen. They can differ, because the
   * two kinds share ONE pool on purpose -- see the body of `update`.
   */
  update(noticed, cleared) {
    const put = (list, sink) => {
      let n = 0;
      for (const e of list) {
        if (n >= sink.length) break;
        const s = sink[n];
        const conf = e.confidence != null ? e.confidence : 1;
        // Constant intensity, modulated ONLY by how much the glass ate the
        // colour. A prize and a rug at the same distance get the same dot.
        s.material.opacity = 0.40 * conf;
        const scale = 0.052 * (1 + 0.5 * (1 - Math.min(1, (e.dist || 0) / 5)));
        s.scale.set(scale, scale, 1);
        s.position.set(e.x, (e.y != null ? e.y : 0.05) + 0.02, e.z);
        s.visible = true;
        n += 1;
      }
      for (let k = n; k < sink.length; k++) sink[k].visible = false;
      return n;
    };
    // ONE POOL, BOTH KINDS, ONE CALL. A packet dot and a rug dot have to be
    // the SAME dot, or the marker answers the question the game is about --
    // so reds and prizes share the sprite budget. But two `put` calls into one
    // sink also made the SECOND list erase the first's sprites: `put` hides
    // every sprite from its own count upward, so a room with three red things
    // and no packet in view drew nothing at all. Measured before this fix:
    // census reds 3, prizes 0 -> seenRed 3, seenPrize 0, visible sprites 0.
    const reds = noticed.reds || [];
    const prizes = noticed.prizes || [];
    this.seenRed = reds.length;
    this.seenPrize = prizes.length;
    this.drawn = put(reds.concat(prizes), this.red);
    this.dropped = Math.max(0, reds.length + prizes.length - this.red.length);

    let n = 0;
    if (cleared) {
      for (const e of noticed.clearedList || []) {
        if (n >= this.done.length) break;
        const s = this.done[n];
        s.material.opacity = 0.30 * (e.confidence != null ? e.confidence : 1);
        s.scale.set(0.075, 0.075, 1);
        s.position.set(e.x, (e.y != null ? e.y : 0.05) + 0.03, e.z);
        s.visible = true;
        n += 1;
      }
    }
    for (let k = n; k < this.done.length; k++) this.done[k].visible = false;
    this.seenCleared = n;
  }

  hideAll() {
    for (const s of [...this.red, ...this.done]) s.visible = false;
  }
}

/* ------------------------------------------------------------------ prizes */

const SEAL = '#E8C46A';

/**
 * One 红包: a 16 x 10 cm flat packet, sealed with the arena's gold stamp.
 *
 * Deliberately NOT emissive and deliberately not outlined -- see the header.
 * `flatShading` keeps it in the kit's visual language rather than looking like
 * a smooth prop dropped into a low-poly room.
 */
export function makeHongbao(collectible) {
  const [w, h, d] = collectible.size;
  const g = new THREE.Group();
  g.name = 'hongbao';

  const paper = new THREE.MeshStandardMaterial({
    color: new THREE.Color(collectible.colour),
    roughness: 0.62, metalness: 0.0, flatShading: true,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), paper);
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  // The stamp sits on the top face, a hair proud of it so it never z-fights.
  const gold = new THREE.MeshStandardMaterial({
    color: new THREE.Color(SEAL), roughness: 0.4, metalness: 0.35, flatShading: true,
  });
  const seal = new THREE.Mesh(new THREE.CircleGeometry(Math.min(w, d) * 0.24, 18), gold);
  seal.rotation.x = -Math.PI / 2;
  seal.position.y = h / 2 + 0.0016;
  g.add(seal);

  // A folded flap along one short edge: three boxes is all it takes to stop
  // the thing reading as a coloured domino.
  const flap = new THREE.Mesh(new THREE.BoxGeometry(w * 0.98, h * 1.35, 0.018), paper);
  flap.position.set(0, 0, -d / 2 + 0.009);
  flap.castShadow = true;
  g.add(flap);

  return g;
}

/** Holds the meshes and mirrors the core's prize list onto the scene graph. */
export class PrizeField {
  constructor(scene, collectible) {
    this.scene = scene;
    this.collectible = collectible;
    this.group = new THREE.Group();
    this.group.name = 'prizes';
    scene.add(this.group);
    this.items = [];
    this.built = collectible;      // the packet size the meshes are at now
  }

  /**
   * @param collectible  the 红包 AS THIS RUN'S DIFFICULTY SIZES IT. The core
   *                     gates "noticeable" on `noticeRange(size0 * size2)`,
   *                     so a preset that shrinks the packet must shrink the
   *                     MESH by the same factor. Otherwise the thing on
   *                     screen would be a different object from the one the
   *                     census reasons about -- a small object drawn at full
   *                     size claims a notice range it cannot honour, and a
   *                     large one drawn small would be the mirror-image lie.
   *                     Defaults to the arena's own packet.
   */
  rebuild(prizes, collectible) {
    const spec = collectible || this.collectible;
    this.built = spec;
    for (const it of this.items) this.group.remove(it.mesh);
    this.items = [];
    for (let i = 0; i < prizes.length; i++) {
      const p = prizes[i];
      const mesh = makeHongbao(spec);
      // Anchors are the surface; the packet is 26 mm thick, so centre it.
      mesh.position.set(p.x, p.y + spec.size[1] / 2, p.z);
      // A deterministic half-turn-ish scatter so six identical packets do not
      // read as one mesh stamped six times. Deterministic, because a non-seeded
      // angle would make two runs of the same seed look different.
      mesh.rotation.y = ((i * 137.5) % 360) * Math.PI / 180;
      this.group.add(mesh);
      this.items.push({ id: p.id, mesh, prize: p, taken: false });
    }
    return this.items.length;
  }

  take(id) {
    const it = this.items.find((x) => x.id === id);
    if (!it || it.taken) return false;
    it.taken = true;
    it.mesh.visible = false;
    return true;
  }

  reset() {
    for (const it of this.items) { it.taken = false; it.mesh.visible = true; }
  }

  /** Positions for the harness, so a screenshot can be aimed at one. */
  positions() {
    return this.items.map((it) => ({ id: it.id, ...it.prize }));
  }
}

/* ------------------------------------------------------------------- guard */

const MODE_COLOUR = {
  patrol: { cone: 0x7fd4ff, eye: 0xe8c46a, opacity: 0.085 },
  alert: { cone: 0xffc24d, eye: 0xffb03a, opacity: 0.16 },
  chase: { cone: 0xff4d4d, eye: 0xff3b30, opacity: 0.24 },
};

function bangTexture() {
  const W = 64;
  const H = 96;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.font = 'bold 84px "Segoe UI", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 9;
  g.strokeStyle = 'rgba(20,14,10,0.85)';
  g.strokeText('!', W / 2, H / 2);
  g.fillStyle = '#ffd98a';
  g.fillText('!', W / 2, H / 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * The sentry, assembled from the kit's own palette so it does not look bolted
 * on: one wheel skirt, one tapered body, one glass dome, one lens.
 *
 * `facing` in the core is a plan bearing where 0 means +X (it is built from
 * `Math.atan2(dz, dx)`), so the mesh's local front is +X and the group is
 * rotated by -facing. Getting this backwards makes the guard walk sideways,
 * which is the kind of bug that looks like a pathfinding failure.
 */
export class GuardActor {
  constructor(scene, body, cfg) {
    this.cfg = cfg;
    this.group = new THREE.Group();
    this.group.name = 'guard';
    scene.add(this.group);

    const dark = new THREE.MeshStandardMaterial({ color: 0x2f3a45, roughness: 0.52, metalness: 0.25, flatShading: true });
    const mid = new THREE.MeshStandardMaterial({ color: 0x59636e, roughness: 0.45, metalness: 0.3, flatShading: true });
    const glassy = new THREE.MeshStandardMaterial({ color: 0x8fb6c9, roughness: 0.15, metalness: 0.1, flatShading: true, transparent: true, opacity: 0.75 });

    const R = body.guardRadius;
    const H = body.guardHeight;

    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 1.06, 0.05, 22), dark);
    skirt.position.y = 0.025;
    this.group.add(skirt);

    const bodyH = H * 0.52;
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.78, R * 0.98, bodyH, 22), mid);
    shell.position.y = 0.05 + bodyH / 2;
    this.group.add(shell);

    const domeR = R * 0.70;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(domeR, 20, 12), glassy);
    dome.position.y = 0.05 + bodyH + domeR * 0.42;
    dome.scale.y = 0.82;
    this.group.add(dome);

    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.06, 6), dark);
    antenna.position.y = H - 0.03;
    this.group.add(antenna);

    // The lens sits at the arena's `guardEye`, on the local +X face.
    this.eyeMat = new THREE.MeshStandardMaterial({
      color: MODE_COLOUR.patrol.eye, emissive: MODE_COLOUR.patrol.eye,
      emissiveIntensity: 1.6, roughness: 0.25, flatShading: true,
    });
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.05, 0.085), this.eyeMat);
    lens.position.set(R * 0.94, body.guardEye, 0);
    this.group.add(lens);

    for (const o of [skirt, shell, dome, antenna, lens]) {
      o.castShadow = true;
      o.receiveShadow = true;
    }

    const light = new THREE.PointLight(MODE_COLOUR.patrol.eye, 0, 2.4, 2);
    light.position.set(R * 1.2, body.guardEye, 0);
    this.group.add(light);
    this.light = light;

    // THE MONITORING AREA, AS AN ACTUAL LIGHT.
    //
    // The fan below is a flat decal at y = 0.014: it says where the guard is
    // looking and lights nothing, so it never tells you what the guard can
    // actually SEE FROM. A spotlight hung off the SAME two numbers --
    // `cfg.coneDeg` for its angle, `cfg.range` for its throw -- puts a pool
    // on the floor that IS the sector, which is what makes the difficulty
    // dial legible: a wider surveillance is a bigger puddle of light, not a
    // wider transparent triangle.
    //
    // It is a CHILD OF `group` (whose rotation is -guard.facing and whose
    // local front is +X), so it follows for free. `target` must be in the
    // scene graph for its world matrix to be updated, and a child of a group
    // that is in the scene is. No shadow: one extra shadow map for a
    // decorative pool is not worth the frame.
    this.R = R;
    this.eyeY = body.guardEye;
    this.spot = new THREE.SpotLight(
      MODE_COLOUR.patrol.cone, 0, 4.2, Math.PI / 4, 0.55, 1.15,
    );
    this.spot.position.set(R * 0.94, this.eyeY, 0);
    this.spot.target.position.set(R * 0.94 + 4.2, 0, 0);
    this.group.add(this.spot);
    this.group.add(this.spot.target);

    // The vision fan: own geometry in WORLD space, rebuilt each frame, because
    // each ray is clipped by a real sight line. It is NOT a child of `group`,
    // so `group.rotation` cannot corrupt it.
    const RAYS = LOOP.coneRays;
    this.rays = RAYS;
    this.coneGeo = new THREE.BufferGeometry();
    this.coneGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAYS * 9), 3));
    this.coneGeo.setDrawRange(0, RAYS * 3);
    this.coneMat = new THREE.MeshBasicMaterial({
      color: MODE_COLOUR.patrol.cone, transparent: true, opacity: MODE_COLOUR.patrol.opacity,
      side: THREE.DoubleSide, depthWrite: false,
      // A floor decal that must stay legible when the fan passes over a rug or
      // a coffee table. The fan is already clipped to the first wall, so
      // drawing it last cannot leak it through a wall -- only over furniture
      // the eye height genuinely sees across.
      depthTest: false,
    });
    this.cone = new THREE.Mesh(this.coneGeo, this.coneMat);
    this.cone.frustumCulled = false;
    this.cone.renderOrder = 6;
    scene.add(this.cone);

    this.bangTex = bangTexture();
    this.bang = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.bangTex, transparent: true, depthWrite: false, depthTest: false,
    }));
    this.bang.scale.set(0.10, 0.15, 1);
    this.bang.visible = false;
    this.bang.renderOrder = 7;
    scene.add(this.bang);
  }

  /**
   * Push the core's `Guard.state()` into the scene graph.
   *
   * @param rebuildCone  rebuild the fan geometry. The fan costs one `sightLine`
   *                     per ray (17 of them, each walking ~190 solids), so it
   *                     runs at CONE_HZ while the body follows the simulation
   *                     every frame -- a guard whose body stutters is far more
   *                     noticeable than a fan that updates 30 times a second.
   */
  update(level, guard, rebuildCone, t) {
    const cfg = guard.cfg;
    const mode = MODE_COLOUR[guard.mode] ? guard.mode : 'patrol';
    const col = MODE_COLOUR[mode];

    const bob = Math.sin(t * 9 + guard.index) * 0.004;
    this.group.position.set(guard.pos.x, bob, guard.pos.z);
    this.group.rotation.y = -guard.facing;

    // Suspicion reads on the lens AND on the fan: a guard you cannot read is a
    // guard that feels unfair, and its bar is the one number the player must be
    // able to see without looking away from the room.
    const heat = Math.min(1, guard.suspicion);
    this.eyeMat.color.setHex(col.eye);
    this.eyeMat.emissive.setHex(col.eye);
    this.eyeMat.emissiveIntensity = 1.2 + 1.6 * heat;
    this.light.color.setHex(col.eye);
    this.light.intensity = 0.35 + 0.5 * heat;

    this.coneMat.color.setHex(col.cone);
    this.coneMat.opacity = col.opacity * (1 + 0.85 * heat);

    // Same three numbers as the fan, from the same `cfg`, so the light and
    // the decal can never disagree about how much floor the guard owns.
    // The axis is aimed at the FLOOR at `cfg.range` metres ahead, so the
    // pool's far rim lands where the fan's rim does.
    this.spot.color.setHex(col.cone);
    this.spot.angle = (cfg.coneDeg * Math.PI) / 180 / 2;
    this.spot.distance = cfg.range;
    this.spot.target.position.set(this.spot.position.x + cfg.range, 0, 0);
    this.spot.intensity = 5.0 + 5.0 * heat;

    if (rebuildCone) this.rebuildCone(level, guard);

    const loud = guard.mode === 'chase' ? true : guard.mode === 'alert';
    this.bang.visible = loud;
    if (loud) {
      this.bang.position.set(guard.pos.x, level.body.guardHeight + 0.12
        + Math.sin(t * 7) * 0.012, guard.pos.z);
      this.bang.material.color.setHex(guard.mode === 'chase' ? 0xff6b5a : 0xffd98a);
      this.bang.material.opacity = 0.85;
    }
  }

  rebuildCone(level, guard) {
    const cfg = guard.cfg;
    const half = (cfg.coneDeg * Math.PI) / 180 / 2;
    const origin = { x: guard.pos.x, z: guard.pos.z };
    const p = this.coneGeo.attributes.position.array;
    const rim = [];
    for (let k = 0; k <= this.rays; k++) {
      const a = guard.facing - half + (2 * half) * (k / this.rays);
      const far = { x: origin.x + Math.cos(a) * cfg.range, z: origin.z + Math.sin(a) * cfg.range };
      const hit = sightLine(level, origin, far, cfg.eyeY);
      // `at` is where the first sight-blocker starts, so the fan stops exactly
      // where the guard's eyes stop. The fan is the model, not a drawing of it.
      const at = hit.clear ? 1 : Math.max(0, Math.min(1, hit.at));
      rim.push({ x: origin.x + (far.x - origin.x) * at, z: origin.z + (far.z - origin.z) * at });
    }
    let w = 0;
    for (let k = 0; k < this.rays; k++) {
      p[w++] = origin.x; p[w++] = 0.014; p[w++] = origin.z;
      p[w++] = rim[k].x; p[w++] = 0.014; p[w++] = rim[k].z;
      p[w++] = rim[k + 1].x; p[w++] = 0.014; p[w++] = rim[k + 1].z;
    }
    this.coneGeo.attributes.position.needsUpdate = true;
  }

  hide() {
    this.group.visible = false;
    this.cone.visible = false;
    this.bang.visible = false;
  }

  show() {
    this.group.visible = true;
    this.cone.visible = true;
  }
}

/* ------------------------------------------------------------ player blob */

export function makePlayerShadow(scene) {
  const tex = dotTexture();
  const mat = new THREE.SpriteMaterial({
    map: tex, color: 0x1a1f26, transparent: true, opacity: 0.42,
    depthWrite: false, depthTest: true,
  });
  const s = new THREE.Sprite(mat);
  s.scale.set(0.20, 0.20, 1);
  s.renderOrder = 2;
  scene.add(s);
  return s;
}
