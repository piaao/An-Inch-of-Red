/**
 * boot.js — load the arena and hand back the CORE objects the game runs on.
 *
 * This file is the play layer's only contact with `game/core/`. It does not
 * re-implement anything: it calls `buildNav`, `placePrizes` and `buildPatrol`
 * with the exact same options `scripts/verify_game.mjs` used, so the playable
 * game and the headless matrix are running the same world.
 *
 * That equality is checkable, and `scripts/verify_play.mjs` checks it: it
 * computes the placements in Node, then compares them, prize for prize, with
 * what the browser produced. Same seed, same numbers, two runtimes -- which is
 * the whole claim of a portable core, stated as a test instead of a comment.
 */
import { validateLevel } from '../core/level.js';
import { buildNav } from '../core/nav.js';
import { Rng } from '../core/rng.js';
import { placePrizes, defaultViewpoints, prizeRng } from '../core/place.js';
import { buildPatrol } from '../core/guard.js';

/** fetch + parse the arena snapshot. */
export async function loadArena(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`arena ${url}: HTTP ${res.status}`);
  const level = await res.json();
  const problems = validateLevel(level);
  if (problems.length) {
    throw new Error(`arena ${url} failed validation:\n  - ${problems.join('\n  - ')}`);
  }
  return level;
}

/**
 * Everything the level needs, in the order the verification built it.
 *
 * Costs ~0.9 s in Node at the 5 cm grid (scripts/time_boot.mjs). It runs live on
 * the loading screen rather than being baked into the snapshot, because baking
 * it would freeze the nav resolution into the data and a different arena would
 * need a different build step -- which is the coupling `game/core/` exists to
 * avoid. 0.9 s is cheaper than that.
 */
export function buildCore(level, { seed, count, onStage } = {}) {
  const stage = (s) => { if (onStage) onStage(s); };
  const t0 = performance.now();
  const ms = {};

  let t = performance.now();
  // Same options as verify_game.mjs. A coarser or finer grid here would put the
  // browser on a different map from the one the verdict was measured on.
  const nav = buildNav(level, {
    inflate: level.body.playerRadius,
    bodyHeight: level.body.playerHeight,
    step: level.meta.step,
  });
  ms.nav = performance.now() - t;
  stage(`导航网格 ${nav.walkableCount} 格`);

  t = performance.now();
  const guardNav = buildNav(level, {
    inflate: level.body.guardRadius,
    bodyHeight: level.body.guardHeight,
    step: level.meta.step,
  });
  ms.guardNav = performance.now() - t;

  t = performance.now();
  const vantages = defaultViewpoints(level, nav);
  ms.vantages = performance.now() - t;

  // `fork` derives a sub-stream by NAME, so adding a consumer later cannot
  // shift the draws placement already spends -- "same seed, same layout" keeps
  // holding as the code grows.
  t = performance.now();
  const placement = placePrizes(level, nav, prizeRng(seed), {
    count, policy: 'spread', viewpoints: vantages,
  });
  ms.place = performance.now() - t;
  stage(`藏好 ${placement.prizes.length} 个红包`);

  t = performance.now();
  const patrol = buildPatrol(level, guardNav, new Rng(`guard-${seed}`), {});
  ms.patrol = performance.now() - t;
  stage(`巡逻路线 ${patrol.waypoints.length} 个航点`);

  ms.total = performance.now() - t0;
  return { nav, guardNav, vantages, placement, prizes: placement.prizes, patrol, ms };
}

/**
 * The placement report, flattened for the HUD's "关于这一局" panel.
 * Same numbers the terminal report prints, so a player can see whether their
 * run is a typical one or a nasty one.
 */
export function placementSummary(level, core) {
  const byTier = {};
  for (const p of core.prizes) byTier[p.tier] = (byTier[p.tier] || 0) + 1;
  const covers = core.prizes.map((p) => p.cover).sort((a, b) => a - b);
  const rooms = new Set(core.prizes.map((p) => p.room));
  return {
    count: core.prizes.length,
    rooms: rooms.size,
    roomIds: [...rooms],
    byTier,
    coverMin: covers.length ? covers[0] : 0,
    coverMax: covers.length ? covers[covers.length - 1] : 0,
    anchors: core.placement.report.anchorsScored,
    candidates: core.placement.report.stats.candidates,
    rejected: core.placement.report.stats.rejected,
    policy: core.placement.report.policy,
    walkable: core.nav.walkableCount,
    regions: core.nav.components.length,
    waypoints: core.patrol.waypoints.length,
    legsDropped: core.patrol.dropped.length,
    buildMs: Math.round(core.ms.total),
    level,
  };
}
