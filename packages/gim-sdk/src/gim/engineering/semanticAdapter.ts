import type {EngineeringSources} from './buildSources.js';
import {engineeringSourceRecords} from './sourceGraph.js';
import {ENGINEERING_RECOGNITION_VERSION} from '../../engineering/recognizeSource.js';
import {engineeringObjectEvidence} from './objectEvidence.js';
import {normalizeEngineeringModel, type EngineeringSnapshot} from '../../engineering/semantic.js';

/** Adapt format evidence once; source collection never invokes normalization. */
export function normalizeEngineeringSources(scope:string,sources:EngineeringSources):EngineeringSnapshot {
  return {...normalizeEngineeringModel(scope,engineeringObjectEvidence(sources.graph,engineeringSourceRecords(sources.graph,sources.ifcRecords)),sources.graph.aliases),
    rulesVersion:ENGINEERING_RECOGNITION_VERSION,evidenceBinding:{scope,sourceRevision:sources.graph.revision??0}};
}

export {toObjectEvidence, ENGINEERING_RECOGNITION_VERSION, ENGINEERING_EVIDENCE_FIELDS} from '../../engineering/recognizeSource.js';
export type {SourceRecord,SourceProperty} from '../../shared/sourceRecord.js';
