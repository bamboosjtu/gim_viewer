import {
  acquireProjectSource,
  type EarlyProjectSource,
  type ProjectSourceInput,
} from './projectSourceAcquisition.js';
import { logger } from '../../utils/logger.js';
import type { ProjectLoadSession } from '../../shared/projectSession.js';

import { scheduleHideLoading } from '../../services/gimOpenCore.js';
import type { AppState } from '../state.js';
import { projectOpenPresentation } from '../../services/projectOpenPresentationPort.js';
import { isTauri } from '@desktop/runtime.js';
import { openGimFilePath } from '@desktop/fileDialog.js';
import { perfBegin, perfReset, perfUpdateSessionIdentity } from '../../utils/perfTimings.js';
import {
  resolveProjectName,
  showLoading,
  type ExtractionResult,
  type GimRuntimeOpenContext,
} from '../../services/gimOpenCore.js';
import {
  getProjectTypeName,
  inspectGimSourceBuffer,
  inspectGimSourceHead,
  resolveGimRuntimeType,
  type GimRuntimeType,
  type GimSourceDescriptor,
} from '../../services/gimSourceService.js';
export interface ProjectOpenRouting {
  ownsIntent: () => boolean;
  dispatch: (type: GimRuntimeType, context: GimRuntimeOpenContext) => Promise<void>;
  loadCleanup: () => Promise<(state: AppState, generation?: number) => Promise<boolean>>;
  beforeOpen: (state: AppState, generation: number) => void;
  recentProjectsChanged: () => void;
  loadEarlySubstation: () => Promise<EarlyProjectSource>;
}

/**
 * 仅开发构建使用的本地性能采集入口。
 *
 * Tauri 的原生文件选择器无法通过 WebView CDP 自动化（它属于系统模态
 * 窗口），而性能灰度需要重复打开固定的真实 GIM。允许采集脚本在当前
 * WebView 设置一个绝对路径，仍然走与点击“打开 GIM”完全相同的原生
 * FileInfo/SQLite/解压/批量读取流程；生产构建通过 import.meta.env.DEV
 * 消除该分支，绝不接受页面注入路径。
 */
function getDevPerformanceFilePath(): string | null {
  if (!import.meta.env.DEV) return null;
  const value = (globalThis as { __GIM_DEV_PERF_FILE_PATH__?: unknown }).__GIM_DEV_PERF_FILE_PATH__;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

interface OpenSourceInput extends ProjectSourceInput {
  showMessage: (text: string) => void;
  sourceSha256: string | null;
  projectName: string;
  projectTypeName: string;
  requestGeneration: number;
  routing: ProjectOpenRouting;
  onSession?: (session: ProjectLoadSession) => void;
}

/**
 * Shared Core boundary:
 * inspect → cleanup/session → source extraction/validation → dispatch.
 *
 * The function deliberately receives an already inspected source. Runtime
 * cache validation is therefore downstream of source identity and cannot
 * select a domain from the legacy cache row.
 */
async function openInspectedSource(input: OpenSourceInput): Promise<void> {
  const { state, showMessage, source, projectId, sourceSha256, requestGeneration, routing } = input;

  const cleanupProject = await input.routing.loadCleanup();
  const cleanup = cleanupProject(state, requestGeneration);
  const cleanedGeneration = state.projectGeneration;
  if (!(await cleanup) || state.projectGeneration !== cleanedGeneration) return;
  // 计时从本次打开重新开始，避免沿用上一工程的已用秒数。
  const { resetLoadingClock } = await import('../../services/gimOpenCore.js');
  if (state.projectGeneration !== cleanedGeneration) return;
  resetLoadingClock();

  const session = state.activateProject(projectId, sourceSha256);
  const scope = state.sessionScope(session);
  input.onSession?.(session);
  perfUpdateSessionIdentity({
    generation: session.generation,
    projectId: session.projectId,
    sourceSha256: session.sourceSha256,
  });
  // Project name is a shared identity field; domain-specific type/UI state is
  // committed by the selected Runtime after dispatch.
  state.projectName = input.projectName;

  let routingType: GimRuntimeType | 'unknown' = source.runtimeType;
  let extractedPromise: Promise<ExtractionResult> | null = null;
  const context: GimRuntimeOpenContext = {
    state,
    source,
    session,
    projectId,
    projectName: input.projectName,
    projectTypeName: input.projectTypeName,
    showMessage,
    getExtracted: () => {
      if (!extractedPromise) {
        extractedPromise = acquireProjectSource(input, context, scope);
      }
      return extractedPromise;
    },
  };

  // Unknown magic has no cache domain to validate. Extract once for fallback
  // detection, then dispatch the same cached extraction result to one Runtime.
  if (routingType === 'unknown') {
    const extracted = await context.getExtracted();
    if (!scope.isCurrent() || extracted.status === 'cancelled') return;
    routingType = resolveGimRuntimeType(source.runtimeType, extracted.projectType ?? 'unknown');
  }

  if (routingType === 'unknown') {
    showLoading('无法识别 GIM 内容：未检测到变电、线路或独立设备入口');
    scheduleHideLoading(() => state.isCurrentSession(session), 4000);
    return;
  }

  await routing.dispatch(routingType, context);
}

async function openTauriGim(
  state: AppState,
  showMessage: (text: string) => void,
  routing: ProjectOpenRouting,
  requestedPath?: string,
  options: { rethrowError?: boolean; recentProjectId?: number } = {},
): Promise<void> {
  const { ownsIntent } = routing;
  if (!ownsIntent()) return;
  let filePath: string | null;
  try {
    if (options.recentProjectId !== undefined) {
      const { authorizeCachedGimProject } =
        await import('../../infrastructure/native/projectFiles.js');
      if (!ownsIntent()) return;
      filePath = await authorizeCachedGimProject(options.recentProjectId, ownsIntent);
    } else {
      filePath = requestedPath ?? getDevPerformanceFilePath() ?? (await openGimFilePath());
    }
  } catch (error) {
    if (ownsIntent()) throw error;
    return;
  }
  if (!filePath || !ownsIntent()) return;

  const {
    generation: requestGeneration,
    ownsControls: ownsRequest,
    isCurrent: ownsOpen,
    setSession,
  } = state.projectSession.beginOpen();
  if (!ownsOpen()) return;
  perfReset({ generation: requestGeneration, projectId: null, sourceSha256: null });
  routing.beforeOpen(state, requestGeneration);
  projectOpenPresentation().setBusy('gim', true);

  try {
    showLoading('正在读取 GIM 文件信息...');
    const { getFileInfo, readFileHead } = await import('../../infrastructure/native/fileReader.js');
    const endInfo = perfBegin('冷启动：读取 GIM 文件信息');
    if (!ownsOpen()) return;
    const info = await getFileInfo(filePath, ownsOpen);
    if (state.projectGeneration !== requestGeneration) return;

    const endHead = perfBegin('冷启动：读取 GIM source header');
    const head = await readFileHead(filePath, undefined, ownsOpen);
    if (state.projectGeneration !== requestGeneration) return;
    endHead(undefined, { bytes: head.byteLength });

    const source = inspectGimSourceHead(info.name, head, {
      path: info.path,
      size: info.size,
      modifiedMs: info.modified_ms,
      sha256: info.sha256,
    });
    endInfo(undefined, {
      bytes: info.size,
      magic: source.magic,
      runtimeType: source.runtimeType,
    });
    if (source.runtimeType === 'unknown') {
      logger.warn('[GIM] GIM source magic is unknown; content detector will be the fallback');
    }

    showLoading('正在登记工程记录...');
    const { upsertGimProject } = await import('@desktop/database.js');
    const endUpsert = perfBegin('项目索引登记');
    if (!ownsOpen()) return;
    const record = await upsertGimProject(info);
    if (state.projectGeneration !== requestGeneration) return;
    endUpsert(undefined, { projectId: record.id });
    // 先更新最近打开时间，再开始加载：用户可能在首屏后立刻关闭/切换工程，
    // 若等 opened 完成再 touch，代次已变化会被跳过，导致“最近工程”永远停在
    // 启动时的第一条。
    void import('@desktop/database.js')
      .then(({ touchGimProjectOpened }) => touchGimProjectOpened(record.id))
      .then(() => routing.recentProjectsChanged())
      .catch(() => {
        /* recency update is best effort */
      });
    showLoading('正在检查本地缓存...');

    const sourceWithIdentity: GimSourceDescriptor = {
      ...source,
      sha256: record.sha256,
    };
    const projectName = resolveProjectName(
      sourceWithIdentity.projectName,
      sourceWithIdentity.projectId,
      info.name,
    );
    const opened = openInspectedSource({
      state,
      showMessage,
      source: sourceWithIdentity,
      projectId: record.id,
      sourceSha256: record.sha256,
      projectName,
      projectTypeName: getProjectTypeName(sourceWithIdentity.magic),
      requestGeneration,
      onSession: setSession,
      routing,
      loadEarlySubstation: routing.loadEarlySubstation,
      nativeFilePath: filePath,
    });
    await opened;
  } catch (error) {
    if (!ownsOpen()) return;
    logger.error(error);
    showLoading(`GIM 解析失败: ${error instanceof Error ? error.message : String(error)}`);
    scheduleHideLoading(ownsOpen, 3000);
    if (options.rethrowError) throw error;
  } finally {
    if (ownsRequest()) projectOpenPresentation().setBusy('gim', false);
  }
}

async function openBrowserGim(
  state: AppState,
  showMessage: (text: string) => void,
  routing: ProjectOpenRouting,
): Promise<void> {
  if (!routing.ownsIntent()) return;
  const file = await projectOpenPresentation().chooseGim();
  if (!file || !routing.ownsIntent()) return;
  const {
    generation: requestGeneration,
    ownsControls: ownsRequest,
    isCurrent: ownsOpen,
    setSession,
  } = state.projectSession.beginOpen();
  if (!ownsOpen()) return;
  perfReset({ generation: requestGeneration, projectId: null, sourceSha256: null });
  routing.beforeOpen(state, requestGeneration);

  projectOpenPresentation().setBusy('gim', true);
  try {
    const bytes = await file.arrayBuffer();
    if (state.projectGeneration !== requestGeneration) return;
    const source = inspectGimSourceBuffer(file.name, bytes, {
      size: file.size,
      modifiedMs: file.lastModified,
      sha256: null,
    });
    await openInspectedSource({
      state,
      showMessage,
      source,
      projectId: null,
      sourceSha256: null,
      projectName: resolveProjectName(source.projectName, source.projectId, file.name),
      projectTypeName: getProjectTypeName(source.magic),
      requestGeneration,
      onSession: setSession,
      routing,
      loadEarlySubstation: routing.loadEarlySubstation,
      sourceBuffer: bytes,
    });
  } catch (error) {
    if (!ownsOpen()) return;
    logger.error(error);
    showLoading(`GIM 解析失败: ${error instanceof Error ? error.message : String(error)}`);
    scheduleHideLoading(ownsOpen, 3000);
  } finally {
    if (ownsRequest()) projectOpenPresentation().resetInput('gim');
    if (ownsRequest()) projectOpenPresentation().setBusy('gim', false);
  }
}

/**
 * 打开 GIM 文件的顶层入口。
 *
 * Shared Core owns source inspection, identity, cleanup and session setup.
 * Exactly one domain Runtime owns cache validation and the remainder of the
 * open lifecycle.
 */
export async function openGimWithDialog(
  state: AppState,
  showMessage: (text: string) => void,
  routing: ProjectOpenRouting,
): Promise<void> {
  if (isTauri()) {
    await openTauriGim(state, showMessage, routing);
  } else {
    await openBrowserGim(state, showMessage, routing);
  }
}

/** 打开数据库已知的最近工程；路径由 Rust 从 gim_project 读取并授权。 */
export async function openGimProjectFromId(
  state: AppState,
  showMessage: (text: string) => void,
  projectId: number,
  routing: ProjectOpenRouting,
): Promise<void> {
  if (!isTauri()) return;
  await openTauriGim(state, showMessage, routing, undefined, { recentProjectId: projectId });
}

/** Path has already been checked against the private native benchmark manifest. */
export async function openGimForBenchmark(
  state: AppState,
  path: string,
  routing: ProjectOpenRouting,
): Promise<void> {
  if (import.meta.env.VITE_GIM_BENCHMARK !== '1') throw Error('benchmark-build-required');
  await openTauriGim(state, () => {}, routing, path, { rethrowError: true });
}
