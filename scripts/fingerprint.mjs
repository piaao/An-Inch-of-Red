/**
 * fingerprint.mjs — a name for "the code that produced this measurement".
 *
 * WHY THIS EXISTS, and it is a scar rather than a design. `verify_arrangement.mjs`
 * cross-checks the CLI's JSON against a layout it computes itself, in-process.
 * For one release that check read a file left behind by an EARLIER state of the
 * tools: the file said `1/6` arrangement checks green, this process said `6/6`,
 * and the check duly reported `DIFFER` -- a disagreement that was entirely
 * about WHEN the file was written and not at all about the generator.
 *
 * Evidence that cannot be dated is evidence that cannot be used, and "remember
 * to re-run the CLI first" is not a mechanism: it is a liability that gets
 * discharged by forgetting. So the CLI stamps its JSON with a hash of every
 * file that can move the verdict, and the acceptance suite recomputes that hash
 * from the working tree and REFUSES a file whose stamp does not match. A stale
 * artifact now fails loudly, with its real reason, instead of being read as a
 * live disagreement.
 *
 * THE LIST IS CHECKED, NOT TRUSTED. `verify_arrangement.mjs` walks the import
 * graph out of the verdict modules and asserts that nothing reachable is
 * missing from `VERDICT_SOURCES` -- so adding a dependency to the generator
 * cannot quietly turn this fingerprint into a lie. Data files are the one thing
 * no import graph can find, so they are listed separately and honestly.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every module the CLI's JSON is computed from.
 *
 * This is THE FULL IMPORT CLOSURE of the three verdict modules below, plus
 * `js/layout.js`. Listing the closure rather than a hand-picked subset is
 * deliberate: the artifact carries `checks` and `prizes` as well as
 * `arrangement`, so `place.js` (prize placement) and `vision.js` (guard sight)
 * are in it exactly as much as `arrangement.js` is. "Only the arrangement half
 * matters" would be a claim about which rows of the file someone happens to
 * read.
 *
 * `js/layout.js` is here although nothing in the closure imports it: the CLI
 * refuses to run at all when its `requiredModels` disagrees with the designed
 * flat, so an artifact produced under a different designed flat is real
 * staleness even though no import edge says so.
 */
export const VERDICT_SOURCES = [
  'game/arena/fromLayout.js',
  'game/arena/openings.js',
  'game/core/climb.js',
  'game/core/level.js',
  'game/core/nav.js',
  'game/core/place.js',
  'game/core/regions.js',
  'game/core/rng.js',
  'game/core/vision.js',
  'game/procgen/arrangement.js',
  'game/procgen/floorplan.js',
  'game/procgen/furnishing.js',
  'game/procgen/palette.js',
  'game/procgen/pipeline.js',
  'game/procgen/required.js',
  'game/procgen/siting.js',
  'js/layout.js',
];

/** Modules the graph walk starts from -- the floor generator and its judge. */
export const VERDICT_ENTRIES = [
  'game/procgen/floorplan.js',
  'game/procgen/arrangement.js',
  'game/procgen/pipeline.js',
];

/**
 * Files that are not modules, so no import graph can find them.
 *
 * `kit_three.json` carries every furniture footprint and `compose()` measures
 * groups with them, so a re-measure of the kit moves the composition readings.
 * `passages.json` is the only source of where the hole in a wall is, and it
 * decides the level geometry the room rects are resolved from. Both facts are
 * invisible to an import graph, which is why they are listed instead of found.
 */
export const VERDICT_DATA = [
  'data/kit_three.json',
  'data/model_surfaces.json',
  'data/passages.json',
];

/** Relative import specifiers, both `import x from` and bare `import '...'`. */
const FROM_RE = /\bfrom\s+['"](\.[^'"]+)['"]/g;
const BARE_RE = /\bimport\s+['"](\.[^'"]+)['"]/g;

/**
 * Every project file reachable by following relative imports from `entries`.
 *
 * Deliberately a text walk rather than a parser: the project is zero-dependency
 * ESM with plain static imports, and a regex that misses something is caught by
 * the caller's own assertion rather than hidden by it.
 */
export function reachableSources(entries = VERDICT_ENTRIES, root = ROOT) {
  const seen = new Set();
  const stack = entries.map((e) => e.replace(/\\/g, '/'));
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const re of [FROM_RE, BARE_RE]) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) {
        stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
      }
    }
  }
  return [...seen].sort();
}

/**
 * sha256 over `VERDICT_SOURCES` + `VERDICT_DATA`, names included.
 *
 * The file NAME is hashed alongside its bytes so that renaming a module cannot
 * leave the digest untouched, and each field is NUL-terminated so that two
 * files whose contents concatenate to the same bytes cannot collide.
 */
export function verdictFingerprint(root = ROOT) {
  const h = crypto.createHash('sha256');
  for (const rel of [...VERDICT_SOURCES, ...VERDICT_DATA]) {
    h.update(rel.replace(/\\/g, '/'));
    h.update('\0');
    h.update(fs.readFileSync(path.join(root, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}
