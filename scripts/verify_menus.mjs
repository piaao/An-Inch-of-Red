/**
 * verify_menus.mjs — "choose a map and a difficulty before you start", checked.
 *
 *     node scripts/verify_menus.mjs
 *     node scripts/verify_menus.mjs --log work/_mut.log
 *
 * ONE Node process, no Chrome, no child processes. There are two kinds of check
 * in here and the log says which is which, because they are not worth the same:
 *
 *   BEHAVIOURAL -- the real `Hud` is constructed against a stub DOM and the real
 *     `showStart` is run: the map cards are built, a card is CLICKED, and the
 *     开始 button is pressed. What `onStart` receives is read, not grepped. This
 *     is the whole reason the harness exists in this shape: `hud.js` imports
 *     cleanly with no DOM at module scope, so the page's own code can be run
 *     here instead of described.
 *
 *   STATIC -- `play.js` cannot be imported (`three` is a browser import map, not
 *     a Node package), so its wiring is asserted by reading the source. That is
 *     weaker evidence and it is labelled as such rather than quietly counted
 *     with the rest.
 *
 * WHAT IT EXISTS TO CATCH, each having actually happened or actually been
 * possible in this repo's history:
 *
 *   1. A SLOT NOBODY FILLS. `#start-maps` in the HTML with no code bound to it
 *      looks exactly like a rail that is merely empty, which is how a menu can
 *      ship with a screen that never appears. So the three ends are checked as
 *      one loop: the id is in play.html, `hud.js` looks it up, the CSS styles it.
 *   2. A DENOMINATOR THAT WAS TYPED. The meta strip printed `${s.rooms}/6 房间`
 *      -- true for the shipped apartment, a lie on the eleven-room 大宅, and
 *      unverifiable because it was a literal. The strip is now run with a
 *      summary whose two counts are deliberately different (3 of 11), so a
 *      hard-coded denominator cannot pass.
 *   3. PRESSING 开始 AND GETTING THE FLOOR THAT WAS ALREADY LOADED. The button
 *      must hand over the SELECTED card, which is not the same as the one that
 *      was loaded when the menu opened. So a card is clicked first, and the map
 *      id that reaches `onStart` is compared with what was clicked.
 *   4. A CHOICE THE BOOT DOES NOT READ. `?map=` is how the rail's reload carries
 *      the floor across; `runURL` wrote the parameter and `resolveArenaURL` did
 *      not read it, so five of six cards did nothing at all -- while the page
 *      rendered perfectly and every light stayed green.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Hud } from '../game/play/hud.js';
import { buildCore, placementSummary } from '../game/play/boot.js';
import { MAPS, DEFAULT_MAP, mapById } from '../game/maps/index.js';
import { DIFFICULTIES, DEFAULT_DIFFICULTY } from '../game/play/config.js';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* Refuse to read a tree that a mutation run has open.
 *
 * A mutation harness and a reader ran concurrently once (see work/_lock.py) and
 * the reader recorded a FAILED transcript -- `wallH 1.30 vs 1.29`, the mutated
 * value -- for a repository that only existed during someone else's run. The
 * harness itself runs this gate, so it passes AIRC_MUTATING=1 and is let in.
 */
const MUTATION_LOCK = path.join(HERE, 'work', '.mutating');
if (fs.existsSync(MUTATION_LOCK) && process.env.AIRC_MUTATING !== '1') {
  let who = 'another run';
  try { who = fs.readFileSync(MUTATION_LOCK, 'utf8').trim() || who; } catch { /* keep default */ }
  console.error(`REFUSING to run: ${who} is holding the working tree`
    + ` (${path.relative(HERE, MUTATION_LOCK).replace(/\\/g, '/')}).`);
  console.error('  While a mutation is applied the tree is INCONSISTENT, so any'
    + ' reading here describes a repository that does not exist.');
  console.error('  Wait for it to finish, or delete that file if it is stale.');
  process.exit(3);
}

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
};

const MANIFEST = path.join(HERE, 'game', 'maps', 'manifest.json');
const PAGE = 'play.html';
const HUD = 'game/play/hud.js';
const CSS = 'css/play.css';
const PLAY = 'game/play/play.js';

const log = [];
const say = (s = '') => { log.push(s); console.log(s); };

const checks = [];
const ok = (cond, label, detail = '') => {
  checks.push({ ok: !!cond, label, detail });
  say(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  -- ' + detail : ''}`);
  return !!cond;
};

/* ---------------------------------------------------------------- stub DOM */
//
// Enough of an element for `hud.js` to build cards with: class list, innerHTML,
// children, dataset, listeners. `innerHTML = ''` clears the children, because
// `_renderMaps` relies on it and a stub that quietly kept the old cards would
// make a second render look like two rails.
function makeEl(id = '') {
  const el = {
    id, tagName: 'DIV', children: [], dataset: {}, listeners: [],
    style: {}, value: '', checked: false, type: '', textContent: '',
    onclick: null, parent: null, _cls: new Set(), _html: '',
  };
  Object.defineProperty(el, 'className', {
    get: () => [...el._cls].join(' '),
    set: (v) => { el._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html,
    set: (v) => { el._html = String(v); if (el._html === '') el.children.length = 0; },
  });
  el.classList = {
    add: (...c) => c.forEach((x) => el._cls.add(x)),
    remove: (...c) => c.forEach((x) => el._cls.delete(x)),
    contains: (c) => el._cls.has(c),
    toggle: (c, on) => {
      const want = on === undefined ? !el._cls.has(c) : !!on;
      if (want) el._cls.add(c); else el._cls.delete(c);
      return want;
    },
  };
  el.appendChild = (c) => { el.children.push(c); c.parent = el; return c; };
  el.addEventListener = (t, fn) => { el.listeners.push({ type: t, fn }); };
  el.querySelector = () => null;
  el.remove = () => {};
  return el;
}

function stubDom() {
  const registry = new Map();
  globalThis.document = {
    createElement: () => makeEl(),
    getElementById: (id) => {
      if (!registry.has(id)) registry.set(id, makeEl(id));
      return registry.get(id);
    },
  };
  return registry;
}

const read = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');
const at = (src, needle) => src.indexOf(needle);
const click = (el) => {
  const l = el.listeners.find((x) => x.type === 'click');
  if (!l) throw new Error('element has no click listener');
  l.fn();
};

let exitCode = 0;
try {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const page = read(PAGE);
  const hudSrc = read(HUD);
  const css = read(CSS);
  const playSrc = read(PLAY);

  /* ================================================================== 1 */
  say('== the rail has three ends and all of them are connected ==');
  say('   (STATIC: the slot, the lookup and the rule are read out of the files)');
  ok(at(page, 'id="start-maps"') >= 0,
    `${PAGE} declares the slot the rail is drawn into`, 'id="start-maps"');
  ok(at(hudSrc, "startMaps: $('start-maps')") >= 0,
    `${HUD} looks that slot up by the same id`, "startMaps: $('start-maps')");
  ok(at(css, '#start-maps {') >= 0,
    `${CSS} styles it (an unstyled grid is a column of raw buttons)`, '#start-maps {');
  ok(at(page, 'id="start-go"') >= 0,
    `${PAGE} still has the button the selection is handed to`, 'id="start-go"');

  say('   -- the page manifest constant is the artifact on disk');
  const manifestConst = playSrc.match(/MAP_MANIFEST_URL\s*=\s*'([^']+)'/);
  ok(!!manifestConst, `${PLAY} names the manifest it fetches`, manifestConst && manifestConst[1]);
  if (manifestConst) {
    const want = manifestConst[1].replace(/^\.\//, '');
    ok(want === 'game/maps/manifest.json',
      'and it is the artifact this harness checks, not a second copy of it', want);
  }

  /* ================================================================== 2 */
  say('\n== the rail renders the roster ==');
  say('   (BEHAVIOURAL: the real Hud, a stub DOM, the real showStart)');
  stubDom();
  const hud = new Hud();
  const summary = {
    count: 6, rooms: 3, roomsTotal: 11, policy: 'spread',
    coverMin: 0.2, coverMax: 0.8, byTier: { tabletop: 4, tucked: 2 },
    walkable: 1234, regions: 1, waypoints: 5, legsDropped: 0, buildMs: 12,
  };
  let handed = null;
  hud.showStart({
    difficulties: DIFFICULTIES.map((d) => ({ ...d, spec: 'spec', ai: 'ai' })),
    defaultId: DEFAULT_DIFFICULTY,
    seed: 'menu-ruler', seedPinned: true,
    summary,
    maps: manifest.maps,
    currentMap: DEFAULT_MAP,
    onStart: (id, mapId) => { handed = { id, mapId }; },
  });

  const rail = hud.el.startMaps;
  ok(rail.children.length === manifest.maps.length,
    `one card per map on the roster (${manifest.maps.length})`,
    `${rail.children.length}`);
  const onCards = rail.children.filter((c) => c.classList.contains('on'));
  ok(onCards.length === 1 && onCards[0].dataset.id === DEFAULT_MAP,
    'exactly one card is marked as the loaded floor, and it is the default map',
    `${onCards.map((c) => c.dataset.id).join(', ') || 'none'}`);
  const elsewhere = rail.children.filter((c) => c.classList.contains('elsewhere'));
  ok(elsewhere.length === manifest.maps.length - 1,
    'every other card is marked as one reload away', `${elsewhere.length}`);
  ok(rail.children.every((c, i) => c.dataset.id === manifest.maps[i].id),
    'the cards are in roster order, so the rail reads the same way twice');

  const manor = manifest.maps.find((m) => m.id === 'manor');
  const manorCard = rail.children.find((c) => c.dataset.id === 'manor');
  ok(!!manorCard && manorCard.innerHTML.includes(manor.name)
    && manorCard.innerHTML.includes(`${manor.roomCount} 房间`)
    && manorCard.innerHTML.includes(`${manor.itemDensity}/m²`),
    'a card states the measured facts it was built from, not adjectives',
    manorCard ? `${manor.name} · ${manor.roomCount} 房间 · ${manor.itemDensity}/m²` : '');
  // Per card, against the entry it was built from: a rail that renders five
  // fresh cards and one stale one is a rail that will send you to the wrong
  // floor, and eyeballing one card would not notice.
  const badSpec = rail.children
    .map((c, i) => ({ c, m: manifest.maps[i] }))
    .filter(({ c, m }) => !c.innerHTML.includes(`${m.roomCount} 房间`)
      || !c.innerHTML.includes(`${m.itemCount} 件`)
      || !c.innerHTML.includes(`${m.itemDensity}/m²`));
  ok(badSpec.length === 0,
    'every card prints the measured room/item/density numbers of its own floor',
    badSpec.map((x) => x.c.dataset.id).join(', '));

  /* ================================================================== 3 */
  say('\n== pressing 开始 hands over the card that was CHOSEN ==');
  click(manorCard);
  ok(manorCard.classList.contains('on'),
    'clicking a card selects it', manorCard.className);
  ok(rail.children.filter((c) => c.classList.contains('on')).length === 1,
    'and only it');
  // Still one reload away -- clicking does not load a floor, 开始 does. Both
  // classes at once is the case the stylesheet has to survive.
  ok(manorCard.classList.contains('elsewhere'),
    'and it is still one reload away, because clicking is not loading');

  const go = document.getElementById('start-go');
  ok(typeof go.onclick === 'function', 'the 开始 button has a handler attached');
  go.onclick();
  ok(handed && handed.mapId === 'manor',
    'what reaches onStart is the card that was clicked, not the floor that was loaded',
    JSON.stringify(handed));
  ok(handed && handed.id === DEFAULT_DIFFICULTY,
    'and the difficulty with it', handed && handed.id);
  ok(manorCard.classList.contains('on') && !rail.children
    .filter((c) => c.dataset.id !== 'manor').some((c) => c.classList.contains('on')),
    'the previous selection did not stay lit');

  // The stylesheet has to let a card be both, and SELECTED has to win the
  // cascade: same specificity, so source order decides.
  const iOn = at(css, '.mapcard.on {');
  const iElse = at(css, '.mapcard.elsewhere {');
  ok(iOn > iElse && iElse >= 0,
    'the selected rule is written AFTER the reload rule, so selection wins the cascade',
    `.elsewhere at ${iElse}, .on at ${iOn}`);
  const onRule = css.slice(iOn, css.indexOf('}', iOn));
  ok(onRule.includes('opacity: 1'),
    'and it states an opacity, or 74% would still apply to a selected card', onRule.trim());

  /* ================================================================== 4 */
  say('\n== the meta strip counts the floor it is actually on ==');
  say('   (BEHAVIOURAL: a summary whose two counts differ on purpose)');
  const strip = hud.el.startMeta.innerHTML;
  ok(strip.includes('3/11'),
    'a summary of 3 rooms out of 11 prints 3/11 -- a typed denominator cannot do this',
    strip.match(/布局<\/i>[^<]*/)?.[0] || '');
  // The SHAPE of the old defect, not the words: a room count divided by a
  // literal. Searching the file for "/6 房间" instead would go red on the
  // comment in hud.js that explains why this was fixed -- prose is not code, and
  // a checker that cannot tell them apart is a checker that gets muted.
  const typedDenominator = /\$\{s\.rooms\}\s*\/\s*6\b/.test(hudSrc);
  const measuredDenominator = hudSrc.includes('${s.rooms}/${s.roomsTotal}');
  ok(!typedDenominator && measuredDenominator,
    `the denominator, and it is a count of the floor: \${s.rooms}/\${s.roomsTotal}`,
    `typed=${typedDenominator} measured=${measuredDenominator}`);

  for (const id of ['studio', 'twobed']) {
    const level = JSON.parse(fs.readFileSync(path.join(HERE, mapById(id).arena.replace(/^\.\//, '')), 'utf8'));
    const core = buildCore(level, { seed: 'menu-ruler', count: 6 });
    const s = placementSummary(level, core);
    ok(s.roomsTotal === level.rooms.length,
      `${id}: placementSummary reports the level's own room count`,
      `${s.roomsTotal} vs ${level.rooms.length}`);
    hud.setSummary(s);
    ok(hud.el.startMeta.innerHTML.includes(`${s.rooms}/${s.roomsTotal}`),
      `${id}: the strip prints ${s.rooms}/${s.roomsTotal}`,
      hud.el.startMeta.innerHTML.match(/布局<\/i>[^<]*/)?.[0] || '');
  }
  const dens = new Set(['studio', 'twobed'].map((id) => {
    const level = JSON.parse(fs.readFileSync(path.join(HERE, mapById(id).arena.replace(/^\.\//, '')), 'utf8'));
    return placementSummary(level, buildCore(level, { seed: 'menu-ruler', count: 6 })).roomsTotal;
  }));
  ok(dens.size === 2,
    'two floors print two different denominators, which is what MEASURED means',
    [...dens].join(' vs '));

  /* ================================================================== 5 */
  say('\n== the wiring play.js cannot be imported for ==');
  say('   (STATIC: `three` is a browser import map, so these are reads, not runs)');
  const staticChecks = [
    ['the boot resolves ?map through the roster, never by building a path',
      at(playSrc, 'function arenaPathForMap(') >= 0],
    ['and an id that is not on the roster is refused, not swapped for another floor',
      at(playSrc, 'booting a different one is worse than refusing') >= 0],
    ['?map is read from the query string', at(playSrc, "search.get('map')") >= 0],
    ['and it is consulted before ?arena, so a stale pointer cannot override a card',
      at(playSrc, 'if (wantMap) return arenaPathForMap(wantMap);') >= 0],
    ['the rail writes ?map into the reload URL', at(playSrc, "q.set('map', mapId);") >= 0],
    ['the reload carries the difficulty', at(playSrc, "q.set('difficulty', presetId);") >= 0],
    ['it drops ?arena, because a roster map is not the workbench floor',
      at(playSrc, "q.delete('arena');") >= 0],
    ['and it asks the boot to start, rather than showing the menu again',
      at(playSrc, "q.set('play', '1');") >= 0],
    ['the boot consumes ?play once it has been read',
      at(playSrc, 'boot.delete(\'play\');') >= 0],
    ['openMenu hands the roster to the rail',
      at(playSrc, '    maps,\n    currentMap: current,') >= 0],
    ['and a different card is a reload, while the loaded one starts at once',
      at(playSrc, 'if (mapId && mapId !== here)') >= 0],
    ['the boot reads the difficulty back out of the query string',
      at(playSrc, "boot.get('difficulty')") >= 0],
    ['the marker checkbox is restored to what the boot was told',
      at(playSrc, 'hud.el.markers.checked = markersOn;') >= 0],
  ];
  for (const [label, pass] of staticChecks) ok(pass, label);

  /* ================================================================== 6 */
  say('\n== the roster answers to its own names ==');
  ok(MAPS.length === manifest.maps.length,
    'every roster map has a manifest entry', `${MAPS.length} vs ${manifest.maps.length}`);
  const missing = MAPS.filter((m) => !fs.existsSync(path.join(HERE, m.arena.replace(/^\.\//, ''))));
  ok(missing.length === 0,
    'every roster arena is a file that exists (a card that 404s is a dead card)',
    missing.map((m) => m.arena).join(', '));
  const noInverse = manifest.maps.filter((r) => mapById(r.id) === null);
  ok(noInverse.length === 0,
    'and every manifest id resolves through mapById, which is how ?map= looks it up',
    noInverse.map((r) => r.id).join(', '));
} catch (err) {
  say('');
  say('HARNESS ERROR: ' + (err && err.stack ? err.stack : err));
  exitCode = 2;
}

const passed = checks.filter((c) => c.ok).length;
say('');
say('='.repeat(72));
say(`  ${passed}/${checks.length} checks passed`);
for (const c of checks) if (!c.ok) say(`   FAILED: ${c.label} — ${c.detail || ''}`);
say('='.repeat(72));
const verdict = checks.length > 0 && passed === checks.length && exitCode === 0;
say(verdict ? '  VERDICT: PASS' : '  VERDICT: FAIL');

// Redirectable, so a mutation run cannot leave a FAILED transcript in the
// canonical slot. Same accident, same cure as verify_packets.mjs.
const logPath = argOf('--log')
  ? path.resolve(argOf('--log'))
  : path.join(HERE, 'work', 'verify_menus.log');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, log.join('\n') + '\n');
say(`  log: ${(path.relative(HERE, logPath) || logPath).replace(/\\/g, '/')}`);

if (!verdict) exitCode = 1;
process.exit(exitCode);
