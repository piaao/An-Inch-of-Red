/**
 * palette.js — what furniture belongs in a room, and how it wants to sit.
 *
 * This file is PURE DATA and pure wishes. It says "a bedroom wants a bed, a rug,
 * two nightstands, a wardrobe and somewhere to put a lamp" -- and nothing about
 * where any of it goes. The placer (floorplan.js) reads these lists in order and
 * keeps whatever actually fits in the room it was given, which is what makes the
 * generator survive a 3 x 3 m room and an 8 x 6 m one without a special case per
 * size. A palette entry that cannot be honoured is a normal outcome, not an
 * error: the achieved item count is EMERGENT, and the report prints it.
 *
 * WHY ORDER MATTERS. `where: 'surface'` needs a host that is already placed, so
 * every list puts hosts before their clutter. And rugs are flat (0.01 m), so
 * they go early and the tall things land on top of them.
 *
 * EVERY MODEL NAME HERE MUST EXIST IN data/kit_index.json. The generator checks
 * that on the first run and refuses to start otherwise -- a typo in this file
 * would otherwise present as "the bedroom just never gets a wardrobe", which is
 * exactly the kind of silent degradation the rest of this project tries to make
 * impossible.
 */

/**
 * The six roles, with the same hues js/layout.js uses, so the viewer's room
 * colours, the minimap and a generated plan all agree about what "客厅" is.
 */
export const ROLE_INFO = {
  living: { name: '客厅', hue: '#e07a72', family: 'large' },
  kitchen: { name: '厨房', hue: '#9dc47f', family: 'large' },
  dining: { name: '餐厅', hue: '#d9b06a', family: 'large' },
  study: { name: '书房', hue: '#8fa9d6', family: 'large' },
  bedroom: { name: '卧室', hue: '#e0a06a', family: 'large' },
  bath: { name: '卫生间', hue: '#7fc9d6', family: 'compact' },
};

/**
 * The order large roles are handed out, by descending room area.
 *
 * Living first because it is the room the entrance opens into and the one that
 * most needs floor space; bath LAST, and only to a room that is small, because
 * a bathtub in a 12 m2 room reads as a mistake. A small flat (N = 2 or 3) gets
 * the front of this list and never reaches the back, which is the right way
 * round: a studio flat has no bath, it has a bathroom cabinet.
 */
export const ROLE_LADDER = ['living', 'bedroom', 'kitchen', 'dining', 'study', 'bath'];

/** A room below this area (m2) is offered the compact role first. */
export const COMPACT_MAX_AREA = 9.0;

/**
 * WISH-LISTS, one per role. Entry fields:
 *
 *   m        model name, OR an array to pick one of (variety between seeds)
 *   where    'wall' | 'mounted' | 'corner' | 'floor' | 'rug' | 'surface' |
 *            'ceiling' | 'ring' | 'counter'
 *   y        absolute lift, for 'mounted' and 'ceiling'
 *   on       host model names, for 'surface'
 *   of       anchor models the item gathers around, for 'ring'
 *   count    [min, max] for 'ring'
 *   repeat   how many times this entry may be placed (default 1)
 *   prob     chance of attempting it at all (default 1)
 *   s        uniform scale
 *   side     'north'|'south'|'east'|'west'|'any' -- wall items only (default 'any')
 *   near     a model name this item wants to be adjacent to (bedside tables)
 */
export const PALETTES = {
  /* ------------------------------------------------------------------ 客厅 */
  living: [
    // The TV wall. `cabinetTelevisionDoors` is 1.16 wide and the television
    // stands ON it, which is why the surface entry comes directly after.
    { m: ['cabinetTelevisionDoors', 'cabinetTelevision'], where: 'wall' },
    { m: 'televisionModern', where: 'surface', on: ['cabinetTelevisionDoors', 'cabinetTelevision'] },

    // The seating group. `rugRectangle` is flat and goes down first.
    { m: ['rugRectangle', 'rugRounded'], where: 'rug' },
    { m: ['loungeSofa', 'loungeSofaLong'], where: 'floor', repeat: 2, prob: 0.85 },
    { m: 'loungeChair', where: 'floor', repeat: 2, prob: 0.7 },
    { m: ['tableCoffee', 'tableCoffeeSquare', 'tableCoffeeGlass'], where: 'floor' },
    { m: 'loungeSofaOttoman', where: 'floor', prob: 0.5 },
    { m: ['lampRoundFloor', 'lampSquareFloor'], where: 'floor', prob: 0.7 },

    // One more run of shelving on a different wall.
    { m: ['bookcaseClosedWide', 'bookcaseOpen', 'bookcaseOpenLow'], where: 'wall', repeat: 2, prob: 0.8 },
    { m: 'books', where: 'surface', on: ['bookcaseOpenLow', 'sideTableDrawers', 'tableCoffee'], prob: 0.6 },

    { m: ['speaker', 'speakerSmall'], where: 'floor', repeat: 2, prob: 0.5 },
    { m: ['sideTable', 'sideTableDrawers'], where: 'wall', prob: 0.6 },
    { m: 'lampSquareTable', where: 'surface', on: ['sideTableDrawers', 'sideTable'], prob: 0.7 },

    { m: ['pottedPlant', 'plantSmall1', 'plantSmall2', 'plantSmall3'], where: 'corner', repeat: 2 },
    { m: ['pillow', 'pillowBlue', 'pillowLong'], where: 'surface', on: ['loungeSofa', 'loungeSofaLong'], prob: 0.7, repeat: 2 },
    { m: 'radio', where: 'surface', on: ['sideTableDrawers', 'bookcaseOpenLow'], prob: 0.4 },
    { m: ['cardboardBoxClosed', 'cardboardBoxOpen'], where: 'floor', prob: 0.35 },
    { m: 'coatRackStanding', where: 'corner', prob: 0.4 },
    { m: 'trashcan', where: 'floor', prob: 0.5 },
    { m: 'bear', where: 'floor', prob: 0.3 },
  ],

  /* ------------------------------------------------------------------ 卧室 */
  bedroom: [
    // The bed is the room. 1.62 x 1.91, so it only fits where the room can
    // spare 1.9 m of depth plus a walkable lane -- rejection handles the rest.
    { m: ['bedDouble', 'bedSingle'], where: 'wall', side: 'north' },
    { m: 'rugRectangle', where: 'rug', prob: 0.7 },
    { m: 'sideTable', where: 'wall', near: ['bedDouble', 'bedSingle'], repeat: 2 },
    { m: ['lampRoundTable', 'lampSquareTable'], where: 'surface', on: ['sideTable', 'sideTableDrawers'], repeat: 2, prob: 0.8 },
    { m: ['pillow', 'pillowLong', 'pillowBlue', 'pillowBlueLong'], where: 'surface', on: ['bedDouble', 'bedSingle'], repeat: 2, prob: 0.9 },
    { m: 'bear', where: 'surface', on: ['bedDouble', 'bedSingle'], prob: 0.5 },

    { m: ['bookcaseClosedDoors', 'bookcaseClosedWide', 'bookcaseClosed'], where: 'wall', repeat: 2 },
    { m: ['books', 'cardboardBoxClosed'], where: 'surface', on: ['bookcaseClosedWide', 'sideTableDrawers', 'cabinetBedDrawer'], prob: 0.5 },

    { m: ['sideTableDrawers', 'cabinetBedDrawer', 'cabinetBedDrawerTable'], where: 'wall', prob: 0.7 },
    { m: ['lampWall'], where: 'mounted', y: 0.92, prob: 0.5 },
    { m: ['coatRackStanding'], where: 'corner', prob: 0.45 },
    { m: ['plantSmall1', 'plantSmall2', 'plantSmall3'], where: 'corner', prob: 0.6 },
    { m: 'trashcan', where: 'floor', prob: 0.5 },
  ],

  /* ------------------------------------------------------------------ 厨房 */
  kitchen: [
    // The counter run: a SEQUENCE laid end to end along the longest free wall,
    // capped by the upper cabinets above it. This is the one entry that is not
    // a single item, because a kitchen is read as a run, not as objects --
    // eight cabinets scattered at random angles is the single most obvious tell
    // that a layout was generated.
    {
      where: 'counter', prob: 0.95,
      sequence: ['kitchenCabinetCornerRound', 'kitchenCabinetDrawer', 'kitchenCabinetDrawer',
                 'kitchenSink', 'kitchenCabinetDrawer', 'kitchenStove', 'kitchenCabinetDrawer',
                 'kitchenCabinet', 'kitchenCabinetDrawer'],
      // Upper run: shorter, and the upper models are 0.39 tall against the
      // base's 0.45, so the two runs read as one wall of kitchen.
      upper: ['kitchenCabinetUpperCorner', 'kitchenCabinetUpper', 'kitchenCabinetUpperDouble',
              'kitchenCabinetUpperDouble', 'kitchenCabinetUpperLow'],
      upperY: 0.78,
      hoodOver: 'kitchenStove', hood: 'hoodModern',
      surfaceY: 0.45,
      surface: ['kitchenMicrowave', 'kitchenCoffeeMachine', 'kitchenBlender', 'toaster'],
    },

    // 0.92 tall fridge: past the climb ceiling (0.93), so it holds no packet --
    // it is here for the kitchen to look like a kitchen, and to block sight.
    { m: ['kitchenFridge', 'kitchenFridgeSmall'], where: 'corner', prob: 0.85 },

    // Island + stools, parallel to the counter when there is room for one.
    { m: ['kitchenBar', 'kitchenBar'], where: 'floor', prob: 0.5, repeat: 4 },
    { m: 'kitchenBarEnd', where: 'floor', prob: 0.35 },
    { m: ['stoolBar', 'stoolBarSquare'], where: 'floor', repeat: 2, prob: 0.6 },

    { m: 'trashcan', where: 'floor', prob: 0.6 },
    { m: 'plantSmall2', where: 'corner', prob: 0.5 },
  ],

  /* ------------------------------------------------------------------ 餐厅 */
  dining: [
    { m: ['rugRound', 'rugRectangle'], where: 'rug' },
    // `tableCross` is 2.03 x 1.07 and its chairs gather around it.
    { m: ['tableCross', 'tableRound', 'table', 'tableGlass'], where: 'floor' },
    { m: ['chairCushion', 'chairModernFrameCushion', 'chairModernCushion'], where: 'ring',
      of: ['tableCross', 'tableRound', 'table', 'tableGlass'], count: [2, 4], s: 1.3 },
    { m: 'lampSquareCeiling', where: 'ceiling', y: 1.14, prob: 0.6 },
    { m: ['bookcaseOpenLow', 'sideTableDrawers'], where: 'wall', repeat: 2 },
    { m: 'books', where: 'surface', on: ['sideTableDrawers', 'bookcaseOpenLow'], prob: 0.6 },
    { m: 'lampSquareTable', where: 'surface', on: ['sideTableDrawers'], prob: 0.5 },
    { m: ['pottedPlant', 'plantSmall1'], where: 'corner', prob: 0.7 },
    { m: 'trashcan', where: 'floor', prob: 0.4 },
  ],

  /* ------------------------------------------------------------------ 书房 */
  study: [
    { m: 'rugSquare', where: 'rug', prob: 0.7 },
    { m: ['desk', 'deskCorner'], where: 'wall' },
    { m: 'chairDesk', where: 'floor', prob: 0.9 },
    { m: 'computerScreen', where: 'surface', on: ['desk', 'deskCorner'], prob: 0.8 },
    { m: 'computerKeyboard', where: 'surface', on: ['desk', 'deskCorner'], prob: 0.7 },
    { m: 'computerMouse', where: 'surface', on: ['desk', 'deskCorner'], prob: 0.6 },
    { m: 'laptop', where: 'surface', on: ['desk', 'deskCorner', 'sideTableDrawers'], prob: 0.4 },

    // Shelving on the remaining walls. This is where a study earns its keep in
    // this game: 0.85 m bookcase tops are under the 0.93 m climb ceiling, so
    // they are prize anchors, and a bookshelf is 0.25 m deep against a 0.44 m
    // doorway -- furniture here narrows passages without sealing them.
    { m: ['bookcaseClosed', 'bookcaseClosedWide', 'bookcaseOpen'], where: 'wall', repeat: 3 },
    { m: 'books', where: 'surface', on: ['bookcaseClosed', 'bookcaseClosedWide', 'bookcaseOpen', 'sideTableDrawers'], prob: 0.6, repeat: 2 },

    { m: 'sideTableDrawers', where: 'wall', prob: 0.7 },
    { m: 'lampSquareTable', where: 'surface', on: ['sideTableDrawers'], prob: 0.6 },
    { m: 'speakerSmall', where: 'mounted', y: 0.79, prob: 0.4 },
    { m: ['pottedPlant', 'plantSmall3'], where: 'corner', prob: 0.7 },
    { m: 'coatRackStanding', where: 'corner', prob: 0.4 },
    { m: 'bear', where: 'floor', prob: 0.3 },
    { m: 'trashcan', where: 'floor', prob: 0.5 },
  ],

  /* -------------------------------------------------------------- 卫生间 */
  bath: [
    // 1.19 x 0.56 against a wall; the shower cubicle is the fallback for a room
    // whose free wall is too short for a tub (it is 0.94 square).
    { m: ['bathtub', 'showerRound', 'shower'], where: 'wall', prob: 0.9 },
    { m: ['toilet', 'toiletSquare'], where: 'wall', prob: 0.95 },
    { m: 'bathroomCabinetDrawer', where: 'wall', prob: 0.6 },
    { m: 'bathroomSink', where: 'mounted', y: 0.55, prob: 0.8 },
    { m: 'bathroomMirror', where: 'mounted', y: 1.02, prob: 0.7 },
    { m: 'bathroomCabinet', where: 'mounted', y: 0.62, prob: 0.5 },
    { m: ['washer', 'dryer'], where: 'corner', prob: 0.45 },
    { m: 'rugDoormat', where: 'floor', prob: 0.5 },
    { m: 'trashcan', where: 'floor', prob: 0.7 },
  ],
};

/**
 * Small things that can go almost anywhere, used only to honour an item budget
 * the palettes alone could not fill.
 *
 * `--items N` is a PARAMETER, so it has to mean something. The palettes above
 * are what a room wants; this list is what a room will tolerate, and it is
 * reached for only after the wish-list is exhausted. It deliberately holds
 * nothing tall, nothing that blocks sight above eye level, and nothing that
 * needs a wall -- a filler that changed the room's readability would be
 * changing the level to hit a number.
 */
export const FILLERS = [
  'plantSmall1', 'plantSmall2', 'plantSmall3', 'pottedPlant',
  'cardboardBoxClosed', 'cardboardBoxOpen', 'trashcan', 'books', 'bear',
  'bench', 'benchCushion', 'chairRounded', 'sideTable',
];

/**
 * The subset of hosts a FILLER may be dropped onto.
 *
 * Narrower than SURFACE_HOSTS on purpose: a filler is decoration, and decoration
 * belongs on a table or a cabinet. Putting a potted plant on the bed, which the
 * full host set would allow, is the kind of detail that makes a generated room
 * read as generated.
 */
export const FILLER_HOSTS = [
  'sideTable', 'sideTableDrawers', 'desk', 'deskCorner', 'table', 'tableRound',
  'tableCross', 'tableCoffee', 'tableCoffeeSquare', 'cabinetTelevision',
  'cabinetTelevisionDoors', 'bookcaseOpenLow', 'kitchenCabinet', 'kitchenCabinetDrawer',
];

/**
 * Items that may host a `where: 'surface'` occupant, and the height they offer.
 * Kept here rather than inferred so the placer does not have to guess which
 * 0.3 m tall thing in the room is furniture and which is a shelf unit.
 */
export const SURFACE_HOSTS = new Set([
  'sideTable', 'sideTableDrawers', 'cabinetBedDrawer', 'cabinetBedDrawerTable',
  'cabinetTelevision', 'cabinetTelevisionDoors', 'bookcaseOpenLow',
  'desk', 'deskCorner', 'table', 'tableCloth', 'tableGlass', 'tableRound',
  'tableCross', 'tableCrossCloth', 'tableCoffee', 'tableCoffeeSquare',
  'tableCoffeeGlass', 'tableCoffeeGlassSquare',
  'bedDouble', 'bedSingle', 'bedBunk',
  'loungeSofa', 'loungeSofaLong', 'loungeSofaCorner',
  'kitchenCabinet', 'kitchenCabinetDrawer', 'kitchenSink', 'kitchenStove',
  'kitchenStoveElectric', 'kitchenCabinetCornerRound', 'kitchenCabinetCornerInner',
  'bookcaseOpen', 'bookcaseClosed', 'bookcaseClosedWide', 'bookcaseClosedDoors',
]);

/**
 * Models whose top is a CLIMB TARGET, i.e. at or below `climbCeil` (0.93 m) and
 * big enough to stand on. Reported by the generator, because the game's whole
 * prize pool comes from these: a generated flat with three climbable tops in it
 * cannot host six 红包.
 */
export const CLIMB_TOPS = new Set([
  'sideTable', 'sideTableDrawers', 'cabinetBedDrawer', 'cabinetBedDrawerTable',
  'cabinetTelevision', 'cabinetTelevisionDoors', 'bookcaseOpenLow',
  'desk', 'deskCorner', 'table', 'tableCloth', 'tableGlass', 'tableRound',
  'tableCross', 'tableCrossCloth', 'tableCoffee', 'tableCoffeeSquare',
  'tableCoffeeGlass', 'tableCoffeeGlassSquare',
  'bedDouble', 'bedSingle', 'loungeSofa', 'loungeSofaLong', 'loungeSofaCorner',
  'loungeSofaOttoman', 'loungeChair', 'loungeChairRelax', 'loungeDesignChair',
  'loungeDesignSofa', 'loungeDesignSofaCorner', 'chairDesk', 'bench', 'benchCushion',
  'bathtub', 'toiletSquare', 'stoolBar', 'stoolBarSquare',
  'kitchenCabinet', 'kitchenCabinetDrawer', 'kitchenSink', 'kitchenStove',
  'kitchenStoveElectric', 'kitchenCabinetCornerRound', 'kitchenCabinetCornerInner',
  'kitchenBar', 'bookcaseClosed', 'bookcaseClosedWide',
]);
