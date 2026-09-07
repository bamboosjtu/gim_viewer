import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { NativeExtractionProfile } from '@desktop/gimExtract.js';
import type { GimSourceDescriptor } from './gimSourceService.js';
import {
  perfCurrentSession,
  perfIsCurrentSession,
  perfRecordExternalSpan,
  type PerfSession,
} from '../utils/perfTimings.js';
import { loadingEl } from '../ui/dom.js';
import { pushBusy, popBusy } from '../ui/shell/statusBar.js';

export interface ExtractedGimSource {
  magic: string;
  projectId?: string;
  projectName?: string;
  files: Map<string, File>;
  cachePaths?: Map<string, string>;
  cacheProjectId?: number;
  extractionProfile?: NativeExtractionProfile;
  semanticPackPath?: string;
}

/** Shared context passed into exactly one domain runtime after dispatch. */
export interface GimRuntimeOpenContext {
  state: AppState;
  source: GimSourceDescriptor;
  session: ProjectLoadSession;
  projectId: number | null;
  projectName: string;
  projectTypeName: string;
  showMessage: (text: string) => void;
  getExtracted: () => Promise<ExtractedGimSource>;
}

export function showLoading(text: string): void {
  loadingEl.textContent = text;
  loadingEl.style.display = 'block';
  pushBusy(text);
}

export function hideLoading(): void {
  loadingEl.style.display = 'none';
  popBusy('就绪');
}

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
): void {
  if (!profile || !perfIsCurrentSession(session)) return;
  const stages: Array<[string, number, Record<string, unknown>]> = [
    ['native extract · header', profile.headerMs, { archiveBytes: profile.archiveBytes }],
    ['native extract · archive decode', profile.decodeMs, { entryCount: profile.entryCount, totalBytes: profile.totalBytes }],
    ['native extract · write', profile.writeMs, {
      writeOpenMs: profile.writeOpenMs ?? null,
      writeDataMs: profile.writeDataMs ?? null,
      writeMode: profile.writeMode ?? null,
    }],
    ['native extract · manifest', profile.manifestMs, {}],
    ['native extract · commit', profile.commitMs ?? 0, {}],
  ];
  for (const [label, durationMs, meta] of stages) {
    if (durationMs > 0) perfRecordExternalSpan(label, durationMs, meta, session);
  }
}
