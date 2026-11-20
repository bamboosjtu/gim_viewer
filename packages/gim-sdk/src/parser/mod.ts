/**
 * MOD format family.
 *
 * Substation MOD is XML; line MOD is a family of text records. The two modes
 * keep separate implementations behind one format entry, and callers must
 * choose by product type instead of sniffing one grammar with another.
 *
 * The line implementation remains the shared `powerline-core` format source
 * so line-only consumers outside the GIM SDK do not acquire a new package
 * dependency. Moving that implementation is a separate package-boundary task.
 */
export * from "./substationMod.js";
export {
  classifyLineMod,
  parseHNumCommaRecord,
  parseKeyValue,
  parseLineMod,
  parsePointLine,
  parseSectionKvRecord,
} from "@gim/powerline-core/geometry/lineModParser.js";
