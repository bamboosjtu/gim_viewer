/**
 * MOD format family.
 *
 * Substation MOD is XML; line MOD is a family of text records. The two modes
 * keep separate implementations behind one format entry, and callers must
 * choose by product type instead of sniffing one grammar with another.
 *
 * Line record grammar is shared with the line domain through gim-primitives.
 */
export * from "./substationMod.js";
export {
  classifyLineMod,
  parseHNumCommaRecord,
  parseKeyValue,
  parseLineMod,
  parsePointLine,
  parseSectionKvRecord,
} from "@gim/gim-primitives/geometry/lineModParser.js";
