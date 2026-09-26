/**
 * siting.js — the three thresholds that BOTH hands have to agree about.
 *
 * WHY THIS FILE EXISTS. These three numbers are the bar by which a floor is
 * judged "arranged" (`arrangement.js`) and they are also the numbers a PLACER
 * has to respect while it is placing things (`floorplan.js`). While only the
 * judge used them, they could live next to the judgement. The moment a placer
 * starts *aiming* at the same bar, two copies of 0.30 is two facts -- and the
 * failure mode is silent and flattering: the generator tunes itself against
 * 0.28, the ruler judges at 0.30, and every room comes back "almost grouped".
 *
 * So one source, two readers, and this file is the source. It is pure numbers:
 * no imports, no functions, no state -- nothing that could make a reader
 * wonder which of the two callers it was written for.
 *
 * Measured provenance for each number is kept with the number, because a
 * threshold whose derivation is lost is a threshold that gets "tuned" the
 * first time something fails.
 */

/**
 * How close two footprints must be to count as ONE composition.
 *
 * NOT tuned: the kit's bedside table is 0.30 deep and a bed/table pair is the
 * tightest legitimate composition in the flat. A bar under it would split a
 * real group; one over it would merge two unrelated walls of shelving.
 *
 * The placer reads it as an instruction ("butt companions this close, or the
 * room will be read as a scatter") and the ruler reads it as a definition.
 */
export const JOIN = 0.30;

/**
 * An object this close to a wall is against it; beyond it, it stands free.
 *
 * The ruler counts a lone piece further than this from every wall as FLOATING
 * -- an object on open floor, touching nothing, which is the single loudest
 * "this was generated" tell. The placer therefore refuses to leave anything
 * there: see `whyBad` in floorplan.js, which asks this question before it
 * accepts a free-standing position.
 */
export const AGAINST_WALL = 0.25;

/**
 * The most doorways a person should cross from the front door to any room.
 *
 * Anchored on the designed flat, which reads 2. Allow one more for a plan
 * whose circulation runs through a hall that is itself a room (entry -> hall
 * -> room), and three is the bound: enter, cross one space, arrive.
 *
 * The placer reads it as a structural target (a band plan whose entry cannot
 * reach every cell in three hops is rejected outright -- see `planCirculation`)
 * and the ruler reads it as the verdict.
 */
export const MAX_DOOR_HOPS = 3;
