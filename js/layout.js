/**
 * layout.js — the apartment, as data.
 *
 * Coordinates: X east, Z south, Y up. One grid unit = one 1.0 m floor tile.
 * The kit's storey is exactly one wall segment tall (1.290), so there is no
 * stacking and no real ceiling — the scene is a cutaway dollhouse, which is
 * the language this kit is drawn in.
 *
 * Furniture is placed by FOOTPRINT CENTRE (x, z) with `r` degrees around Y.
 * The loader normalises every model so (x, 0, z) means "centre of its
 * footprint, sitting on the floor" — no per-model offset fudge anywhere.
 *
 * Wall thickness is 0.05 and walls are placed OUTSIDE the room they enclose,
 * so a room's usable edge is the nominal coordinate. The one exception is the
 * spine wall (z = 3, side +1) and the east spine (x = 6, side +1), whose
 * bodies fall INSIDE the south band — furniture below them is offset by 0.05
 * accordingly. Those offsets are noted inline.
 */

export const WALL_H = 1.29;

/** Outer envelope. Floors tile this rectangle exactly. */
export const PLAN = { w: 10, d: 8 };

/**
 * Zones drive the labels and the camera presets.
 *
 * Every entry carries an explicit `eye` -- the point the camera hangs from --
 * plus `face`, the plan direction the shot is composed to look along.
 *
 * The first version derived the camera from a distance and an azimuth that ran
 * "outward from the plan centre through the focus point". That is a formula
 * with no idea what is in the room, and it showed: the living-room camera
 * ended up north of the sofa with the TV wall it was meant to show behind the
 * lens, and the kitchen shot looked at the back of the north wall. An eye and
 * a facing direction can be checked; a distance and an angle cannot.
 */
export const ZONES = [
  { id: 'bedroom', name: '卧室', hue: '#e0a06a', at: [2.0, 1.6],
    focus: [2.05, 0.45, 1.25], eye: [1.35, 3.35, 5.05], face: [0, -1] },
  { id: 'bath', name: '卫生间', hue: '#7fc9d6', at: [5.0, 2.1],
    focus: [4.95, 0.50, 1.35], eye: [5.55, 2.95, 4.75], face: [0, -1] },
  { id: 'kitchen', name: '厨房', hue: '#9dc47f', at: [7.9, 1.6],
    focus: [8.00, 0.45, 1.05], eye: [7.55, 3.20, 4.50], face: [0, -1] },
  { id: 'living', name: '客厅', hue: '#e07a72', at: [2.2, 5.9],
    focus: [2.20, 0.40, 6.60], eye: [2.35, 3.25, 3.45], face: [0, 1] },
  { id: 'dining', name: '餐厅', hue: '#d9b06a', at: [7.9, 4.1],
    focus: [7.95, 0.42, 4.00], eye: [7.15, 2.85, 5.95], face: [0, -1] },
  { id: 'study', name: '书房', hue: '#8fa9d6', at: [8.1, 6.6],
    focus: [8.90, 0.50, 6.90], eye: [7.00, 3.05, 4.35], face: [0.5, 1] },
];

/* ------------------------------------------------------------------- walls */
/**
 * A wall run walks `from`..`to` along an axis, laying 1 m segments and one
 * 0.5 m `wallHalf` for any .5 remainder.
 *
 *  axis 'x' : wall lies along X at Z = `at`
 *  axis 'z' : wall lies along Z at X = `at`
 *  side -1  : wall body falls on the low side of `at` (room is on the high side)
 *  side +1  : wall body falls on the high side
 *  kinds    : { segmentIndex: modelName }; `null` leaves a gap (an opening)
 */
export const WALLS = [
  // ---- perimeter (bodies outside the floor slab) -------------------------
  { id: 'north', axis: 'x', at: 0, from: 0, to: 10, side: -1,
    kinds: { 2: 'wallWindow', 7: 'wallWindow' } },
  // The entrance uses `wallDoorway`, not `wallDoorwayWide`. Measured with
  // the renderer (scripts/probe_passages.js): `wallDoorwayWide` opens 0.86 m
  // but the front door model only covers 0.486, leaving a pair of 18 cm slits
  // straight through the building envelope. `wallDoorway` opens 0.44 m and the
  // door closes it properly.
  { id: 'south', axis: 'x', at: 8, from: 0, to: 10, side: 1,
    kinds: { 4: 'wallDoorway', 8: 'wallWindow' } },
  { id: 'west', axis: 'z', at: 0, from: 0, to: 8, side: -1,
    kinds: { 4: 'wallWindow' } },
  { id: 'east', axis: 'z', at: 10, from: 0, to: 8, side: 1,
    kinds: { 1: 'wallWindow', 6: 'wallWindow' } },

  // ---- interior partitions ----------------------------------------------
  { id: 'bed|bath', axis: 'z', at: 4, from: 0, to: 3, side: -1 },
  { id: 'bath|kit', axis: 'z', at: 6, from: 0, to: 3, side: -1 },
  // north band (bedroom/bath/kitchen) vs south band — body sits at z 3..3.05
  { id: 'spine', axis: 'x', at: 3, from: 0, to: 10, side: 1,
    kinds: { 2: 'wallDoorway', 4: 'wallDoorway', 8: 'wallDoorway' } },
  // living vs dining/study — body sits at x 6..6.05
  //
  // This run carries a doorway and it is load-bearing for the whole building.
  // Measured with the renderer, without it the apartment is THREE sealed
  // regions -- {bedroom, living}, {bath}, {kitchen, dining, study} -- because
  // every other link between the two bands is a shut door. Nobody noticed
  // while the scene was only ever looked at, because a sealed wall looks
  // exactly like a wall.
  { id: 'living|east', axis: 'z', at: 6, from: 3, to: 8, side: 1,
    kinds: { 3: 'wallDoorway' } },
  // dining vs study, with an open bay at x 7..8 — body sits at z 5..5.05
  { id: 'dine|study', axis: 'x', at: 5, from: 6, to: 10, side: 1,
    kinds: { 7: null } },
];

/**
 * Corner brackets -- deliberately EMPTY. Kept as a list (rather than deleted)
 * so the build step still has a documented hook if a future layout needs them.
 *
 * The kit's `wallCorner` bracket assumes a run that BEGINS at a corner and
 * turns: it carries the two half-thicknesses that tidy the inside of the turn.
 * Our runs are laid slab edge to slab edge, so two full segments already close
 * the corner and the bracket only adds ~0.28 m of wall poking out past the
 * envelope -- four loose flaps, plainly visible from above. The 5 cm seam it
 * would have hidden is not visible in any view we ship.
 */
export const CORNERS = [];

/** Door leaves, sat inside their opening (thin spine wall spans z 3..3.05). */
export const DOORS = [
  { m: 'doorwayOpen', x: 2.5, z: 3.025, r: 0, note: '卧室门' },
  // The kit ships `doorway` here: a shut leaf with a metal handle (188 tris
  // against the open frame's 28, measured), and the renderer confirms it is
  // SOLID from floor to head height. That detail was the prototype's first
  // gift -- a room with one narrow way in -- but a room you cannot enter at
  // all is a bug in a search game, not a feature, so the leaf becomes the open
  // frame. The doorway is still 0.44 m wide: single file, one way in.
  { m: 'doorwayOpen', x: 4.5, z: 3.025, r: 0, note: '卫生间门（原 doorway 门扇）' },
  // z 3.5 is correct: the `living|east` run starts at z 3, so its
  // `kinds: { 3: 'wallDoorway' }` key anchors the doorway at z 3..4 and
  // the frame that belongs in it sits at the middle, z 3.5. Reading that
  // key as a 0-based segment index is a real trap -- it argues for z 6.5,
  // which is a plain solid wall, and leaves the actual 0.44 m passage
  // with no frame in it.
  { m: 'doorwayOpen', x: 6.025, z: 3.5, r: 90, note: '客厅-餐厅门' },
  { m: 'doorwayOpen', x: 8.5, z: 3.025, r: 0, note: '厨房门' },
  { m: 'doorwayFront', x: 4.5, z: 8.025, r: 180, note: '入户门' },
];

/* --------------------------------------------------------------- furniture */
/**
 * `s` scales the model uniformly — the kit draws chairs narrow, and a touch of
 * scale makes a dining set read as a set. `y` lifts an item for wall-mounted
 * or on-surface placement.
 */
export const ROOMS = [
  {
    id: 'bedroom', name: '卧室',
    items: [
      { m: 'bedDouble', x: 1.10, z: 0.60, r: 0, note: '双人床，床头靠北墙' },
      { m: 'sideTable', x: 0.35, z: 0.36, r: 90 },
      { m: 'lampRoundTable', x: 0.35, z: 0.36, r: 0, y: 0.384 },
      { m: 'sideTableDrawers', x: 1.84, z: 0.36, r: 90 },
      { m: 'lampRoundTable', x: 1.84, z: 0.36, r: 0, y: 0.384 },
      { m: 'pillow', x: 0.90, z: 0.22, r: 0, y: 0.375 },
      { m: 'pillowLong', x: 1.32, z: 0.22, r: 0, y: 0.375 },
      { m: 'bear', x: 1.10, z: 0.80, r: 200, y: 0.375 },
      { m: 'bookcaseClosedWide', x: 2.75, z: 0.125, r: 0, note: '矮书柜靠北墙' },
      { m: 'books', x: 2.58, z: 0.13, r: 12, y: 0.79 },
      { m: 'books', x: 2.86, z: 0.13, r: -8, y: 0.79 },
      { m: 'bookcaseClosedDoors', x: 3.865, z: 1.60, r: 90, note: '衣柜靠东墙' },
      { m: 'rugRectangle', x: 2.70, z: 2.00, r: 0, note: '床尾地毯' },
      { m: 'lampWall', x: 2.20, z: 0.04, r: 0, y: 0.92, note: '壁灯' },
      { m: 'plantSmall1', x: 3.76, z: 2.78, r: 30 },
      { m: 'trashcan', x: 2.30, z: 2.82, r: 0 },
    ],
  },
  {
    id: 'bath', name: '卫生间',
    items: [
      { m: 'bathtub', x: 4.30, z: 0.66, r: 90, note: '浴缸贴西墙' },
      { m: 'toilet', x: 4.26, z: 1.80, r: 90 },
      { m: 'bathroomSink', x: 5.805, z: 0.75, r: -90, y: 0.55, note: '壁挂洗手盆' },
      { m: 'bathroomMirror', x: 5.878, z: 0.75, r: -90, y: 1.02, note: '镜子' },
      { m: 'bathroomCabinetDrawer', x: 5.790, z: 1.72, r: -90 },
      { m: 'bathroomCabinet', x: 5.88, z: 2.52, r: -90, y: 0.62, note: '吊柜' },
      { m: 'trashcan', x: 4.35, z: 2.74, r: 0 },
    ],
  },
  {
    id: 'kitchen', name: '厨房',
    items: [
      // base run along the north wall (depth 0.45 -> z 0 .. 0.45)
      { m: 'kitchenCabinetCornerRound', x: 6.225, z: 0.225, r: 0, note: '转角柜' },
      { m: 'kitchenCabinetDrawer', x: 6.665, z: 0.225, r: 0 },
      { m: 'kitchenCabinetDrawer', x: 7.095, z: 0.225, r: 0 },
      { m: 'kitchenSink', x: 7.525, z: 0.225, r: 0, note: '水槽' },
      { m: 'kitchenStove', x: 7.955, z: 0.225, r: 0, note: '灶台' },
      { m: 'kitchenCabinetDrawer', x: 8.385, z: 0.225, r: 0 },
      { m: 'kitchenCabinet', x: 8.815, z: 0.225, r: 0 },
      { m: 'kitchenCabinetDrawer', x: 9.245, z: 0.225, r: 0 },
      // wall cabinets at y 0.78
      { m: 'kitchenCabinetUpper', x: 6.665, z: 0.11, r: 0, y: 0.78 },
      { m: 'kitchenCabinetUpperDouble', x: 7.095, z: 0.11, r: 0, y: 0.78 },
      { m: 'hoodModern', x: 7.955, z: 0.15, r: 0, y: 0.78, note: '抽油烟机' },
      { m: 'kitchenCabinetUpperDouble', x: 8.385, z: 0.11, r: 0, y: 0.78 },
      { m: 'kitchenCabinetUpperCorner', x: 8.815, z: 0.105, r: 0, y: 0.78 },
      { m: 'kitchenCabinetUpperLow', x: 9.130, z: 0.11, r: 0, y: 0.78 },
      // fridge in the east corner (0.292 x 0.43 when turned)
      //
      // z 0.62 -> 0.215: TUCKED INTO THE CORNER, and that is a nav fact rather
      // than a styling one. At z 0.62 the fridge's back (z 0.405) stood 0.248 m
      // from the counter run's east end (x 9.46) -- and 0.248 m is WIDER than
      // the 0.24 m body, so the player could physically squeeze through, while
      // nav's 0.05 m lattice could not place a single cell centre in the
      // 0.008 m window that clearance leaves (needs x >= 9.58 and x <= 9.588).
      // The corner behind the fridge therefore read as 0.060 m2 of sealed floor.
      // Flush against the wall, the corner stops being floor at all. Measured
      // with scripts/_probe_ship_regions.mjs; guarded by the pocket assertion in
      // scripts/verify_play.mjs.
      { m: 'kitchenFridge', x: 9.854, z: 0.215, r: -90, note: '冰箱' },
      // countertop clutter
      { m: 'kitchenMicrowave', x: 8.30, z: 0.235, r: 0, y: 0.45 },
      { m: 'kitchenCoffeeMachine', x: 8.56, z: 0.235, r: 0, y: 0.45 },
      { m: 'kitchenBlender', x: 8.80, z: 0.235, r: 0, y: 0.45 },
      { m: 'toaster', x: 9.06, z: 0.235, r: 0, y: 0.45 },
      // island + stools (island depth 0.21 -> z 1.795 .. 2.005)
      { m: 'kitchenBar', x: 6.420, z: 1.90, r: 0 },
      { m: 'kitchenBar', x: 6.850, z: 1.90, r: 0 },
      { m: 'kitchenBar', x: 7.280, z: 1.90, r: 0 },
      { m: 'kitchenBarEnd', x: 7.610, z: 1.90, r: 0 },
      { m: 'stoolBar', x: 6.62, z: 2.14, r: 0 },
      { m: 'stoolBar', x: 7.16, z: 2.14, r: 0 },
      { m: 'plantSmall2', x: 6.30, z: 2.72, r: 210 },
      { m: 'trashcan', x: 9.60, z: 2.66, r: 0 },
    ],
  },
  {
    id: 'living', name: '客厅',
    items: [
      // TV wall (south). Usable z edge is 8.0.
      { m: 'cabinetTelevisionDoors', x: 1.90, z: 7.87, r: 180, note: '电视柜' },
      { m: 'televisionModern', x: 1.90, z: 7.84, r: 180, y: 0.31, note: '电视' },
      { m: 'speaker', x: 1.16, z: 7.90, r: 180 },
      { m: 'speaker', x: 2.64, z: 7.90, r: 180 },
      { m: 'bookcaseOpen', x: 3.50, z: 7.875, r: 180 },
      { m: 'books', x: 3.40, z: 7.88, r: 8, y: 0.06 },
      { m: 'books', x: 3.62, z: 7.88, r: -6, y: 0.06 },
      { m: 'lampRoundFloor', x: 3.18, z: 7.18, r: 0, note: '落地灯' },
      // seating group
      { m: 'rugRectangle', x: 1.40, z: 6.60, r: 0, note: '客厅地毯' },
      { m: 'loungeSofa', x: 0.90, z: 5.72, r: 0 },
      { m: 'loungeSofa', x: 1.90, z: 5.72, r: 0 },
      { m: 'pillow', x: 0.70, z: 5.68, r: 0, y: 0.30 },
      { m: 'pillowBlue', x: 2.08, z: 5.68, r: 0, y: 0.30 },
      { m: 'bear', x: 1.90, z: 5.76, r: 195, y: 0.46 },
      { m: 'tableCoffee', x: 1.40, z: 6.74, r: 0, note: '茶几' },
      { m: 'loungeChair', x: 3.05, z: 6.62, r: -90 },
      { m: 'loungeChairRelax', x: 3.62, z: 5.88, r: -90, note: '躺椅' },
      { m: 'loungeSofaOttoman', x: 2.58, z: 6.98, r: 0 },
      { m: 'radio', x: 3.95, z: 4.62, r: -90 },
      // west wall
      { m: 'bookcaseClosedWide', x: 0.125, z: 4.20, r: 90 },
      { m: 'speakerSmall', x: 0.16, z: 4.00, r: 90, y: 0.79 },
      { m: 'plantSmall3', x: 0.16, z: 4.42, r: 90, y: 0.79 },
      { m: 'pottedPlant', x: 0.44, z: 7.32, r: 0, note: '盆栽' },
      // entry corner — main door at x 4..5 on the south wall
      { m: 'rugDoormat', x: 4.50, z: 7.76, r: 180, note: '门垫' },
      { m: 'coatRackStanding', x: 5.28, z: 7.58, r: 0, note: '衣帽架' },
      { m: 'coatRack', x: 4.50, z: 7.94, r: 180, y: 0.92 },
      { m: 'trashcan', x: 5.30, z: 7.05, r: 0 },
      // north edge (spine wall body occupies z 3 .. 3.05, so start at 3.05)
      { m: 'sideTableDrawers', x: 0.60, z: 3.20, r: 180 },
      { m: 'lampSquareTable', x: 0.60, z: 3.20, r: 0, y: 0.384 },
      { m: 'cardboardBoxClosed', x: 3.40, z: 3.30, r: 18 },
      { m: 'cardboardBoxOpen', x: 3.62, z: 3.52, r: -12 },
      // reading nook filling the living room's north-east quadrant
      { m: 'rugRounded', x: 4.55, z: 4.05, r: 90, note: '阅读角地毯' },
      { m: 'loungeChairRelax', x: 4.50, z: 4.00, r: -135, note: '阅读椅' },
      { m: 'sideTable', x: 5.35, z: 4.35, r: 45 },
      { m: 'lampSquareTable', x: 5.35, z: 4.35, r: 0, y: 0.384 },
      { m: 'bookcaseClosedWide', x: 5.875, z: 4.95, r: -90 },
      { m: 'plantSmall2', x: 3.95, z: 5.05, r: 75 },
    ],
  },
  {
    id: 'dining', name: '餐厅',
    items: [
      { m: 'rugRound', x: 7.90, z: 4.05, r: 0, note: '圆地毯' },
      { m: 'tableCross', x: 7.90, z: 4.05, r: 0, note: '餐桌' },
      { m: 'chairCushion', x: 7.70, z: 3.68, r: 180, s: 1.30 },
      { m: 'chairCushion', x: 8.10, z: 3.68, r: 180, s: 1.30 },
      { m: 'chairModernFrameCushion', x: 7.70, z: 4.42, r: 0, s: 1.30 },
      { m: 'chairModernFrameCushion', x: 8.10, z: 4.42, r: 0, s: 1.30 },
      { m: 'lampSquareCeiling', x: 7.90, z: 4.05, r: 0, y: 1.14, note: '吊灯' },
      { m: 'bookcaseOpenLow', x: 9.870, z: 4.50, r: -90, note: '餐边柜' },
      { m: 'pottedPlant', x: 6.38, z: 4.72, r: 0 },
      { m: 'plantSmall1', x: 9.72, z: 3.26, r: 45 },
      { m: 'sideTableDrawers', x: 8.85, z: 3.28, r: 0 },
      { m: 'books', x: 8.78, z: 3.28, r: 10, y: 0.384 },
      { m: 'trashcan', x: 9.30, z: 4.80, r: 0 },
    ],
  },
  {
    id: 'study', name: '书房',
    items: [
      { m: 'rugSquare', x: 8.10, z: 6.55, r: 0 },
      // desk against the east wall (0.392 x 0.735 when turned)
      { m: 'desk', x: 9.800, z: 6.55, r: -90, note: '书桌' },
      { m: 'computerScreen', x: 9.86, z: 6.55, r: -90, y: 0.384, note: '显示器' },
      { m: 'computerKeyboard', x: 9.71, z: 6.55, r: -90, y: 0.384 },
      { m: 'computerMouse', x: 9.66, z: 6.88, r: -90, y: 0.384 },
      { m: 'chairDesk', x: 9.16, z: 6.55, r: 90, note: '办公椅' },
      // shelving along the south wall
      { m: 'bookcaseClosed', x: 6.62, z: 7.875, r: 180 },
      { m: 'bookcaseClosed', x: 7.04, z: 7.875, r: 180 },
      { m: 'books', x: 6.56, z: 7.88, r: 6, y: 0.06 },
      { m: 'books', x: 7.10, z: 7.88, r: -10, y: 0.06 },
      { m: 'sideTableDrawers', x: 8.55, z: 7.87, r: 180 },
      { m: 'lampSquareTable', x: 8.55, z: 7.87, r: 0, y: 0.384 },
      { m: 'laptop', x: 8.64, z: 7.86, r: 168, y: 0.384 },
      // north edge (dine|study wall body sits at z 5 .. 5.05)
      { m: 'bookcaseClosedWide', x: 6.60, z: 5.18, r: 0 },
      { m: 'speakerSmall', x: 6.40, z: 5.19, r: 0, y: 0.79 },
      { m: 'coatRackStanding', x: 9.62, z: 5.32, r: 0 },
      { m: 'pottedPlant', x: 6.38, z: 7.05, r: 0 },
      { m: 'trashcan', x: 9.60, z: 7.55, r: 0 },
      { m: 'bear', x: 9.30, z: 7.72, r: 150 },
    ],
  },
];

/** Every unique kit model the layout asks for, in load order. */
export function requiredModels() {
  const out = new Set();
  for (const z of ROOMS) for (const it of z.items) if (!it.skip) out.add(it.m);
  for (const d of DOORS) out.add(d.m);
  for (const c of CORNERS) out.add(c.m);
  for (const w of WALLS) {
    const len = w.to - w.from;
    const whole = Math.floor(len + 1e-9);
    for (let k = 0; k < whole; k++) {
      const i = w.from + k;
      const kind = w.kinds && Object.prototype.hasOwnProperty.call(w.kinds, i) ? w.kinds[i] : undefined;
      if (kind === null) continue;
      out.add(kind || 'wall');
    }
    if (len - whole > 0.01) out.add('wallHalf');
  }
  out.add('floorFull');
  return [...out].sort();
}

/** Rough item count per zone, for the info panel. */
export function zoneCounts() {
  return ROOMS.map((r) => ({ id: r.id, name: r.name, count: r.items.filter((i) => !i.skip).length }));
}
