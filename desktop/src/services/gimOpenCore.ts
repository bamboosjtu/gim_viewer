import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { NativeExtractionProfile } from '@desktop/gimExtract.js';
import type { GimSourceDescriptor } from './gimSourceService.js';
import {
  perfBegin,
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

export function getDevLineBatchOptions(): { maxFiles?: number; maxBytes?: number } {
  if (!import.meta.env.DEV) return {};
  const globals = globalThis as {
    __GIM_DEV_LINE_BATCH_MAX_FILES__?: unknown;
    __GIM_DEV_LINE_BATCH_MAX_BYTES__?: unknown;
  };
  const asPositiveInt = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const integer = Math.floor(value);
    return integer > 0 ? integer : undefined;
  };
  return {
    maxFiles: asPositiveInt(globals.__GIM_DEV_LINE_BATCH_MAX_FILES__),
    maxBytes: asPositiveInt(globals.__GIM_DEV_LINE_BATCH_MAX_BYTES__),
  };
}

export function getDevLineCatenaryMode(): boolean | undefined {
  if (!import.meta.env.DEV) return undefined;
  const value = (globalThis as { __GIM_DEV_CATENARY_MODE__?: unknown }).__GIM_DEV_CATENARY_MODE__;
  return typeof value === 'boolean' ? value : undefined;
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

/** A small shared timing helper for runtime boundaries. */
export function beginRuntimeSpan(label: string, session?: PerfSession): ReturnType<typeof perfBegin> {
  return perfBegin(label, undefined, session ?? currentPerfSession());
}
