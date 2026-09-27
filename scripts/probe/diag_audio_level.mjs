/**
 * diag_audio_level.mjs — measure the soundtrack's REAL samples, headless.
 *
 * Headless Chrome has no sound card, so tapping a live AnalyserNode gives
 * silence regardless of how loud the graph really is. The way to measure actual
 * samples without a device is an OfflineAudioContext: render the graph to a PCM
 * buffer and read the floats. That is the strongest evidence available in this
 * environment -- not "the gains multiply to 6.7e-2" but "here is the waveform".
 *
 * The live path is checked too (context state, node wiring), just not for level.
 *
 * Usage:  node scripts/diag_audio_level.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cdp = require('../cdp.js');
const { serve, launch, attach, killStrayChrome } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8795;
const DEBUG = 9240;

const server = await serve(ROOT, PORT);
const chrome = await launch({ port: DEBUG, userDataDir: 'C:/Users/Public/cdpprofile_diagaud2' });
try {
  const sess = await attach({ port: DEBUG });
  await sess.goto(`http://127.0.0.1:${PORT}/play.html`, { settle: 3000 });
  for (let i = 0; i < 60; i++) {
    const ok = await sess.evalJs('typeof __play !== "undefined"');
    if (ok) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const out = await sess.evalAsync(`
    const { Procedural } = await import('/game/play/procedural.js');
    const { PROCEDURAL, MUSIC } = await import('/game/play/config.js');
    const { Audio } = await import('/game/play/audio.js');

    // --- 1. the live graph, for WIRING only --------------------------------
    const au = __play.audio;
    const unlocked = __play.unlockAudio();
    const liveInfo = {
      unlocked,
      ctxState: au && au.ctx ? au.ctx.state : null,
      hasMusicBus: !!(au && au.musicBus),
      musicBusGain: au && au.musicBus ? au.musicBus.gain.value : null,
      masterGain: au && au.master ? au.master.gain.value : null,
      musicSource: __play.music ? __play.music.state().source : null,
      musicBed: __play.music ? __play.music.state().bed : null,
    };

    // --- 2. the same engine, rendered OFFLINE to real samples --------------
    const sr = 44100;
    const seconds = 3.0;
    const octx = new OfflineAudioContext(1, Math.round(sr * seconds), sr);
    // The same downstream shape the live path has, minus the two buses we are
    // MEASURING (those are folded in as scalars so the rendered buffer shows
    // what actually reaches the speakers' side of musicBus).
    const pre = octx.createGain();
    pre.gain.value = 1;                       // stands in for audio.musicBus
    pre.connect(octx.destination);

    // A lowpass at the same cutoff procedural.js installs, so the rendered
    // waveform is what the filter passes, not a raw saw.
    const eng = new Procedural(octx, pre, {});
    eng.setBed('explore');
    // Drive the scheduler across the whole render window. currentTime does not
    // advance in offline mode, so schedule manually against a synthetic clock.
    for (let i = 0; i < Math.ceil(seconds * 60); i++) {
      // Fake the audio clock forward so the scheduler tops the queue up.
      Object.defineProperty(octx, 'currentTime', { value: i / 60, configurable: true });
      eng.update(1 / 60, { phase: 'playing' });
    }

    const rendered = await octx.startRendering();
    const data = rendered.getChannelData(0);
    let peak = 0, sumSq = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / data.length);

    // What reaches the SPEAKER: fold in the two scalars we left out.
    const tail = (au && au.musicBus ? au.musicBus.gain.value : 1)
      * (au && au.master ? au.master.gain.value : 0.35);
    return {
      live: liveInfo,
      offline: {
        seconds, sampleRate: sr,
        frames: data.length,
        peak: +peak.toFixed(6),
        rms: +rms.toFixed(6),
        nonzeroFrac: +(data.reduce((n, v) => n + (v === 0 ? 0 : 1), 0) / data.length).toFixed(4),
        atSpeaker: { peak: +(peak * tail).toFixed(6), rms: +(rms * tail).toFixed(6) },
        tailScalar: +tail.toFixed(4),
        procState: eng.state(),
      },
      config: { padGain: PROCEDURAL.padGain, bellGain: PROCEDURAL.bellGain,
                bassGain: PROCEDURAL.bassGain, procMaster: PROCEDURAL.master,
                musicMaster: MUSIC.master },
    };
  `);

  console.log(JSON.stringify(out, null, 2));
} finally {
  await chrome.kill();
  await killStrayChrome();
  if (server && server.close) server.close();
}
