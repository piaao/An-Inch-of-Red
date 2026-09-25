/**
 * ui.js — all DOM side effects: loading bar, HUD stats, room labels,
 * toolbar, and hover/click picking.
 */
import * as THREE from 'three';
import { ZONES } from './layout.js';

export { ZONES };

const $ = (id) => document.getElementById(id);

let labelEls = new Map();
let labelsVisible = true;
let highlight = null;
let tipEl = null;

/* ---------------------------------------------------------------- loading */

export function setLoading(on, msg, frac) {
  const el = $('loading');
  if (!el) return;
  el.classList.toggle('hidden', !on);
  if (on) setProgress(frac || 0, msg || '');
}

export function setProgress(frac, name) {
  const bar = $('load-bar');
  const txt = $('load-msg');
  const pct = $('load-pct');
  if (bar) bar.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
  if (pct) pct.textContent = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
  if (txt && name) txt.textContent = name;
}

export function fail(msg) {
  const el = $('loading');
  if (!el) return;
  el.classList.remove('hidden');
  el.classList.add('failed');
  const txt = $('load-msg');
  if (txt) txt.innerHTML = msg;
}

/* ------------------------------------------------------------------ stats */

export function setStats(stats, kit) {
  const el = $('stats');
  if (!el) return;
  const rows = [
    ['家具件数', stats.furniture],
    ['地板砖', stats.floorTiles],
    ['墙段', stats.wallSegments],
    ['网格对象', stats.meshes],
    ['三角面', stats.tris.toLocaleString()],
    ['装载模型', kit.entries.size + ' / ' + (kit.stats.filesLoaded || kit.entries.size)],
  ];
  el.innerHTML = rows
    .map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`)
    .join('');
}

export function setPerf(fps, calls, tris) {
  const el = $('perf');
  if (!el) return;
  el.textContent = `${fps} FPS · ${calls} draw calls · ${(tris / 1000).toFixed(0)}k tris`;
}

/* ----------------------------------------------------------------- labels */

export function setLabels(zones) {
  const layer = $('labels');
  if (!layer) return;
  layer.innerHTML = '';
  labelEls = new Map();
  for (const z of zones) {
    const d = document.createElement('div');
    d.className = 'zone-label';
    d.style.setProperty('--hue', z.hue);
    d.innerHTML = `<i></i><span>${z.name}</span>`;
    d.addEventListener('click', () => {
      const ev = new CustomEvent('zone-label-click', { detail: { id: z.id } });
      window.dispatchEvent(ev);
    });
    layer.appendChild(d);
    labelEls.set(z.id, d);
  }
}

const _v = new THREE.Vector3();

export function updateLabels(camera, renderer) {
  if (!labelsVisible) return;
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  for (const z of ZONES) {
    const el = labelEls.get(z.id);
    if (!el) continue;
    _v.set(z.at[0], 0.94, z.at[1]);
    _v.project(camera);
    const behind = _v.z > 1;
    const x = (_v.x * 0.5 + 0.5) * w;
    const y = (-_v.y * 0.5 + 0.5) * h;
    el.style.transform = `translate(-50%,-50%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
    el.style.opacity = behind ? '0' : '1';
  }
}

export function setLabelsVisible(v) {
  labelsVisible = v;
  const layer = $('labels');
  if (layer) layer.style.display = v ? '' : 'none';
}

/* ---------------------------------------------------------------- toolbar */

export function bindToolbar({ views, flags, onView }) {
  const bar = $('views');
  if (bar) {
    bar.innerHTML = '';
    views.forEach((v, i) => {
      const b = document.createElement('button');
      b.textContent = v.name;
      b.dataset.view = v.id;
      if (i === 0) b.classList.add('active');
      b.addEventListener('click', () => {
        bar.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        onView(v.id);
      });
      bar.appendChild(b);
    });
    window.addEventListener('zone-label-click', (e) => {
      const btn = [...bar.querySelectorAll('button')].find((x) => x.dataset.view === e.detail.id);
      if (btn) btn.click();
    });
  }

  const fbar = $('flags');
  if (fbar) {
    fbar.innerHTML = '';
    for (const f of flags) {
      const b = document.createElement('button');
      b.textContent = f.label;
      b.classList.toggle('on', !!f.on);
      b.addEventListener('click', () => {
        const next = !b.classList.contains('on');
        b.classList.toggle('on', next);
        f.apply(next);
      });
      fbar.appendChild(b);
      if (f.apply) f.apply(!!f.on);
    }
  }
}

/* ------------------------------------------------------------------ hover */

export function bindHover({ camera, scene, apartment, onZone, onLeave, onPick }) {
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const canvas = $('stage');
  let hovered = null;

  // Floor-hugging outline for the hovered room.
  const group = new THREE.Group();
  group.visible = false;
  group.name = 'highlight';
  const lineGeo = new THREE.BufferGeometry().setFromPoints(
    [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
  );
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffd98a }));
  const fillGeo = new THREE.PlaneGeometry(1, 1);
  const fill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({
    color: 0xffd98a, transparent: true, opacity: 0.07, depthWrite: false,
  }));
  fill.rotation.x = -Math.PI / 2;
  fill.position.y = 0.004;
  group.add(line, fill);
  scene.add(group);

  const targets = apartment.furniture.children;

  function pick(ev) {
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(targets, true);
    if (!hits.length) return null;
    let o = hits[0].object;
    while (o && !o.userData.zone) o = o.parent;
    return o ? o.userData.zone : null;
  }

  canvas.addEventListener('pointermove', (ev) => {
    const id = pick(ev);
    if (id !== hovered) {
      hovered = id;
      canvas.style.cursor = id ? 'pointer' : 'grab';
      if (id) onZone(id, ev.clientX, ev.clientY);
      else { onLeave(); hideZoneTip(); }
    } else if (id) {
      onZone(id, ev.clientX, ev.clientY);
    }
  });
  canvas.addEventListener('pointerleave', () => {
    hovered = null;
    onLeave();
    hideZoneTip();
  });
  canvas.addEventListener('click', (ev) => {
    if (ev.detail === 0) return;
    const id = pick(ev);
    if (id) onPick(id);
  });

  return {
    setBox(box) {
      if (!box) { group.visible = false; return; }
      const { min, max } = box;
      const m = 0.06;
      const x0 = min.x - m, x1 = max.x + m, z0 = min.z - m, z1 = max.z + m;
      const pos = lineGeo.attributes.position;
      const pts = [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];
      pts.forEach(([x, z], i) => pos.setXYZ(i, x, 0.012, z));
      pos.needsUpdate = true;
      lineGeo.computeBoundingSphere();
      fill.scale.set(Math.max(0.01, x1 - x0), Math.max(0.01, z1 - z0), 1);
      fill.position.set((x0 + x1) / 2, 0.004, (z0 + z1) / 2);
      group.visible = true;
    },
  };
}

export function setZoneHighlight(box) {
  // routed through bindHover's returned handle in app.js; kept for symmetry
  if (highlight) highlight.setBox(box);
}

export function attachHighlight(handle) {
  highlight = handle;
}

/* -------------------------------------------------------------------- tip */

export function showZoneTip(id, box, x, y) {
  if (!tipEl) tipEl = $('zone-tip');
  if (!tipEl || !box) return;
  tipEl.innerHTML = `<b>${box.name}</b><span>${box.count || ''} 件</span>`;
  tipEl.style.transform = `translate(${x + 16}px, ${y + 16}px)`;
  tipEl.classList.add('show');
}

export function hideZoneTip() {
  if (tipEl) tipEl.classList.remove('show');
}
