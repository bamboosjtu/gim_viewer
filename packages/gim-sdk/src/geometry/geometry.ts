/** Geometry/source addresses are available independently of semantic ownership. */
export { extractPhysicalOccurrences } from "./physicalOccurrences.js";
export {
  collectSourceGeometryOccurrences,
  sourceGeometryLocations,
} from "./geometryOccurrences.js";
export { RepresentationAddressIndex } from "./representationAddresses.js";
export type {
  SourceRepresentation,
  DevRepresentationHint,
} from "./representationAddresses.js";
export type {
  SourceGeometryOccurrence,
  SourceGeometryOccurrenceCatalog,
} from "./geometryOccurrences.js";

export * from "./affineMatrix.js";
