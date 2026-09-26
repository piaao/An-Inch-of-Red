/**
 * prose.js — the roster's prose, checked against numbers it does not own.
 *
 * WHY THIS EXISTS. `game/maps/index.js` is hand-written, and hand-written
 * prose drifts. The first version of it said 一人间 had "73 件家具" -- true when
 * it was typed, false the moment a bookcase run was added, and nothing in the
 * repo could tell. A blurb is read by every player before the map loads, so a
 * stale number in it is not a typo, it is a wrong measurement shipped to the
 * user.
 *
 * The cure is not "remember to update the prose". It is to make the prose
 * state its numbers in a form a machine can check, and then check them:
 *
 *     N 个房间   must equal the measured room count
 *     N 件家具   must equal the measured item count
 *     N m²      must equal the measured floor area (plan w x d)
 *     N×M m     must equal the measured plan
 *
 * Anything else -- a digit the checker cannot attach to a measured fact -- is
 * reported too, and that is the important half. The failure mode being fixed
 * is not "the wrong number", it is "a number nobody was watching": a blurb
 * that says "54 m² 的中厅" is fine when the hall is 54 m² and invisible when
 * it is 42 m². Refusing to recognise the unit is what makes it visible.
 *
 * One implementation, two callers: `scripts/build_maps.mjs` fails the build on
 * a problem, `scripts/verify_maps.mjs` re-checks the committed roster. Neither
 * owns the rule.
 */

/** A bare number is checkable when a known suffix follows it. */
const UNITS = [
  { suffix: '个房间', of: (s) => s.roomCount, what: 'room count' },
  { suffix: '间房', of: (s) => s.roomCount, what: 'room count' },
  { suffix: '件家具', of: (s) => s.itemCount, what: 'item count' },
  { suffix: '平方米', of: (s) => s.area, what: 'floor area' },
  { suffix: 'm²', of: (s) => s.area, what: 'floor area' },
];

/**
 * Every number in `entry.style` / `entry.blurb` that is not equal to the fact
 * it claims. Returns `[]` when the prose is honest.
 *
 * @param {{id:string, style?:string, blurb?:string}} entry
 * @param {{plan:{w:number,d:number}, area:number, roomCount:number, itemCount:number}} stats
 */
export function proseProblems(entry, stats) {
  const out = [];
  const where = entry.id || '(unnamed)';

  for (const field of ['style', 'blurb']) {
    const text = entry[field];
    if (!text) continue;

    const re = /\d+(?:\.\d+)?/g;
    const tokens = [];
    for (let m = re.exec(text); m; m = re.exec(text)) {
      tokens.push({ value: Number(m[0]), at: m.index, end: m.index + m[0].length });
    }

    const used = new Set();
    for (let i = 0; i < tokens.length; i++) {
      if (used.has(i)) continue;
      const t = tokens[i];
      const rest = text.slice(t.end);
      const excerpt = text.slice(Math.max(0, t.at - 6), t.end + 5);

      // ---- a plan, written as 8×6 (optionally with a trailing m) ----------
      const pair = rest.match(/^\s*[×x]\s*(\d+(?:\.\d+)?)/);
      if (pair && tokens[i + 1] && tokens[i + 1].at <= t.end + 6) {
        used.add(i);
        used.add(i + 1);
        const d = Number(pair[1]);
        if (t.value !== stats.plan.w || d !== stats.plan.d) {
          out.push(`${where} ${field}: "${t.value}×${d}" is not this map's plan`
            + ` (${stats.plan.w}×${stats.plan.d})`);
        }
        continue;
      }

      // ---- a fact with a unit ---------------------------------------------
      const bare = rest.replace(/^\s*/, '');
      const unit = UNITS.find((u) => bare.startsWith(u.suffix));
      if (!unit) {
        out.push(`${where} ${field}: the number in "${excerpt}" has no unit this`
          + ' checker knows, so nothing keeps it true -- give it one of'
          + ` ${UNITS.map((u) => u.suffix).join(' / ')}, or write it in words`);
        continue;
      }
      const want = unit.of(stats);
      if (t.value !== want) {
        out.push(`${where} ${field}: says "${t.value}${bare.slice(0, unit.suffix.length)}"`
          + ` but the measured ${unit.what} is ${want}`);
      }
    }
  }
  return out;
}
