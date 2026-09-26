/**
 * twobed.js — map 3 of 5. 「两室一厅」 / The Two-Bedroom Flat.
 *
 * CATEGORY 中: balanced. Eight rooms over 14 x 10 m, and the item density sits
 * between the two 小 maps and the 大 one -- roughly a third of the floor is
 * still open, so you can cross a room without touching anything, and roughly
 * two thirds is furniture, so you cannot see across it.
 *
 * THE PLAN IS TWO BANDS AND A TILING, and both halves matter:
 *
 *   z 0..5   | 主卧 0..5 | 卫生间 5..8 (z0-3) / 洗衣房 5..8 (z3-5) | 次卧 8..11 | 书房 11..14 |
 *   z 5..10  | 客厅 0..6 | 餐厅 6..10 | 厨房 10..14 |
 *
 * Every room is a rectangle and no two overlap (see studio.js). Circulation is
 * a tree rooted at the entrance: 客厅 is the hub, and every other room is one
 * doorway away from a room you have already been in -- 主卧 and 洗衣房 off
 * 客厅, 次卧 off 餐厅, 书房 off 次卧, 卫生间 off 洗衣房, 厨房 off 餐厅.
 * There is no un-owned corridor anywhere, which is not a stylistic choice:
 * `resolveRooms` reports a walkable region that belongs to no room as a
 * defect, so a hallway you forgot to name is a broken floor plan.
 */
import { row } from './_author.js';

export const WALL_H = 1.29;

export const PLAN = { w: 14, d: 10 };

export const ZONES = [
  { id: 'master', name: '主卧', hue: '#e0a06a', at: [2.5, 2.5] },
  { id: 'bath', name: '卫生间', hue: '#7fc9d6', at: [6.5, 1.5] },
  { id: 'laundry', name: '洗衣房', hue: '#9fb8c4', at: [6.5, 4.0] },
  { id: 'second', name: '次卧', hue: '#d9b06a', at: [9.5, 2.5] },
  { id: 'study', name: '书房', hue: '#8fa9d6', at: [12.5, 2.5] },
  { id: 'living', name: '客厅', hue: '#e07a72', at: [3.0, 7.5] },
  { id: 'dining', name: '餐厅', hue: '#c9a2d6', at: [8.0, 7.5] },
  { id: 'kitchen', name: '厨房', hue: '#9dc47f', at: [12.0, 7.5] },
];

export const WALLS = [
  { id: 'north', axis: 'x', at: 0, from: 0, to: 14, side: -1,
    kinds: { 1: 'wallWindow', 3: 'wallWindow', 6: 'wallWindow', 9: 'wallWindow', 12: 'wallWindow' } },
  { id: 'south', axis: 'x', at: 10, from: 0, to: 14, side: 1,
    kinds: { 2: 'wallDoorway', 4: 'wallWindow', 8: 'wallWindow', 12: 'wallWindow' } },
  { id: 'west', axis: 'z', at: 0, from: 0, to: 10, side: -1,
    kinds: { 1: 'wallWindow', 7: 'wallWindow' } },
  { id: 'east', axis: 'z', at: 14, from: 0, to: 10, side: 1,
    kinds: { 1: 'wallWindow', 7: 'wallWindow' } },

  // ---- the north block's internal walls -------------------------------
  // 卫生间 | 洗衣房, body z 3.00..3.05.
  { id: 'bath|laundry', axis: 'x', at: 3, from: 5, to: 8, side: 1,
    kinds: { 5: 'wallDoorway' } },
  // 主卧 | (卫生间 / 洗衣房). Body x 4.95..5.00.
  { id: 'master|wet', axis: 'z', at: 5, from: 0, to: 5, side: -1 },
  // (卫生间 / 洗衣房) | 次卧. Body x 7.95..8.00.
  { id: 'wet|second', axis: 'z', at: 8, from: 0, to: 5, side: -1 },
  // 次卧 | 书房, with the study's only door in it. Body x 10.95..11.00.
  { id: 'second|study', axis: 'z', at: 11, from: 0, to: 5, side: -1,
    kinds: { 2: 'wallDoorway' } },

  // ---- the spine between the two bands --------------------------------
  // Body z 5.00..5.05, so the south band starts at 5.05 -- no furniture below
  // it is written at 5.02.
  { id: 'spine', axis: 'x', at: 5, from: 0, to: 14, side: 1,
    kinds: { 1: 'wallDoorway', 5: 'wallDoorway', 8: 'wallDoorway' } },

  // ---- the south block's internal walls -------------------------------
  { id: 'living|dining', axis: 'z', at: 6, from: 5, to: 10, side: 1,
    kinds: { 6: 'wallDoorway' } },
  { id: 'dining|kitchen', axis: 'z', at: 10, from: 5, to: 10, side: 1,
    kinds: { 6: 'wallDoorway' } },
];

export const CORNERS = [];

export const DOORS = [
  { m: 'doorwayOpen', x: 1.5, z: 5.025, r: 0, note: '主卧门' },
  { m: 'doorwayOpen', x: 5.5, z: 5.025, r: 0, note: '洗衣房门' },
  { m: 'doorwayOpen', x: 8.5, z: 5.025, r: 0, note: '次卧门' },
  { m: 'doorwayOpen', x: 5.5, z: 3.025, r: 0, note: '卫生间门' },
  { m: 'doorwayOpen', x: 10.975, z: 2.5, r: 90, note: '书房门' },
  { m: 'doorwayOpen', x: 6.025, z: 6.5, r: 90, note: '客厅-餐厅门' },
  { m: 'doorwayOpen', x: 10.025, z: 6.5, r: 90, note: '餐厅-厨房门' },
  { m: 'doorwayFront', x: 2.5, z: 10.025, r: 180, note: '入户门' },
];

export const ROOMS = [
  {
    id: 'master', name: '主卧',
    items: [
      { m: 'bedDouble', x: 2.4, z: 0.65, r: 0, note: '双人床' },
      { m: 'sideTableDrawers', x: 1.6, z: 0.45, r: 0 },
      { m: 'lampRoundTable', x: 1.6, z: 0.45, r: 0, y: 0.384 },
      { m: 'sideTable', x: 3.2, z: 0.45, r: 0 },
      { m: 'lampRoundTable', x: 3.2, z: 0.45, r: 0, y: 0.384 },
      { m: 'pillow', x: 2.15, z: 0.75, r: 0, y: 0.375 },
      { m: 'pillowLong', x: 2.65, z: 0.75, r: 0, y: 0.375 },
      { m: 'bear', x: 2.4, z: 1.3, r: 200, y: 0.375 },
      { m: 'lampWall', x: 2.4, z: 0.03, r: 0, y: 0.92 },
      { m: 'rugRectangle', x: 2.4, z: 2.6, r: 0 },
      { m: 'bookcaseClosedDoors', x: 4.82, z: 1.5, r: -90, note: '衣柜' },
      { m: 'bookcaseClosedDoors', x: 4.82, z: 1.95, r: -90 },
      { m: 'bookcaseOpen', x: 0.14, z: 2.0, r: 90 },
      { m: 'books', x: 0.13, z: 1.9, r: 6, y: 0.34 },
      { m: 'books', x: 0.13, z: 2.1, r: -5, y: 0.34 },
      { m: 'sideTableDrawers', x: 1.0, z: 4.3, r: 90 },
      { m: 'lampSquareTable', x: 1.0, z: 4.3, r: 0, y: 0.384 },
      { m: 'chairRounded', x: 3.6, z: 4.4, r: 210 },
      { m: 'pottedPlant', x: 0.45, z: 4.6, r: 0 },
      { m: 'plantSmall1', x: 4.75, z: 4.6, r: 30 },
      { m: 'cardboardBoxClosed', x: 4.3, z: 4.6, r: 10 },
      { m: 'trashcan', x: 4.6, z: 2.5, r: 0 },
    ],
  },
  {
    id: 'bath', name: '卫生间',
    items: [
      { m: 'bathtub', x: 6.0, z: 0.75, r: 90, note: '浴缸' },
      { m: 'shower', x: 7.5, z: 0.65, r: 180 },
      { m: 'toilet', x: 5.45, z: 2.2, r: 0 },
      { m: 'bathroomSink', x: 7.8, z: 1.9, r: -90, y: 0.55 },
      { m: 'bathroomMirror', x: 7.86, z: 1.9, r: -90, y: 1.02 },
      { m: 'bathroomCabinetDrawer', x: 7.75, z: 2.7, r: -90 },
      { m: 'bathroomCabinet', x: 7.8, z: 0.3, r: -90, y: 0.62 },
      { m: 'trashcan', x: 5.4, z: 0.6, r: 0 },
      { m: 'plantSmall2', x: 6.9, z: 2.7, r: 0 },
    ],
  },
  {
    id: 'laundry', name: '洗衣房',
    items: [
      { m: 'washer', x: 5.4, z: 3.6, r: 0, note: '洗衣机' },
      { m: 'dryer', x: 5.4, z: 4.15, r: 0, note: '烘干机' },
      { m: 'washerDryerStacked', x: 6.15, z: 3.65, r: 0 },
      { m: 'bookcaseClosedWide', x: 7.5, z: 4.86, r: 180 },
      { m: 'cardboardBoxClosed', x: 6.9, z: 4.5, r: 15 },
      { m: 'cardboardBoxOpen', x: 7.12, z: 4.2, r: -8 },
      { m: 'sideTableDrawers', x: 7.0, z: 3.3, r: 0 },
      { m: 'trashcan', x: 6.6, z: 3.3, r: 0 },
      { m: 'plantSmall3', x: 5.4, z: 4.75, r: 0 },
    ],
  },
  {
    id: 'second', name: '次卧',
    items: [
      { m: 'bedSingle', x: 9.3, z: 0.65, r: 0, note: '单人床' },
      // Flush to the north wall, not 0.40 m off it: the gap above a 0.22 m
      // deep bedside table is 0.34 m, and 0.34 m is a corridor for the nav
      // lattice (0.24 m minimum) but not for a body.  Measured: a 22-cell
      // pocket at (8.5, 0.1), past the walker's bar.
      { m: 'sideTable', x: 8.5, z: 0.28, r: 0 },
      { m: 'lampRoundTable', x: 8.5, z: 0.28, r: 0, y: 0.384 },
      { m: 'pillow', x: 9.3, z: 0.75, r: 0, y: 0.375 },
      { m: 'bookcaseClosed', x: 10.82, z: 1.2, r: -90 },
      { m: 'books', x: 10.76, z: 1.1, r: 5, y: 0.34 },
      { m: 'books', x: 10.76, z: 1.3, r: -4, y: 0.34 },
      { m: 'desk', x: 10.6, z: 2.6, r: -90 },
      { m: 'computerScreen', x: 10.68, z: 2.6, r: -90, y: 0.384 },
      { m: 'chairDesk', x: 10.0, z: 2.6, r: 90 },
      { m: 'rugRectangle', x: 9.4, z: 3.9, r: 0 },
      { m: 'tableCoffee', x: 9.4, z: 4.3, r: 0 },
      { m: 'chairCushion', x: 8.6, z: 4.4, r: 0 },
      { m: 'bear', x: 9.6, z: 3.6, r: 140 },
      { m: 'stoolBarSquare', x: 10.6, z: 4.7, r: 0 },
      { m: 'plantSmall1', x: 10.7, z: 4.4, r: 60 },
      { m: 'trashcan', x: 8.3, z: 2.6, r: 0 },
    ],
  },
  {
    id: 'study', name: '书房',
    items: [
      { m: 'desk', x: 12.0, z: 0.7, r: 0, note: '书桌' },
      { m: 'computerScreen', x: 12.0, z: 0.66, r: 180, y: 0.384 },
      { m: 'computerKeyboard', x: 12.0, z: 0.82, r: 180, y: 0.384 },
      { m: 'computerMouse', x: 12.24, z: 0.86, r: 180, y: 0.384 },
      { m: 'chairDesk', x: 12.0, z: 1.3, r: 180 },
      { m: 'bookcaseClosed', x: 13.82, z: 1.6, r: -90 },
      { m: 'bookcaseClosed', x: 13.82, z: 2.05, r: -90 },
      { m: 'bookcaseOpen', x: 13.82, z: 2.5, r: -90 },
      { m: 'bookcaseOpenLow', x: 13.82, z: 2.9, r: -90 },
      ...row('books', 13.75, 1.55, 4, 0, 0.45, { r: 5, y: 0.34 }),
      { m: 'bookcaseClosedWide', x: 11.55, z: 4.86, r: 180 },
      { m: 'books', x: 11.4, z: 4.86, r: 6, y: 0.79 },
      { m: 'books', x: 11.7, z: 4.86, r: -6, y: 0.79 },
      { m: 'rugSquare', x: 12.3, z: 3.7, r: 0 },
      { m: 'loungeChairRelax', x: 12.3, z: 3.7, r: 135, note: '阅读椅' },
      { m: 'sideTable', x: 13.3, z: 4.3, r: 45 },
      { m: 'lampSquareTable', x: 13.3, z: 4.3, r: 0, y: 0.384 },
      { m: 'laptop', x: 13.3, z: 4.3, r: 200, y: 0.414 },
      { m: 'pottedPlant', x: 11.4, z: 3.9, r: 0 },
      { m: 'radio', x: 11.6, z: 1.6, r: 0 },
      { m: 'trashcan', x: 11.4, z: 4.7, r: 0 },
      { m: 'plantSmall2', x: 13.7, z: 4.6, r: 0 },
    ],
  },
  {
    id: 'living', name: '客厅',
    items: [
      { m: 'loungeSofa', x: 1.5, z: 6.6, r: 0 },
      { m: 'loungeSofa', x: 2.6, z: 6.6, r: 0 },
      { m: 'pillow', x: 1.3, z: 6.56, r: 0, y: 0.3 },
      { m: 'pillowBlue', x: 2.8, z: 6.56, r: 0, y: 0.3 },
      { m: 'bear', x: 2.6, z: 6.56, r: 195, y: 0.46 },
      { m: 'rugRectangle', x: 2.0, z: 7.4, r: 0 },
      { m: 'tableCoffee', x: 2.1, z: 7.7, r: 0 },
      { m: 'loungeChairRelax', x: 3.6, z: 7.2, r: -135 },
      { m: 'lampRoundFloor', x: 3.5, z: 6.3, r: 0 },
      { m: 'cabinetTelevisionDoors', x: 2.0, z: 9.87, r: 180, note: '电视柜' },
      { m: 'televisionModern', x: 2.0, z: 9.84, r: 180, y: 0.31 },
      { m: 'speaker', x: 1.1, z: 9.9, r: 180 },
      { m: 'speaker', x: 2.9, z: 9.9, r: 180 },
      { m: 'bookcaseOpen', x: 4.6, z: 9.87, r: 180 },
      { m: 'books', x: 4.5, z: 9.88, r: 6, y: 0.06 },
      { m: 'books', x: 4.7, z: 9.88, r: -6, y: 0.06 },
      { m: 'bookcaseClosed', x: 0.14, z: 7.0, r: 90 },
      { m: 'bookcaseClosed', x: 0.14, z: 7.5, r: 90 },
      ...row('books', 0.13, 6.9, 4, 0, 0.22, { r: 5, y: 0.34 }),
      { m: 'sideTableDrawers', x: 0.5, z: 8.6, r: 90 },
      { m: 'lampSquareTable', x: 0.5, z: 8.6, r: 0, y: 0.384 },
      { m: 'pottedPlant', x: 0.55, z: 9.5, r: 0 },
      { m: 'rugDoormat', x: 2.5, z: 9.72, r: 180 },
      { m: 'coatRackStanding', x: 3.35, z: 9.6, r: 0 },
      { m: 'trashcan', x: 3.3, z: 8.7, r: 0 },
      { m: 'rugRounded', x: 4.6, z: 8.0, r: 90 },
      { m: 'loungeChair', x: 4.6, z: 8.0, r: -135, note: '阅读椅' },
      { m: 'sideTable', x: 5.5, z: 8.5, r: 45 },
      { m: 'lampSquareTable', x: 5.5, z: 8.5, r: 0, y: 0.384 },
      { m: 'cardboardBoxClosed', x: 5.6, z: 6.2, r: 12 },
      { m: 'cardboardBoxOpen', x: 5.7, z: 6.5, r: -6 },
      { m: 'plantSmall1', x: 5.7, z: 8.9, r: 0 },
      { m: 'stoolBar', x: 1.0, z: 9.0, r: 0 },
    ],
  },
  {
    id: 'dining', name: '餐厅',
    items: [
      { m: 'rugRound', x: 8.0, z: 7.6, r: 0, note: '圆地毯' },
      { m: 'tableCross', x: 8.0, z: 7.6, r: 0, note: '餐桌' },
      { m: 'chairCushion', x: 7.75, z: 7.25, r: 180, s: 1.3 },
      { m: 'chairCushion', x: 8.25, z: 7.25, r: 180, s: 1.3 },
      { m: 'chairModernFrameCushion', x: 7.75, z: 7.95, r: 0, s: 1.3 },
      { m: 'chairModernFrameCushion', x: 8.25, z: 7.95, r: 0, s: 1.3 },
      { m: 'lampSquareCeiling', x: 8.0, z: 7.6, r: 0, y: 1.14, note: '吊灯' },
      { m: 'bookcaseOpenLow', x: 9.87, z: 6.2, r: -90 },
      { m: 'pottedPlant', x: 6.35, z: 6.3, r: 0 },
      { m: 'plantSmall1', x: 9.7, z: 8.6, r: 45 },
      { m: 'sideTableDrawers', x: 9.5, z: 5.5, r: 0 },
      { m: 'books', x: 9.6, z: 5.5, r: 10, y: 0.384 },
      { m: 'bench', x: 6.6, z: 9.5, r: 0 },
      { m: 'speaker', x: 9.7, z: 9.6, r: 180 },
      { m: 'trashcan', x: 6.4, z: 8.9, r: 0 },
    ],
  },
  {
    id: 'kitchen', name: '厨房',
    items: [
      // base run along the spine wall, z 5.05 .. 5.50
      ...row('kitchenCabinetDrawer', 10.65, 5.275, 3, 0.43, 0, { r: 180 }),
      { m: 'kitchenSink', x: 11.94, z: 5.275, r: 180 },
      { m: 'kitchenStove', x: 12.37, z: 5.275, r: 180 },
      { m: 'kitchenCabinetDrawer', x: 12.8, z: 5.275, r: 180 },
      ...row('kitchenCabinetUpper', 10.65, 5.16, 2, 0.43, 0, { r: 180, y: 0.78 }),
      { m: 'hoodModern', x: 12.37, z: 5.13, r: 180, y: 0.78 },
      { m: 'kitchenCabinetUpperDouble', x: 12.8, z: 5.16, r: 180, y: 0.78 },
      { m: 'kitchenMicrowave', x: 12.85, z: 5.29, r: 180, y: 0.45 },
      { m: 'kitchenCoffeeMachine', x: 12.6, z: 5.29, r: 180, y: 0.45 },
      { m: 'toaster', x: 10.9, z: 5.29, r: 180, y: 0.45 },
      { m: 'kitchenFridgeLarge', x: 13.5, z: 5.35, r: 180, note: '冰箱' },
      // island
      ...row('kitchenBar', 11.2, 6.9, 3, 0.43, 0),
      { m: 'kitchenBarEnd', x: 12.49, z: 6.9, r: 0 },
      { m: 'stoolBar', x: 11.35, z: 7.25, r: 0 },
      { m: 'stoolBar', x: 12.0, z: 7.25, r: 0 },
      { m: 'radio', x: 12.0, z: 5.9, r: 0 },
      // breakfast table, south-east
      { m: 'tableCross', x: 12.6, z: 9.3, r: 0 },
      { m: 'chairCushion', x: 12.3, z: 9.3, r: -90 },
      { m: 'chairCushion', x: 12.9, z: 9.3, r: 90 },
      { m: 'sideTableDrawers', x: 13.6, z: 9.0, r: 90 },
      { m: 'books', x: 13.6, z: 9.0, r: 8, y: 0.384 },
      { m: 'bench', x: 11.4, z: 9.6, r: 0 },
      { m: 'speaker', x: 13.7, z: 7.3, r: 0 },
      { m: 'cardboardBoxClosed', x: 10.4, z: 8.6, r: 20 },
      { m: 'pottedPlant', x: 10.5, z: 7.6, r: 0 },
      { m: 'plantSmall2', x: 13.6, z: 9.7, r: 0 },
      { m: 'trashcan', x: 10.4, z: 9.5, r: 0 },
    ],
  },
];
