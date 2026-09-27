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
  // rad per pixel of pointer-lock movement. The player's words were "鼠标太灵敏，
  // 一转就过头" and 0.0021 is a lot at any resolution: a 400 px flick swung the view
  // 0.84 rad -- 48 degrees -- so aiming at a 0.42 m packet across the room was a
  // twitch, not a turn. 0.0015 is a 29 % cut (400 px -> 34 deg), which keeps a slow
  // sweep of the room comfortable while still crossing the flat in one motion.
  //
  // THIS IS A RENDERER-ONLY DIAL, and the rule in the header says why it is safe
  // to move: `mouseSens` is read by `avatar.js` alone, from the pointer-lock delta
  // -- the headless harness drives `turn` (turnRate) instead, and `stepSim` never
  // sees it. So no measured win rate moves when this changes; only the hand.
  mouseSens: 0.0015,       // rad per pixel of pointer-lock movement (was 0.0021)
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
 *
 * ============================================================ REVISION 2 ===
 * THE LADDER ABOVE IS NOW A HISTORICAL READING, and every `ai` string below
 * says so. Two things changed at once and both invalidate it:
 *
 *   1. The 红包 got smaller. `fromLayout.js` now builds an 11.5 x 7.2 cm
 *      packet where it used to build a 16 x 10 cm one, and `noticeRange` is
 *      `sqrt(area / MIN_ANGLE)` -- so EVERY preset's target is now harder to
 *      notice, including 标准, which had not otherwise moved.
 *   2. The rungs became a ladder of GARRISONS and PRIZES, not just of cones:
 *      见习 now runs a (weak) guard at all, and 紧张/硬核 run TWO guards over
 *      12 and 24 packets. The old rows were taken with one guard over six.
 *
 * So the numbers in `ai` are kept as the readings they are, marked with the
 * configuration they were taken under. Re-measuring is `measure_surveil.mjs`
 * with this table's own garrisons and packet count; until that runs, no card
 * may quote these as its own win rate. The rule in the header stands: a preset
 * may not quote a number it did not measure -- and it may not keep quoting one
 * taken under a configuration that no longer exists.
 */
export const DIFFICULTIES = [
  {
    id: 'solo', name: '见习', budget: 240,
    guard: 'patrol', guards: 1, prizeCount: 6,
    // The narrowest fan on the ladder (74° / 4.2 m at 0.8x -> 59° / 3.4 m).
    // 见习 used to have NO guard; a rung with nothing on it taught the
    // controls and nothing about the game, and the first thing every player
    // asked for was "where is it". It is still the quietest thing to walk
    // past on this ladder, which is what keeps the ladder a ladder.
    surveil: 0.80, prizeScale: 1.15,      // packet 13.2 x 8.3 cm
    blurb: '男主人一个人在家，走得慢、看得近（扇区收窄至 0.8×）。红包比平时大一圈，先把六个房间走熟。',
    ai: '⚠ 旧配置（无守卫 / 6 红包 / 16×10 cm）240 s：66.7 %，收集 5.67/6 —— 本档已有守卫，'
      + '且红包尺寸已缩小，此数作废，待按新配置重测（scripts/README「五条教训」1、VERDICT §6.2 REVISION 3）',
  },
  {
    id: 'patrol', name: '标准', budget: 180,
    guard: 'patrol', guards: 1, prizeCount: 6,
    surveil: 1.00, prizeScale: 1.00,      // the measured base. do not move.
    blurb: '男主人一个人绕全屋走，在你附近停下来左右扫视。',
    ai: '⚠ 旧配置（1 守卫 / 6 红包 / 16×10 cm）180 s：无守卫 66.7 % → 有巡逻 33.3 %'
      + '（−33.4 pt，被抓 2.08 次；24 种子，§6.2）。红包尺寸已缩小，此数作废，待重测',
  },
  {
    id: 'tight', name: '紧张', budget: 180,
    guard: 'patrol', guards: 2, prizeCount: 12,
    surveil: 1.19, prizeScale: 0.85,      // 74°/4.2 m -> 88°/5.0 m (11.4 -> 19.2 m2)
    blurb: '男主人与女主人分头绕屋，监控扇区也更宽更远；红包十二个，每个都小一圈。',
    ai: '⚠ 旧配置（1 守卫 / 6 红包 / 16×10 cm）180 s：29.2 % 胜，收集 4.88/6，被抓 1.96 次'
      + '（24 种子，§6.2）。本档现为 2 守卫 / 12 红包，此数作废，待重测',
  },
  {
    id: 'hunter', name: '硬核', budget: 180,
    guard: 'hunter', guards: 2, prizeCount: 24,
    surveil: 1.00, prizeScale: 0.70,      // base 96°/6.0 m, packet 8.1 x 5.0 cm
    blurb: '男女主人视野更宽、跑得更快；二十四个红包，每个只有一张名片大。',
    ai: '⚠ 旧配置（1 守卫 / 6 红包 / 16×10 cm）180 s：12.5 % 胜，收集 3.54/6，被抓 3.21 次'
      + '（24 种子，§6.2）。本档现为 2 守卫 / 24 红包，此数作废，待重测',
  },
];

/** Which preset the start overlay opens on. */
export const DEFAULT_DIFFICULTY = 'patrol';

/**
 * The DEFAULT 红包 count -- 6 over 6 rooms, held equal to the verified
 * pipeline's count. A preset may raise it (`prizeCount`); nothing may lower it
 * below the number of rooms, because "one hidden in every room" is what makes
 * a sweep of the flat a strategy rather than a gamble.
 */
export const PRIZE_COUNT = 6;

/** How many guards this preset garrisons. `guard` names the MODE they share. */
export function guardCountFor(preset) {
  if (!preset || !preset.guard) return 0;
  // THE FLOOR OF 1 IS DELIBERATE: a preset cannot express "no guard" through
  // this table -- `guards: 0` is silently coerced to 1. Standing the garrison
  // down is a TEST HOOK on the play layer (`begin(id, { guards: 0 })`), not a
  // table entry. That is what keeps "见习 has a guard" a design decision
  // instead of an accident of how a default happened to be spelled.
  return Math.max(1, preset.guards || 1);
}

/** How many 红包 this preset hides. Falls back to the verified 6. */
export function prizeCountFor(preset) {
  return (preset && preset.prizeCount) || PRIZE_COUNT;
}

/** Re-render the guard's vision fan this often, in seconds. */
export const CONE_HZ = 30;

/** HUD-ish pacing. */
export const FEEL = {
  hintFadeAfter: 9,        // s before the controls line dims
  caughtFlash: 0.55,       // s of red flash
  lowTime: 30,             // s at which the clock turns red
  toastMs: 1500,
};

/* --------------------------------------------------------------- actors */

/**
 * 男女主人：屋里那两个人。
 *
 * 素材是 KayKit Adventurers 的 Knight 与 Rogue（CC0），由
 * `scripts/build_actors.py` 裁成五条剪辑后收进 `assets/actors/`。为什么是这一套、
 * 裁掉了什么、量出来多少，都在 `game/ACTORS.md` 与 `data/actors.json` 里。
 *
 * **这里没有一个是"影响胜率"的旋钮。** 主人走多快、看多远、罚多久，全部由
 * `GUARD_MODES` 与难度卡决定；下面这些只决定"看起来像不像人"：
 * 播哪条剪辑、交叉淡入多久、贴多近挥拳。要动真格，请先读 `game/ACTORS.md` §5。
 */
export const HOSTS = {
  enabled: true,
  manifest: 'data/actors.json',

  // 状态名 -> 源剪辑名。左边是本项目状态机的四个状态（+ 一个受惊过渡），
  // 右边是素材里量出来的剪辑名（`data/actors.json` 的 `clips`）。
  clips: {
    idle: 'idle',        // 待机：站住、扫视
    walk: 'walk',        // 行动：在巡逻路上走
    run: 'run',          // 奔跑：追你
    strike: 'strike',    // 打击：空手挥拳
    startle: 'startle',  // 受惊：第一次看见你时那一下
  },

  // 模型局部正面是 +Z（量出来的，见 `scripts/build_actors.py` 的 FRONT_AXIS），
  // 而 `GuardActor.group` 的约定是"局部正面 = +X"（视锥与聚光灯都照这个摆）。
  // +pi/2 把模型的 +Z 拧成组内的 +X，于是"哪边是前"仍然只有一个来源。
  modelYaw: Math.PI / 2,

  fade: 0.16,          // s，状态之间的交叉淡入
  strikeRange: 0.62,   // m，追击时贴到这个距离就出手（渲染层加注，不改物理）
  strikeCooldown: 1.4, // s，两次挥拳之间至少隔这么久
  startleFor: 0.44,    // s，受惊那一下演多久
  // s，两次"受惊"之间至少隔这么久。**这不是手感调料，是量出来的必需项。**
  // 核心的 `spot` 事件发的是"视线由断到通"的那一帧，而主人一边走一边被家具挡，
  // 视线会一闪一灭 —— 实测在 2 m 处吊住玩家，`spot` 会在 240 帧里触发 176 帧的
  // 受惊（73 %），把待机、行动、奔跑全顶掉，看着像在打摆子。加冷却后同一次
  // 追捕里只激灵一次，后面的反复"看见"由 alert/run 自己表达。
  startleCooldown: 2.5,
  stillAfter: 0.35,    // s，位移小于阈值的沉默超过这么久就算"站着"

  // 一个循环走几个身高（见 `HostBody._cadence` 里写明的取舍）。
  stridePerHeight: { walk: 0.95, run: 1.60 },
  maxTimeScale: 1.9,
  timeScaleCap: { walk: 1.9, run: 1.7 },
};

/* --------------------------------------------------------------- music */

/**
 * The music mixer. Seven generated cues (`game/MUSIC.md`, produced by
 * `scripts/gen_music.py`), routed through ONE bus in `music.js`.
 *
 * NOTHING HERE DECIDES WHETHER YOU WIN, so unlike everything above it is free
 * to be tuned by ear. The two numbers that DO touch play are read from the
 * state the run already computes -- `dangerM` against the guard's position and
 * `lowSeconds` against the clock -- and neither feeds back into the sim.
 *
 * `lowSeconds` is deliberately `FEEL.lowTime`: the moment the clock turns red
 * is the same moment the sprint cue comes in. Two definitions of "nearly out
 * of time" is how a HUD and a soundtrack start telling different stories.
 *
 * THE TRACKS ARE OPTIONAL AND THE GAME MUST NOT CARE. They are the only
 * binaries this repo would ship, so they are generated rather than committed,
 * and `music.js` loads them ONLY if `assets/audio/manifest.json` is present.
 * Absent manifest = the mixer stays off and not one mp3 is requested. That
 * keeps `verify_play.mjs`'s clean-console rule true on a fresh clone.
 */
export const MUSIC = {
  enabled: true,
  dir: 'assets/audio/',
  manifest: 'assets/audio/manifest.json',

  // The music bus level. NOT the SFX bus: `audio.js` keeps 0.35 for cues, and
  // the soundtrack gets its own unity bus (`audio.musicBus`) instead of being
  // attenuated twice. Measured before the fix: the whole bed landed at an RMS
  // near 1e-3 -- half of a "there is no sound" bug report. See `unlock()`.
  master: 1.0,
  crossfadeS: 1.1,         // s for one bed to replace another
  duckS: 0.22,             // s for the duck coefficient to reach its target

  // A sting (caught / win / lose) is a one-shot that owns the foreground.
  stingDuck: 0.34,         // beds fall to this fraction while a sting rings
  stingDuckS: 1.2,         // how long they stay down
  stingAttack: 0.06,       // s fade-in on the sting itself
  stingRelease: 0.70,      // s fade-out at the sting's tail

  pauseDuck: 0.30,         // beds fall to this while paused

  // Danger: the guard is close, or it has already noticed you. 5.0 m is
  // deliberately ABOVE the base cone's 4.2 m range -- the music should tighten
  // as the light approaches, before it can actually see you, so it reads as
  // your nerves rather than as a second detection channel.
  dangerM: 5.0,
};

/**
 * The procedural fallback: the SAME seven cues, synthesised in the browser.
 *
 * WHY THIS EXISTS. `fun-music-v1` and `fun-music-preview` are both invitation-
 * only and the account is in free-tier-only mode, so the generated mp3s cannot
 * be produced yet (game/MUSIC.md §8). Rather than ship silence, `music.js` now
 * synthesises the beds and stings itself, on the ONE `AudioContext` that
 * `audio.js` already owns. Nothing is fetched, so the zero-404 rule is intact
 * and a fresh clone is still silent-free by construction.
 *
 * HOW IT SOUNDS: not a loop of samples but a SCHEDULED ensemble. Each bed is a
 * chord progression written out as a small table (root semitone + triad quality),
 * played by three plain oscillators (a mild saw "pad", a triangle "bell" and a
 * sine "bass") with a per-chord envelope. The lookahead scheduler in `music.js`
 * queues the next bar ~25 ms ahead of `ctx.currentTime`, which is what keeps it
 * on the audio clock instead of the frame clock -- a rhythm driven by rAF would
 * wobble every time a guard update ate a frame.
 *
 * NOTHING HERE DECIDES WHETHER YOU WIN. Like `MUSIC` above it is free to be
 * tuned by ear; the four state signals it reads (phase / danger / low / sting)
 * all come from the run's own state and only select which bed is playing.
 *
 * KEEP `tracks` IN STEP WITH `scripts/gen_music.py`. The stinger/bed split is
 * the same seven ids the generator and MUSIC.md §3 declare, and
 * `scripts/verify_music.mjs` A1 still checks those two against each other.
 * When the mp3s finally exist, `music.js` prefers them and this whole block
 * becomes a fallback that never runs -- which is the point.
 */
export const PROCEDURAL = {
  enabled: true,
  master: 1.0,             // this bus's ceiling; the final level is MUSIC.master * this

  // ---- the ensemble -----------------------------------------------------
  // THESE NUMBERS ARE A LEVEL, NOT A TASTE. A bed is six saw oscillators at
  // `padGain / 3` each (plus a bell and a bass), so the pad's peak is roughly
  // its own value, not a third of it. At 0.045 the product of the whole chain
  // -- pad x track.gain x 6 voices x this bus x MUSIC.master x audio.master --
  // came to about 4e-3: audible only with the speaker against your ear. Raised
  // so the bed's RMS sits near 0.02-0.03 with the SFX bus untouched.
  padGain: 0.20,           // sustained saw, the room's "air"
  padDetune: 3.0,          // cents between the two pad oscillators (the chorus)
  bellGain: 0.10,          // triangle that walks the chord
  bassGain: 0.26,          // sine on the root, one octave down
  attack: 0.35,            // s, per-voice fade-in
  release: 0.45,           // s, per-voice fade-out at the tail

  // ---- the scheduler ----------------------------------------------------
  lookahead: 0.08,         // s of audio queued ahead of now each tick
  tickHz: 30,              // how often we top the queue up (cheap; not the frame rate)

  // ---- danger tension ---------------------------------------------------
  tensionDepth: 4.0,       // semitones the "danger" bed leans sharp-ish by
  lowTempo: 1.12,          // lastcall plays its bar this much faster

  // ---- the stings -------------------------------------------------------
  // One-shots. `dur` is only a guardrail -- like the mp3 path, the voice list
  // is what actually ends them.
  stings: {
    caught: { dur: 0.75 },
    win: { dur: 1.6 },
    lose: { dur: 1.4 },
  },
};

/**
 * The seven cues, as DATA: the id, whether it loops, and the chord table.
 *
 * A chord is `[rootSemitoneFromC, quality]` where quality indexes `CHORDS`
 * below. Reading them as numbers rather than note names is what lets a bed
 * transpose (menu sits under C4, danger sits on the same shapes a tritone up)
 * without rewriting the melody as text.
 *
 * `menu` is warm and unresolved (a slow I–vi–IV–V that never quite lands on
 * the tonic for long); `explore` is the same key, moving; `danger` is the
 * same motion with a low minor-second drone under it; `lastcall` is danger
 * with the tempo pushed and the bass walking down. The stings are one-liners.
 */
const CHORDS = {
  // semitone offsets within an octave, for the triad
  maj: [0, 4, 7],
  min: [0, 3, 7],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  sus: [0, 5, 7],
  dim: [0, 3, 6],
};

/** Cue table. `root` is a MIDI note; `chords` are [semi, quality] pairs. */
export const PROCEDURAL_TRACKS = [
  { id: 'menu', loop: true, root: 60, gain: 0.55, bpm: 76,
    chords: [[0, 'maj7'], [-3, 'min7'], [5, 'maj'], [7, 'maj']] },
  { id: 'explore', loop: true, root: 57, gain: 0.48, bpm: 92,
    chords: [[0, 'min7'], [8, 'maj'], [5, 'min7'], [3, 'maj']] },
  { id: 'danger', loop: true, root: 55, gain: 0.52, bpm: 104,
    chords: [[0, 'min'], [-1, 'min'], [0, 'min'], [1, 'min']] },
  { id: 'lastcall', loop: true, root: 55, gain: 0.55, bpm: 120,
    chords: [[0, 'min'], [5, 'min'], [3, 'dim'], [-2, 'maj']] },
  { id: 'caught', loop: false, root: 52, gain: 0.6, bpm: 0,
    chords: [[0, 'dim'], [-6, 'dim']] },
  { id: 'win', loop: false, root: 60, gain: 0.6, bpm: 0,
    chords: [[0, 'maj'], [4, 'maj'], [7, 'maj'], [12, 'maj7']] },
  { id: 'lose', loop: false, root: 55, gain: 0.6, bpm: 0,
    chords: [[0, 'min'], [-5, 'maj'], [-7, 'min']] },
];

/** Semitone offset -> Hz, anchored at A4 = 440 (MIDI 69). */
export function midiHz(midi, semis = 0) {
  return 440 * Math.pow(2, (midi + semis - 69) / 12);
}

/** The triad for a quality name, as semitone offsets. */
export function chordTones(quality) {
  return CHORDS[quality] || CHORDS.maj;
}

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
  const n = guardCountFor(preset);
  const cm = (v) => String(Math.round(v * 100));
  // The garrison and the prize count are the two things a player is choosing
  // between, so they are printed FIRST -- a card whose headline number is the
  // cone area buries the decision under its units.
  const watched = cfg
    ? `${n} 位主人 · 监控 ${fanArea(cfg.coneDeg, cfg.range).toFixed(1)} m²`
      + ` · ${Math.round(cfg.coneDeg)}° × ${cfg.range.toFixed(1)} m`
    : '无监控';
  return `${watched} · 红包 ${prizeCountFor(preset)} 个（${cm(c.size[0])}×${cm(c.size[2])} cm，`
    + `${noticeRangeOf(prizeAreaOf(c)).toFixed(1)} m 内可见）`;
}
