import type { ObjectNameEvidence } from "../engineering/types.js";

/** Raw source records stay in the source domain, separate from engineering identity. */
export interface SourceProperty {
  sourceId?: string;
  applicability?: "instance" | "type" | "unknown";
  rawContainerName?: string;
  containerId?: string;
  rawUnit?: string;
  rawValueType?: string;
  keys?: readonly string[];
  value: string;
  path?: string;
  /** IFC raw property spelling/value, before semantic decoding. */
  key?: string;
  source?: string;
  line?: number;
  rawLine?: string;
  section?: string;
}

export interface SourceRecord {
  /** A logical attribute reference with no physical DEV occurrence address. */
  attributeOnly?: boolean;
  attributeContextId?: string;
  id: string;
  track: "dev" | "ifc";
  source: string;
  name: string;
  nameEvidence?: ObjectNameEvidence[];
  source_type: string;
  /** Only a real DEV assembly or IFC object decomposition edge. */
  parent: string;
  properties: readonly SourceProperty[];
  sources: readonly string[];
  context: readonly string[];
  guid: string;
  devOccurrence?: {
    rootSourceId: string;
    cbmOccurrenceId: string;
    assemblyPath: string;
  };
  ifcOccurrence?: { modelId: string; expressId: number; globalId: string };
  /** Hosting/space relations are evidence, not physical assembly membership. */
  relations?: Array<{ kind: "host"; targetSourceId: string; evidence: string }>;
}

export const isIfcFeatureSourceType = (type: string): boolean =>
  /^(?:IFCDISTRIBUTIONPORT|IFCPORT|IFCOPENINGELEMENT|IFCOPENINGSTANDARDCASE|IFCVOIDINGFEATURE|IFCFEATUREELEMENTSUBTRACTION|IFCFEATUREELEMENTADDITION|IFCFEATUREELEMENT|IFCPROJECTIONELEMENT|IFCANNOTATION|IFCGRID)$/.test(
    type,
  );
