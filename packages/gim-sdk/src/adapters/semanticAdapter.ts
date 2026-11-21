import type { EngineeringSources } from "../source/buildSources.js";
import { engineeringSourceRecords } from "../source/sourceGraph.js";
import { ENGINEERING_RECOGNITION_VERSION } from "./recognizeSource.js";
import { engineeringObjectEvidence } from "./objectEvidence.js";
import {
  normalizeEngineeringModel,
  type EngineeringSnapshot,
} from "../semantic/semantic.js";

/** Adapt format evidence once; source collection never invokes normalization. */
export function normalizeEngineeringSources(
  scope: string,
  sources: EngineeringSources,
): EngineeringSnapshot {
  return {
    ...normalizeEngineeringModel(
      scope,
      engineeringObjectEvidence(
        sources.graph,
        engineeringSourceRecords(sources.graph, sources.ifcRecords),
      ),
      sources.graph.aliases,
    ),
    rulesVersion: ENGINEERING_RECOGNITION_VERSION,
    evidenceBinding: { scope, sourceRevision: sources.graph.revision ?? 0 },
  };
}

export {
  toObjectEvidence,
  ENGINEERING_RECOGNITION_VERSION,
  ENGINEERING_EVIDENCE_FIELDS,
} from "./recognizeSource.js";
export type { SourceRecord, SourceProperty } from "../shared/sourceRecord.js";
