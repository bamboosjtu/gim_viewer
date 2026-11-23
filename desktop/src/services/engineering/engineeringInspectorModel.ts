import type {
  EngineeringEntity,
  PendingWhole,
  EntityRelationship,
} from '../../engineering/types.js';
import type { SourceRecord } from '../../gim/engineering/sourceEvidence.js';
export interface EngineeringDetailsCursor {
  revision: number;
  offset: number;
}
export interface EngineeringDetailsPage {
  sections: readonly { title: string; rows: readonly [string, string][] }[];
  next?: EngineeringDetailsCursor;
  incomplete?: boolean;
}

export interface EngineeringInspectorInput {
  parts?: readonly string[];
  title: string;
  entity?: EngineeringEntity;
  pending?: PendingWhole;
  group?: {
    entityCount: number;
    pendingCount: number;
    declarations?: Array<{ title: string; document: string }>;
  };
  sources: readonly SourceRecord[];
  relationships: readonly EntityRelationship[];
  relatedNames: ReadonlyMap<string, string>;
  partial: boolean;
  geometryNote: string;
  onFit(this: void): void;
  onIsolate(this: void): void;
  onRestore(this: void): void;
  onSource(sourceId: string): void;
  onOwner?: () => void;
  onDocument?: (path: string) => void;
  onRefine?: (progress: (message: string) => void) => Promise<void>;
  onReleaseFine?: () => void;
  onDetails?: (cursor?: EngineeringDetailsCursor) => Promise<EngineeringDetailsPage>;
}
