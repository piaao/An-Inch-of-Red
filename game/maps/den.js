/**
 * den.js — map 2 of 5. 「藏书房」 / The Book Den.
 *
 * CATEGORY 小: three rooms in 9 x 7 m, and the second-highest item density of
 * the five. What makes it a different place from 「一人间」 is not its size,
 * it is its OBJECTS: twelve metres of shelving and two dozen books, so the
 * floor is a maze of thin furniture and every sight line is broken by a spine
 * of paperbacks. A one-room flat is open and empty in the middle; this one is
 * a warren.
 *
 *   z 0..3   卫生间 x 0..2   |  书斋 x 2..9
 *   z 3..7   起居室 x 0..9
 *
 * Rooms are rectangles that tile the plan -- see studio.js for why that is a
 * hard rule and not a style choice.
 */
import { row } from './_author.js';

export const WALL_H = 1.29;

export const PLAN = { w: 9, d: 7 };

export const ZONES = [
  { id: 'bath', name: '卫生间', hue: '#7fc9d6', at: [1.0, 1.5] },
  { id: 'study', name: '书斋', hue: '#8fa9d6', at: [5.5, 1.5] },
  { id: 'living', name: '起居室', hue: '#e0a06a', at: [4.5, 5.0] },
];

export const WALLS = [
  { id: 'north', axis: 'x', at: 0, from: 0, to: 9, side: -1,
    kinds: { 4: 'wallWindow', 7: 'wallWindow' } },
  { id: 'south', axis: 'x', at: 7, from: 0, to: 9, side: 1,
    kinds: { 7: 'wallDoorway' } },
  { id: 'west', axis: 'z', at: 0, from: 0, to: 7, side: -1,
    kinds: { 1: 'wallWindow', 5: 'wallWindow' } },
  { id: 'east', axis: 'z', at: 9, from: 0, to: 7, side: 1,
    kinds: { 1: 'wallWindow', 5: 'wallWindow' } },
  // The band wall. Body z 3.00..3.05, so the two north rooms keep a usable
  // edge at z 3 and the living room starts at 3.05 -- the +0.05 the shipped
  // spine wall carries, and the reason no furniture below it sits at z 3.02.
  { id: 'band', axis: 'x', at: 3, from: 0, to: 9, side: 1,
    kinds: { 0: 'wallDoorway', 4: 'wallDoorway' } },
  // 卫生间 | 书斋. Body x 2.00..2.05; 卫生间 keeps its edge at 2, 书斋 starts 2.05.
  { id: 'bath|study', axis: 'z', at: 2, from: 0, to: 3, side: 1 },
];

export const CORNERS = [];

export const DOORS = [
  { m: 'doorwayOpen', x: 0.5, z: 3.025, r: 0, note: '卫生间门' },
  { m: 'doorwayOpen', x: 4.5, z: 3.025, r: 0, note: '书斋门' },
  { m: 'doorwayFront', x: 7.5, z: 7.025, r: 180, note: '入户门' },
];

export const ROOMS = [
  {
    id: 'bath', name: '卫生间',
    items: [
      { m: 'shower', x: 1.4, z: 0.5, r: 0, note: '淋浴房' },
      { m: 'toilet', x: 1.5, z: 1.8, r: 180 },
      { m: 'bathroomSinkSquare', x: 0.6, z: 0.3, r: 180, y: 0.55, note: '壁挂盆' },
      { m: 'bathroomMirror', x: 0.6, z: 0.1, r: 180, y: 1.02 },
      { m: 'trashcan', x: 0.5, z: 2.6, r: 0 },
      { m: 'plantSmall2', x: 1.8, z: 2.7, r: 0 },
    ],
  },
  {
    id: 'study', name: '书斋',
    items: [
      // ---- the east wall is twelve metres of shelving -----------------
      { m: 'bookcaseClosed', x: 8.87, z: 0.4, r: -90 },
      { m: 'bookcaseClosedDoors', x: 8.87, z: 0.85, r: -90 },
      { m: 'bookcaseClosed', x: 8.87, z: 1.3, r: -90 },
      { m: 'bookcaseOpen', x: 8.87, z: 1.75, r: -90 },
      { m: 'bookcaseClosed', x: 8.87, z: 2.2, r: -90 },
      { m: 'bookcaseOpenLow', x: 8.87, z: 2.62, r: -90 },
      ...row('books', 8.78, 0.35, 6, 0, 0.45, { r: 4, y: 0.34 }),
      ...row('books', 8.9, 0.4, 6, 0, 0.45, { r: -6, y: 0.62 }),
      { m: 'speaker', x: 8.7, z: 2.9, r: 0 },

      // ---- desk under the east window ---------------------------------
      { m: 'desk', x: 7.6, z: 1.5, r: -90, note: '书桌' },
      { m: 'computerScreen', x: 7.68, z: 1.5, r: -90, y: 0.384 },
      { m: 'computerKeyboard', x: 7.53, z: 1.5, r: -90, y: 0.384 },
      { m: 'computerMouse', x: 7.5, z: 1.75, r: -90, y: 0.384 },
      { m: 'chairDesk', x: 7.0, z: 1.5, r: 90 },
      { m: 'laptop', x: 6.6, z: 0.3, r: 160, y: 0.384 },

      // ---- reading corner ---------------------------------------------
      { m: 'bookcaseClosedWide', x: 6.0, z: 0.14, r: 0 },
      { m: 'books', x: 5.9, z: 0.14, r: 8, y: 0.79 },
      { m: 'books', x: 6.15, z: 0.14, r: -6, y: 0.79 },
      { m: 'rugSquare', x: 4.5, z: 1.5, r: 0 },
      { m: 'loungeChairRelax', x: 3.4, z: 1.1, r: 135 },
      { m: 'sideTable', x: 4.6, z: 0.5, r: 0 },
      { m: 'lampSquareTable', x: 4.6, z: 0.5, r: 0, y: 0.384 },
      { m: 'pottedPlant', x: 2.4, z: 0.35, r: 0 },
      { m: 'plantSmall1', x: 6.6, z: 0.55, r: 45 },
      { m: 'sideTableDrawers', x: 3.9, z: 2.75, r: 180 },
      { m: 'books', x: 4.0, z: 2.75, r: 10, y: 0.384 },
      { m: 'cardboardBoxClosed', x: 6.8, z: 2.6, r: 20 },
      { m: 'lampSquareFloor', x: 2.3, z: 2.6, r: 0 },
      { m: 'radio', x: 5.4, z: 2.7, r: 0 },
      { m: 'trashcan', x: 3.0, z: 2.7, r: 0 },
    ],
  },
  {
    id: 'living', name: '起居室',
    items: [
      // ---- sofa group ---------------------------------------------------
      { m: 'loungeSofa', x: 1.4, z: 4.2, r: 0 },
      { m: 'loungeSofa', x: 2.5, z: 4.2, r: 0 },
      { m: 'pillow', x: 1.2, z: 4.16, r: 0, y: 0.3 },
      { m: 'pillowBlue', x: 2.7, z: 4.16, r: 0, y: 0.3 },
      { m: 'bear', x: 2.5, z: 4.16, r: 195, y: 0.46 },
      { m: 'rugRectangle', x: 2.0, z: 5.0, r: 0 },
      { m: 'tableCoffee', x: 1.9, z: 5.3, r: 0 },
      { m: 'lampRoundFloor', x: 3.3, z: 4.0, r: 0 },

      // ---- west wall: the second shelf run -----------------------------
      { m: 'bookcaseClosed', x: 0.14, z: 3.6, r: 90 },
      { m: 'bookcaseClosed', x: 0.14, z: 4.1, r: 90 },
      { m: 'bookcaseClosed', x: 0.14, z: 4.6, r: 90 },
      { m: 'bookcaseOpen', x: 0.14, z: 5.1, r: 90 },
      ...row('books', 0.13, 3.5, 8, 0, 0.22, { r: 5, y: 0.34 }),

      // ---- TV wall ------------------------------------------------------
      { m: 'cabinetTelevisionDoors', x: 4.4, z: 6.87, r: 180 },
      { m: 'televisionModern', x: 4.4, z: 6.84, r: 180, y: 0.31 },
      { m: 'speaker', x: 3.5, z: 6.9, r: 180 },
      { m: 'speaker', x: 5.3, z: 6.9, r: 180 },
      { m: 'loungeChairRelax', x: 3.6, z: 5.2, r: -135, note: '看电视的躺椅' },
      { m: 'loungeChair', x: 4.6, z: 5.9, r: 0 },

      // ---- reading nook, north-east -------------------------------------
      { m: 'rugRounded', x: 7.9, z: 4.5, r: 90 },
      { m: 'loungeChairRelax', x: 7.6, z: 4.2, r: -45, note: '阅读椅' },
      { m: 'sideTable', x: 8.3, z: 4.6, r: 45 },
      { m: 'lampSquareTable', x: 8.3, z: 4.6, r: 0, y: 0.384 },
      { m: 'trashcan', x: 8.6, z: 3.3, r: 0 },
      { m: 'plantSmall3', x: 5.0, z: 3.3, r: 0 },
      { m: 'cardboardBoxClosed', x: 5.9, z: 3.4, r: 15 },
      { m: 'cardboardBoxOpen', x: 6.1, z: 3.65, r: -10 },
      { m: 'bench', x: 6.8, z: 5.6, r: 0 },
      { m: 'sideTableDrawers', x: 5.6, z: 5.6, r: 0 },
      { m: 'books', x: 5.7, z: 5.6, r: 8, y: 0.384 },
      { m: 'stoolBarSquare', x: 6.3, z: 6.4, r: 0 },

      // ---- entry corner --------------------------------------------------
      { m: 'rugDoormat', x: 7.5, z: 6.75, r: 180 },
      { m: 'coatRackStanding', x: 8.5, z: 6.5, r: 0 },
      { m: 'pottedPlant', x: 3.0, z: 6.6, r: 0 },
    ],
  },
];
