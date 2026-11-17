/** Read-only evidence contracts. No parser, IO or rendering dependencies. */
export type EvidenceStatus = 'not_requested' | 'complete' | 'partial' | 'unsupported' | 'failed';
export interface EvidenceRef { documentId: string; path: string; line?: number; containerId?: string; sourceId?: string }
export type AttributePayload = string | number | boolean | null | readonly AttributePayload[] | {readonly [key:string]:AttributePayload};
export type AttributeValue = {kind:'scalar';value:string|number|boolean|null} | {kind:'unknown';sourceType?:string} | {kind:'extension';typeId:string;version:string;payload:AttributePayload};
export interface SourceAttribute {
  conflict?:{group:string;reason:'incompatible_observations'};
  id:string;rawKey:string;rawValue:string;rawUnit?:string;rawValueType?:string;rawSection?:string;containerId?:string;
  sourceId?:string;
  applicability?:'instance'|'type'|'unknown';
  rawContainerName?:string;
  evidence:readonly EvidenceRef[];
  parsedValue?:{status:'parsed'|'unsupported'|'failed';value?:AttributeValue;method:string;version:string};
  semanticValue?:{propertyId:string;value:AttributeValue;unit?:{symbol:string;quantityKind?:string;dimensionId?:string};method:string;version:string};
}
export interface SourceAttributeAssignment {attributeId:string;sourceId?:string;occurrenceId?:string;candidateSourceIds:readonly string[];status:'confirmed'|'ambiguous'|'unresolved'}
export interface EvidenceRange {entryIds:readonly string[];kinds:readonly ('documents'|'attributes'|'references'|'occurrences'|'assignments')[]}
export interface EvidenceQuery {range:EvidenceRange;revision:number;offset?:number;limit:number}
export interface EvidenceInventory {
  entryRange?:readonly string[];
  inventoryTotals?:{entries:number;parsedComplete:number};
  /** Source facts used by Core; revision below also tracks parsing/residency. */
  sourceRevision:number;
  scope:string;revision:number;inventoryComplete:boolean;
  entries:readonly {id:string;path:string;formatHint:string;readStatus:'not_requested'|'available'|'failed';status:EvidenceStatus}[];
  coverage:readonly {entryId:string;status:EvidenceStatus;capability?:EvidenceRange['kinds'][number];materialization?:'materialized'|'not_materialized';rawAvailable?:boolean;restorable?:boolean}[];
}
export interface EvidencePage {
  revision:number;attributes:readonly SourceAttribute[];assignments:readonly SourceAttributeAssignment[];
  documents:readonly {path:string;rawLines:readonly string[]}[];
  references:readonly {owner:string;field:string;value:string;target:string|null;status:string}[];
  occurrences:readonly {id:string;path:string}[];
  coverage:EvidenceInventory['coverage'];nextOffset?:number;
}
