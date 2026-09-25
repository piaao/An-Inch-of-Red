/**
 * nav.js — walkable grid, connected regions, and A*.
 *
 * The apartment's floor is literally 1 m tiles, so the plan grid IS the
 * navigation grid: 80 cells for 10 x 8. But nothing here assumes that — cell
 * size comes from `meta.cell`, so a different arena with 0.5 m tiles works
 * unchanged.
 *
 * Clearance is CONTINUOUS, not baked into the cells. A cell centre is walkable
 * if a disc of the walker's radius fits there; an edge exists if a straight
 * line between two cell centres stays clear. Bollard-and-line beats
 * "is this cell blocked?" because a 0.486 m doorway is far narrower than the
 * grid, and a coarse blocked-cell test would seal it shut.
 *
 * Region detection is the interesting part. Flood-filling the walkable cells
 * and matching each connected region to a room is how the game learns the
 * floor plan — and, more usefully, how it FAILS when the plan is wrong. If two
 * rooms share a region, a wall is missing. That is the "six rooms collapse
 * into one open floor" failure from the design doc, caught as an assertion
 * rather than as a screenshot nobody looks at twice.
 */

/**
 * Sampling resolution, in metres, for the walkable grid.
 *
 * A grid has to be fine enough that a 0.44 m doorway -- the narrowest this
 * kit builds -- always contains a lattice point. The window a walker of
 * radius 0.12 can stand in is 0.44 - 2*0.12 = 0.20 m across, so in
 * principle anything at or below 0.20 m would do; 0.05 m leaves a factor
 * of four of margin, which matters because furniture narrows doorways in
 * practice (a bin at the bedroom door leaves 0.32 m of it).
 *
 * This is NOT the floor-tile size, even though it coincides with it here
 * because the floor is tiled in 1 m squares. The coincidence is expensive:
 * scripts/diag_resolution.mjs measures this plan as ONE region at 5 cm and
 * SEVEN at 1 m, so a 1 m grid both invents passages and loses real ones.
 */
const DEFAULT_CELL = 0.05;

/**
 * Line-of-sight sample step, in metres. Set by the walker's radius and by
 * the thinnest thing in the level (0.089 m walls), not by the grid: tying
 * it to the grid made every edge test 12x more expensive the moment the
 * grid got finer, and bought no extra accuracy.
 */
const LOS_STEP = 0.05;

/**
 * Bucket solids by grid cell so clearance tests touch a handful, not all 200.
 *
 * TWO THINGS HERE ARE NOT OPTIONAL, and both were wrong until the generated
 * flats asked the question.
 *
 * 1. THE SOLID IS REGISTERED DILATED BY THE WALKER'S RADIUS. `clear()` scans
 *    only the query cell's +-1 bucket neighbourhood, so registering the raw
 *    footprint leaves a hole exactly as wide as the grid step: a 0.12 m radius
 *    spans 2.4 cells of a 0.05 m grid, and a solid whose edge lies 0.05..0.12 m
 *    from a cell centre falls two buckets away and is never tested at all.
 *    Measured on the generated flats: a bookcaseOpenLow 0.105 m from a cell
 *    centre, and a 0.20 m slot between two cabinets, both read as open floor.
 *    Dilating at registration costs a few extra bucket writes per solid, once,
 *    and makes the +-1 scan exact for every query at the nav's own radius.
 *
 * 2. THE INDEX RANGE IS CLAMPED, NOT COMPUTED AND DISCARDED. A solid lying
 *    outside the plan rectangle gets `j0 > j1`, the registration loop body
 *    never runs, and the solid becomes invisible. That is not a corner case:
 *    `fromLayout` places every PERIMETER wall body OUTSIDE the plan on purpose
 *    ("the body never eats floor"), so the outer wall of the apartment has
 *    never been an obstacle to nav. Measured on the shipped arena before this
 *    fix, `nav.clear(0.2, 7.90)` returned true -- a walker standing 0.10 m from
 *    the edge, i.e. inside the wall it is not allowed to see. Clamping puts
 *    such a solid in the boundary cells, where `contains()` -- an exact
 *    geometric test -- decides the question instead of losing it.
 */
function buildBuckets(blockers, plan, cell, pad) {
  const w = Math.ceil(plan.w / cell);
  const d = Math.ceil(plan.d / cell);
  const buckets = new Array(w * d);
  for (let i = 0; i < w * d; i++) buckets[i] = [];
  const bound = (lo, hi, lim) => [
    Math.max(0, Math.min(lim, Math.floor(lo / cell))),
    Math.max(0, Math.min(lim, Math.floor(hi / cell))),
  ];
  for (let k = 0; k < blockers.length; k++) {
    const s = blockers[k];
    const a = s.footprint || { x0: s.x - s.hx, z0: s.z - s.hz, x1: s.x + s.hx, z1: s.z + s.hz };
    const [i0, i1] = bound(a.x0 - pad, a.x1 + pad, w - 1);
    const [j0, j1] = bound(a.z0 - pad, a.z1 + pad, d - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) buckets[j * w + i].push(k);
  }
  return { buckets, w, d };
}

/**
 * @param level    a validated Level
 * @param opts.inflate      body radius (how much clearance the walker needs)
 * @param opts.bodyHeight   head height; solids entirely above it are ignored
 * @param opts.step         tallest rise the walker can step onto
 */
export function buildNav(level, opts = {}) {
  const cell = opts.cell || DEFAULT_CELL;
  const inflate = opts.inflate != null ? opts.inflate : 0.14;
  const bodyHeight = opts.bodyHeight != null ? opts.bodyHeight : 0.42;
  const step = opts.step != null ? opts.step : 0.26;

  const w = Math.ceil(level.meta.plan.w / cell);
  const d = Math.ceil(level.meta.plan.d / cell);

  // `sealOpenings` puts every doorway and every declared bay back into
  // the obstacle list FOR THIS NAV ONLY. Movement never wants it -- a
  // sealed doorway is still a doorway you can walk through. It exists
  // because a room is what you get when you shut the doors: flood-fill
  // the plan with them open and the whole apartment is one room.
  const blockers = opts.sealOpenings && level.openings
    ? level.solids.concat(level.openings.map((o) => ({ ...o, blocksMove: true })))
    : level.solids;
  // Dilation at registration uses the nav's OWN radius, so `clear` at that
  // radius needs no scan margin. A caller asking for more widens its own scan.
  const { buckets, w: bw, d: bd } = buildBuckets(blockers, level.meta.plan, cell, inflate);
  // ONE radius for every edge test in this nav. Regions, A* and the
  // caller's own mover all have to agree, or a route exists on paper and
  // not on the floor -- which is exactly what `inflate * 0.9` bought.
  const edgeRadius = opts.edgeRadius != null ? opts.edgeRadius : inflate;

  const index = (i, j) => (i < 0 || j < 0 || i >= w || j >= d ? -1 : j * w + i);
  const cellOf = (x, z) => ({ i: Math.floor(x / cell), j: Math.floor(z / cell) });
  const centreOf = (i, j) => ({ x: (i + 0.5) * cell, z: (j + 0.5) * cell });

  /**
   * Does a disc of `radius` fit here without overlapping an obstacle, with the
   * feet at `feetY`?
   *
   * ONE RULE, TWO HEIGHTS. A solid blocks movement when it rises above the
   * feet by more than `step` AND still starts below the head:
   *
   *     s.y1 > feetY + step   &&   s.y0 < feetY + bodyHeight
   *
   * At `feetY = 0` -- which is every caller that existed before climbing -- that
   * is exactly the old pair of skips (`s.y1 <= step` walked over, `s.y0 >=
   * bodyHeight` walked under), so the guard, A*, the region flood fill and the
   * placement's own probe all keep the numbers the headless matrix measured.
   * At `feetY > 0` the very same rule is simply asked where the feet are now,
   * which is what lets a jump carry you onto a 0.42 m bathtub without inventing
   * a second collision model to disagree with this one.
   *
   * `feetY` is a default so the 3-argument call is still the ground-level one.
   */
  function clear(x, z, radius = inflate, feetY = 0) {
    const ci = Math.floor(x / cell);
    const cj = Math.floor(z / cell);
    const headY = feetY + step;
    const topY = feetY + bodyHeight;
    // Buckets carry footprints dilated by `inflate`, so one bucket of margin is
    // exact for a query at that radius. A LARGER radius gets a matching margin
    // rather than a silent hole -- the failure this whole function just had.
    const m = radius <= inflate + 1e-9 ? 1 : Math.ceil(radius / cell) + 1;
    for (let j = cj - m; j <= cj + m; j++) {
      if (j < 0 || j >= bd) continue;
      for (let i = ci - m; i <= ci + m; i++) {
        if (i < 0 || i >= bw) continue;
        for (const k of buckets[j * bw + i]) {
          const s = blockers[k];
          if (s.blocksMove === false) continue;     // a passage, or a pane of glass
          if (s.y1 <= headY) continue;              // at or under the feet: walk over
          if (s.y0 >= topY) continue;               // over the head: walk under
          if (contains(s, x, z, radius)) return false;
        }
      }
    }
    return true;
  }

  function contains(s, x, z, radius) {
    // Inline of level.js containsXZ(), with a circular test rather than a
    // square one -- a square pad would over-block narrow doorways.
    const a = -(s.rot * Math.PI) / 180;
    const dx = x - s.x;
    const dz = z - s.z;
    const lx = dx * Math.cos(a) - dz * Math.sin(a);
    const lz = dx * Math.sin(a) + dz * Math.cos(a);
    const qx = Math.max(Math.abs(lx) - s.hx, 0);
    const qz = Math.max(Math.abs(lz) - s.hz, 0);
    return qx * qx + qz * qz <= radius * radius;
  }

  /** Straight-line clearance at body height, sampled. `feetY` passes through
   *  so a route test can be asked at the height it is walked at. */
  function los(ax, az, bx, bz, radius = inflate, feetY = 0) {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    const n = Math.max(2, Math.ceil(len / LOS_STEP));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      if (!clear(ax + dx * t, az + dz * t, radius, feetY)) return false;
    }
    return true;
  }

  // ---- cells -------------------------------------------------------------
  const walkable = new Uint8Array(w * d);
  let walkableCount = 0;
  for (let j = 0; j < d; j++) {
    for (let i = 0; i < w; i++) {
      const c = centreOf(i, j);
      const ok = clear(c.x, c.z) ? 1 : 0;
      walkable[j * w + i] = ok;
      walkableCount += ok;
    }
  }

  // ---- regions (4-connected: conservative, so a missing wall shows up) ----
  const comp = new Int16Array(w * d).fill(-1);
  const components = [];
  for (let j = 0; j < d; j++) {
    for (let i = 0; i < w; i++) {
      const start = index(i, j);
      if (comp[start] !== -1 || !walkable[start]) continue;
      const id = components.length;
      const cells = [];
      const stack = [start];
      comp[start] = id;
      while (stack.length) {
        const cur = stack.pop();
        const ci = cur % w;
        const cj = (cur - ci) / w;
        cells.push({ i: ci, j: cj, x: (ci + 0.5) * cell, z: (cj + 0.5) * cell });
        const push = (ni, nj) => {
          const nx = index(ni, nj);
          if (nx < 0 || comp[nx] !== -1 || !walkable[nx]) return;
          // Edge VERIFIED, exactly as astar() verifies it. Plain cell
          // adjacency is not enough: a kit wall is 0.089 m thick and a
          // nav cell is 1 m, so the wall lies on the boundary between
          // two adjacent cell centres and a naive flood steps straight
          // across it. That is how six walled rooms read as one open
          // floor while every wall was present and correct.
          const nc = centreOf(ni, nj);
          if (!los((ci + 0.5) * cell, (cj + 0.5) * cell, nc.x, nc.z, edgeRadius)) return;
          comp[nx] = id;
          stack.push(nx);
        };
        push(ci - 1, cj); push(ci + 1, cj); push(ci, cj - 1); push(ci, cj + 1);
      }
      const cx = cells.reduce((a, c) => a + c.x, 0) / cells.length;
      const cz = cells.reduce((a, c) => a + c.z, 0) / cells.length;
      components.push({ id, cells, area: cells.length * cell * cell, cx, cz });
    }
  }

  function componentAt(x, z) {
    const { i, j } = cellOf(x, z);
    const k = index(i, j);
    return k < 0 ? -1 : comp[k];
  }

  /**
   * Nearest WALKABLE CELL CENTRE, searched in rings. Null if none in range.
   *
   * `maxDistance` is in METRES, and that is not cosmetic. It used to be a
   * count of cells, so a caller passing 4 meant four metres on the 1 m grid
   * it was written against and 20 cm on the 5 cm grid the nav actually
   * uses -- silently, and only for the seeds that live inside furniture.
   *
   * This searches UNCONDITIONALLY, and that is the whole point of it existing
   * separately. The `clear(x, z)` shortcut lives one level up in
   * `nearestWalkable`, because "where can this body stand" and "which cell can
   * I plan from" are different questions, and conflating them is what broke
   * astar -- see `nodeOf`.
   */
  function nearestCentre(x, z, maxDistance = 2) {
    const maxCells = Math.max(1, Math.ceil(maxDistance / cell));
    const { i, j } = cellOf(x, z);
    for (let r = 1; r <= maxCells; r++) {
      let best = null;
      let bestD = Infinity;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const k = index(i + di, j + dj);
          if (k < 0 || !walkable[k]) continue;
          const c = centreOf(i + di, j + dj);
          const dd = (c.x - x) ** 2 + (c.z - z) ** 2;
          if (dd < bestD) { bestD = dd; best = c; }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * A point where this body fits: itself when it fits, else the nearest cell
   * centre. Answers "can I stand here", NOT "where can I plan from" -- the
   * second question is `nodeOf`'s, and keeping them apart is the fix.
   */
  function nearestWalkable(x, z, maxDistance = 2) {
    if (clear(x, z)) return { x, z };
    return nearestCentre(x, z, maxDistance);
  }

  /**
   * A lattice NODE for a point: the cell it sits in, or the nearest walkable
   * cell centre when that cell is not walkable.
   *
   * WHY THE CELL AND NOT THE POINT. `clear` is CONTINUOUS while `walkable[]`
   * samples CELL CENTRES, so a point can be clear while its own cell is not --
   * and a cell that is not walkable belongs to no component, which makes every
   * route out of it report "no route". A* plans over cells, so it needs a cell.
   *
   * The cost of getting this wrong was invisible, and it was already being
   * paid. A generated 16x14 flat had ONE guard-nav component (64,502 cells) and
   * a legally clear spawn whose own cell was not walkable: A* reached 0 of 23
   * patrol stops, so buildPatrol dropped 23 of 24 and the guard would have
   * patrolled one room forever. The SHIPPED apartment has the same fault all
   * along -- 12 stops built, 6 dropped -- so half its patrol was never walked,
   * and every coverage number measured on that patrol was measured on half a
   * patrol. (scripts/_probe_astar.mjs, scripts/_probe_guard_nan.mjs.)
   *
   * Safe everywhere: it returns exactly the cell astar used before whenever
   * that cell IS walkable, so working routes are untouched bit for bit
   * (scripts/_probe_astar_ab.mjs).
   */
  function nodeOf(x, z) {
    const c0 = cellOf(x, z);
    const k0 = index(c0.i, c0.j);
    if (k0 >= 0 && walkable[k0]) return { k: k0, x, z };
    const c = nearestCentre(x, z);
    if (!c) return null;
    const c1 = cellOf(c.x, c.z);
    const k1 = index(c1.i, c1.j);
    return k1 >= 0 && walkable[k1] ? { k: k1, x: c.x, z: c.z } : null;
  }

  /**
   * A* over cell centres, 8-connected, with every edge verified by a
   * straight-line clearance test. Returns [{x,z}, ...] including both ends,
   * or null when no route exists.
   */
  function astar(from, to) {
    const a = nearestWalkable(from.x, from.z);
    const b = nearestWalkable(to.x, to.z);
    if (!a || !b) return null;

    // THE ENDPOINTS ARE POINTS; THE SEARCH RUNS OVER CELLS. `a` and `b` are
    // kept verbatim for the returned path's first and last node -- callers
    // steer from where they really are -- but the SEARCH needs walkable cells,
    // or it starts in a cell that belongs to no component and reports "no
    // route" for a route that exists. See `nodeOf`.
    const na = nodeOf(a.x, a.z);
    const nb = nodeOf(b.x, b.z);
    if (!na || !nb) return null;
    const ka = na.k;
    const kb = nb.k;
    if (ka < 0 || kb < 0) return null;
    if (comp[ka] !== comp[kb]) return null;        // different region: give up early
    if (ka === kb) return [{ x: a.x, z: a.z }, { x: b.x, z: b.z }];

    const h = (k) => {
      const i = k % w;
      const j = (k - i) / w;
      return Math.hypot((i + 0.5) * cell - b.x, (j + 0.5) * cell - b.z);
    };

    // Binary heap on f, plus a closed set. The linear "scan the open set for
    // the smallest f" this replaced cost 80 iterations on the 1 m grid it was
    // written for; at the 5 cm the nav actually uses it would be 32000^2.
    const gScore = new Map([[ka, 0]]);
    const came = new Map();
    const closed = new Set();
    const heap = [];
    const heapPush = (k, f) => {
      heap.push([f, k]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
        i = p;
      }
    };
    const heapPop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          const t = heap[m]; heap[m] = heap[i]; heap[i] = t;
          i = m;
        }
      }
      return top[1];
    };
    heapPush(ka, h(ka));

    let guardIterations = w * d * 8;
    while (heap.length && guardIterations-- > 0) {
      const cur = heapPop();
      if (closed.has(cur)) continue;          // a stale duplicate entry
      closed.add(cur);
      if (cur === kb) {
        const path = [];
        let node = cur;
        while (node !== undefined) {
          const i = node % w;
          const j = (node - i) / w;
          path.push(centreOf(i, j));
          node = came.get(node);
        }
        path.reverse();
        path[0] = { x: a.x, z: a.z };
        path[path.length - 1] = { x: b.x, z: b.z };
        return path;
      }
      const ci = cur % w;
      const cj = (cur - ci) / w;
      const cc = centreOf(ci, cj);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const nk = index(ci + di, cj + dj);
          if (nk < 0 || !walkable[nk] || closed.has(nk)) continue;
          const nc = centreOf(ci + di, cj + dj);
          // `edgeRadius`, not `inflate * 0.9`. The 10 % discount this
          // used to carry made A* plan edges the walker could not take:
          // 0.135 m of clearance is not 0.15 m of clearance in a
          // 0.44 m doorway. The guard's mover then found that out at
          // runtime, by grinding into the jamb for 460 s of a 600 s
          // shift (scripts/diag_guard_where.mjs).
          if (!los(cc.x, cc.z, nc.x, nc.z, edgeRadius)) continue;
          const tentative = (gScore.get(cur) || 0) + Math.hypot(di, dj) * cell;
          if (tentative < (gScore.get(nk) ?? Infinity)) {
            came.set(nk, cur);
            gScore.set(nk, tentative);
            heapPush(nk, tentative + h(nk));
          }
        }
      }
    }
    return null;
  }

  function pathLength(path) {
    if (!path) return Infinity;
    let s = 0;
    for (let i = 1; i < path.length; i++) s += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    return s;
  }

  return {
    level, cell, w, d, inflate, bodyHeight, step, edgeRadius,
    sealedOpenings: blockers.length - level.solids.length,
    walkable, walkableCount,
    index, cellOf, centreOf, clear, los, contains,
    components, componentAt, nearestWalkable,
    astar, pathLength,
  };
}
