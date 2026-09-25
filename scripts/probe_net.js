/**
 * probe_net.js — why does exactly one .glb report net::ERR_ABORTED?
 *
 * The verification run is otherwise clean, so this needs evidence rather than
 * a theory. It reloads the page with Network recording on and dumps:
 *   - every URL requested more than once (a duplicate fetch is the classic
 *     source of an ERR_ABORTED, because the browser cancels the loser);
 *   - every loadingFailed event with its initiator, type and any response that
 *     had already arrived;
 *   - the kitchenBar family specifically, since that is the one the report
 *     names, alongside a list of any .glb that never got a 200.
 *
 * Read-only: it writes no project files.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { serve, launch, attach, killStrayChrome, sleep } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8778;
const DEBUG = 9225;

const short = (u) => String(u || '?').replace(/^https?:\/\/[^/]+/, '').replace(/\?_=\d+$/, '');

(async () => {
  await killStrayChrome();
  const server = await serve(ROOT, PORT);
  const chrome = await launch({ port: DEBUG, gl: 'gpu', userDataDir: 'C:/Users/Public/cdpprofile_net' });
  let sess;
  try {
    sess = await attach({ port: DEBUG });
    await sess.viewport(1200, 800);
    await sess.goto(`http://127.0.0.1:${PORT}/index.html`, { settle: 3000 });

    for (let i = 0; i < 60; i++) {
      if (await sess.evalJs('!!window.__ready') === true) break;
      await sleep(1000);
    }
    const ready = await sess.evalJs('!!window.__ready');
    await sleep(1200);   // let any straggler request settle or cancel

    const sends = new Map();     // requestId -> request meta
    const resps = new Map();     // requestId -> response meta
    const fin = new Map();       // requestId -> total bytes actually delivered
    const fails = [];

    for (const e of sess.events) {
      const p = e.params || {};
      if (e.method === 'Network.requestWillBeSent' && p.request) {
        sends.set(p.requestId, {
          url: p.request.url, method: p.request.method, type: p.type,
          ts: p.timestamp, initiator: (p.initiator && p.initiator.type) || '?',
        });
      } else if (e.method === 'Network.responseReceived') {
        resps.set(p.requestId, {
          status: p.response.status, mime: p.response.mimeType,
          fromDiskCache: !!p.response.fromDiskCache,
        });
      } else if (e.method === 'Network.loadingFinished') {
        fin.set(p.requestId, p.encodedDataLength);
      } else if (e.method === 'Network.loadingFailed') {
        fails.push({
          requestId: p.requestId, error: p.errorText, type: p.type,
          canceled: !!p.canceled, blocked: p.blockedReason || null,
          url: (sends.get(p.requestId) || {}).url || '(unknown)',
        });
      }
    }

    const byUrl = new Map();
    for (const [id, s] of sends) {
      const k = short(s.url);
      if (!byUrl.has(k)) byUrl.set(k, []);
      byUrl.get(k).push({ id, ...s, resp: resps.get(id) || null });
    }

    console.log('ready=%s  requests=%d  uniqueUrls=%d', ready, sends.size, byUrl.size);

    const dupes = [...byUrl].filter(([, v]) => v.length > 1);
    console.log('--- URLs requested more than once: %d ---', dupes.length);
    for (const [k, v] of dupes) {
      console.log('  DUP x%d  %s', v.length, k);
      for (const r of v) {
        console.log('      id=%s type=%s init=%s ts=%s resp=%s',
          r.id, r.type, r.initiator, r.ts, JSON.stringify(r.resp));
      }
    }

    console.log('--- loadingFailed: %d ---', fails.length);
    for (const f of fails) {
      const s = sends.get(f.requestId);
      const delivered = fin.get(f.requestId);
      console.log('  FAIL %s  type=%s canceled=%s blocked=%s  %s',
        f.error, f.type, f.canceled, f.blocked, short(f.url));
      console.log('       initiator=%s  status=%s  bytesDelivered=%s',
        s ? s.initiator : '?',
        (resps.get(f.requestId) || {}).status,
        delivered === undefined ? 'NONE (no loadingFinished)' : delivered);
    }

    // The decisive question for a canceled fetch: did the bytes arrive anyway?
    const onDisk = (u) => {
      try { return fs.statSync(path.join(ROOT, short(u).replace(/^\//, ''))).size; }
      catch { return -1; }
    };
    console.log('--- same requests, accounting ---');
    for (const f of fails) {
      console.log('  %s  onDisk=%d  delivered=%s  -> %s', short(f.url), onDisk(f.url),
        fin.get(f.requestId) === undefined ? 'NONE' : fin.get(f.requestId),
        onDisk(f.url) === fin.get(f.requestId) ? 'FULL BODY ARRIVED' : 'body short/missing');
    }

    // What the page thinks it loaded -- the ground truth for "did a model fail".
    const inPage = await sess.evalJs(`JSON.stringify({
      entries: window.__app.kit.entries.size,
      filesLoaded: window.__app.kit.stats.filesLoaded,
      tris: window.__app.kit.stats.tris,
      meshes: window.__app.kit.stats.meshes,
      requested: window.__app.apartment.stats.furniture,
    })`);
    console.log('--- page-side load accounting ---');
    console.log('  ' + inPage);

    console.log('--- kitchenBar family ---');
    for (const [k, v] of [...byUrl].filter(([k]) => k.includes('kitchenBar'))) {
      console.log('  %s  x%d', k, v.length);
      for (const r of v) console.log('      id=%s type=%s init=%s resp=%s', r.id, r.type, r.initiator, JSON.stringify(r.resp));
    }

    const glbs = [...byUrl].filter(([k]) => k.endsWith('.glb'));
    const bad = glbs.filter(([, v]) => v.some((r) => !r.resp || r.resp.status !== 200));
    console.log('--- .glb: %d urls, %d without a clean 200 ---', glbs.length, bad.length);
    for (const [k, v] of bad) {
      console.log('  %s', k);
      for (const r of v) console.log('      id=%s type=%s resp=%s', r.id, r.type, JSON.stringify(r.resp));
    }
  } finally {
    if (sess) sess.close();
    chrome.kill();
    await server.close();
  }
})().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
