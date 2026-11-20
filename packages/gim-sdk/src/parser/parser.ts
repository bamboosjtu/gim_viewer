/**
 * Independent format-parser layer.
 *
 * Parsers emit source spelling and diagnostics. They must not import the five
 * cores, make business-identity decisions, read files, or schedule runtime work.
 */
export * from "./types.js";
export * from "./values.js";
export * from "./fam.js";
