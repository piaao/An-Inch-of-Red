/**
 * hud.js — every pixel that is not the room.
 *
 * Kept as its own module because a HUD is where a game is most tempted to
 * editorialise, and here it must not. The two numbers that carry the design are
 * printed straight from the core:
 *
 *   the clock   what a 红包 actually costs you, in the currency the budget is
 *               denominated in -- because VERDICT §6 measured budget as the
 *               second-strongest difficulty dial and the strongest one you can
 *               still see
 *   suspicion   the guard's single readable dial. Break the line and it falls;
 *               that promise is only true if the bar is on screen.
 *
 * Nothing here reveals WHICH red thing is a 红包. The objective count is the
 * only channel, and it moves when you have already walked over one.
 */

const $ = (id) => document.getElementById(id);

const pad2 = (n) => String(Math.floor(n)).padStart(2, '0');

export function formatClock(sec) {
  const s = Math.max(0, sec);
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

/**
 * The measured-numbers strip under the difficulty cards.
 *
 * ONE definition, called by both `showStart` and `setSummary`. It used to be
 * two identical copies, which is how `/6 房间` survived the roster growing to
 * an eleven-room map: the denominator was typed, and a typed number cannot
 * notice a new floor plan.
 */
function metaHTML(s) {
  return `
      <span><i>布局</i>${s.count} 个红包 · ${s.rooms}/${s.roomsTotal} 房间 · ${s.policy}</span>
      <span><i>暴露度</i>${(s.coverMin * 100).toFixed(1)}% – ${(s.coverMax * 100).toFixed(1)}%</span>
      <span><i>分层</i>${Object.entries(s.byTier).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}</span>
      <span><i>导航</i>${s.walkable} 格 · ${s.regions} 连通域</span>
      <span><i>巡逻</i>${s.waypoints} 航点 · 丢 ${s.legsDropped} 段</span>
      <span><i>构建</i>${s.buildMs} ms</span>`;
}

export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'),
      mapToggle: $('map-toggle'),
      objective: $('objective-n'),
      objectiveTotal: $('objective-total'),
      room: $('roomname'),
      clock: $('clocktext'),
      clockbar: $('clockbar'),
      clockfill: $('clockfill'),
      guardBox: $('guardbox'),
      guardState: $('guard-state'),
      guardDot: $('guard-dot'),
      guardHint: $('guard-hint'),
      suspFill: $('suspfill'),
      suspBar: $('suspbar'),
      toasts: $('toasts'),
      hint: $('hint'),
      crosshair: $('crosshair'),
      propPrompt: $('prop-prompt'),
      propPromptText: $('prop-prompt-text'),
      flash: $('flash'),
      stain: $('stain'),
      load: $('ov-load'),
      loadMsg: $('load-msg'),
      loadBar: $('load-bar'),
      loadPct: $('load-pct'),
      start: $('ov-start'),
      startCards: $('start-cards'),
      startMaps: $('start-maps'),
      startMeta: $('start-meta'),
      seed: $('seed-input'),
      seedNote: $('seed-note'),
      markers: $('opt-markers'),
      pause: $('ov-pause'),
      end: $('ov-end'),
      endTitle: $('end-title'),
      endBody: $('end-body'),
      endStats: $('end-stats'),
      endAgain: $('end-again'),
      endMenu: $('end-menu'),
      banner: $('banner'),
    };
    this._room = null;
    this._guardMode = null;
    this._bindChrome();
  }

  /**
   * 两处只关外观、不关规则的接线。**放在 HUD 里而不是 play.js**，
   * 因为这是"不是房间的每一个像素"那一类东西，和暂停/结束面板同一层。
   *
   * 1. 窄屏的小地图折叠开关（宽屏 CSS 把它藏起来，所以这里不会有人点到）。
   *    地图为什么不能缩而是收，见 minimap.js 头注。
   * 2. 手机上把「怎么玩」那段长文案收进 <details>。**默认是开着的**，
   *    只有量到窄屏才收 —— 收起来是给窄屏的让步，不该顺手把桌面也改掉。
   */
  _bindChrome() {
    const hud = this.el.hud;
    const toggle = this.el.mapToggle;
    if (hud && toggle && toggle.addEventListener) {
      toggle.addEventListener('click', () => {
        const on = !hud.classList.contains('showmap');
        hud.classList.toggle('showmap', on);
        // 真 DOM 上有 setAttribute；验收用的桩没有，所以问一句再写。
        if (toggle.setAttribute) toggle.setAttribute('aria-expanded', on ? 'true' : 'false');
      });
    }
    const howto = $('start-howto');
    if (howto && typeof window !== 'undefined' && window.matchMedia) {
      howto.open = !window.matchMedia('(max-width: 700px)').matches;
    }
  }

  /* ------------------------------------------------------------- loading */

  loading(msg, pct) {
    // Always re-show: the overlay is used twice, once for the cold boot and
    // again for a 0.8 s placement rebuild when the seed changes, and a progress
    // bar nobody can see is not progress.
    if (this.el.load) this.el.load.classList.remove('hidden');
    if (this.el.loadMsg) this.el.loadMsg.textContent = msg;
    const p = Math.round((pct || 0) * 100);
    if (this.el.loadBar) this.el.loadBar.style.width = p + '%';
    if (this.el.loadPct) this.el.loadPct.textContent = p + '%';
  }

  loadingFail(title, html) {
    const box = this.el.load && this.el.load.querySelector('.box');
    if (!box) return;
    this.el.load.classList.remove('hidden');
    this.el.load.classList.add('failed');
    $('load-title').textContent = title;
    this.el.loadMsg.innerHTML = html;
    this.el.loadBar.style.width = '0%';
    this.el.loadPct.textContent = '';
  }

  hideLoading() {
    if (this.el.load) this.el.load.classList.add('hidden');
  }

  /* --------------------------------------------------------------- start */

  /**
   * Bind the inputs that live in the start overlay. Called ONCE, not from
   * showStart: showStart is re-run every time the seed changes, and re-binding
   * there would stack duplicate listeners until one seed change fired five
   * rebuilds.
   */
  bindStart({ onSeed, onOptions }) {
    if (this._bound) return;
    this._bound = true;
    // The raw text, INCLUDING empty. An empty seed box is not a seed called
    // "seed"; it is the player asking for a fresh layout, and play.js is the
    // one place that decides what that means.
    this.el.seed.addEventListener('change', () => onSeed(this.el.seed.value.trim()));
    if (this.el.markers) {
      this.el.markers.addEventListener('change', () => onOptions({ markers: this.el.markers.checked }));
    }
  }

  /**
   * @param difficulties  from config.js, each carrying its measured AI baseline
   * @param summary       placementSummary() output -- printed so the player can
   *                      tell a nasty layout from a routine one
   */
  showStart({ difficulties, defaultId, seed, seedPinned, summary,
    maps, currentMap, onStart }) {
    this._renderMaps(maps || [], currentMap || null);

    this.el.startCards.innerHTML = '';
    for (const d of difficulties) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'card';
      card.dataset.id = d.id;
      if (d.id === defaultId) card.classList.add('on');
      card.innerHTML = `
        <span class="card-top"><b>${d.name}</b><em>${formatClock(d.budget)} · ${d.guard ? '有主人' : '空屋'}</em></span>
        <span class="card-blurb">${d.blurb}</span>
        ${d.spec ? `<span class="card-spec">${d.spec}</span>` : ''}
        <span class="card-ai">${d.ai}</span>`;
      card.addEventListener('click', () => {
        for (const c of this.el.startCards.children) c.classList.remove('on');
        card.classList.add('on');
        this._preset = d.id;
      });
      this.el.startCards.appendChild(card);
    }
    this._preset = defaultId;
    this.el.seed.value = seed;
    if (this.el.seedNote) {
      this.el.seedNote.textContent = seedPinned
        ? '已固定：这一局就用这个种子。清空输入框即恢复随机。'
        : '每局开始重新藏红包。把某一局的种子填进来，可以复现那一局。';
    }

    this.el.startMeta.innerHTML = metaHTML(summary);

    $('start-go').onclick = () => onStart(this._preset, this._map);
    this.el.start.classList.remove('hidden');
  }

  /** Update just the meta strip, without rebuilding the cards. */
  setSummary(summary) {
    if (!this.el.startMeta) return;
    this.el.startMeta.innerHTML = metaHTML(summary);
  }

  /**
   * The map rail: one card per floor on the roster.
   *
   * THE LOADED FLOOR IS THE ONLY ONE THAT CAN START WITHOUT A PAGE LOAD. The
   * plan decides the ground plane, the lights, which models get downloaded and
   * the apartment mesh, and `start()` builds all of that once. Swapping floors
   * under a live scene would mean writing a second boot -- see the header of
   * scripts/_mapmenu.py, and the note in play.js above `loadArena`.
   *
   * So picking a different card RECORDS the choice and play.js reloads with
   * `?map=`. To the player it reads as "choose a map, choose a difficulty,
   * press 开始"; the cards that will cause a reload are drawn a shade quieter,
   * because that is the one thing about them the player can feel.
   */
  _renderMaps(maps, currentId) {
    this._map = currentId;
    const host = this.el.startMaps;
    if (!host) return;
    host.innerHTML = '';
    for (const m of maps) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'mapcard';
      card.dataset.id = m.id;
      card.classList.toggle('on', m.id === currentId);
      card.classList.toggle('elsewhere', m.id !== currentId);
      card.innerHTML = `
        <span class="map-top"><b>${m.name}</b><em>${m.category} · ${m.plan.w}×${m.plan.d}</em></span>
        <span class="map-spec">${m.roomCount} 房间 · ${m.itemCount} 件 · ${m.itemDensity}/m²</span>
        <span class="map-rooms">${(m.rooms || []).map((r) => r.name).join(' · ')}</span>`;
      card.addEventListener('click', () => {
        for (const c of host.children) c.classList.remove('on');
        card.classList.add('on');
        this._map = m.id;
      });
      host.appendChild(card);
    }
  }

  hideStart() {
    this.el.start.classList.add('hidden');
  }

  /* ---------------------------------------------------------------- play */

  objective(n, total) {
    if (this.el.objective) this.el.objective.textContent = n;
    if (this.el.objectiveTotal) this.el.objectiveTotal.textContent = total;
  }

  clock(remaining, budget, low) {
    if (this.el.clock) this.el.clock.textContent = formatClock(remaining);
    if (this.el.clockfill) {
      const f = budget > 0 ? Math.max(0, Math.min(1, remaining / budget)) : 0;
      this.el.clockfill.style.width = (f * 100).toFixed(1) + '%';
      this.el.clockfill.classList.toggle('low', !!low);
    }
    if (this.el.clock) this.el.clock.classList.toggle('low', !!low);
  }

  room(name) {
    if (name === this._room) return;
    this._room = name;
    if (this.el.room) this.el.room.textContent = name || '—';
  }

  guard({ enabled, mode, suspicion, hint }) {
    if (!this.el.guardBox) return;
    this.el.guardBox.classList.toggle('off', !enabled);
    // 「主人」而不是「守卫」：这一局的设定是闯空门，屋里站着的是房主本人。
    // 空屋（没有主人）也标成「空 屋」，和另外三个两字标签同一个排版节奏。
    const label = !enabled ? '空 屋'
      : mode === 'chase' ? '追 击' : mode === 'alert' ? '察 觉' : '巡 逻';
    if (this.el.guardState) this.el.guardState.textContent = label;
    if (this.el.guardDot) {
      this.el.guardDot.dataset.mode = !enabled ? 'off' : mode;
    }
    if (this.el.suspFill) {
      const v = enabled ? Math.max(0, Math.min(1, suspicion)) : 0;
      this.el.suspFill.style.width = (v * 100).toFixed(1) + '%';
      this.el.suspFill.dataset.mode = v > 0.66 ? 'hot' : v > 0.2 ? 'warm' : 'cool';
    }
    if (this.el.guardHint) this.el.guardHint.textContent = hint || '';
  }

  toast(text, kind = 'info') {
    if (!this.el.toasts) return;
    const d = document.createElement('div');
    d.className = 'toast ' + kind;
    d.textContent = text;
    this.el.toasts.appendChild(d);
    return d;
  }

  /**
   * The crosshair hint: what E would do to the thing you are looking at.
   *
   * Pass the prop the play layer's ray found, or null. The label comes from the
   * SAME `kind`/`open` the activation will use, so the prompt cannot promise an
   * action the key would not take -- a prompt that says "打开" over something E
   * treats as "关上" is the small lie this repo keeps refusing to ship.
   *
   * `state` is deliberately reused as `lastKey` so a no-op frame does not touch
   * the DOM: this runs 60x a second.
   */
  propPrompt(state) {
    const el = this.el.propPrompt;
    if (!el) return;
    if (!state) {
      if (this._propKey !== '') { el.hidden = true; this._propKey = ''; }
      return;
    }
    const verb = state.kind === 'slide' ? (state.open ? '拉开' : '推回')
      : (state.open ? '打开' : '关上');
    const key = verb + '|' + state.model;
    if (key === this._propKey) return;
    this._propKey = key;
    if (this.el.propPromptText) this.el.propPromptText.textContent = verb;
    el.hidden = false;
  }

  flash(kind) {
    if (!this.el.flash) return;
    this.el.flash.className = kind;
    // Force a reflow so repeating the same flash restarts the animation.
    void this.el.flash.offsetWidth;
  }

  /** The room-wide colour grade: warm when a guard is chasing, cold at 0 clock. */
  grade(kind) {
    if (this.el.stain) this.el.stain.dataset.kind = kind || 'none';
  }

  banner(text, ms = 1800) {
    const b = this.el.banner;
    if (!b) return;
    b.textContent = text;
    b.classList.add('on');
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => b.classList.remove('on'), ms);
  }

  /* -------------------------------------------------------------- overlays */

  /** Bound once; the overlays are static markup, only their content changes. */
  bindPause({ onResume, onRestart, onMenu }) {
    if ($('pause-resume')) $('pause-resume').onclick = onResume;
    if ($('pause-restart')) $('pause-restart').onclick = onRestart;
    if ($('pause-menu')) $('pause-menu').onclick = onMenu;
  }

  showPause() { this.el.pause.classList.remove('hidden'); }
  hidePause() { this.el.pause.classList.add('hidden'); }

  showEnd({ win, collected, total, used, budget, catches, penalties, seed, presetName, timeouts, onAgain, onMenu }) {
    this.el.end.classList.remove('hidden');
    this.el.endTitle.textContent = win ? '集齐了' : (timeouts ? '时间到' : '结束');
    this.el.endTitle.dataset.win = win ? '1' : '0';
    this.el.endBody.textContent = win
      ? `${total} 个红包全部到手，用时 ${formatClock(used)}（预算 ${formatClock(budget)}）。`
      : `只找到 ${collected}/${total} 个，时间用完了。`;
    this.el.endStats.innerHTML = `
      <span><i>用时</i>${formatClock(used)} / ${formatClock(budget)}</span>
      <span><i>红包</i>${collected} / ${total}</span>
      <span><i>被抓</i>${catches} 次${caughtText(penalties)}</span>
      <span><i>难度</i>${presetName}</span>
      <span><i>种子</i>${seed}</span>
      <span><i>复现</i>菜单种子框填上面这串</span>`;
    if (this.el.endAgain) this.el.endAgain.onclick = onAgain;
    if (this.el.endMenu) this.el.endMenu.onclick = onMenu;
  }

  hideEnd() { this.el.end.classList.add('hidden'); }
}

function caughtText(penalties) {
  if (!penalties) return '';
  return `（罚时 ${formatClock(penalties)}）`;
}
