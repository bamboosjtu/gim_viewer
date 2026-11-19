/** Source capability: documents, occurrences and format evidence; no normalization. */
export {
  extractEngineeringSourceGraph,
  materializeEngineeringFamilies,
  engineeringSourceRecords,
} from "./sourceGraph.js";
export type {
  EngineeringSourceGraph,
  SourceFileReader,
  CbmOccurrence,
  SourceReference,
} from "./sourceGraph.js";
export { SourceDocuments, parseSourceDocument } from "./sourceDocuments.js";
export type { SourceDocument } from "./sourceDocuments.js";
export {
  collectEngineeringSources,
  ENGINEERING_SOURCE_VERSION,
} from "./buildSources.js";
export type { EngineeringSources } from "./buildSources.js";
export {
  collectSourceComposition,
  cbmRelationKind,
} from "./sourceComposition.js";
export type {
  SourceRecord,
  SourceProperty,
} from "../../shared/sourceRecord.js";
export { isIfcFeatureSourceType } from "../../shared/sourceRecord.js";
export { ifcSourceRecords } from "./ifcSourceRecords.js";
