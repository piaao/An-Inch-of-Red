/**
 * cdp.js — reusable headless-Chrome harness for this project.
 *
 * Provides: an in-process static server (correct MIME + no-store), a headless
 * Chrome launch with a deliberate GL backend, and a CDP session exposing
 * send / evalJs / shot.
 *
 * Deliberately dependency-free: only Node built-ins (node:http, node:child_process,
 * global fetch, global WebSocket — Node 22+).
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CHROME = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ server */

function serve(root, port = 8765) {
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/' || p === '') p = '/index.html';
      const abs = path.join(root, p);
      // keep everything inside root
      if (!path.resolve(abs).startsWith(path.resolve(root))) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat || stat.isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 ' + p);
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      fs.createReadStream(abs).pipe(res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('500 ' + err.message);
    }
  });
  return new Promise((resolve, reject) => {
    // Reject rather than throw. With no 'error' listener an occupied port is an
    // UNCAUGHT exception: the whole suite dies with a raw EADDRINUSE stack and
    // the caller never gets the chance to pick another port. Measured on 8777
    // while start.bat had it open. Rejecting changes nothing for callers that
    // do not catch -- they still fail, with a real error instead of a corpse.
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      port,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

/* ------------------------------------------------------------------ chrome */

const GL = {
  // Software rasteriser: deterministic, no GPU dependency, fine for one scene.
  soft: ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  // Real GPU: required when the page is heavy (large three.js, many meshes).
  gpu: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11',
        '--enable-unsafe-swiftshader'],
};

async function launch({ port = 9222, gl = 'gpu', userDataDir = 'C:/Users/Public/cdpprofile_room' } = {}) {
  const args = [
    '--headless=new', '--no-sandbox',
    ...(GL[gl] || GL.gpu),
    '--hide-scrollbars',
    '--window-size=1600,1000',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDataDir,
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    'about:blank',
  ];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', () => {});
  proc.stdout.on('data', () => {});

  const deadline = Date.now() + 20000;
  let ver = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { ver = await r.json(); break; }
    } catch { /* not up yet */ }
    await sleep(200);
  }
  if (!ver) { proc.kill(); throw new Error('chrome did not expose the debugging port'); }
  return {
    proc,
    version: ver,
    kill: () => { try { proc.kill(); } catch {} },
  };
}

/* ----------------------------------------------------------------- session */

async function attach({ port = 9222, timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  let target = null;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((x) => x.type === 'page');
      if (target && target.webSocketDebuggerUrl) break;
    } catch { /* retry */ }
    await sleep(200);
  }
  if (!target) throw new Error('no page target to attach to');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('ws connect failed')));
  });

  let id = 0;
  const pending = new Map();
  const events = [];
  const reqUrls = new Map();          // requestId -> url, to name failed loads
  const reqStatus = new Map();        // requestId -> HTTP status, to classify them
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) {
      events.push(m);
      if (m.method === 'Network.requestWillBeSent' && m.params && m.params.request) {
        reqUrls.set(m.params.requestId, m.params.request.url);
      } else if (m.method === 'Network.responseReceived' && m.params && m.params.response) {
        reqStatus.set(m.params.requestId, m.params.response.status);
      }
    }
  });

  const send = (method, params = {}) => new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');

  /** Evaluate JS in the page. Returns the raw value, or a `<<EXC>>` string.
   *  Wrap awaited work yourself: evalJs('return (async()=>{...})()'). */
  const evalJs = async (expression, { awaitPromise = true } = {}) => {
    const r = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise,
    });
    const ed = r.result && r.result.exceptionDetails;
    if (ed) {
      const desc = (ed.exception && (ed.exception.description || ed.exception.value)) || ed.text;
      const first = String(desc).split('\n').slice(0, 3).join(' ⏎ ');
      // A `<<EXC>>` string is a harness failure — callers must treat it as such.
      return '<<EXC>> ' + first;
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  /** Evaluate an async body wrapped in an IIFE. `body` may use `await`. */
  const evalAsync = (body) => evalJs(`(async () => { ${body} })()`);

  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const data = r.result && r.result.data;
    if (!data) return { ok: false };
    await fsp.writeFile(file, Buffer.from(data, 'base64'));
    const st = await fsp.stat(file);
    return { ok: true, bytes: st.size };
  };

  const viewport = (width, height) => send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });

  let navSeq = 0;
  const goto = async (url, { settle = 4000, bust = true } = {}) => {
    const full = bust ? url + (url.includes('?') ? '&' : '?') + '_=' + (++navSeq) : url;
    await send('Page.navigate', { url: full });
    await sleep(settle);
  };

  /** Collect console + exceptions + failed requests. */
  const diagnostics = () => {
    const out = { exceptions: [], consoleErrors: [], logErrors: [], failedRequests: [],
                  failedDetail: [], httpErrors: [] };
    for (const e of events) {
      if (e.method === 'Runtime.exceptionThrown') {
        const d = e.params.exceptionDetails || {};
        out.exceptions.push(((d.exception && d.exception.description) || d.text || '').split('\n')[0]);
      } else if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
        out.consoleErrors.push((e.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        out.logErrors.push(e.params.entry.text + ' @ ' + (e.params.entry.url || ''));
      } else if (e.method === 'Network.loadingFailed') {
        const url = reqUrls.get(e.params.requestId) || '(unknown)';
        const short = url.replace(/^https?:\/\/[^/]+/, '');
        out.failedRequests.push(e.params.errorText + ' [' + (e.params.type || '?') + '] ' + short);
        // Structured twin of the line above. A failure's HTTP status is the
        // difference between "the server refused this" and "the renderer let go
        // of a stream it had already finished reading" -- callers need to be
        // able to tell those apart instead of printing both the same way.
        out.failedDetail.push({
          errorText: e.params.errorText,
          type: e.params.type || '?',
          canceled: !!e.params.canceled,
          status: reqStatus.has(e.params.requestId) ? reqStatus.get(e.params.requestId) : null,
          url: short,
        });
      } else if (e.method === 'Network.responseReceived' && e.params.response.status >= 400) {
        out.httpErrors.push(e.params.response.status + ' ' + e.params.response.url);
      }
    }
    return out;
  };

  const glRenderer = async () => evalJs(
    `(()=>{const c=document.createElement('canvas');const g=c.getContext('webgl2')||c.getContext('webgl');
      if(!g)return 'no-webgl';
      const d=g.getExtension('WEBGL_debug_renderer_info');
      return d?g.getParameter(d.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER);})()`);

  const close = () => { try { ws.close(); } catch {} };

  return { send, evalJs, evalAsync, shot, goto, viewport, diagnostics, glRenderer, close, events };
}

/**
 * Kill only OUR stray headless instances — identified by the throwaway
 * `--user-data-dir` they carry on their command line.
 *
 * Deliberately NOT `Get-Process chrome | Stop-Process -Force`: that would close
 * whatever the human is browsing with. Stray instances sharing one profile
 * silently hijack the debug port, so they must go, but only they.
 */
function killStrayChrome() {
  return new Promise((resolve) => {
    const ps = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$me=[System.Diagnostics.Process]::GetCurrentProcess().Id",
      "$killed=0",
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object {",
      "  if ($_.CommandLine -like '*cdpprofile*' -and $_.ProcessId -ne $me) {",
      "    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed++",
      "  }",
      "}",
      "Write-Output ('killed=' + $killed)",
    ].join('; ');
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('exit', () => resolve(out.trim()));
    p.on('error', () => resolve('kill skipped'));
  });
}

module.exports = { serve, launch, attach, killStrayChrome, sleep, GL, CHROME, MIME };
