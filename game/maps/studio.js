/**
 * studio.js — map 1 of 5. 「一人间」 / The One-Room Flat.
 *
 * CATEGORY 小: few rooms, and the highest item density of the five. Two rooms
 * (起居室 36 m2 + 卫浴 12 m2) inside 8 x 6 m, and the kitchenette, the bed, the
 * desk and the sofa all share the same open floor -- which is what a real
 * one-room flat is, and also what makes it the hardest map to read: there is
 * no doorway to tell you where you are, because there is only one place to be.
 *
 * GEOMETRY CONVENTIONS, inherited from js/layout.js and not re-invented here:
 *
 *   axis 'x'  a wall lies along X at Z = at;  `from`/`to` are X
 *   axis 'z'  a wall lies along Z at X = at;  `from`/`to` are Z
 *   side -1   the wall BODY falls on the low side of `at` -- the room it
 *             encloses is on the HIGH side
 *   kinds {i: model}  the segment of the run that starts at coordinate i
 *             (`i` is the distance along the run from `from`, NOT an index)
 *   kinds {i: null}   a deliberate open bay with no model at all
 *
 * A door sits at `at + side * 0.025`, which is the centre of the wall body --
 * writing the door at `at` would leave it half-buried in the run.
 *
 * ROOMS ARE RECTANGLES AND THEY TILE THE PLAN. Room ownership is decided by
 * bounding box (`roomAt` in game/core/place.js, `roomOfPoint` in level.js), so
 * an L-shaped room would swallow its neighbour's floor and hand that
 * neighbour's 红包 to the wrong room. Every room below is axis-aligned and no
 * two overlap; `scripts/verify_maps.mjs` holds that as a check rather than a
 * convention.
 */
import { row } from './_author.js';

export const WALL_H = 1.29;

/** Outer envelope. Floors tile this rectangle exactly. */
export const PLAN = { w: 8, d: 6 };

export const ZONES = [
  { id: 'living', name: '起居室', hue: '#e0a06a', at: [3.0, 3.0] },
  { id: 'bath', name: '卫浴', hue: '#7fc9d6', at: [7.0, 3.0] },
];

export const WALLS = [
  { id: 'north', axis: 'x', at: 0, from: 0, to: 8, side: -1,
    kinds: { 1: 'wallWindow', 6: 'wallWindow' } },
  // The entrance. `wallDoorway` opens 0.44 m where `wallDoorwayWide` opens
  // 0.86 m and leaves 18 cm slits beside the 0.486 m door leaf -- measured in
  // js/layout.js and true of this kit, so it is true here too.
  { id: 'south', axis: 'x', at: 6, from: 0, to: 8, side: 1,
    kinds: { 5: 'wallDoorway' } },
  { id: 'west', axis: 'z', at: 0, from: 0, to: 6, side: -1,
    kinds: { 2: 'wallWindow' } },
  { id: 'east', axis: 'z', at: 8, from: 0, to: 6, side: 1,
    kinds: { 1: 'wallWindow' } },
  // The one partition in the flat. Body x 5.95..6.00, so the living room's
  // usable edge is 5.95 -- the offset is the reason nothing sits at 5.99.
  { id: 'liv|bath', axis: 'z', at: 6, from: 0, to: 6, side: -1,
    kinds: { 1: 'wallDoorway' } },
];

/** Corner brackets stay empty: the runs are laid slab edge to slab edge, so
 *  two full segments already close the corner (js/layout.js measures the
 *  bracket as four loose flaps poking out past the envelope). */
export const CORNERS = [];

export const DOORS = [
  { m: 'doorwayOpen', x: 5.975, z: 1.5, r: 90, note: '卫浴门' },
  { m: 'doorwayFront', x: 5.5, z: 6.025, r: 180, note: '入户门' },
];

export const ROOMS = [
  {
    id: 'living', name: '起居室',
    items: [
      // ---- bed, north-west -------------------------------------------
      // THE BED IS PUSHED WEST, and that is a nav fact rather than a styling
      // one.  A nav cell needs 0.12 m of clearance to each side, so any gap
      // over 0.24 m holds cells -- and below roughly 0.5 m it holds cells that
      // no body can enter.  At x 1.00 the bed's west edge stood 0.52 m off the
      // wall, with the bedside table capping it above and the shelving below,
      // so both ends were sealed.  Measured before the move (work/_orphans.mjs):
      // a 50-cell pocket at (0.3, 1.1) and a 25-cell one at (0.2, 2.2), both
      // past the walker's own 0.0452 m2 bar, both reported by resolveRooms as
      // floor belonging to no room.  At x 0.70 the gap is 0.20 m: no strip.
      { m: 'bedDouble', x: 0.70, z: 0.72, r: 0, note: '双人床，床头靠北墙' },
      { m: 'sideTableDrawers', x: 1.51, z: 0.45, r: 90 },
      { m: 'lampRoundTable', x: 1.51, z: 0.45, r: 0, y: 0.384 },
      { m: 'pillow', x: 0.45, z: 0.28, r: 0, y: 0.375 },
      { m: 'pillowLong', x: 0.95, z: 0.28, r: 0, y: 0.375 },
      { m: 'bear', x: 0.70, z: 0.95, r: 200, y: 0.375 },
      { m: 'lampWall', x: 0.70, z: 0.03, r: 0, y: 0.92, note: '壁灯' },
      { m: 'rugRectangle', x: 2.6, z: 1.9, r: 0, note: '床尾地毯' },
      { m: 'radio', x: 2.9, z: 1.35, r: -90 },

      // ---- west wall: shelving ---------------------------------------
      // ONE UNBROKEN RUN on the west wall, and "unbroken" is load-bearing: a
      // gap over 0.24 m holds nav cells and a gap under a body is a pocket
      // nothing can enter, so the run is laid at a 0.40 m pitch from z 1.40 to
      // z 4.20 with no seam wider than a hand.  The wide unit at the north end
      // closes the run off from the desk that follows it.
      { m: 'bookcaseOpenLow', x: 0.14, z: 1.6, r: 90 },
      { m: 'bookcaseClosed', x: 0.14, z: 2.0, r: 90 },
      { m: 'bookcaseClosedDoors', x: 0.14, z: 2.4, r: 90 },
      { m: 'bookcaseOpen', x: 0.14, z: 2.8, r: 90 },
      { m: 'bookcaseClosed', x: 0.14, z: 3.2, r: 90 },
      { m: 'bookcaseClosedWide', x: 0.14, z: 3.8, r: 90 },
      ...row('books', 0.13, 1.55, 6, 0, 0.2, { r: 6, y: 0.34 }),
      ...row('books', 0.19, 1.65, 6, 0, 0.2, { r: -6, y: 0.62 }),

      // ---- kitchenette along the north wall, x 3.0 .. 5.58 -----------
      ...row('kitchenCabinetDrawer', 3.2, 0.225, 3, 0.43, 0),
      { m: 'kitchenSink', x: 4.49, z: 0.225, r: 0 },
      { m: 'kitchenStove', x: 4.92, z: 0.225, r: 0 },
      { m: 'kitchenCabinetDrawer', x: 5.35, z: 0.225, r: 0 },
      ...row('kitchenCabinetUpper', 3.63, 0.11, 2, 0.43, 0, { y: 0.78 }),
      { m: 'hoodModern', x: 4.92, z: 0.15, r: 0, y: 0.78, note: '抽油烟机' },
      { m: 'kitchenCabinetUpperDouble', x: 5.35, z: 0.11, r: 0, y: 0.78 },
      { m: 'kitchenMicrowave', x: 3.85, z: 0.235, r: 0, y: 0.45 },
      { m: 'kitchenBlender', x: 4.09, z: 0.235, r: 0, y: 0.45 },
      { m: 'toaster', x: 4.31, z: 0.235, r: 0, y: 0.45 },
      { m: 'kitchenFridge', x: 5.7, z: 0.24, r: -90, note: '冰箱，贴北墙' },
      { m: 'stoolBar', x: 4.6, z: 1.0, r: 0 },

      // ---- wardrobe + storage on the partition -----------------------
      { m: 'bookcaseClosedDoors', x: 5.72, z: 1.4, r: 90, note: '衣柜靠隔墙' },
      { m: 'sideTableDrawers', x: 5.62, z: 4.4, r: 90 },
      { m: 'cardboardBoxClosed', x: 3.4, z: 2.6, r: 18 },
      { m: 'cardboardBoxOpen', x: 3.65, z: 2.85, r: -12 },
      { m: 'trashcan', x: 2.6, z: 2.6, r: 0 },

      // ---- seating group ---------------------------------------------
      { m: 'loungeSofa', x: 0.55, z: 2.4, r: 90 },
      { m: 'sideTable', x: 0.5, z: 3.4, r: 90 },
      { m: 'lampSquareTable', x: 0.5, z: 3.4, r: 0, y: 0.384 },
      { m: 'loungeChair', x: 0.95, z: 4.3, r: 45 },
      { m: 'rugRectangle', x: 2.1, z: 4.3, r: 0 },
      { m: 'tableCoffee', x: 2.2, z: 4.3, r: 0 },
      { m: 'loungeSofaOttoman', x: 1.6, z: 5.0, r: 0 },
      { m: 'benchCushionLow', x: 2.9, z: 3.4, r: 0 },
      { m: 'bookcaseOpen', x: 3.4, z: 4.4, r: 90 },
      ...row('books', 3.36, 4.3, 2, 0, 0.2, { r: -7, y: 0.06 }),
      { m: 'bear', x: 2.6, z: 4.3, r: 150 },
      { m: 'speaker', x: 1.0, z: 5.75, r: 180 },

      // ---- TV wall + desk, south -------------------------------------
      { m: 'cabinetTelevisionDoors', x: 4.3, z: 5.87, r: 180 },
      { m: 'televisionModern', x: 4.3, z: 5.84, r: 180, y: 0.31 },
      { m: 'desk', x: 0.55, z: 5.4, r: 90 },
      { m: 'chairDesk', x: 1.05, z: 5.4, r: -90 },
      { m: 'computerScreen', x: 0.6, z: 5.4, r: -90, y: 0.384 },
      { m: 'computerKeyboard', x: 0.68, z: 5.4, r: -90, y: 0.384 },
      { m: 'computerMouse', x: 0.72, z: 5.62, r: -90, y: 0.384 },

      // ---- entry corner ----------------------------------------------
      { m: 'rugDoormat', x: 5.5, z: 5.72, r: 180 },
      { m: 'coatRackStanding', x: 5.75, z: 5.75, r: 0 },
      // Off the walk-in line and into the slot against the partition. The
      // measured reason: at (5.30, 5.60) this bin stood 0.1331 m from the
      // spawn, which is legal for a 0.12 m body and NOT legal for the cell
      // lattice -- `componentAt(spawn)` answered -1, the spawn belonged to no
      // nav region, and `climbPlan` silently lost the whole climb graph. See
      // the note in game/core/climb.js; this is the data half of that fix.
      { m: 'trashcan', x: 5.78, z: 5.15, r: 0 },
      { m: 'plantSmall2', x: 4.6, z: 5.3, r: 75 },
      { m: 'pottedPlant', x: 5.55, z: 3.0, r: 0 },
      { m: 'plantSmall1', x: 5.5, z: 5.5, r: 30 },
      { m: 'plantSmall3', x: 4.2, z: 5.55, r: 200 },
    ],
  },
  {
    id: 'bath', name: '卫浴',
    items: [
      { m: 'bathtub', x: 7.35, z: 0.75, r: 90, note: '浴缸贴北墙' },
      { m: 'shower', x: 7.5, z: 5.2, r: 180, note: '淋浴房' },
      { m: 'toilet', x: 7.4, z: 2.3, r: 0 },
      { m: 'bathroomSink', x: 6.16, z: 2.6, r: 90, y: 0.55, note: '壁挂洗手盆' },
      { m: 'bathroomMirror', x: 6.09, z: 2.6, r: 90, y: 1.02, note: '镜子' },
      { m: 'bathroomCabinetDrawer', x: 6.2, z: 4.0, r: 90 },
      { m: 'washer', x: 6.35, z: 5.6, r: 0, note: '洗衣机' },
      { m: 'trashcan', x: 6.3, z: 0.9, r: 0 },
      { m: 'plantSmall3', x: 7.7, z: 3.3, r: 45 },
    ],
  },
];
