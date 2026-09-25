/**
 * playground.js — the workshop. Adjust parameters, generate a floor plan, and
 * see it drawn and judged, all in the page.
 *
 * WHAT THIS FILE IS NOT. It is not a second implementation of the generator or
 * of the verdict. It calls `game/procgen/floorplan.js` and
 * `game/procgen/pipeline.js` -- the same modules `scripts/procgen.mjs` calls --
 * and draws with `game/procgen/draw.js`, the same code the CLI writes to disk.
 * The only thing that differs between the two front ends is where the strings
 * end up.
 *
 * WHY THE CONTROLS ARE BUILT FROM DEFAULTS. Thirteen knobs typed twice is
 * thirteen chances to disagree. The field list below carries the LABEL and the
 * RANGE; the VALUE comes from `DEFAULTS`, so a knob that changes its default in
 * the generator changes here too, and a knob that is added there shows up here
 * as soon as it is named.
 */
import { generateFloorplan, DEFAULTS } from './floorplan.js';
import { validateLayout, PRIZE_COUNT } from './pipeline.js';
import { planSVG } from './draw.js';
import { buildLevel } from '../arena/fromLayout.js';
import { buildWallOpenings, buildDoorStates } from '../arena/openings.js';

/* ------------------------------------------------------------------ data */

// Module-relative, so the page works from any directory the server mounts it at.
const dataURL = (name) => new URL('../../data/' + name, import.meta.url).href;

const loadJSON = async (name) => {
  const res = await fetch(dataURL(name), { cache: 'no-store' });
  if (!res.ok) throw new Error(`data/${name}: HTTP ${res.status} -- run the script that produces it`);
  return res.json();
};

/* ------------------------------------------------------------- the fields */

/** value comes from DEFAULTS; this list only names and ranges them. */
const PRIMARY = [
  { name: 'w', label: '整体宽', unit: 'm', min: 5, max: 30, step: 1, hint: '户型东西向尺寸' },
  { name: 'd', label: '整体深', unit: 'm', min: 5, max: 30, step: 1, hint: '户型南北向尺寸' },
  { name: 'rooms', label: '房间数', unit: '', min: 1, max: 20, step: 1, hint: '装不下时会报 FAIL，不会静默少给' },
  { name: 'items', label: '物品数', unit: '', min: 0, max: 400, step: 5, hint: '家具件数上限' },
];

const ADVANCED = [
  { name: 'minRoom', label: '最小房间边长', unit: 'm', min: 1.5, max: 6, step: 0.1, hint: '一次拆分的两侧都要满足' },
  { name: 'lane', label: '门口净通道', unit: 'm', min: 0, max: 1.5, step: 0.02, hint: '每个门前预留的通道' },
  { name: 'gap', label: '家具间隙', unit: 'm', min: 0, max: 0.3, step: 0.01, hint: '两件家具包围盒之间' },
  { name: 'doorMargin', label: '门离角落', unit: '格', min: 0, max: 4, step: 1, hint: '门离房间角落的最小距离' },
  { name: 'loopDoor', label: '额外门概率', unit: '', min: 0, max: 1, step: 0.02, hint: '生成树之外再开一个门' },
  { name: 'maxLoopDoors', label: '额外门上限', unit: '', min: 0, max: 6, step: 1, hint: '' },
  { name: 'windowChance', label: '开窗概率', unit: '', min: 0, max: 1, step: 0.02, hint: '' },
  { name: 'roomCap', label: '单房间物品上限', unit: '', min: 1, max: 80, step: 1, hint: '防止一个房间塞满' },
  { name: 'floorTries', label: '落地采样预算', unit: '', min: 1, max: 120, step: 1, hint: '独立家具的拒绝采样次数' },
];

const SEED_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const randomSeed = () => {
  let s = '';
  for (let i = 0; i < 6; i++) s += SEED_CHARS[(Math.random() * SEED_CHARS.length) | 0];
  return s;
};

/* ------------------------------------------------------------------ state */

const KEY = 'an-inch-of-red:procgen';
let sizes = null;
let surfaces = {};
let passages = null;
let last = null;          // { gen, v, params, svg }
let busy = false;
let seq = 0;              // stale-result guard: only the newest run may paint

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------ form builds */

function fieldEl(f) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const dflt = DEFAULTS[f.name];
  wrap.innerHTML = '<span class="fl">' + f.label
    + (f.unit ? ' <i>(' + f.unit + ')</i>' : '') + '</span>';
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.name = f.name;
  inp.value = String(dflt);
  // Only when the spec states them: writing "undefined" into a range attribute
  // is invalid, and a field with no declared floor should simply have none.
  if (f.min != null) inp.min = String(f.min);
  if (f.max != null) inp.max = String(f.max);
  if (f.step != null) inp.step = String(f.step);
  wrap.appendChild(inp);
  if (f.hint) {
    const h = document.createElement('span');
    h.className = 'fh';
    h.textContent = f.hint;
    wrap.appendChild(h);
  }
  return wrap;
}

function buildControls() {
  const prim = $('primary');
  for (const f of PRIMARY) prim.appendChild(fieldEl(f));

  const adv = $('advanced-fields');
  for (const f of ADVANCED) adv.appendChild(fieldEl(f));

  const seedWrap = $('seed-field');
  seedWrap.appendChild(fieldEl({ name: 'seed', label: '种子', unit: '', hint: '同参数 + 同种子 → 逐位相同' }));
  const seedInput = document.querySelector('input[name=seed]');
  seedInput.type = 'text';
  seedInput.value = DEFAULTS.seed;
}

/* -------------------------------------------------------------- read form */

function paramsFromForm() {
  const read = (name, dflt) => {
    const el = document.querySelector('input[name=' + name + ']');
    if (!el) return dflt;
    const v = String(el.value).trim();
    if (v === '') return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  const p = { w: DEFAULTS.w, d: DEFAULTS.d, rooms: DEFAULTS.rooms, items: DEFAULTS.items };
  for (const f of PRIMARY) p[f.name] = read(f.name, DEFAULTS[f.name]);
  for (const f of ADVANCED) p[f.name] = read(f.name, DEFAULTS[f.name]);
  const seedEl = document.querySelector('input[name=seed]');
  p.seed = (seedEl && String(seedEl.value).trim()) || DEFAULTS.seed;
  return p;
}

/* ------------------------------------------------------------- the run */

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.dataset.kind = kind || '';
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

async function generate() {
  if (busy) return null;
  busy = true;
  const mine = ++seq;
  setStatus('生成中…', 'busy');
  await nextFrame();

  try {
    const p = paramsFromForm();
    const gen = generateFloorplan(p, { sizes });
    let v;
    try {
      v = validateLayout(gen, sizes, surfaces, passages, String(p.seed));
    } catch (err) {
      // A thrown pipeline is a FAILED LAYOUT, not a broken page: show it the
      // same way the CLI does, as one more failing check.
      v = {
        level: null, nav: null, placement: { prizes: [], report: {} }, detail: {},
        checks: [{ id: 'harness', label: '管线抛出异常', pass: false, detail: String(err && err.message || err) }],
        genReport: gen.report,
      };
    }
    if (mine !== seq) return null;   // a newer run already painted

    last = { gen, v, params: p };
    paint();
    return last;
  } finally {
    busy = false;
  }
}

/* --------------------------------------------------------------- painting */

function planScale(plan) {
  // Fit the drawing to the stage without ever shrinking a small flat into a
  // postage stamp.
  return Math.max(14, Math.min(88, Math.floor(Math.min(940 / plan.w, 600 / plan.d))));
}

function paint() {
  const { gen, v, params } = last;
  const fails = v.checks.filter((c) => !c.pass);

  /* verdict */
  const banner = $('verdict');
  banner.dataset.state = fails.length ? 'fail' : 'pass';
  banner.textContent = fails.length
    ? fails.length + ' 项未通过 / ' + v.checks.length + ' 项'
    : '全部 ' + v.checks.length + ' 项通过';

  /* readings */
  const r = gen.report;
  const readings = [
    ['房间', r.rooms + ' / 要求 ' + params.rooms, r.rooms === params.rooms ? 'ok' : 'bad'],
    ['家具', r.items.placed + ' / ' + r.items.wanted, r.items.placed > 0 ? 'ok' : 'bad'],
    ['可攀爬台面', String(r.climbTops), ''],
    ['空余地面', (r.freeFraction * 100).toFixed(0) + '%', ''],
    ['门', String(r.doors.total), ''],
    ['红包', v.placement.prizes.length + ' / ' + PRIZE_COUNT, v.placement.prizes.length === PRIZE_COUNT ? 'ok' : 'bad'],
  ];
  if (v.nav) {
    const pct = (v.nav.walkableCount / (v.nav.w * v.nav.d) * 100).toFixed(0);
    readings.push(['可走格', v.nav.walkableCount + ' (' + pct + '%)', '']);
    readings.push(['连通块', String(v.nav.components.length), v.nav.components.length === 1 ? 'ok' : 'bad']);
  }
  $('readings').innerHTML = readings.map(([k, val, kind]) =>
    '<div class="rd" data-kind="' + kind + '"><span>' + k + '</span><b>' + val + '</b></div>').join('');

  /* the plan */
  if (v.level) {
    const plan = v.level.meta.plan;
    const scale = planScale(plan);
    $('plan').innerHTML = planSVG({
      level: v.level, placement: v.placement, checks: v.checks,
      label: params.w + '×' + params.d + ' m · ' + params.rooms + ' 房 · ' + params.items + ' 件',
      sub: 'seed ' + params.seed + ' · ' + r.items.placed + ' 件家具落位 · '
        + r.climbTops + ' 个可攀爬台面 · 空余 ' + (r.freeFraction * 100).toFixed(0) + '%',
    }, { scale, showLabels: true });
    $('plan').firstChild.setAttribute('shape-rendering', 'crispEdges');
  } else {
    $('plan').innerHTML = '<p class="empty">没有可画的楼层：生成器在建立关卡之前就失败了。</p>';
  }

  /* the checks, with the generator's own words when it has any */
  const genProblems = r.problems || [];
  $('checks').innerHTML = v.checks.map((c) => {
    const cls = c.pass ? 'ok' : 'bad';
    const detail = c.detail ? '<em>' + escapeHtml(c.detail) + '</em>' : '';
    return '<li class="chk" data-state="' + cls + '"><span class="mk">'
      + (c.pass ? '✓' : '✗') + '</span><span class="tx"><b>'
      + escapeHtml(c.label) + '</b>' + detail + '</span></li>';
  }).join('') + (genProblems.length
    ? '<li class="chk" data-state="bad"><span class="mk">!</span><span class="tx"><b>生成器自述</b><em>'
      + escapeHtml(genProblems.join(' | ')) + '</em></span></li>'
    : '');

  /* the rejection tally, so "why did it say no" is visible */
  const rej = r.rejected || {};
  const rejLine = Object.entries(rej).sort((a, b) => b[1] - a[1])
    .filter(([, n]) => n > 0).map(([k, n]) => k + ' ' + n).join(' · ') || '无';
  $('rejected').textContent = rejLine;

  $('trace').textContent = (r.trace || []).join('\n');

  $('play').disabled = !v.level;
  setStatus('生成完成', fails.length ? 'fail' : 'ok');

  /* the handoff note: say plainly WHAT would be played */
  $('handoff').textContent = v.level
    ? '将载入：' + params.w + '×' + params.d + ' m，' + r.rooms + ' 个房间，'
      + v.level.solids.length + ' 个碰撞体，' + v.placement.prizes.length + ' 个红包（seed ' + params.seed + '）'
    : '没有可进入的楼层。';
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ------------------------------------------------------------- handoff */

/**
 * Hand the generated floor to the game.
 *
 * A page cannot write a file, so `play.html?arena=<path>` is not reachable from
 * here. What it CAN do is leave the snapshot in sessionStorage and let play.js
 * pick it up through the `session:` scheme, which it turns into a Blob URL in
 * its own document -- same origin, same shape, same `loadArena` as any other
 * arena. The snapshot written is the level this page already built and judged,
 * not a re-derivation: what you looked at is what you walk into.
 */
function playIt() {
  if (!last || !last.v.level) return;
  const level = last.v.level;
  level.meta.provenance = { generatedBy: 'procgen.html', params: last.params };
  const text = JSON.stringify(level);
  try {
    sessionStorage.setItem(KEY, text);
  } catch (err) {
    setStatus('交接失败：' + (err && err.name === 'QuotaExceededError'
      ? '这一层太大，放不进 sessionStorage（' + (text.length / 1024).toFixed(0) + ' KB）'
      : String(err && err.message || err)), 'fail');
    return;
  }
  location.href = 'play.html?arena=session:procgen';
}

/* ------------------------------------------------------------------ wire */

function wire() {
  $('params').addEventListener('submit', (e) => { e.preventDefault(); generate(); });
  $('params').addEventListener('input', () => {
    if ($('auto').checked) schedule();
  });
  $('reroll').addEventListener('click', () => {
    document.querySelector('input[name=seed]').value = randomSeed();
    generate();
  });
  $('play').addEventListener('click', playIt);
  $('reset').addEventListener('click', () => {
    for (const f of PRIMARY.concat(ADVANCED)) {
      document.querySelector('input[name=' + f.name + ']').value = String(DEFAULTS[f.name]);
    }
    document.querySelector('input[name=seed]').value = DEFAULTS.seed;
    generate();
  });
}

let timer = 0;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(generate, 260);
}

/* ------------------------------------------------------------ harness API */

/**
 * A tiny imperative surface for scripts/verify_playground.mjs.
 *
 * It exists so the acceptance run can hold the page to one question -- did the
 * UI produce the floor Node produces from the same parameters -- without
 * scraping the DOM for numbers that are already in hand. The panel is still
 * painted by the same `paint()` the button uses; this is a window onto the
 * result, not a second path to it.
 */
function expose() {
  globalThis.__procgen = {
    ready: false,
    // The generator's own defaults. Exposed so the acceptance run can hold the
    // FORM against them: thirteen knobs rendered from a list is thirteen chances
    // for the panel and the generator to disagree about what "default" means.
    defaults: () => Object.assign({}, DEFAULTS),
    params: () => paramsFromForm(),
    state: () => (last ? {
      params: last.params,
      checks: last.v.checks.map((c) => ({ id: c.id, pass: c.pass })),
      fails: last.v.checks.filter((c) => !c.pass).length,
      rooms: last.v.level ? last.v.level.rooms.length : 0,
      plan: last.v.level ? last.v.level.meta.plan : null,
      solids: last.v.level ? last.v.level.solids.length : 0,
      walkable: last.v.level ? last.v.nav.walkableCount : 0,
      components: last.v.level ? last.v.nav.components.length : 0,
      spawn: last.v.level ? last.v.level.spawn : null,
      prizes: last.v.level ? last.v.placement.prizes.map((p) => [p.x, p.z, p.y]) : [],
      planSVG: $('plan').innerHTML.length,
      readouts: $('verdict').textContent,
    } : null),
    // the exact bytes the handoff would hand over
    snapshot: () => (last && last.v.level
      ? JSON.stringify(Object.assign({}, last.v.level, {
        meta: Object.assign({}, last.v.level.meta, { provenance: null }),
      }))
      : null),
    set: (obj) => {
      for (const [k, val] of Object.entries(obj)) {
        const el = document.querySelector('input[name=' + k + ']');
        if (el) el.value = String(val);
      }
      return paramsFromForm();
    },
    generate,
  };
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  buildControls();
  wire();
  expose();
  try {
    const [sz, su, ps] = await Promise.all([
      loadJSON('kit_three.json'), loadJSON('model_surfaces.json'), loadJSON('passages.json'),
    ]);
    sizes = sz; surfaces = su; passages = ps;
    if (!sizes || !sizes.models) throw new Error('data/kit_three.json has no `models` -- run scripts/measure.js first');
    globalThis.__procgen.ready = true;
  } catch (err) {
    setStatus('素材加载失败：' + String(err && err.message || err), 'fail');
    $('play').disabled = true;
    return;
  }
  await generate();
}

boot();
