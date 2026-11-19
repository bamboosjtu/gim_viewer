/** Read-only evidence contracts. No parser, IO or rendering dependencies.
 * The contract shapes live in shared/contracts.ts and are re-exported here so
 * existing import sites and the public semantic surface are unchanged. */
export type {
  EvidenceStatus,
  EvidenceRef,
  AttributePayload,
  AttributeValue,
  SourceAttribute,
  SourceAttributeAssignment,
  EvidenceRange,
  EvidenceQuery,
  EvidenceInventory,
  EvidencePage,
} from "../shared/contracts.js";
