/**
 * avatar.js — the thing you are.
 *
 * A 0.42 m creature with its eyes at 0.36 m, which is the single decision that
 * makes this apartment a game: walls are 1.29 m (3.07 body heights), a sofa
 * back is 0.46 (above the eyes, so you can hide behind it), a coffee table is
 * 0.23 (below, so you see over it). Every number is read from the arena -- none
 * of it is typed here.
 *
 * COLLISION IS THE CORE'S, NOT THE RENDERER'S. Movement asks `nav.clear(x, z, r)`
 * -- the very same test that decided which cells are walkable and therefore the
 * same one that decided where the 红包 could be placed. There is no second
 * collision model to disagree with the first, and it makes the one invariant
 * that matters directly assertable:
 *
 *     after any number of steps, nav.clear(pos.x, pos.z, r) is STILL true.
 *
 * A renderer-side AABB sweep would have been a second implementation of the same
 * question, and the two would drift.
 */
import { supportY, roomOfPoint, climbCeilOf } from '../core/level.js';
import { MOVE } from './config.js';

const TAU = Math.PI * 2;

export class Avatar {
  constructor(level, nav, spawn) {
    this.level = level;
    this.nav = nav;
    this.radius = level.body.playerRadius;
    this.eyeHeight = level.body.eyeHeight;
    this.step = level.meta.step;
    // The highest thing the player may STAND on. Walls (1.29) and the upper
    // cabinets (1.17) are above it, so neither is a surface -- see
    // `climbCeilOf`. The avatar is the last caller to start passing it.
    this.ceil = climbCeilOf(level);
    this.spawn = { x: spawn.x, z: spawn.z, yaw: spawn.yaw || 0 };
    this.snapped = null;
    this.reset(spawn);
  }

  /**
   * Put the player somewhere legal.
   *
   * The arena's spawn is validated as "not inside a solid", but that is a POINT
   * test; a body of radius 0.12 also needs 12 cm of air. So the first thing we
   * do is ask the nav for a genuinely clear spot, and record whether the spawn
   * had to move -- a spawn that silently teleports is a floor-plan bug wearing
   * a costume, and it should be readable rather than invisible.
   */
  reset(spawn) {
    const s = spawn || this.spawn;
    let x = s.x;
    let z = s.z;
    this.snapped = null;
    if (!this.nav.clear(x, z, this.radius)) {
      const near = this.nav.nearestWalkable(x, z, 1.5);
      if (near) {
        this.snapped = { from: { x, z }, to: { x: near.x, z: near.z } };
        x = near.x;
        z = near.z;
      }
    }
    this.x = x;
    this.z = z;
    // `spawn.yaw` comes out of the arena adapter as a CORE bearing
    // (`deriveSpawn` builds it with atan2(dz, dx)), so it has to be converted.
    this.yaw = 0;
    this.fromFacing(s.yaw != null ? s.yaw : 0);
    this.pitch = 0;
    // `groundY` is the floor the body stands on; `feetY` is groundY + `hop`.
    // They are separate because the two answer different questions: collision
    // and reach ask about the GROUND, the camera and the red census ask about
    // the EYE. Folding them into one number is how a jump silently extends
    // your reach.
    this.groundY = supportY(this.level, x, z, 0, this.step, this.ceil);
    this.feetY = this.groundY;
    this.bob = 0;
    this.moving = 0;         // 0..1, smoothed, for the HUD and the audio
    this.stun = 0;
    this.distance = 0;
    this.room = roomOfPoint(this.level, x, z);
    this.vy = 0;
    this.hop = 0;
    this.airborne = false;
    this.jumps = 0;
  }

  /** @param facing a CORE bearing (atan2(dz, dx)); omit to keep the heading. */
  teleport(x, z, facing) {
    const near = this.nav.clear(x, z, this.radius) ? { x, z } : this.nav.nearestWalkable(x, z, 1.5);
    if (!near) return false;
    this.x = near.x;
    this.z = near.z;
    if (facing != null) this.fromFacing(facing);
    this.groundY = supportY(this.level, this.x, this.z, 0, this.step, this.ceil);
    this.hop = 0;
    this.vy = 0;
    this.airborne = false;
    this.feetY = this.groundY;
    this.room = roomOfPoint(this.level, this.x, this.z);
    return true;
  }

  /** Aim the camera at a plan point (pitch included). Used by the harness. */
  lookAt(x, z, y) {
    const fx = x - this.x;
    const fz = z - this.z;
    this.fromFacing(Math.atan2(fz, fx));
    const eyeY = this.feetY + this.eyeHeight;
    const fy = (y != null ? y : eyeY) - eyeY;
    const flat = Math.hypot(fx, fz);
    this.pitch = Math.max(-MOVE.pitchLimit, Math.min(MOVE.pitchLimit, Math.atan2(fy, flat)));
    return { yaw: this.yaw, pitch: this.pitch };
  }

  /**
   * One step.
   *
   * @param dt     seconds
   * @param input  { fwd, side, turn, look }  fwd/side in [-1, 1], turn in rad/s
   *               worth of intent, look = pointer-lock delta in pixels
   */
  update(dt, input) {
    // ---- look ------------------------------------------------------------
    // HORIZONTAL IS SUBTRACTED, AND THAT IS NOT A TYPO.
    //
    // `camera.rotation.y = yaw` (order YXZ) aims the camera at
    // (-sin yaw, -cos yaw), so a yaw that GROWS swings the view from -Z
    // toward -X: to the LEFT. Moving the mouse right must therefore
    // DECREASE yaw. This line was first written as `+=` and shipped
    // inverted -- the world turned the wrong way under the hand, which is
    // the one control bug a player feels instantly and no screenshot can
    // show. `scripts/verify_play.mjs` now pins the DIRECTION geometrically
    // (the view must rotate toward the camera's own right vector) instead
    // of re-reading this sign.
    //
    // Pitch keeps its sign: `-=` on dy means a mouse pushed DOWN looks
    // DOWN, which is the un-inverted convention and the one this build has
    // always had.
    if (input.look) {
      this.yaw -= input.look.dx * MOVE.mouseSens;
      this.pitch -= input.look.dy * MOVE.mouseSens;
    }
    if (input.turn) this.yaw += input.turn * MOVE.turnRate * dt;
    if (this.yaw > Math.PI) this.yaw -= TAU;
    if (this.yaw < -Math.PI) this.yaw += TAU;
    if (this.pitch > MOVE.pitchLimit) this.pitch = MOVE.pitchLimit;
    if (this.pitch < -MOVE.pitchLimit) this.pitch = -MOVE.pitchLimit;

    if (this.stun > 0) {
      this.stun -= dt;
      this.moving += (0 - this.moving) * Math.min(1, dt * 8);
      if (this.airborne) this.hopStep(dt);      // finish an arc already in flight
      this.settleVertical();
      return;
    }

    // ---- jump ------------------------------------------------------------
    // A ballistic arc on the FEET, and what it lands on is asked of the core.
    // `feetY` is the state; `supportY(..., ceil)` says which surface is under
    // it and `nav.clear(..., feetY)` says whether the body fits at that height.
    // A hop can therefore put you ON the coffee table and inside the bathtub,
    // which is what the player asked for ("能跳到桌子上面或者浴缸里面"), while
    // the ceiling keeps it from putting you on a wall.
    if (input.jump && !this.airborne) {
      this.vy = MOVE.jumpVel;
      this.airborne = true;
      this.jumps += 1;
    }
    if (this.airborne) this.hopStep(dt);

    // ---- move ------------------------------------------------------------
    let fwd = input.fwd || 0;
    let side = input.side || 0;
    const mag = Math.hypot(fwd, side);
    if (mag > 1) { fwd /= mag; side /= mag; }

    // THREE.JS'S OWN YAW CONVENTION, deliberately.
    //
    // `camera.rotation.y = yaw` (order YXZ) points the camera at
    // (-sin yaw, -cos yaw) -- at yaw 0 that is -Z, which is what a default
    // PerspectiveCamera already looks at, so the driver can copy `yaw` and
    // `pitch` straight onto the camera with no conversion at all.
    //
    // The core uses a DIFFERENT convention: guard.facing is `atan2(dz, dx)`,
    // i.e. atan2's bearing where 0 is +X. The two differ by a quarter turn, and
    // mixing them silently makes everything walk sideways. `facing()` and
    // `fromFacing()` below are the only place the two meet.
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    const dx = fwd * fx + side * rx;
    const dz = fwd * fz + side * rz;

    let travel = MOVE.speed * dt;
    const startX = this.x;
    const startZ = this.z;

    if (travel > 1e-9 && (dx || dz)) {
      // Sub-step, and resolve the two axes SEPARATELY: that is what lets you
      // slide along a sofa instead of sticking to it, and the sub-step keeps
      // the penetration you can reach in one frame below 3.5 cm.
      const steps = Math.max(1, Math.min(64, Math.ceil(travel / MOVE.substep)));
      const s = travel / steps;
      // AT THE FEET'S OWN HEIGHT. `nav.clear(x, z, r, 0)` is bit-identical to
      // the old two-argument form (measured: 12,000 pairs, 0 mismatches), so a
      // walk on the floor is unchanged; the argument is what lets a body that
      // is already up on something move across the top of it instead of being
      // stopped by the thing it is standing on.
      for (let k = 0; k < steps; k++) {
        const nx = this.x + dx * s;
        if (this.nav.clear(nx, this.z, this.radius, this.feetY)) this.x = nx;
        const nz = this.z + dz * s;
        if (this.nav.clear(this.x, nz, this.radius, this.feetY)) this.z = nz;
      }
    }

    const moved = Math.hypot(this.x - startX, this.z - startZ);
    this.distance += moved;
    const target = moved > 1e-4 ? 1 : 0;
    this.moving += (target - this.moving) * Math.min(1, dt * 9);

    // Bob is driven by metres actually covered, not by intent, so walking into
    // a wall does not shake the camera.
    this.bob += moved * MOVE.bobHz * TAU;

    if (this.airborne) {
      this.hopStep(dt);
    } else {
      // The support can change because we MOVED. A rise of up to one `step` is
      // walked up (the rug, the coffee table); a drop of more than a step is a
      // fall off a ledge, not a glide down through the furniture.
      const want = supportY(this.level, this.x, this.z, this.feetY, this.step, this.ceil);
      if (want < this.feetY - (this.step + 0.02)) {
        this.airborne = true;
        this.vy = 0;
      } else {
        this.feetY += (want - this.feetY) * Math.min(1, dt * 12);
        if (Math.abs(want - this.feetY) < 1e-3) this.feetY = want;
      }
    }
    this.settleVertical();
    this.room = roomOfPoint(this.level, this.x, this.z);
  }

  /**
   * One step of the vertical arc, and it LANDS ON SOMETHING.
   *
   * `vy` starts positive, gravity pulls it negative, and the arc ends when the
   * feet reach the highest surface they are allowed to land on. That surface is
   * `supportY(..., feetY, step, ceil)` -- the same query the placement used to
   * decide a packet up there was obtainable -- so "where can I land" and "where
   * can a 红包 be placed" are one rule, not two.
   *
   * The landing test runs only while DESCENDING, which is what stops a rising
   * body from being teleported onto the top of whatever it is passing.
   */
  hopStep(dt) {
    this.vy -= MOVE.gravity * dt;
    const y = this.feetY + this.vy * dt;
    const below = supportY(this.level, this.x, this.z, this.feetY, this.step, this.ceil);
    if (this.vy <= 0 && y <= below) {
      this.feetY = below;
      this.vy = 0;
      this.airborne = false;
    } else {
      this.feetY = y;
    }
  }

  /**
   * `groundY` and `hop` are DERIVED from `feetY`, which is the state.
   *
   *   groundY  the highest surface at or below the feet: "what I am on"
   *   hop      how far the feet are above it
   *
   * They are recomputed rather than integrated because a body's support can
   * change without it moving vertically at all -- stepping from the floor onto
   * a rug is a new groundY and a zero hop.
   */
  settleVertical() {
    this.groundY = supportY(this.level, this.x, this.z, this.feetY + 1e-6, 0, this.ceil);
    this.hop = this.feetY - this.groundY;
  }

  /** Where the eyes are. Horizontal, because the world is 2.5D on purpose. */
  eye() {
    const bob = Math.sin(this.bob) * MOVE.bobAmp * this.moving;
    return { x: this.x, y: this.feetY + this.eyeHeight + bob, z: this.z };
  }

  /** Plan position, which is what the core's vision and guard consume. */
  pos() {
    return { x: this.x, z: this.z };
  }

  /** The core's bearing convention: atan2(dz, dx), 0 = +X. */
  facing() {
    return Math.atan2(-Math.cos(this.yaw), -Math.sin(this.yaw));
  }

  /** Set the camera yaw from a core bearing. The inverse of `facing()`. */
  fromFacing(f) {
    this.yaw = Math.atan2(-Math.cos(f), -Math.sin(f));
    return this.yaw;
  }

  /** Careful: `y` is the feet, and it is what a lift test measures against. */
  state() {
    return {
      x: this.x, z: this.z, y: this.feetY, yaw: this.yaw, pitch: this.pitch,
      facing: this.facing(),
      room: this.room, moving: this.moving, stun: this.stun, distance: this.distance,
      hop: this.hop, groundY: this.groundY, airborne: this.airborne, jumps: this.jumps,
      snappedFromSpawn: this.snapped,
    };
  }
}
