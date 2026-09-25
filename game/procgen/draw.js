/**
 * draw.js — the floor plan as SVG, drawn from the BUILT LEVEL.
 *
 * WHY DRAW THE LEVEL AND NOT THE LAYOUT. Everything below is a solid the game
 * will collide with, a door it will treat as shut or open, and a prize it will
 * ask the player to find. A generator that believes it placed a wardrobe
 * against the north wall and a level that put it across a doorway look
 * identical in a layout dump and completely different here. So if the generator
 * and the game ever disagree, the picture shows the disagreement instead of
 * hiding it -- which is why the drawing code reads the level and nothing else.
 *
 * Shares its implementation with the CLI on purpose: `scripts/procgen.mjs`
 * writes what `planSVG`/`contactSVG` return, and `procgen.html` puts the same
 * string straight into the page. One drawing, two surfaces.
 */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One plan, in a <g>. `item` is { level, placement, checks }. */
export function planGroup({ level, placement, checks }, scale, showLabels) {
  const S = scale;
  const W = level.meta.plan.w * S;
  const H = level.meta.plan.d * S;
  const out = [];
  const px = (v) => (v * S).toFixed(2);

  const roleOf = (id) => (level.rooms.find((r) => r.id === id) || {}).id;

  out.push(`<rect x="0" y="0" width="${W.toFixed(1)}" height="${H.toFixed(1)}" fill="#f6f1e7"/>`);

  // rooms, tinted by their own hue so a mis-assigned role is visible at a glance
  const HUES = { living: '#e07a72', bedroom: '#e0a06a', kitchen: '#9dc47f', bath: '#7fc9d6', dining: '#d9b06a', study: '#8fa9d6' };
  for (const r of level.rooms) {
    const b = r.rect;
    const base = (r.id || '').replace(/[0-9]+$/, '');
    const hue = HUES[base] || '#dddddd';
    out.push(`<rect x="${px(b.x0)}" y="${px(b.z0)}" width="${px(b.x1 - b.x0)}" height="${px(b.z1 - b.z0)}" fill="${hue}" fill-opacity="0.20"/>`);
  }

  // furniture first (so walls and doors read on top)
  for (const s of level.solids) {
    if (s.kind !== 'furniture') continue;
    const fill = s.red ? '#C8102E' : '#b9a184';
    const op = s.red ? '0.72' : (s.y0 > 0.4 ? '0.35' : '0.60');
    out.push(`<rect x="${px(s.x - s.hx)}" y="${px(s.z - s.hz)}" width="${px(s.hx * 2)}" height="${px(s.hz * 2)}"`
      + ` transform="rotate(${s.rot} ${px(s.x)} ${px(s.z)})" fill="${fill}" fill-opacity="${op}" stroke="#5b4a36" stroke-width="0.5"/>`);
    if (s.glass) {
      out.push(`<rect x="${px(s.x - s.hx)}" y="${px(s.z - s.hz)}" width="${px(s.hx * 2)}" height="${px(s.hz * 2)}"`
        + ` transform="rotate(${s.rot} ${px(s.x)} ${px(s.z)})" fill="none" stroke="#4aa3c7" stroke-width="1" stroke-dasharray="2 2"/>`);
    }
  }

  // walls
  for (const s of level.solids) {
    if (s.kind !== 'wall') continue;
    out.push(`<rect x="${px(s.x - s.hx)}" y="${px(s.z - s.hz)}" width="${px(s.hx * 2)}" height="${px(s.hz * 2)}"`
      + ` fill="${s.blocksSight ? '#3b3b3b' : '#9a9a9a'}"/>`);
  }

  // doors: a shut leaf is solid, an open frame is a pair of jambs with a gap
  for (const s of level.solids) {
    if (s.kind !== 'door') continue;
    const shut = s.blocksMove;
    if (shut) {
      out.push(`<rect x="${px(s.x - s.hx)}" y="${px(s.z - s.hz)}" width="${px(s.hx * 2)}" height="${px(s.hz * 2)}"`
        + ` transform="rotate(${s.rot} ${px(s.x)} ${px(s.z)})" fill="#7a5c3a"/>`);
    } else {
      // the leaf is the FRAME; the passage is whatever the wall leaves open
      out.push(`<rect x="${px(s.x - s.hx)}" y="${px(s.z - s.hz)}" width="${px(s.hx * 2)}" height="${px(s.hz * 2)}"`
        + ` transform="rotate(${s.rot} ${px(s.x)} ${px(s.z)})" fill="none" stroke="#2e7d32" stroke-width="2.4"/>`);
    }
  }

  // prizes
  for (const p of placement.prizes) {
    out.push(`<circle cx="${px(p.x)}" cy="${px(p.z)}" r="${Math.max(3, S * 0.07).toFixed(1)}" fill="none" stroke="#C8102E" stroke-width="2"/>`);
    out.push(`<circle cx="${px(p.x)}" cy="${px(p.z)}" r="${Math.max(1.4, S * 0.03).toFixed(1)}" fill="#C8102E"/>`);
  }

  // spawn
  out.push(`<circle cx="${px(level.spawn.x)}" cy="${px(level.spawn.z)}" r="${Math.max(2.4, S * 0.05).toFixed(1)}" fill="#1b6ec2" stroke="#ffffff" stroke-width="1.4"/>`);

  if (showLabels) {
    for (const r of level.rooms) {
      const fs = Math.max(9, Math.min(14, S * 0.20));
      out.push(`<text x="${px((r.rect.x0 + r.rect.x1) / 2)}" y="${px((r.rect.z0 + r.rect.z1) / 2)}"`
        + ` font-family="system-ui,Segoe UI,sans-serif" font-size="${fs}" font-weight="600"`
        + ` text-anchor="middle" fill="#2b2b2b" fill-opacity="0.85">${esc(roleOf(r.id) || '')}</text>`);
      out.push(`<text x="${px((r.rect.x0 + r.rect.x1) / 2)}" y="${px((r.rect.z0 + r.rect.z1) / 2 + 0.42)}"`
        + ` font-family="system-ui,Segoe UI,sans-serif" font-size="${fs * 0.72}"`
        + ` text-anchor="middle" fill="#555" fill-opacity="0.8">${(r.area || 0).toFixed(1)} m2</text>`);
    }
  }
  void W; void H;
  return out.join('\n');
}

/** One plan plus its caption strip and its verdict dot. */
export function frame(item, { scale, label, sub, showLabels }) {
  const { level, checks } = item;
  const W = level.meta.plan.w * scale;
  const H = level.meta.plan.d * scale;
  const head = 34;
  const fails = checks.filter((c) => !c.pass);
  const mark = fails.length ? '#c62828' : '#2e7d32';
  return [
    `<rect x="0" y="0" width="${W}" height="${H + head}" fill="#ffffff" stroke="#e0d9cc"/>`,
    `<text x="8" y="16" font-family="system-ui,Segoe UI,sans-serif" font-size="12" font-weight="700" fill="#222">${esc(label)}</text>`,
    `<text x="8" y="29" font-family="system-ui,Segoe UI,sans-serif" font-size="10.5" fill="#666">${esc(sub)}</text>`,
    `<circle cx="${W - 12}" cy="12" r="5" fill="${mark}"/>`,
    `<text x="${W - 22}" y="16" text-anchor="end" font-family="system-ui,Segoe UI,sans-serif" font-size="10.5" font-weight="600" fill="${mark}">${fails.length ? fails.length + ' FAIL' : 'PASS'}</text>`,
    `<g transform="translate(0 ${head})">`,
    planGroup(item, scale, showLabels),
    '</g>',
  ].join('\n');
}

/** A standalone <svg> for ONE plan. */
export function planSVG(item, { scale, showLabels = true } = {}) {
  const W = item.level.meta.plan.w * scale;
  const H = item.level.meta.plan.d * scale + 34;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<rect width="${W}" height="${H}" fill="#ffffff"/>`
    + frame(item, { scale, label: item.label, sub: item.sub, showLabels })
    + '</svg>';
}

/** A standalone <svg> contact sheet for MANY plans. `items` carry their `scale`. */
export function contactSVG(items, cols) {
  const scale = items[0].scale;
  const cw = items[0].level.meta.plan.w * scale;
  const ch = items[0].level.meta.plan.d * scale + 34;
  const pad = 18;
  const rows = Math.ceil(items.length / cols);
  const W = cols * cw + (cols + 1) * pad;
  const H = rows * ch + (rows + 1) * pad + 46;
  const body = items.map((it, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = pad + c * (cw + pad);
    const y = 46 + pad + r * (ch + pad);
    return `<g transform="translate(${x} ${y})">${frame(it, { scale, label: it.label, sub: it.sub, showLabels: false })}</g>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<rect width="${W}" height="${H}" fill="#f2ede3"/>`
    + `<text x="${pad}" y="28" font-family="system-ui,Segoe UI,sans-serif" font-size="17" font-weight="700" fill="#1f1f1f">`
    + `一寸红 · 程序化户型批量生成</text>`
    + `<text x="${pad}" y="43" font-family="system-ui,Segoe UI,sans-serif" font-size="11" fill="#666">`
    + `每格 = 一次生成，经 buildLevel + nav + regions + placePrizes 实跑判定（绿点 = 全部断言通过）。`
    + `深灰 = 挡视线的墙，绿框 = 可通行的门，深红块 = 带红色贴图的家具（红鲱鱼），红圈 = 红包，蓝点 = 出生点。</text>`
    + body + '</svg>';
}
