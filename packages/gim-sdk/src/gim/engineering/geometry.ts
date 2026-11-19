/** Geometry/source addresses are available independently of semantic ownership. */
export { extractPhysicalOccurrences } from "./physicalOccurrences.js";
export {
  collectSourceGeometryOccurrences,
  sourceGeometryLocations,
} from "./geometryOccurrences.js";
export { RepresentationAddressIndex } from "../../shared/representationAddresses.js";
export type {
  SourceRepresentation,
  DevRepresentationHint,
} from "../../shared/representationAddresses.js";
export type {
  SourceGeometryOccurrence,
  SourceGeometryOccurrenceCatalog,
} from "./geometryOccurrences.js";

export * from "../geometry/affineMatrix.js";
