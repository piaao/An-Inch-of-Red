/**
 * minimap.js — the top-left thumbnail: a floor plan with two headings on it.
 *
 * It is a PLAN, not a radar. It draws the six ROOM rects the arena already
 * declares plus the door openings, and then the one thing a first-person view
 * structurally cannot tell you: which way YOU face, and which way the GUARD
 * faces. Both triangles are drawn from the CORE's own bearings
 * (`avatar.facing()` / `guard.state().facing`, i.e. atan2(dz, dx), 0 = +X), so
 * the thumbnail cannot disagree with the simulation about where anyone is
 * pointing -- the same discipline the rest of `game/play/` follows.
 *
 * Two things it deliberately does NOT draw:
 *
 *   the 红包     drawing them would be the marker cheating. `refreshCensus`
 *              in play.js goes to some trouble to make "red" the only channel;
 *              a map that highlights the prizes would make the design's central
 *              claim true by rendering instead of by play.
 *   vision cone an UNCLIPPED fan would claim sight through walls. The world
 *              fan is clipped per-ray by the core's `sightLine`; copying that
 *              here would mean 17 sight tests a frame for decoration. Drawing
 *              none is honest; drawing an unclipped one would not be.
 *
 * `project(x, z)` is public on purpose: it is how the verifier asserts that the
 * triangle lands exactly where the world position maps, instead of trusting a
 * picture of one.
 *
 * THE MARKERS ARE BUILT FOR CONTRAST, NOT FOR SIZE. A slightly larger triangle
 * is the wrong lever: the acceptance suite bounds the marker's changed-pixel
 * blob at 12 CSS px, and at this scale the bar is nearly the shape's own
 * width. So the shape keeps its size and gains a dark ground ring, a thin
 * WHITE edge and a solid dot at the position -- the guard's #7fd4ff on the
 * #242e3b floor was a contrast you could only read if you already knew where
 * to look.
 *
 * FOG IS PASSED IN, NOT TRACKED HERE. `draw({fog})` blacks out every cell the
 * run has not seen yet, so the thumbnail starts as a dark card and is drawn by
 * walking. What has been seen is simulation state and lives with the run --
 * this class stays a function of what it is handed.
 */

const PAD = 8;                 // CSS px of margin inside the canvas
const ARROW = 5.0;             // CSS px, tip length of a heading arrow.
// 5.0 rather than 5.2 is not a size cut: the marker's changed-pixel blob is
// bounded at 12 CSS px by `verify_play`, and contrast (white edge, dot,
// guard ring) is what buys legibility here, not area.
// The plan is 10 x 8 m. At the original 208 CSS px the scale was 19 px/m,
// which made the 1.75 m bathroom a 33 px box -- too narrow for a
// three-character name at ANY font size worth reading, so 「卫生间」 was
// either 9 px or spilling over both neighbours. 260 CSS px is 24.4 px/m:
// the bathroom box becomes 43 px, and 36 px of ink fits inside it. The
// canvas grew because the FONT needed the room, not the other way round.
const WIDTH = 260;             // CSS px of plan width
const LABEL_PX = 12;           // CSS px room-name font. Was 9.

const INK_PLAN = '#131922';
const INK_ROOM = '#242e3b';
const INK_ROOM_LINE = 'rgba(255,255,255,.15)';
const INK_DOOR = 'rgba(255,255,255,.34)';
const INK_LABEL = 'rgba(159,176,196,.80)';

/** Matches scene.js MODE_COLOUR, so the thumbnail and the world agree. */
const GUARD_INK = { patrol: '#7fd4ff', alert: '#ffc24d', chase: '#ff4d4d' };
const PLAYER_INK = '#ffd98a';
const Halo = 'rgba(8,10,14,.92)';
/** The thin edge on every marker. White holds on a dark floor AND a lit one. */
const OUTLINE = 'rgba(255,255,255,.92)';
/** Unexplored ground: near-black, a touch blue so it still reads as the map. */
const INK_FOG = 'rgba(6,8,12,.94)';

export class Minimap {
  constructor(canvas, level) {
    this.canvas = canvas;
    // willReadFrequently: the verifier reads this canvas back every run, and
    // the alternative is a Chrome readback warning per frame.
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.level = level;
    this.rooms = level.rooms || [];
    this.doors = level.openings || [];
    this.plan = (level.meta && level.meta.plan) || { w: 10, d: 8 };

    this.pad = PAD;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = WIDTH;
    // Keep the plan's own aspect, so the thumbnail is a scaled copy of the
    // floor rather than a stretched one: distances on it stay comparable.
    this.scale = (this.cssW - PAD * 2) / this.plan.w;
    this.cssD = this.plan.d * this.scale + PAD * 2;

    canvas.style.width = this.cssW + 'px';
    canvas.style.height = this.cssD + 'px';
    canvas.width = Math.round(this.cssW * this.dpr);
    canvas.height = Math.round(this.cssD * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** World (x, z) -> canvas CSS pixels. The verifier's reference frame. */
  project(x, z) {
    return { x: this.pad + x * this.scale, y: this.pad + z * this.scale };
  }

  metrics() {
    return {
      pad: this.pad, scale: this.scale, dpr: this.dpr,
      cssW: this.cssW, cssD: this.cssD,
      pxW: this.canvas.width, pxH: this.canvas.height,
      planW: this.plan.w, planD: this.plan.d,
      rooms: this.rooms.length, doors: this.doors.length,
      labelPx: LABEL_PX, labelled: this.labelled || 0,
    };
  }

  /**
   * @param player  {x, z, facing} — omit/null to leave the player off entirely.
   *                The verifier passes null to A/B the arrow (draw, grab, then
   *                draw with the arrow, grab, diff) exactly the way the world
   *                guard is A/B'd in `scene.js`.
   * @param guard   {x, z, facing, mode} or null
   * @param guards    the whole garrison; `guard` is still accepted for the
   *                single-sentry callers (the verifier draws one)
   * @param fog     {cols, rows, cell, x0, z0, seen} or null. `seen` is a
   *                Uint8Array of cols*rows, 1 = explored. Omit it and the
   *                plan is drawn whole -- which is what the verifier wants.
   */
  draw({ player = null, guard = null, guards = null, fog = null } = {}) {
    const c = this.ctx;
    const m = this.metrics();
    c.clearRect(0, 0, m.cssW, m.cssD);

    // The slab first: corridors must read as floor, not as holes in the map.
    c.fillStyle = INK_PLAN;
    c.fillRect(0, 0, m.cssW, m.cssD);

    c.font = `${LABEL_PX}px "Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';

    this.labelled = 0;
    for (const r of this.rooms) {
      const a = this.project(r.rect.x0, r.rect.z0);
      const b = this.project(r.rect.x1, r.rect.z1);
      const w = b.x - a.x;
      const h = b.y - a.y;
      c.fillStyle = INK_ROOM;
      c.fillRect(a.x, a.y, w, h);
      c.strokeStyle = INK_ROOM_LINE;
      c.lineWidth = 1;
      c.strokeRect(a.x + 0.5, a.y + 0.5, w - 1, h - 1);
      // Label a room when the ink FITS -- and "fits" is MEASURED, not
      // guessed. The old gate was `w > 34 && h > 16`, which passed the 33 px
      // bathroom and then drew a 36 px name straight over its neighbours.
      // Measuring is also what allows the font to grow at all: at 9 px these
      // names were legible only to someone who already knew which room they
      // were looking at. `labelled` is counted so the verifier can assert
      // that growing the font did not silently drop a room off the map.
      const ink = c.measureText(r.name).width;
      if (ink + 4 <= w && h >= LABEL_PX * 1.25) {
        c.fillStyle = INK_LABEL;
        c.fillText(r.name, a.x + w / 2, a.y + h / 2);
        this.labelled += 1;
      }
    }

    // Doorways: where the walls actually stop. This is the thing that makes the
    // thumbnail usable for navigation rather than just decorative.
    c.strokeStyle = INK_DOOR;
    c.lineWidth = 2;
    c.beginPath();
    for (const d of this.doors) {
      const p = this.project(d.x, d.z);
      const hx = (d.hx || 0.2) * this.scale;
      const hz = (d.hz || 0.08) * this.scale;
      if (hz > hx) { c.moveTo(p.x, p.y - hz); c.lineTo(p.x, p.y + hz); }
      else { c.moveTo(p.x - hx, p.y); c.lineTo(p.x + hx, p.y); }
    }
    c.stroke();

    // Fog first, so it covers the plan and NOT the people: a marker you cannot
    // see because you have not walked there yet would be the map forgetting
    // where you are. Half a pixel is added to each cell so the seams between
    // them do not show as hairlines of un-fogged floor.
    //
    // "First" is an ASSERTION, not a comment. `scripts/verify_minimap.mjs`
    // records the call order and fails if the last fog cell is painted after
    // the first marker -- because moving this block below the markers changes
    // no other reading at all, and quietly makes a guard in an unexplored room
    // vanish from the map, in the one game whose whole point is "where is it".
    if (fog && fog.seen) {
      const cs = Math.max(1, fog.cell * this.scale) + 0.5;
      c.fillStyle = INK_FOG;
      for (let j = 0; j < fog.rows; j++) {
        for (let i = 0; i < fog.cols; i++) {
          if (fog.seen[j * fog.cols + i]) continue;
          const a = this.project(fog.x0 + i * fog.cell, fog.z0 + j * fog.cell);
          c.fillRect(a.x, a.y, cs, cs);
        }
      }
    }

    // Guards first, player last: you are the one you must never lose. A
    // single `guard` is still accepted -- it is what the verifier draws -- but
    // the run hands over the whole garrison, because a preset may hold two.
    const gs = (guards && guards.length) ? guards : (guard ? [guard] : []);
    for (const g of gs) {
      const p = this.project(g.x, g.z);
      this.arrow(p.x, p.y, g.facing, ARROW * 1.1,
        GUARD_INK[g.mode] || GUARD_INK.patrol, true);
    }
    if (player) {
      const p = this.project(player.x, player.z);
      this.arrow(p.x, p.y, player.facing, ARROW, PLAYER_INK, false);
    }
    return m;
  }

  /**
   * A triangle whose tip points along a CORE bearing (0 = +X, screen +x right /
   * +z down). Backed off by 0.55 of the tip length so the shape's centroid sits
   * essentially ON the position -- a triangle drawn "from the position to the
   * front" would read as if you were standing where you are about to be.
   *
   * Drawn in THREE passes: a dark ground ring, the colour, then a thin white
   * edge -- plus a small solid dot exactly at the position. The dot is the
   * half that size cannot buy: the triangle's centroid is deliberately behind
   * the position, so without it "where is the marker pointing from" is a
   * judgement call rather than a fact. `ring` adds the outer circle the guard
   * gets, which is what makes the two markers tell apart in a glance instead
   * of by colour alone.
   *
   * Every part stays inside the blob bound the acceptance suite asserts: the
   * widest marker (the guard, at ARROW * 1.1) measures 10.9 CSS px against a
   * bar of 12 -- read back by `scripts/verify_minimap.mjs`, which drives THIS file
   * with a recording canvas. That is why the shape did not grow: contrast is
   * free, and area is what the bar measures.
   */
  arrow(px, py, facing, len, fill, ring = false) {
    const c = this.ctx;
    const dx = Math.cos(facing);
    const dz = Math.sin(facing);
    const nx = -dz;
    const nz = dx;
    const tx = px + dx * len;
    const ty = py + dz * len;
    const bx = px - dx * len * 0.55;
    const by = py - dz * len * 0.55;
    c.beginPath();
    c.moveTo(tx, ty);
    c.lineTo(bx + nx * len * 0.5, by + nz * len * 0.5);
    c.lineTo(bx - nx * len * 0.5, by - nz * len * 0.5);
    c.closePath();
    c.strokeStyle = Halo;
    c.lineWidth = 2.0;
    c.stroke();
    c.fillStyle = fill;
    c.fill();
    c.strokeStyle = OUTLINE;
    c.lineWidth = 1.0;
    c.stroke();

    c.beginPath();
    c.arc(px, py, 1.9, 0, Math.PI * 2);
    c.fillStyle = OUTLINE;
    c.fill();

    if (ring) {
      c.beginPath();
      c.arc(px, py, 3.6, 0, Math.PI * 2);
      c.strokeStyle = fill;
      c.lineWidth = 1.6;
      c.stroke();
    }
  }
}
