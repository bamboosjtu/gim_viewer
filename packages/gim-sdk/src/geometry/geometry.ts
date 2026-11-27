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
export type * from "./primitiveContracts.js";
export { DEFAULT_GEOMETRY_LIMITS } from "./geometryBudget.js";
export { interpretXmlModPrimitive } from "./interpretXmlModPrimitive.js";
export { compilePrimitive } from "./compilePrimitive.js";
export { compileXmlModDocument } from "./compileXmlModDocument.js";
export * from "./analysisGeometry.js";
export { PROFILE_TAGS } from "./profileFamilies.js";
export { COMPLEX_TAGS } from "./interpretXmlModPrimitive.js";
export { curveCenterline } from "./curveCable.js";
export {
  compileStl,
  queryStlBounds,
  type StlFormat,
  type StlCompileResult,
} from "./formats/stl.js";
