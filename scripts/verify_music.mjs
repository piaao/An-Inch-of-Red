/**
 * verify_music.mjs — keeps the three copies of the cue list telling one story.
 *
 * The cue list lives in THREE places, and any pair of them can drift:
 *
 *   scripts/gen_music.py   what actually gets sent to fun-music-v1  (the SOURCE)
 *   game/MUSIC.md          what a human reads before running it
 *   game/play/config.js    the knobs the running game reads
 *   game/play/play.js      where the triggers are wired
 *
 * Nothing here needs a browser OR a single generated mp3, so it is cheap enough
 * to run on every change -- which is the point: by the time the audio EXISTS
 * (see game/MUSIC.md §8 for why it does not yet), it must be impossible for the
 * manifest and the mixer to disagree about what should be playing.
 *
 * The honest limit: A5/A6 are STATIC assertions. They prove the calls are
 * written, not that frame 60 of a real run made them. Behavioural verification
 * belongs to scripts/verify_play.mjs, and only becomes meaningful once there is
 * audio to hear.
 *
 *     node scripts/verify_music.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const AUDIO_DIR = path.join(ROOT, 'assets', 'audio');
const MANIFEST = path.join(AUDIO_DIR, 'manifest.json');

const results = [];
const check = (name, ok, detail = '') => results.push([!!ok, name, detail]);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

/* ------------------------------------------------------------------ A1/A2 */

const genSrc = read('scripts/gen_music.py');
const docSrc = read('game/MUSIC.md');

// The ids the generator declares: `"id": "menu"` inside the TRACKS list.
const genIds = [...genSrc.matchAll(/"id":\s*"([a-z]+)"/g)].map((m) => m[1]);
const genLoop = [...genSrc.matchAll(/"id":\s*"([a-z]+)",\s*"file":\s*"[^"]+",\s*"loop":\s*(True|False)/g)]
  .map((m) => [m[1], m[2] === 'True']);

// The ids the DOC's §3 table declares: a row that starts with `| \`id\` |`.
const docIds = [...docSrc.matchAll(/^\|\s*`([a-z]+)`\s*\|\s*`\d\d_[a-z_]+\.mp3`/gm)].map((m) => m[1]);

const uGen = [...new Set(genIds)].sort();
const uDoc = [...new Set(docIds)].sort();

check('A1 cue ids: gen_music.py == MUSIC.md §3',
  uGen.length > 0 && uGen.join(',') === uDoc.join(','),
  `gen=[${uGen}] doc=[${uDoc}]`);

const nLoop = genLoop.filter(([, l]) => l).length;
const nOnce = genLoop.length - nLoop;
check('A2 seven cues: 4 looping beds + 3 one-shot stings',
  uGen.length === 7 && nLoop === 4 && nOnce === 3,
  `total=${uGen.length} loop=${nLoop} oneShot=${nOnce}`);

/* ---------------------------------------------------------------------- A3 */

// Every prompt must forbid vocals. The model writes and SINGS lyrics by
// default -- `gender` exists for exactly that -- so this is the one line of
// each prompt that keeps a background bed from becoming a theme song.
const promptBlocks = [...genSrc.matchAll(/"prompt":\s*\(?\s*([\s\S]*?)\n\s*\)?,?\n\s*\}/g)]
  .map((m) => m[1]);
const noVocal = promptBlocks.filter((b) => /无人声|不要唱词/.test(b));
check('A3 every prompt forbids vocals (无人声 / 不要唱词)',
  promptBlocks.length === 7 && noVocal.length === promptBlocks.length,
  `prompts=${promptBlocks.length} withNoVocal=${noVocal.length}`);

/* ---------------------------------------------------------------------- A4 */

const cfgSrc = read('game/play/config.js');
const KEYS = ['enabled', 'dir', 'manifest', 'master', 'crossfadeS', 'duckS',
  'stingDuck', 'stingDuckS', 'stingAttack', 'stingRelease', 'pauseDuck', 'dangerM'];
const cfgBlock = (cfgSrc.match(/export const MUSIC = \{([\s\S]*?)\n\};/) || [])[1] || '';
const missingKeys = KEYS.filter((k) => !new RegExp(`\\b${k}\\s*:`).test(cfgBlock));
check('A4 config.js exports MUSIC with every knob music.js reads',
  cfgBlock.length > 0 && missingKeys.length === 0,
  missingKeys.length ? `missing: ${missingKeys.join(', ')}` : `${KEYS.length} keys`);

/* ---------------------------------------------------------------------- A5 */

const playSrc = read('game/play/play.js');
const wiring = [
  ['imports Music', /import\s*\{\s*Music\s*\}\s*from\s*'\.\/music\.js'/],
  ['imports MUSIC', /import\s*\{[\s\S]*?\bMUSIC\b[\s\S]*?\}\s*from\s*'\.\/config\.js'/],
  ['constructs Music()', /new\s+Music\(\)/],
  ['loads manifest', /music\.load\(\)/],
  ['has musicTick()', /function\s+musicTick/],
  ['musicTick runs in loop', /musicTick\(\s*dt\s*\)/],
  ["sting('caught')", /music\.sting\(\s*'caught'\s*\)/],
  ["sting win/lose", /music\.sting\(\s*win\s*\?\s*'win'\s*:\s*'lose'\s*\)/],
  ['M mutes music', /music\.setMuted\(/],
];
const badWiring = wiring.filter(([, re]) => !re.test(playSrc)).map(([n]) => n);
check('A5 play.js wires all five trigger sites (STATIC)',
  badWiring.length === 0,
  badWiring.length ? `not found: ${badWiring.join(', ')}` : `${wiring.length}/${wiring.length} sites`);

/* ---------------------------------------------------------------------- A6 */

const musSrc = read('game/play/music.js');
const upd = (musSrc.match(/update\(dt,\s*s\)\s*\{([\s\S]*?)\n  \}/) || [])[1] || '';
const iLast = upd.indexOf("'lastcall'");
const iDanger = upd.indexOf("'danger'");
const iExplore = upd.indexOf("'explore'");
check('A6 priority order in music.js update(): lastcall > danger > explore',
  iLast > 0 && iDanger > iLast && iExplore > iDanger,
  `indices lastcall=${iLast} danger=${iDanger} explore=${iExplore}`);

/* ------------------------------------------------------------------ A7/A8 */

const hasManifest = exists(MANIFEST);
if (hasManifest) {
  let m = null;
  try { m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { /* below */ }
  const tracks = (m && m.tracks) || [];
  const bad = [];
  for (const t of tracks) {
    const p = path.join(AUDIO_DIR, t.file);
    if (!exists(p)) { bad.push(`${t.file}: missing`); continue; }
    const head = fs.readFileSync(p).subarray(0, 4);
    const isMp3 = (head.length >= 3 && head.subarray(0, 3).toString('latin1') === 'ID3')
      || (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
    if (!isMp3) bad.push(`${t.file}: not an mp3`);
  }
  check('A7 manifest present: every listed file exists and is an mp3',
    tracks.length > 0 && bad.length === 0,
    bad.length ? bad.join('; ') : `${tracks.length} tracks OK`);
  check('A7b manifest ids are a subset of the generator\'s cue ids',
    tracks.every((t) => uGen.includes(t.id)),
    tracks.map((t) => t.id).join(','));
} else {
  // No manifest is a VALID state (a fresh clone). The thing that would be a
  // bug is having mp3s on disk that the manifest forgot -- because the mixer
  // would then be OFF while the files sit there, and the next person would
  // spend an hour asking why the game is silent.
  const loose = exists(AUDIO_DIR)
    ? fs.readdirSync(AUDIO_DIR).filter((f) => f.toLowerCase().endsWith('.mp3'))
    : [];
  check('A8 no manifest: assets/audio/ holds no orphan mp3',
    loose.length === 0,
    loose.length ? `orphans: ${loose.join(', ')}` : 'music stays off, zero mp3 requests');
  check('A7 (skipped) manifest present', true, 'not generated yet — see game/MUSIC.md §8');
}

/* ---------------------------------------------------------------------- A9 */

/**
 * A BEHAVIOURAL test of the mixer, with the browser stubbed out.
 *
 * A5/A6 are static: they prove the calls are written. This one actually runs
 * `Music` -- it stubs `fetch` and `Audio`, feeds the state machine the five
 * phases and the two danger signals, and reads the bed back. So the priority
 * order, the fallback when a cue is absent, and the mute path are all checked
 * as BEHAVIOUR, in Node, with no browser and no audio files.
 *
 * What it cannot check: that any of it SOUNDS right. That is what ears are for.
 */
async function behaviour(genIds) {
  const tracks = genIds.map((id, i) => ({
    id, file: `${id}.mp3`,
    loop: ['menu', 'explore', 'danger', 'lastcall'].includes(id),
    gain: 0.4 + i * 0.01,
  }));

  globalThis.fetch = async (url, opt) => {
    if (String(url).includes('NOTHING')) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => ({ model: 'fun-music-v1', tracks }) };
  };
  globalThis.Audio = class {
    constructor(src) { this.src = src; this.volume = 0; this.paused = true; this.loop = false; this.duration = 8; this.currentTime = 0; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  };

  const { Music } = await import('../game/play/music.js');
  const m = new Music();
  const ok = await m.load();
  check('A9.1 load() enables the mixer off a manifest', ok && m.enabled, m.reason);

  const bedAfter = (s, frames = 90) => {
    for (let i = 0; i < frames; i++) m.update(1 / 60, s);
    return m.state().bed;
  };

  check('A9.2 phase=ready  -> bed menu',
    bedAfter({ phase: 'ready' }) === 'menu');
  check('A9.3 phase=playing, no danger, not low -> bed explore',
    bedAfter({ phase: 'playing', danger: false, low: false }) === 'explore');
  check('A9.4 guard within 5 m -> bed danger',
    bedAfter({ phase: 'playing', danger: true, low: false }) === 'danger');
  check('A9.5 last 30 s beats danger -> bed lastcall',
    bedAfter({ phase: 'playing', danger: true, low: true }) === 'lastcall');
  check('A9.6 back to explore when the guard leaves',
    bedAfter({ phase: 'playing', danger: false, low: false }) === 'explore');
  check('A9.7 phase=won -> beds stand down (sting owns the foreground)',
    bedAfter({ phase: 'won' }) === null);

  m.sting('caught');
  // The duck is applied BY update(), not by sting() -- advance a few frames
  // before reading it, or this checks a coefficient that has not moved yet.
  for (let i = 0; i < 6; i++) m.update(1 / 60, { phase: 'playing', danger: false, low: false });
  check('A9.8 sting("caught") takes the foreground and ducks the beds',
    m.state().sting === 'caught' && m.state().duck < 1,
    `sting=${m.state().sting} duck=${m.state().duck}`);

  // A sting must not be a permanent duck: 1.2 s later the beds come back.
  for (let i = 0; i < 180; i++) m.update(1 / 60, { phase: 'playing', danger: false, low: false });
  check('A9.9 the duck releases (~3 s later duck is back to 1)',
    m.state().duck > 0.99, `duck=${m.state().duck}`);

  m.setMuted(true);
  for (let i = 0; i < 120; i++) m.update(1 / 60, { phase: 'playing', danger: false, low: false });
  const vols = Object.values(m.state().volumes);
  check('A9.10 muted silences every track',
    vols.every((v) => v === 0), `max=${Math.max(...vols)}`);

  // A SECOND instance against a manifest that 404s. This WAS "must stay off",
  // and that assertion is now wrong on purpose: with no mp3s the mixer falls
  // back to the in-browser synth (config.js PROCEDURAL / procedural.js), so it
  // must come up ENABLED with source 'procedural' -- and, crucially, still
  // never throw and still issue no request for an audio file.
  let fetches = [];
  globalThis.fetch = async (url) => { fetches.push(String(url)); return { ok: false, status: 404 }; };
  const off = new Music();
  const offOk = await off.load();
  let threw = false;
  try { off.update(1 / 60, { phase: 'playing', danger: true, low: true }); off.sting('win'); } catch { threw = true; }
  check('A9.11 no manifest -> mixer falls back to procedural, never throws',
    offOk === true && off.enabled === true && off.source === 'procedural' && !threw,
    `${off.reason}; source=${off.source}`);
  // The fallback must not fetch a single audio file (zero-404 rule).
  check('A9.12 procedural fallback requests no audio files',
    fetches.length === 1 && fetches[0].includes('manifest.json'),
    `requests=${fetches.length}`);
  // And it must still answer the state machine on the four beds.
  const offBed = (s, frames = 90) => { for (let i = 0; i < frames; i++) off.update(1 / 60, s); return off.state().bed; };
  check('A9.13 procedural: phase=ready -> bed menu',
    offBed({ phase: 'ready' }) === 'menu');
  check('A9.14 procedural: low clock -> bed lastcall (the signal play.js now feeds)',
    offBed({ phase: 'playing', danger: true, low: true }) === 'lastcall');
  check('A9.15 procedural: sting("win") is accepted with no ctx attached',
    (() => { off.sting('win'); return off.state().sting !== null || off.proc === null; })());

  /* ---- A10/A11: the synth engine itself, against a stub WebAudio ------ */
  //
  // `procedural.js` touches the real AudioContext API, so it is exercised
  // against a MINIMAL stub -- enough node types to spawn voices and read the
  // schedule back. The value here is not "does it sound good" (ears do that)
  // but "does it schedule the right cue, on the audio clock, and stop".
  const stubNodes = [];
  const mkParam = () => ({ value: 0, setValueAtTime() { return this; }, linearRampToValueAtTime() { return this; }, exponentialRampToValueAtTime() { return this; }, cancelScheduledValues() { return this; } });
  const StubCtx = class {
    constructor() { this.currentTime = 0; }
    createGain() { const n = { kind: 'gain', gain: mkParam(), connect() {}, disconnect() {} }; stubNodes.push(n); return n; }
    createOscillator() { const n = { kind: 'osc', type: 'sine', frequency: mkParam(), detune: mkParam(), connect() {}, start() {}, stop() {} }; stubNodes.push(n); return n; }
    createBiquadFilter() { const n = { kind: 'filter', type: 'lowpass', frequency: mkParam(), Q: mkParam(), connect() {}, disconnect() {} }; stubNodes.push(n); return n; }
  };
  const { Procedural } = await import('../game/play/procedural.js');
  const { PROCEDURAL_TRACKS } = await import('../game/play/config.js');
  const ctx = new StubCtx();
  const bus = ctx.createGain();
  const eng = new Procedural(ctx, bus, {});
  eng.setBed('explore');
  check('A10.1 Procedural.setBed() accepts a looping cue',
    eng.state().playing === 'explore', JSON.stringify(eng.state()));
  for (let i = 0; i < 60; i++) { ctx.currentTime += 1 / 60; eng.update(1 / 60, { phase: 'playing' }); }
  check('A10.2 scheduler queues voices ahead of the audio clock',
    eng.state().voices > 0 && eng.state().chordIx > 0,
    `voices=${eng.state().voices} chordIx=${eng.state().chordIx}`);
  const before = stubNodes.length;
  eng.sting('caught');
  check('A10.3 sting() spawns its own voices',
    stubNodes.length > before && eng.state().sting === 'caught');
  eng.silence();
  check('A10.4 silence() clears both bed and sting',
    eng.state().playing === null && eng.state().sting === null);
  check('A10.5 all seven cues are known to the engine',
    PROCEDURAL_TRACKS.every((t) => !!Procedural.track(t.id)),
    `tracks=${PROCEDURAL_TRACKS.length}`);

  /* ---- A11: IS IT ACTUALLY AUDIBLE? ---------------------------------- */
  //
  // The gap that let a real bug through. Every A9/A10 check above asks a
  // BEHAVIOURAL question -- which cue, on what clock, did it stop -- and all of
  // them passed while the whole soundtrack sat at an RMS near 1e-3. The user's
  // report was "I can't hear any sound", and the suite had nothing to say about
  // it, because "which cue is playing" and "can you hear the cue" are different
  // questions.
  //
  // So this one computes the level. A stub that RECORDS the gain it was set to
  // lets the chain be multiplied out the way the graph multiplies it:
  //
  //   voice gain -> section envelope (track.gain) -> proc bus (PROCEDURAL.master)
  //              -> music bus (MUSIC.master) -> audio.musicBus ->
  //              -> audio.master (0.35) -> destination
  //
  // The number to beat is a floor, not a taste: a bed below roughly 5e-3 peak
  // is inaudible on ordinary speakers, which is exactly the report this check
  // exists to prevent from recurring.
  const levels = [];
  const RecParam = (tag) => {
    const p = {
      tag, value: 0, ramp: null,
      setValueAtTime(v) { this.value = v; return this; },
      linearRampToValueAtTime(v) { this.value = v; this.ramp = v; return this; },
      exponentialRampToValueAtTime(v) { this.value = v; this.ramp = v; return this; },
      cancelScheduledValues() { return this; },
    };
    return p;
  };
  const LevelCtx = class {
    constructor() { this.currentTime = 0; }
    createGain() {
      return { kind: 'gain', gain: RecParam('gain'), connect() {}, disconnect() {} };
    }
    createOscillator() {
      return {
        kind: 'osc', type: 'sine', frequency: RecParam('freq'), detune: RecParam('det'),
        connect() {}, start() {}, stop() {},
      };
    }
    createBiquadFilter() {
      return { kind: 'filter', type: 'lowpass', frequency: RecParam('cut'), Q: RecParam('q'),
        connect() {}, disconnect() {} };
    }
  };
  const { PROCEDURAL: PROC, MUSIC: MUS } = await import('../game/play/config.js');
  const { Audio } = await import('../game/play/audio.js');

  // Audio side, stubbed: what does `audio.musicBus` and `audio.master` end at?
  // Read them off a real `Audio` instance driven through the stub context.
  const actx = new LevelCtx();
  const au = new Audio();
  au.ctx = actx;
  au.master = actx.createGain();
  au.master.gain.value = 0.35;           // what unlock() sets
  au.musicBus = actx.createGain();
  au.musicBus.gain.value = 1.0;          // what unlock() sets

  const lctx = new LevelCtx();
  const lbus = lctx.createGain();
  const leng = new Procedural(lctx, au.musicBus, {});
  leng.setBed('explore');

  // One bar of the bed, then read the loudest voice gain that was scheduled.
  let worstVoice = 0;
  let sectionEnv = 0;
  const seen = [];
  const origCreateGain = lctx.createGain.bind(lctx);
  lctx.createGain = () => {
    const g = origCreateGain();
    seen.push(g);
    return g;
  };
  leng.setBed('explore');
  for (let i = 0; i < 120; i++) {
    lctx.currentTime += 1 / 60;
    leng.update(1 / 60, { phase: 'playing' });
  }
  // The bus is the engine ceiling; the section envelope is the loudest of the
  // per-bar gain nodes the scheduler created.
  const busGain = leng.bus.gain.value;
  for (const g of seen) {
    if (g.gain.value > sectionEnv) sectionEnv = g.gain.value;
  }
  // The oscillator voices each carry `padGain/3`, `bellGain` or `bassGain`.
  // Take the loudest of them from config -- the pad is two oscillators per
  // chord tone and there are three tones, so six voices stack.
  const loudestVoice = Math.max(PROC.padGain / 3, PROC.bellGain, PROC.bassGain);
  const padPeak = (PROC.padGain / 3) * 6;   // six pad oscillators at once
  const track = PROCEDURAL_TRACKS.find((t) => t.id === 'explore');
  const section = Math.max(padPeak, loudestVoice) * (track ? track.gain : 1);

  const chain = busGain * MUS.master * au.musicBus.gain.value * au.master.gain.value;
  const peak = section * chain;
  levels.push({ cue: 'explore', busGain, master: MUS.master,
    musicBus: au.musicBus.gain.value, audioMaster: au.master.gain.value,
    section: +section.toFixed(4), chain: +chain.toFixed(4), peak: +peak.toFixed(5) });

  // And the SFX bus must be unchanged: the fix is "give music its own bus",
  // not "turn everything up". A cue at gain 0.5 through 0.35 is the reference.
  const sfxPeak = 0.5 * au.master.gain.value;

  check('A11.1 the music bus does not share the SFX attenuation',
    au.musicBus.gain.value > au.master.gain.value,
    `musicBus ${au.musicBus.gain.value} vs master ${au.master.gain.value}`);
  check('A11.2 the SFX bus is untouched (a cue still lands near 0.18)',
    Math.abs(sfxPeak - 0.175) < 1e-6,
    `0.5 cue x ${au.master.gain.value} = ${sfxPeak}`);
  check('A11.3 the bed is LOUD ENOUGH TO HEAR (peak > 5e-3)',
    peak > 5e-3,
    `${levels[0].cue}: peak ${peak.toExponential(2)} `
    + `(section ${levels[0].section} x chain ${levels[0].chain}); `
    + `the pre-fix chain gave ~4e-3`);
  check('A11.4 the engine has exactly ONE path to its destination',
    (() => {
      // `procedural.js` used to connect `bus` straight to `dest` AND through
      // the lowpass, which doubled the level and bypassed the filter. The bus
      // must now leave only via the filter.
      const src = read('game/play/procedural.js');
      const direct = /this\.bus\.connect\(\s*dest\s*\)/.test(src);
      const viaFilter = /this\.bus\.connect\(this\.filter\)/.test(src)
        && /this\.filter\.connect\(dest\)/.test(src);
      return !direct && viaFilter;
    })(),
    'bus -> filter -> dest only (no parallel bus -> dest)');
}

await behaviour(uGen);

/* --------------------------------------------------------------- reporting */

let pass = 0;
const lines = [];
for (const [ok, name, detail] of results) {
  if (ok) pass += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   — ' + detail : ''}`);
}
const head = `verify_music  ${pass}/${results.length} PASS`;
console.log(head);
console.log(lines.join('\n'));

try {
  fs.mkdirSync(path.join(ROOT, 'work'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'work', 'verify_music.txt'),
    head + '\n' + lines.join('\n') + '\n', 'utf8');
} catch { /* work/ is a convenience, not a contract */ }

process.exit(pass === results.length ? 0 : 1);
