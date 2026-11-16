import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { NativeExtractionProfile } from '@desktop/gimExtract.js';
import type { GimSourceDescriptor } from './gimSourceService.js';
import {
  perfCurrentSession,
  perfIsCurrentSession,
  perfRecordExternalSpan,
  type PerfSession,
} from '../utils/perfTimings.js';

export interface ExtractedGimSource {
  magic: string;
  /** Content subtype; GIMPKGS also occurs on standalone device packages. */
  projectType?: import('../gim/projectType.js').GimProjectType;
  sourceMaterialization?: Promise<void>;
  earlySemantic?: boolean;
  semanticCheckpoint?: Record<string, number | boolean>;
  projectId?: string;
  projectName?: string;
  files: Map<string, File>;
  cachePaths?: Map<string, string>;
  /** 变电源 pack 成员：没有独立缓存路径，但仍可作为合法语义源。 */
  packedPaths?: Set<string>;
  cacheProjectId?: number;
  extractionProfile?: NativeExtractionProfile;
  semanticPackPath?: string;
  parseCopy?: import('@desktop/substationParseCopy.js').ParseCopyReceipt;
  /** Small semantic inputs were hydrated before content-type detection. */
  preHydrated?: boolean;
  entryTrace?: import('@desktop/gimExtract.js').NativeExtractionEntryTiming[];
}

export type ExtractionResult = ({ status: 'ok' } & ExtractedGimSource) | { status: 'cancelled' };

/** Shared context passed into exactly one domain runtime after dispatch. */
export interface GimRuntimeOpenContext {
  state: AppState;
  source: GimSourceDescriptor;
  session: ProjectLoadSession;
  projectId: number | null;
  projectName: string;
  projectTypeName: string;
  showMessage: (text: string) => void;
  getExtracted: () => Promise<ExtractionResult>;
}

export {showLoading,hideLoading,resetLoadingClock,scheduleHideLoading} from './loadingPresentationPort.js';

export function currentPerfSession(): PerfSession {
  return perfCurrentSession();
}

/** Keep source/header naming fallback in Shared Core. */
export function resolveProjectName(
  headerName: string | undefined,
  headerId: string | undefined,
  fileName: string,
): string {
  const fileStem = (fileName.split(/[\\/]/).pop() || fileName).replace(/\.gim$/i, '').trim();
  return [headerName, headerId, fileStem].map((value) => String(value ?? '').trim()).find(Boolean) || '';
}

export function recordNativeExtractionStages(
  profile: NativeExtractionProfile | undefined,
  session: PerfSession,
  substation = false,
): void {
  if (!profile || !perfIsCurrentSession(session)) return;
  const stages: Array<[string, number, Record<string, unknown>]> = [
    ['native extract · header', profile.headerMs, { archiveBytes: profile.archiveBytes }],
    ['native extract · archive decode', profile.decodeMs, { entryCount: profile.entryCount, totalBytes: profile.totalBytes,
      ...(substation ? {maxEntryDecodeMs:profile.maxEntryDecodeMs,maxEntryDecodePath:profile.maxEntryDecodePath} : {}) }],
    ['native extract · write', profile.writeMs, {
      writeOpenMs: profile.writeOpenMs ?? null,
      writeDataMs: profile.writeDataMs ?? null,
      writeMode: profile.writeMode ?? null,
      ...(substation ? {maxEntryWriteMs:profile.maxEntryWriteMs,maxEntryWritePath:profile.maxEntryWritePath} : {}),
    }],
    ['native extract · manifest', profile.manifestMs, {}],
    ['native extract · commit', profile.commitMs ?? 0, {}],
  ];
  if(substation)stages.splice(1,0,['native extract · archive wall',profile.archiveMs,{includesDecodeAndWrite:true}]);
  for (const [label, durationMs, meta] of stages) {
    if (durationMs > 0) perfRecordExternalSpan(label, durationMs, meta, session);
  }
}
