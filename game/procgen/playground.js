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
 *
 * TWO VERDICTS ON SCREEN, in two strips, with two sets of words.
 * `validateLayout` returns playability (`checks`) and arrangement
 * (`arrangement`) as separate axes -- see `pipeline.js` for why they are not
 * merged. This file paints both and never averages them: a floor that is
 * walkable and uninhabitable must not be able to read as either one alone.
 */
import { generateFloorplan, DEFAULTS, PROGRAM, KNOWN_ROLES, roomProgram } from './floorplan.js';
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
  // Not "an upper bound on the count" -- that is `roomCap`, which lives under
  // 高级旋钮. This is the number of pieces to place, full stop, and it is spread
  // over the rooms by usable floor. The hint says so, because a knob whose label
  // has to be reverse-engineered is a knob that gets set wrong.
  { name: 'items', label: '家具总数', unit: '', min: 0, max: 400, step: 5,
    hint: '一共摆几件，按各房间可用地面分配；单个房间的上限是「单房间物品上限」' },
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

/* ------------------------------------------------------------- the room list */

/**
 * `rooms` says HOW MANY rooms; this list says WHICH ONES.
 *
 * IT IS A MULTISET, NOT A MAP. This docblock said "entry 1 is the room the
 * front door opens into" until the claim was measured, and it is not true:
 * `planCirculation()` picks the entry cell from the WALLS (the most-connected
 * cell on the front edge), marks it `living`, and then draws each role out of
 * the list by name. The four rules are
 *
 *     entry          -> living
 *     off the entry  -> bath
 *     adjacent pair  -> kitchen + dining
 *     leftover       -> bedrooms first, to the cells with an outside wall
 *
 * and everything left over is spilled into whatever cells remain. So position
 * in this list is a TIE-BREAK among those leftovers and nothing else. Measured
 * in work/_p3b_program.mjs: 'living' written last still ends up as the room you
 * walk into, and a list and its reverse give the same plan.
 *
 * THE CONTROL IS STILL A LIST, because the multiset has to be expressible --
 * ['bedroom','bedroom','study'] and ['bedroom','study','study'] are different
 * buildings. But the note under it describes what it does, not what an
 * ordered-looking widget suggests it does.
 *
 * THE AUTO PREVIEW IS PRINTED, NOT RE-DERIVED. With no explicit list the rows
 * below show what `roomProgram()` returns for the current `rooms`, so this page
 * cannot form its own opinion about what a 6-room flat contains.
 */
const ROLE_LABEL = {
  living: '客厅', bedroom: '卧室', kitchen: '厨房',
  bath: '卫生间', dining: '餐厅', study: '书房',
};
const roleName = (r) => ROLE_LABEL[r] || r;

/** null = follow `rooms`; an array = the explicit room list. */
let programRoles = null;

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

  // Fills the role <select> above with every role the palette knows, so the
  // list of legal words is the generator's own list rather than a second one
  // typed here.
  $('program-add').innerHTML = PROGRAM.map((r) =>
    '<option value="' + r + '">' + escapeHtml(roleName(r)) + '</option>').join('');

  renderProgram();
}

/* -------------------------------------------------------------- room list */

function readNumber(name, dflt) {
  const el = document.querySelector('input[name=' + name + ']');
  if (!el) return dflt;
  const v = String(el.value).trim();
  if (v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** The list the generator would build right now: explicit if set, else `rooms`. */
function effectiveProgram() {
  if (programRoles && programRoles.length) return programRoles.slice();
  return roomProgram({ rooms: readNumber('rooms', DEFAULTS.rooms), program: null }).roles;
}

function renderProgram() {
  const custom = !!(programRoles && programRoles.length);
  const list = effectiveProgram();

  $('program').innerHTML = list.map((role, i) => {
    const ix = '<span class="ix">' + (i + 1) + '</span>';
    if (!custom) return '<li class="pr auto">' + ix + '<span class="rl">'
      + escapeHtml(roleName(role)) + '</span></li>';
    // An unknown role can only arrive through the script API (`set({
    // program: [...] })`). Showing it as a blank row would hide the generator's
    // own "the palette does not know this word" problem; showing it as an
    // option makes it visible and fixable.
    const unknown = KNOWN_ROLES.has(role)
      ? '' : '<option value="' + escapeHtml(role) + '" selected>'
        + escapeHtml(role) + '（生成器不认识）</option>';
    return '<li class="pr">' + ix
      + '<select data-i="' + i + '" aria-label="第 ' + (i + 1) + ' 个房间">' + unknown
      + PROGRAM.map((r) => '<option value="' + r + '"' + (r === role ? ' selected' : '') + '>'
        + escapeHtml(roleName(r)) + '</option>').join('')
      + '</select>'
      + '<button type="button" class="mini" data-mv="' + i + '" data-dir="-1" title="上移"'
      + (i === 0 ? ' disabled' : '') + '>↑</button>'
      + '<button type="button" class="mini" data-mv="' + i + '" data-dir="1" title="下移"'
      + (i === list.length - 1 ? ' disabled' : '') + '>↓</button>'
      + '<button type="button" class="mini ghost" data-rm="' + i + '" title="删掉">✕</button>'
      + '</li>';
  }).join('');

  $('program-use').checked = custom;
  // THE COPY IS A CLAIM ABOUT THE GENERATOR, so it is written from the
  // measurement in work/_p3b_program.mjs rather than from what the widget looks
  // like. A reorderable list invites "position means position"; it does not, and
  // a control that lies about itself is worse than no control.
  const noLiving = custom && !list.includes('living');
  $('program-note').textContent = !custom
    ? '按房间数自动：' + list.length + ' 间，由生成器决定。勾选「自定义」可以自己排。'
    : noLiving
      ? '自定义 ' + list.length + ' 间 —— 但没有客厅。每套户型的入户门都必须开进客厅，'
        + '缺了它生成器会当场报告「生成不出」。'
      : '自定义 ' + list.length + ' 间。有哪几种房间、各几间，由这张清单决定；'
        + '哪一间落在哪个位置由规则决定（入户那间一定是客厅）。';
}

function wireProgram() {
  const kick = () => { renderProgram(); if ($('auto').checked) schedule(); };

  $('program-use').addEventListener('change', () => {
    if ($('program-use').checked) {
      // Start from what is already drawn, so ticking the box is an edit rather
      // than a reset to some other six rooms.
      if (!programRoles || !programRoles.length) programRoles = effectiveProgram();
    } else {
      programRoles = null;
    }
    kick();
  });

  $('program').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-i]');
    if (!sel || !programRoles) return;
    programRoles[Number(sel.dataset.i)] = sel.value;
    kick();
  });

  $('program').addEventListener('click', (e) => {
    if (!programRoles) return;
    const mv = e.target.closest('button[data-mv]');
    const rm = e.target.closest('button[data-rm]');
    if (mv) {
      const i = Number(mv.dataset.mv);
      const j = i + Number(mv.dataset.dir);
      if (j < 0 || j >= programRoles.length) return;
      const t = programRoles[i];
      programRoles[i] = programRoles[j];
      programRoles[j] = t;
      kick();
    } else if (rm) {
      // A flat needs at least one room; the last row's ✕ is refused rather than
      // producing a zero-room plan that every downstream check would call a bug.
      if (programRoles.length <= 1) return;
      programRoles.splice(Number(rm.dataset.rm), 1);
      kick();
    }
  });

  $('program-add-btn').addEventListener('click', () => {
    if (!programRoles) programRoles = effectiveProgram();
    programRoles.push($('program-add').value);
    kick();
  });

  $('program-auto').addEventListener('click', () => { programRoles = null; kick(); });
}

/* -------------------------------------------------------------- read form */

function paramsFromForm() {
  const p = { w: DEFAULTS.w, d: DEFAULTS.d, rooms: DEFAULTS.rooms, items: DEFAULTS.items };
  for (const f of PRIMARY) p[f.name] = readNumber(f.name, DEFAULTS[f.name]);
  for (const f of ADVANCED) p[f.name] = readNumber(f.name, DEFAULTS[f.name]);
  // THE ONE PARAMETER THAT IS NOT A NUMBER, and it must not go through the
  // number reader: `Number(["living"])` is NaN, the NaN would fall back to the
  // default, and the control would be wired, look right and do nothing.
  p.program = programRoles && programRoles.length ? programRoles.slice() : null;
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
        arrangement: null,
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

  /* the SECOND verdict: is it a place, not merely a maze ------------------ */
  const arr = v.arrangement;
  const arrFails = arr ? arr.checks.filter((c) => !c.pass) : [];
  const arrNa = arr ? arr.checks.filter((c) => c.applicable === false).length : 0;
  const aban = $('verdict-arr');
  if (aban) {
    aban.dataset.state = arr && !arrFails.length ? 'pass' : 'fail';
    aban.textContent = !arr
      ? '布置未评估'
      : (arrFails.length
        ? '布置 ' + arrFails.length + ' 项未过 / ' + arr.checks.length + ' 项'
        : '布置 ' + arr.checks.length + ' 项全过' + (arrNa ? '（' + arrNa + ' 项不适用）' : ''));
  }
  const ahead = $('arrhead');
  if (ahead) {
    // The composition numbers ride along in the heading because they are what
    // the next stage of this work is measured against, and a number nobody can
    // see is a number nobody maintains.
    const t = arr ? arr.readings.totals : null;
    const meta = arr && t
      ? '（' + arr.checks.length + ' 项 · 件/组 ' + t.piecesPerGroup.toFixed(2)
        + ' · 孤立件 ' + Math.round(t.loneShare * 100) + '%'
        + ' · 空地飘件 ' + t.floating + '）'
      : '';
    ahead.innerHTML = '布置合理性 <span class="n">' + meta + '</span>';
  }

  /* readings */
  const r = gen.report;
  // WITH A ROOM LIST THE ASK IS THE LIST, not the `rooms` box -- `roomProgram()`
  // says the list wins, so the strip has to ask the generator's question or a
  // six-room flat built from a list would be reported as three missing rooms.
  const wantRooms = params.program && params.program.length
    ? params.program.length : params.rooms;
  const it = r.items;
  const readings = [
    ['房间', r.rooms + ' / 要求 ' + wantRooms, r.rooms === wantRooms ? 'ok' : 'bad'],
    // `placed / wanted` is always the ASK. When the ask is past what the flat
    // can hold, the ceiling rides along on the same chip, so a shortfall cannot
    // be on screen without its reason also being on screen.
    ['家具', it.placed + ' / ' + it.wanted
      + (it.wanted > it.ceiling ? '（上限 ' + it.ceiling + '）' : ''),
      it.placed > 0 ? 'ok' : 'bad'],
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
      // The caption describes the DRAWING, so it prints what was built rather
      // than what was asked for -- `params.items` is an ask, and an ask printed
      // under a picture reads as a result.
      label: params.w + '×' + params.d + ' m · ' + r.rooms + ' 房 · ' + r.items.placed + ' 件',
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

  const arrList = $('arrchecks');
  if (arrList) {
    arrList.innerHTML = arr ? arr.checks.map((c) => {
      const state = c.applicable === false ? 'na' : c.pass ? 'ok' : 'bad';
      return '<li class="chk" data-state="' + state + '"><span class="mk">'
        + (state === 'na' ? '–' : c.pass ? '✓' : '✗') + '</span><span class="tx"><b>'
        + escapeHtml(c.label) + '</b><em>' + escapeHtml(c.detail) + '</em></span></li>';
    }).join('') : '<li class="chk" data-state="bad"><span class="mk">!</span>'
      + '<span class="tx"><b>无法评估布置</b><em>管线在建立关卡之前就失败了</em></span></li>';
  }

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
    // The room list is a parameter too. A 恢复默认 that leaves one knob where it
    // was is a 恢复默认 that lies.
    programRoles = null;
    renderProgram();
    generate();
  });

  wireProgram();
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
      // The second axis, exposed as its own field so the acceptance run can
      // assert on it WITHOUT the two axes ever being conflated in one count.
      arrangement: last.v.arrangement ? {
        ready: last.v.arrangement.ready,
        checks: last.v.arrangement.checks.map((c) => ({
          id: c.id, pass: c.pass, applicable: c.applicable !== false,
        })),
        fails: last.v.arrangement.checks.filter((c) => !c.pass).length,
        readings: last.v.arrangement.readings,
      } : null,
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
        // The room list is the one parameter that is not a string in a box, so
        // it is the one parameter that needs its own door in.
        if (k === 'program') {
          programRoles = Array.isArray(val) && val.length ? val.slice() : null;
          continue;
        }
        const el = document.querySelector('input[name=' + k + ']');
        if (el) el.value = String(val);
      }
      renderProgram();          // the auto preview follows `rooms`
      return paramsFromForm();
    },
    // The room list gets its own handles: the acceptance run cannot drive it
    // with a string, and a control the harness cannot reach is a control nobody
    // proves works.
    program: () => (programRoles ? programRoles.slice() : null),
    setProgram: (list) => {
      programRoles = Array.isArray(list) && list.length ? list.slice() : null;
      renderProgram();
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
