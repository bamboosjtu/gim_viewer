import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { NativeExtractionProfile } from '@desktop/gimExtract.js';
import type { GimSourceDescriptor } from './gimSourceService.js';
import {
  perfCurrentSession,
  perfIsCurrentSession,
  perfRecordExternalSpan,
  type PerfSession,
} from '../utils/perfTimings.js';
import { loadingEl, emptyTipEl } from '../ui/dom.js';
import { pushBusy, popBusy } from '../ui/shell/statusBar.js';

export interface ExtractedGimSource {
  magic: string;
  sourceMaterialization?: Promise<void>;
  earlySemantic?: boolean;
  semanticCheckpoint?: Record<string, number | boolean>;
  projectId?: string;
  projectName?: string;
  files: Map<string, File>;
  cachePaths?: Map<string, string>;
  cacheProjectId?: number;
  extractionProfile?: NativeExtractionProfile;
  semanticPackPath?: string;
  parseCopy?: import('@desktop/substationParseCopy.js').ParseCopyReceipt;
  entryTrace?: import('@desktop/gimExtract.js').NativeExtractionEntryTiming[];
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

let loadingStartedAt: number | null = null;
let loadingTimer: ReturnType<typeof setInterval> | null = null;
let loadingProgress = 0;

function updateLoadingElapsed(): void {
  const elapsed = document.getElementById('loading-elapsed');
  if (!elapsed) return;
  if (loadingStartedAt == null) { elapsed.textContent = ''; return; }
  elapsed.textContent = `${((performance.now() - loadingStartedAt) / 1000).toFixed(1)} s`;
}

function inferLoadingProgress(text: string): number {
  const explicitIfc = text.match(/\bIFC\s+(\d+)\s*\/\s*(\d+)/i);
  if (explicitIfc) {
    const done = Number(explicitIfc[1]), total = Math.max(1, Number(explicitIfc[2]));
    return 78 + Math.min(1, done / total) * 10;
  }
  const percent = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (percent) return 88 + Math.min(1, Number(percent[1]) / 100) * 6;
  const stages: Array<[RegExp, number]> = [
    [/读取 GIM 文件信息/i, 3],
    [/登记工程记录/i, 7],
    [/检查本地缓存/i, 12],
    [/解压并校验|正在解压|解压（/i, 24],
    [/校验解压后的工程类型/i, 55],
    [/解析 GIM 层级结构/i, 65],
    [/从本地缓存恢复 GIM 索引/i, 68],
    [/加载 3D 引擎/i, 75],
    [/加载 IFC 模型/i, 78],
    [/正在加载 .*IFC|正在加载 .*\.ifc/i, 80],
    [/semantic pack 恢复|已从 .*恢复线路工程|线路工程已加载/i, 60],
  ];
  for (const [pattern, value] of stages) if (pattern.test(text)) return value;
  return 8;
}

function applyLoadingProgress(text: string): void {
  const bar = document.getElementById('loading-bar') as HTMLElement | null;
  const stage = document.getElementById('loading-stage') as HTMLElement | null;
  if (!bar) return;
  const inferred = inferLoadingProgress(text);
  // Never move backwards; extraction/IFC callbacks can arrive out of order.
  if (inferred > loadingProgress) loadingProgress = inferred;
  bar.style.width = `${Math.min(96, Math.round(loadingProgress))}%`;
  if (stage) stage.textContent = loadingProgress > 0 ? `${Math.round(loadingProgress)}%` : '准备中';
}

export function showLoading(text: string): void {
  const textEl = document.getElementById('loading-text');
  if (textEl) textEl.textContent = text;
  else loadingEl.textContent = text;
  loadingEl.style.display = 'block';
  if (loadingStartedAt == null) {
    loadingStartedAt = performance.now();
    loadingProgress = 0;
    loadingEl.classList.add('active');
  }
  if (!loadingTimer && typeof setInterval === 'function') {
    loadingTimer = setInterval(() => {
      if (loadingStartedAt == null) return;
      updateLoadingElapsed();
    }, 100);
  }
  updateLoadingElapsed();
  applyLoadingProgress(text);
  // While a project is opening, replace the empty-state copy with the
  // viewport skeleton; the bottom status bar carries IFC/DEV progress.
  emptyTipEl?.classList.add('loading');
  pushBusy(text);
}

export function hideLoading(): void {
  loadingEl.style.display = 'none';
  loadingEl.classList.remove('active');
  if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
  loadingStartedAt = null;
  loadingProgress = 0;
  emptyTipEl?.classList.remove('loading');
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
