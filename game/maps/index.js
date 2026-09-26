/**
 * index.js — the map roster: id, name, category, and the blurb the menu shows.
 *
 * THIS FILE IS THE SOURCE; `manifest.json` IS THE DERIVED ARTIFACT. The menu
 * needs numbers this file must not invent -- how many rooms, how many items,
 * how big the floor is -- and those are not properties of a name, they are
 * properties of a floor plan. So they are MEASURED by `scripts/build_maps.mjs`
 * while it builds each arena, and written into `manifest.json` alongside the
 * prose below. The menu reads the artifact; `scripts/verify_maps.mjs` asserts
 * the artifact still agrees with this file, so the two cannot drift.
 *
 * The prose below quotes those measured numbers ON PURPOSE, and quotes them in
 * a form `game/maps/prose.js` can check: `N 个房间`, `N 件家具`, `N m²`, and a
 * plan written as `N×M m`. A digit the checker cannot attach to a measured fact
 * fails the build. That rule exists because this file shipped a blurb reading
 * "73 件家具" for a map that had 83 -- true when typed, false one bookcase run
 * later, and nothing in the repo could tell.
 *
 * `layout` is null for the shipped apartment, and that is not a special case
 * in the data -- it is the honest description. The apartment's layout lives in
 * `js/layout.js` and is built into `game/arenas/room_scene.json` by
 * `scripts/snapshot_arena.mjs`; it predates this directory and rebuilding it
 * here would produce a file that disagrees with the one every measurement in
 * `game/VERDICT.md` was taken on.
 *
 * EVERY ENTRY'S `id` IS THE ID ITS ARENA GIVES ITSELF, and
 * `scripts/verify_maps.mjs` asserts exactly that. The menu decides which card is
 * the loaded one by comparing the level's `meta.id` with the roster id, so a
 * floor with two names is a floor the menu cannot mark -- and this file shipped
 * `origin` for an artifact that answers to `room_scene`, which drew six cards
 * with none of them chosen and looked entirely normal while doing it. The id is
 * not a nickname: to change it you change what the artifact calls itself.
 *
 * `category` is the roster's own vocabulary, not a difficulty: 小 / 中 / 大
 * name the SHAPE of the map (rooms vs items), 原型 is the one map that shipped
 * before any of this existed.
 */

/** The five hand-made maps' own description of themselves. */
export const MAPS = [
  {
    id: 'room_scene',
    name: '剖面公寓',
    category: '原型',
    tier: 0,
    style: '两带六室 · 10×8 m',
    blurb: '最早的那张图：6 个房间、119 件家具塞进 80 m²。它的每一个数字都是 '
      + 'game/VERDICT.md 里被量过的那一套，所以它也是判断别的图好不好玩的基准。',
    layout: null,
    arena: './game/arenas/room_scene.json',
  },
  {
    id: 'studio',
    name: '一人间',
    category: '小',
    tier: 1,
    style: '一室到底 · 8×6 m · 物品最密',
    blurb: '2 个房间、83 件家具挤在 48 m² 里。厨房、床、书桌、沙发全在同一片地上：'
      + '没有门框告诉你走到哪了，因为只有一个地方可去。单件物品最密的一张图。',
    layout: 'game/maps/studio.js',
    arena: './game/arenas/maps/studio.json',
  },
  {
    id: 'den',
    name: '藏书房',
    category: '小',
    tier: 1,
    style: '书墙围合 · 9×7 m',
    blurb: '3 个房间、87 件家具铺在 63 m² 上，书架沿墙排满。'
      + '地面被薄家具切碎，每一条视线都被书脊挡住 —— 和「一人间」同量级，但走起来像迷宫。',
    layout: 'game/maps/den.js',
    arena: './game/arenas/maps/den.json',
  },
  {
    id: 'twobed',
    name: '两室一厅',
    category: '中',
    tier: 2,
    style: '中轴对称 · 14×10 m · 八间',
    blurb: '南北两带、8 个房间，165 件家具，140 m²。动线是一棵树：客厅是枢纽，'
      + '每间房都与你已经进过的某间房只隔一道门。近七成的地面是空的 —— 能跑起来。',
    layout: 'game/maps/twobed.js',
    arena: './game/arenas/maps/twobed.json',
  },
  {
    id: 'teahouse',
    name: '茶室小院',
    category: '中',
    tier: 2,
    style: '东西长廊 · 13×9 m · 六间',
    blurb: '同样是「平衡」，形状却相反：6 个房间、127 件家具摆在 117 m² 上，'
      + '一条东西向的长廊把北侧切成三间。先是大房间的远视线，后是小房间的窄拐角 —— '
      + '和两室一厅的节奏正好倒过来。',
    layout: 'game/maps/teahouse.js',
    arena: './game/arenas/maps/teahouse.json',
  },
  {
    id: 'manor',
    name: '大宅',
    category: '大',
    tier: 3,
    style: '中厅为轴 · 18×14 m · 十一间',
    blurb: '11 个房间、246 件家具，252 m²，是原始公寓的三倍多。入户门在西南角，'
      + '主卧在西北角，中间隔着一间横贯全宅的中厅 —— 只够扫完西半边。',
    layout: 'game/maps/manor.js',
    arena: './game/arenas/maps/manor.json',
  },
];

/** The map the menu opens on. */
export const DEFAULT_MAP = 'room_scene';

/** Look one up, or `null`. */
export function mapById(id) {
  return MAPS.find((m) => m.id === id) || null;
}

/** The three size categories the roster is built from, in order. */
export const CATEGORIES = ['原型', '小', '中', '大'];
