/**
 * teahouse.js — map 4 of 5. 「茶室小院」 / The Tea House.
 *
 * CATEGORY 中: balanced, and deliberately balanced in a DIFFERENT shape from
 * 「两室一厅」. That one is a spine with rooms hung off it; this one is a
 * long east-west gallery with the north band split three ways. Six rooms over
 * 13 x 9 m, and the two large south rooms are what a player crosses first, so
 * a run here is long sight lines early and tight corners late -- the opposite
 * of the previous map, at the same item density.
 *
 *   z 0..4   茶室 0..5 | 卧室 5..9 | 浴室 9..13
 *   z 4..9   起居 0..6 | 书房 6..10 | 厨房 10..13
 *
 * Rooms are rectangles that tile the plan -- see studio.js for why.
 */
import { row } from './_author.js';

export const WALL_H = 1.29;

export const PLAN = { w: 13, d: 9 };

export const ZONES = [
  { id: 'tea', name: '茶室', hue: '#9dc47f', at: [2.5, 2.0] },
  { id: 'bed', name: '卧室', hue: '#e0a06a', at: [7.0, 2.0] },
  { id: 'bath', name: '浴室', hue: '#7fc9d6', at: [11.0, 2.0] },
  { id: 'living', name: '起居室', hue: '#e07a72', at: [3.0, 6.5] },
  { id: 'study', name: '书房', hue: '#8fa9d6', at: [8.0, 6.5] },
  { id: 'kitchen', name: '厨房', hue: '#d9b06a', at: [11.5, 6.5] },
];

export const WALLS = [
  { id: 'north', axis: 'x', at: 0, from: 0, to: 13, side: -1,
    kinds: { 1: 'wallWindow', 6: 'wallWindow', 11: 'wallWindow' } },
  { id: 'south', axis: 'x', at: 9, from: 0, to: 13, side: 1,
    kinds: { 2: 'wallDoorway', 5: 'wallWindow', 10: 'wallWindow' } },
  { id: 'west', axis: 'z', at: 0, from: 0, to: 9, side: -1,
    kinds: { 1: 'wallWindow', 6: 'wallWindow' } },
  { id: 'east', axis: 'z', at: 13, from: 0, to: 9, side: 1,
    kinds: { 1: 'wallWindow', 6: 'wallWindow' } },

  // The band. Body z 4.00..4.05.
  { id: 'band', axis: 'x', at: 4, from: 0, to: 13, side: 1,
    kinds: { 2: 'wallDoorway', 5: 'wallDoorway' } },
  // 茶室 | 卧室. Body x 4.95..5.00.
  { id: 'tea|bed', axis: 'z', at: 5, from: 0, to: 4, side: -1 },
  // 卧室 | 浴室, with the 浴室's only door. Body x 8.95..9.00.
  { id: 'bed|bath', axis: 'z', at: 9, from: 0, to: 4, side: -1,
    kinds: { 1: 'wallDoorway' } },
  // 起居 | 书房. Body x 6.00..6.05.
  { id: 'living|study', axis: 'z', at: 6, from: 4, to: 9, side: 1,
    kinds: { 6: 'wallDoorway' } },
  // 书房 | 厨房. Body x 10.00..10.05.
  { id: 'study|kitchen', axis: 'z', at: 10, from: 4, to: 9, side: 1,
    kinds: { 6: 'wallDoorway' } },
];

export const CORNERS = [];

export const DOORS = [
  { m: 'doorwayOpen', x: 2.5, z: 4.025, r: 0, note: '茶室门' },
  { m: 'doorwayOpen', x: 5.5, z: 4.025, r: 0, note: '卧室门' },
  { m: 'doorwayOpen', x: 8.975, z: 1.5, r: 90, note: '浴室门' },
  { m: 'doorwayOpen', x: 6.025, z: 6.5, r: 90, note: '起居-书房门' },
  { m: 'doorwayOpen', x: 10.025, z: 6.5, r: 90, note: '书房-厨房门' },
  { m: 'doorwayFront', x: 2.5, z: 9.025, r: 180, note: '入户门' },
];

export const ROOMS = [
  {
    id: 'tea', name: '茶室',
    items: [
      { m: 'rugSquare', x: 2.4, z: 2.4, r: 0, note: '茶席' },
      { m: 'tableCross', x: 2.4, z: 2.4, r: 0 },
      { m: 'chairCushion', x: 2.15, z: 1.95, r: 180 },
      { m: 'chairCushion', x: 2.65, z: 1.95, r: 180 },
      { m: 'chairCushion', x: 2.15, z: 2.85, r: 0 },
      { m: 'chairCushion', x: 2.65, z: 2.85, r: 0 },
      { m: 'benchCushionLow', x: 0.35, z: 1.8, r: 90 },
      { m: 'benchCushionLow', x: 0.35, z: 2.4, r: 90 },
      { m: 'bookcaseOpenLow', x: 0.14, z: 3.4, r: 90 },
      { m: 'books', x: 0.13, z: 3.3, r: 5, y: 0.34 },
      { m: 'books', x: 0.13, z: 3.5, r: -5, y: 0.34 },
      { m: 'bookcaseClosed', x: 4.82, z: 1.2, r: -90 },
      { m: 'books', x: 4.76, z: 1.1, r: 6, y: 0.34 },
      { m: 'pottedPlant', x: 4.4, z: 0.4, r: 0 },
      { m: 'pottedPlant', x: 0.5, z: 0.5, r: 0 },
      { m: 'plantSmall1', x: 4.5, z: 3.5, r: 45 },
      { m: 'lampSquareCeiling', x: 2.4, z: 2.4, r: 0, y: 1.14 },
      { m: 'radio', x: 2.4, z: 0.35, r: 0 },
      { m: 'trashcan', x: 0.6, z: 3.5, r: 0 },
    ],
  },
  {
    id: 'bed', name: '卧室',
    items: [
      { m: 'bedDouble', x: 6.6, z: 0.65, r: 0 },
      { m: 'sideTable', x: 5.4, z: 0.4, r: 0 },
      { m: 'lampRoundTable', x: 5.4, z: 0.4, r: 0, y: 0.384 },
      { m: 'sideTableDrawers', x: 7.9, z: 0.45, r: 0 },
      { m: 'lampRoundTable', x: 7.9, z: 0.45, r: 0, y: 0.384 },
      { m: 'pillow', x: 6.35, z: 0.75, r: 0, y: 0.375 },
      { m: 'pillowBlue', x: 6.85, z: 0.75, r: 0, y: 0.375 },
      { m: 'bear', x: 6.6, z: 1.3, r: 200, y: 0.375 },
      { m: 'lampWall', x: 6.6, z: 0.03, r: 0, y: 0.92 },
      { m: 'bookcaseClosedDoors', x: 8.82, z: 1.8, r: -90, note: '衣柜' },
      { m: 'rugRectangle', x: 6.6, z: 2.6, r: 0 },
      { m: 'benchCushion', x: 5.6, z: 3.4, r: 0 },
      { m: 'sideTableDrawers', x: 8.6, z: 3.3, r: 90 },
      { m: 'books', x: 8.6, z: 3.3, r: 8, y: 0.384 },
      { m: 'trashcan', x: 5.4, z: 3.6, r: 0 },
      { m: 'plantSmall3', x: 8.6, z: 0.3, r: 0 },
    ],
  },
  {
    id: 'bath', name: '浴室',
    items: [
      { m: 'bathtub', x: 9.75, z: 1.0, r: 90, note: '浴缸' },
      { m: 'shower', x: 12.4, z: 0.7, r: 180 },
      { m: 'toilet', x: 9.5, z: 2.6, r: 0 },
      { m: 'bathroomSink', x: 12.5, z: 2.2, r: -90, y: 0.55 },
      { m: 'bathroomMirror', x: 12.56, z: 2.2, r: -90, y: 1.02 },
      { m: 'bathroomCabinetDrawer', x: 12.45, z: 3.3, r: -90 },
      { m: 'bathroomCabinet', x: 12.5, z: 0.3, r: -90, y: 0.62 },
      { m: 'washerDryerStacked', x: 9.5, z: 3.5, r: 0, note: '洗衣烘干塔' },
      { m: 'plantSmall2', x: 11.5, z: 3.6, r: 0 },
      { m: 'trashcan', x: 11.0, z: 0.4, r: 0 },
    ],
  },
  {
    id: 'living', name: '起居室',
    items: [
      { m: 'loungeSofa', x: 1.6, z: 5.4, r: 0 },
      { m: 'loungeSofaLong', x: 3.1, z: 5.4, r: 0 },
      { m: 'pillow', x: 1.4, z: 5.36, r: 0, y: 0.3 },
      { m: 'pillowBlueLong', x: 3.1, z: 5.36, r: 0, y: 0.3 },
      { m: 'bear', x: 2.8, z: 5.36, r: 195, y: 0.46 },
      { m: 'rugRectangle', x: 2.2, z: 6.6, r: 0 },
      { m: 'tableCoffee', x: 2.3, z: 6.9, r: 0 },
      { m: 'loungeChair', x: 4.0, z: 6.8, r: -90 },
      { m: 'loungeChairRelax', x: 4.6, z: 5.6, r: -135 },
      { m: 'lampRoundFloor', x: 0.8, z: 6.0, r: 0 },
      { m: 'cabinetTelevisionDoors', x: 1.6, z: 8.87, r: 180, note: '电视柜' },
      { m: 'televisionModern', x: 1.6, z: 8.84, r: 180, y: 0.31 },
      { m: 'speaker', x: 0.7, z: 8.9, r: 180 },
      { m: 'speaker', x: 2.5, z: 8.9, r: 180 },
      { m: 'bookcaseOpen', x: 4.4, z: 8.87, r: 180 },
      { m: 'books', x: 4.3, z: 8.88, r: 6, y: 0.06 },
      { m: 'books', x: 4.5, z: 8.88, r: -6, y: 0.06 },
      { m: 'bookcaseClosed', x: 0.14, z: 7.2, r: 90 },
      { m: 'books', x: 0.13, z: 7.1, r: 5, y: 0.34 },
      { m: 'books', x: 0.13, z: 7.3, r: -5, y: 0.34 },
      { m: 'pottedPlant', x: 0.5, z: 8.5, r: 0 },
      { m: 'rugDoormat', x: 2.5, z: 8.7, r: 180 },
      { m: 'coatRackStanding', x: 3.3, z: 8.6, r: 0 },
      { m: 'trashcan', x: 3.2, z: 7.6, r: 0 },
      { m: 'cardboardBoxClosed', x: 5.4, z: 4.6, r: 12 },
      { m: 'cardboardBoxOpen', x: 5.55, z: 4.85, r: -8 },
      { m: 'plantSmall1', x: 5.6, z: 7.8, r: 0 },
      { m: 'sideTableDrawers', x: 5.5, z: 8.5, r: 90 },
      { m: 'lampSquareTable', x: 5.5, z: 8.5, r: 0, y: 0.384 },
    ],
  },
  {
    id: 'study', name: '书房',
    items: [
      { m: 'desk', x: 7.0, z: 5.0, r: 0, note: '书桌' },
      { m: 'computerScreen', x: 7.0, z: 4.96, r: 180, y: 0.384 },
      { m: 'computerKeyboard', x: 7.0, z: 5.12, r: 180, y: 0.384 },
      { m: 'computerMouse', x: 7.24, z: 5.16, r: 180, y: 0.384 },
      { m: 'chairDesk', x: 7.0, z: 5.6, r: 180 },
      { m: 'bookcaseClosed', x: 9.82, z: 5.2, r: -90 },
      { m: 'bookcaseClosed', x: 9.82, z: 5.65, r: -90 },
      { m: 'bookcaseOpen', x: 9.82, z: 6.1, r: -90 },
      { m: 'bookcaseOpenLow', x: 9.82, z: 6.5, r: -90 },
      ...row('books', 9.75, 5.15, 4, 0, 0.45, { r: 5, y: 0.34 }),
      { m: 'bookcaseClosedWide', x: 6.55, z: 8.86, r: 180 },
      { m: 'books', x: 6.4, z: 8.86, r: 6, y: 0.79 },
      { m: 'books', x: 6.7, z: 8.86, r: -6, y: 0.79 },
      { m: 'rugSquare', x: 8.0, z: 7.6, r: 0 },
      { m: 'loungeChairRelax', x: 8.0, z: 7.6, r: 135, note: '阅读椅' },
      { m: 'sideTable', x: 9.0, z: 8.2, r: 45 },
      { m: 'lampSquareTable', x: 9.0, z: 8.2, r: 0, y: 0.384 },
      { m: 'lampSquareFloor', x: 6.4, z: 7.0, r: 0 },
      { m: 'pottedPlant', x: 6.4, z: 6.0, r: 0 },
      { m: 'radio', x: 8.6, z: 4.6, r: 0 },
      { m: 'bear', x: 8.6, z: 5.9, r: 150 },
      { m: 'stoolBarSquare', x: 7.6, z: 8.6, r: 0 },
      { m: 'trashcan', x: 9.6, z: 8.7, r: 0 },
      { m: 'plantSmall2', x: 6.4, z: 4.6, r: 0 },
    ],
  },
  {
    id: 'kitchen', name: '厨房',
    items: [
      // base run down the east wall, x 12.55 .. 13.00
      ...row('kitchenCabinetDrawer', 12.775, 4.8, 2, 0, 0.43, { r: 90 }),
      { m: 'kitchenSink', x: 12.775, z: 5.66, r: 90 },
      { m: 'kitchenStove', x: 12.775, z: 6.09, r: 90 },
      { m: 'kitchenCabinetDrawer', x: 12.775, z: 6.52, r: 90 },
      ...row('kitchenCabinetUpper', 12.66, 4.8, 2, 0, 0.43, { r: 90, y: 0.78 }),
      { m: 'hoodModern', x: 12.7, z: 6.09, r: 90, y: 0.78 },
      { m: 'kitchenCabinetUpperDouble', x: 12.66, z: 6.52, r: 90, y: 0.78 },
      { m: 'kitchenMicrowave', x: 12.9, z: 5.0, r: 90, y: 0.45 },
      { m: 'toaster', x: 12.9, z: 5.4, r: 90, y: 0.45 },
      { m: 'kitchenFridgeLarge', x: 12.75, z: 8.4, r: 90, note: '冰箱' },
      // island
      ...row('kitchenBar', 11.0, 6.4, 2, 0.43, 0),
      { m: 'kitchenBarEnd', x: 11.86, z: 6.4, r: 0 },
      { m: 'stoolBar', x: 11.2, z: 6.75, r: 0 },
      { m: 'stoolBar', x: 11.6, z: 6.75, r: 0 },
      { m: 'radio', x: 11.0, z: 5.0, r: 0 },
      // small table, south-west
      { m: 'tableCross', x: 10.9, z: 8.3, r: 0 },
      { m: 'chairCushion', x: 10.6, z: 8.3, r: -90 },
      { m: 'chairCushion', x: 11.2, z: 8.3, r: 90 },
      { m: 'bench', x: 10.4, z: 7.4, r: 0 },
      { m: 'cardboardBoxClosed', x: 11.8, z: 4.6, r: 15 },
      { m: 'pottedPlant', x: 10.4, z: 4.5, r: 0 },
      { m: 'plantSmall1', x: 12.6, z: 7.4, r: 0 },
      { m: 'trashcan', x: 10.4, z: 8.9, r: 0 },
    ],
  },
];
