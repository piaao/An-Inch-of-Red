/**
 * config.js — the play layer's OWN numbers, and nothing else.
 *
 * Hard rule: nothing in this file may change a verified number. Walk speed,
 * body radius, eye height, arm's reach and every guard behaviour come from the
 * arena snapshot and from `game/core/`, because those are exactly what the
 * headless matrix in `game/VERDICT.md` measured. What belongs here is only what
 * a RENDERER needs and a simulation does not: mouse sensitivity, head bob,
 * camera FOV, how often the red census is refreshed.
 *
 * ONE EXCEPTION, stated so that it is not a loophole: the difficulty table
 * below deliberately re-parameterises the guard, the 红包 and the clock,
 * because a ladder needs rungs. It is CONSTRAINED rather than forbidden --
 * the measured base preset (标准) keeps the core's own numbers untouched,
 * and any preset that moves a dial carries the win rate re-measured WITH
 * that dial, at THAT preset's own budget (scripts/measure_surveil.mjs,
 * recorded in game/VERDICT.md §6.2). A preset may not quote a number it
 * did not measure.
 *
 * EVERY RUNG IS READ AT ITS OWN BUDGET. The rig used to sweep 120/180 s,
 * so the 见习 card's 240 s was never measured at all and the card said so
 * instead of quoting a number it had not taken. §6.2 fixed the rig; the
 * budgets here are now a mirror of it, and changing one without the other
 * is how a card starts lying.
 */

/**
 * Movement feel. `speed` is deliberately the sim's `WALKER.speed` (1.5 m/s)
 * and there is no run and no sneak:
 *
 *  - A run key would silently make the game easier than the baselines the
 *    difficulty presets quote, because every one of those numbers was measured
 *    at ONE speed and this is now that speed.
 *  - A sneak key would be purely decorative: the guard's detection is cone +
 *    line-of-sight only, so moving slowly is not quieter in any way the model
 *    can see. A control that does nothing is worse than no control.
 */
import { MIN_ANGLE } from '../core/vision.js';

export const MOVE = {
  // 1.5 m/s, and it used to be 2.1. The player's words were "人物速度太快，
  // 一下子就逛玩了" and they are right about what a number does: 2.1 m/s is 5
  // body-heights a second (a human RUNNING, scaled), which crossed this 10.8 x
  // 8 m flat in 6 s -- a run was a lap. 1.5 is 3.6 heights/s, a brisk walk.
  //
  // A SPEED CHANGE IS NOT A FEEL CHANGE. Every win rate in VERDICT §6 and
  // §6.1 was measured at 2.1 m/s; §6.2 re-runs the whole ladder at 1.5 and is
  // now the only set of numbers a card may quote. The rule survives the
  // re-run: the rig measures at whatever this constant says, so move the
  // constant and re-run the rig -- do not re-quote.
  speed: 1.5,              // m/s -- WALKER.speed, held equal on purpose
  turnRate: 2.6,           // rad/s, now used ONLY by the scripted harness channel
  mouseSens: 0.0021,       // rad per pixel of pointer-lock movement
  pitchLimit: 1.20,        // rad, just under straight up/down
  substep: 0.035,          // m per collision sub-step
  bobHz: 2.35,             // head-bob cycles per metre travelled
  bobAmp: 0.0055,          // m
  stunAfterCatch: 0.9,     // s frozen after being caught (see hud/README note)

  // ---- jump -----------------------------------------------------------
  // A ballistic arc for the EYE, with no collision terms at all. The body's
  // legality stays `nav.clear(x, z, r)`, which has no vertical component, so a
  // hop can never put you in a cell a walk could not -- which is what keeps
  // every measured timing (1.5 m/s over the measured plan) exactly true.
  // What a hop buys is HEIGHT, and the height is chosen against the
  // furniture, which is what this apartment is made of:
  //
  //     peak = v^2 / 2g          airtime = 2v / g
  //     2.30 / 6.00   ->   0.441 m in 0.77 s
  //
  // At 0.441 m the eye rises from 0.36 to 0.80 m, so a hop clears the
  // 0.23 m coffee table, clears the 0.46 m sofa back, and still sits well
  // under the 1.29 m walls. That last one is a property, not a detail: it
  // is why jumping can never turn four rooms into one sight line. It was
  // 1.40 / 5.00 (0.196 m, 0.56 s), which read as a stumble rather than a
  // jump -- you could not see anything you could not already see standing.
  //
  // NOTE: the red census samples from the STANDING eye -- `groundY +
  // eyeHeight`, the eye of a body resting on whatever it is standing on. A
  // mid-flight hop therefore still cannot hand you a marker you would not have
  // got standing up. STANDING now includes standing ON things, which is the
  // point of climbing: the eye that spots a packet on the counter is the eye of
  // a body on the counter. The word that changed is STANDING, not the rule.
  jumpVel: 2.30,           // m/s upward, applied instantly on the press
  gravity: 6.00,           // m/s^2
};

export const VIEW = {
  fov: 74,                 // a small creature needs a wide lens to read a room
  near: 0.02,
  far: 60,
};

export const LOOP = {
  maxDt: 1 / 20,           // never integrate more than 50 ms in one step
  censusHz: 12,            // red-census refresh rate. 60 Hz would be 5x the cost
                           // for a signal that only changes as you walk.
  coneRays: 17,            // guard vision-fan resolution (each ray is a sightLine)
};

/**
 * Difficulty presets.
 *
 * TWO DIALS MOVE WITH THE LADDER, and both are printed on the card so a
 * player can watch them move:
 *
 *   surveil     a multiplier on the guard's cone angle AND its range. More
 *               surveillance is the same walk, watched from further and
 *               wider.
 *   prizeScale  a multiplier on the 红包 itself. A smaller packet is a
 *               smaller `noticeRange`, so you must be closer before the red
 *               census will admit it is there.
 *
 * `prizeScale` is NOT cosmetic, and that is the trap here: `redCensus` gates
 * "noticeable" on `noticeRange(prizeArea)`, so shrinking the packet changes
 * what the BLIND AI CAN FIND, not merely what the player can see. So any
 * preset that moves a dial carries the win rate re-measured WITH it --
 * scripts/measure_surveil.mjs, 24 seeds, re-run against the NEW placement
 * (game/VERDICT.md §6.2).
 *
 * THE OLD ROWS COULD NOT BE CARRIED OVER, and it is worth saying why rather
 * than quietly dropping them. They were taken by a rig that walked a
 * floor-eye 0.5 m lattice, in a flat whose walls did not block sight
 * (`fromLayout.js` emitted `blocksSight: false` for every wall), at 2.1 m/s,
 * with the 红包 still ON THE FLOOR. Five premises; every one since moved.
 * Re-quoting them under a new placement is exactly the failure this file's
 * header forbids.
 *
 * `ai` is quoted VERBATIM from the §6.2 run, and every string that could not
 * be measured says so. That is the point: a preset menu is where a design
 * most easily starts lying, because the numbers look authoritative and
 * nobody re-derives them.
 */
/**
 * THE CLOCK IS THE THIRD DIAL, AND IT HAS BEEN RECALIBRATED ONCE.
 *
 * 240/180/120/120 was tuned when a glance from the doorway already saw most
 * of the 红包 (they were ON THE FLOOR) and the walker ran at 2.1 m/s. The
 * placement then moved every packet off the floor, and §6.2 control A put a
 * number on the consequence: most packets are now visible only from ON the
 * furniture, so a run spends its clock SEARCHING rather than walking
 * (0.83/6 collected without climbing, 5.67/6 with). A 120 s clock that was
 * calibrated against a 4 s search now cuts the search off in the middle: the
 * same persona collects 2.83/6 and 2.13/6 there against 4.88/6 and 3.54/6 at
 * 180 s, and both hard cards read 0.0 % -- a wall, not a rung.
 *
 * So 紧张 and 硬核 run 180 s, and the ladder the cards quote is measured,
 * per card, at that card's own budget (game/VERDICT.md §6.2):
 *
 *   见习 240 s 66.7 %  >  标准 180 s 33.3 %  >  紧张 180 s 29.2 %
 *                       >  硬核 180 s 12.5 %
 *
 * 标准 and 紧张 are 4.1 pt apart, which is INSIDE the noise of a 24-seed
 * proportion (sd ~ 9 pt at p = 0.3), so those two are not ordered by this
 * table; what the table does establish is that both are distinctly harder
 * than 见习 and distinctly easier than 硬核.
 */
export const DIFFICULTIES = [
  {
    id: 'solo', name: '见习', budget: 240, guard: null,
    surveil: null, prizeScale: 1.15,      // 18.4 x 11.5 cm, noticed at 5.1 m
    blurb: '没有守卫。红包比平时大一圈，先把六个房间走熟、看清它长在什么地方。',
    ai: 'AI 玩家型人格 240 s：胜率 66.7 %，收集 5.67/6，用时 180 s（24 种子，§6.2）',
  },
  {
    id: 'patrol', name: '标准', budget: 180, guard: 'patrol',
    surveil: 1.00, prizeScale: 1.00,      // the measured base. do not move.
    blurb: '一名巡逻哨。它会绕全屋走，在你附近停下来左右扫视。',
    ai: 'AI 玩家型人格 180 s：无守卫 66.7 % → 有巡逻 33.3 %'
      + '（−33.4 pt，被抓 2.08 次；24 种子，§6.2）',
  },
  {
    id: 'tight', name: '紧张', budget: 180, guard: 'patrol',
    surveil: 1.19, prizeScale: 0.85,      // 74°/4.2 m -> 88°/5.0 m (11.4 -> 19.2 m2)
    blurb: '同一名哨兵，却长了眼：监控扇区更宽更远，红包也小了一圈。',
    ai: 'AI 玩家型人格 180 s：29.2 % 胜，收集 4.88/6，被抓 1.96 次（24 种子，§6.2）',
  },
  {
    id: 'hunter', name: '硬核', budget: 180, guard: 'hunter',
    surveil: 1.00, prizeScale: 0.70,      // base 96°/6.0 m, packet 11.2 x 7.0 cm
    blurb: '视野更宽、跑得更快、更不容易被甩掉的哨兵，红包只有一张名片大。',
    ai: 'AI 玩家型人格 180 s：12.5 % 胜，收集 3.54/6，被抓 3.21 次（24 种子，§6.2）',
  },
];

/** Which preset the start overlay opens on. */
export const DEFAULT_DIFFICULTY = 'patrol';

/** 6 红包 over 6 rooms. Held equal to the verified pipeline's count. */
export const PRIZE_COUNT = 6;

/** Re-render the guard's vision fan this often, in seconds. */
export const CONE_HZ = 30;

/** HUD-ish pacing. */
export const FEEL = {
  hintFadeAfter: 9,        // s before the controls line dims
  caughtFlash: 0.55,       // s of red flash
  lowTime: 30,             // s at which the clock turns red
  toastMs: 1500,
};

/* ------------------------------------------------------- the two dials */

/**
 * The floor area the guard's fan sweeps: a circular sector, 0.5 * theta * r^2.
 *
 * This is GEOMETRY, not a play measurement, and it is printed on the
 * difficulty card next to numbers that WERE measured -- which is fine as long
 * as it is labelled, because the ladder claim being made ("the harder the
 * preset, the more floor is watched") is exactly a claim about geometry. The
 * thing it must not do is stand in for a win rate, and it does not: the win
 * rate is in `ai`, and it says where it came from.
 */
export function fanArea(coneDeg, range) {
  return 0.5 * ((coneDeg * Math.PI) / 180) * range * range;
}

/**
 * The guard config a preset actually runs: the core's base mode, widened by
 * `surveil`. Returns a COPY, so the shared GUARD_MODES entries can never be
 * mutated by a preset.
 */
export function guardCfgFor(preset, modes) {
  if (!preset || !preset.guard) return null;
  const base = modes[preset.guard];
  if (!base) return null;
  const k = preset.surveil != null ? preset.surveil : 1;
  return { ...base, coneDeg: base.coneDeg * k, range: base.range * k };
}

/**
 * The 红包 as this preset sizes it. Same object when nothing scales, so the
 * arena's own packet stays the identity case.
 *
 * NOTHING ELSE ABOUT THE PACKET SCALES WITH IT. In particular `pickup` stays
 * the arena's 0.42 m, because that is the arm's reach, not the packet's size
 * -- and because the verified worst stand gap is 0.351 m, which leaves 0.07 m
 * of headroom. Scaling the reach by 0.85 would eat all of it and turn "every
 * 红包 is collectible", a measured fact, into a coin flip.
 */
export function collectibleFor(preset, collectible) {
  const k = preset && preset.prizeScale != null ? preset.prizeScale : 1;
  if (k === 1) return collectible;
  return { ...collectible, size: collectible.size.map((v) => v * k) };
}

/** The area the core's census gate is computed from. One definition, used
 *  by the marker (play.js) and by the mesh (PrizeField) alike. */
export function prizeAreaOf(collectible) {
  return collectible.size[0] * collectible.size[2];
}

/**
 * How far away something of `area` is still a smudge -- the core's own
 * formula with the core's own constant, imported rather than retyped. A card
 * that advertised a different reach from the one the census uses would be a
 * menu lying about the game underneath it.
 */
export function noticeRangeOf(area) {
  return Math.sqrt(area / MIN_ANGLE);
}

/**
 * One line for the difficulty card: what this preset watches and how small it
 * makes the target. Both halves come from the same helpers the run uses.
 */
export function difficultySpec(preset, modes, collectible) {
  const cfg = guardCfgFor(preset, modes);
  const c = collectibleFor(preset, collectible);
  const cm = (v) => String(Math.round(v * 100));
  const watched = cfg
    ? `监控 ${fanArea(cfg.coneDeg, cfg.range).toFixed(1)} m²`
      + ` · ${Math.round(cfg.coneDeg)}° × ${cfg.range.toFixed(1)} m`
    : '无监控';
  return `${watched} · 红包 ${cm(c.size[0])}×${cm(c.size[2])} cm`
    + ` · ${noticeRangeOf(prizeAreaOf(c)).toFixed(1)} m 内可见`;
}
