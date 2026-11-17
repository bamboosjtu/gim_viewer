/** Source capability: documents, occurrences and format evidence; no normalization. */
export {extractEngineeringSourceGraph, materializeEngineeringFamilies, engineeringSourceRecords} from './sourceGraph.js';
export type {EngineeringSourceGraph, SourceFileReader, CbmOccurrence, SourceReference} from './sourceGraph.js';
export {SourceDocuments} from './sourceDocuments.js';
export type {SourceDocument} from './sourceDocuments.js';
export {collectEngineeringSources} from './buildSources.js';
export type {EngineeringSources} from './buildSources.js';
