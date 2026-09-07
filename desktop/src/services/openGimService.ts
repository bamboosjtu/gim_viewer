import type { AppState } from '../app/state.js';
import { btnLoadGim, gimFileInput } from '../ui/dom.js';
import { isTauri } from '@desktop/runtime.js';
import { openGimFilePath } from '@desktop/fileDialog.js';
import { DEBUG_RUNTIME_LOGS } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import {
  perfBegin,
  perfCurrentSession,
  perfReset,
  perfUpdateSessionIdentity,
} from '../utils/perfTimings.js';
import {
  hideLoading,
  recordNativeExtractionStages,
  resolveProjectName,
  showLoading,
  type ExtractedGimSource,
  type GimRuntimeOpenContext,
} from './gimOpenCore.js';
import {
  inspectGimSourceBuffer,
  inspectGimSourceHead,
  resolveGimRuntimeType,
  type GimContentProjectType,
  type GimRuntimeType,
  type GimSourceDescriptor,
} from './gimSourceService.js';
import { extractGimFile, getProjectTypeName } from '../gim/gimExtractor.js';
import { detectGimProjectType } from '../gim/projectType.js';
import { openPowerlineProject, commitLineParserResult, buildLineSemanticWarmFiles } from './powerlineRuntime.js';
import { openSubstationProject, onGimExtracted, loadAllIfcFiles } from './substationRuntime.js';

export { commitLineParserResult, buildLineSemanticWarmFiles };
export { onGimExtracted, loadAllIfcFiles };

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

function describeType(type: GimRuntimeType | 'unknown'): string {
  return type === 'transmission_line' ? 'transmission_line'
    : type === 'substation' ? 'substation'
    : 'unknown';
}

interface OpenSourceInput {
  state: AppState;
  showMessage: (text: string) => void;
  source: GimSourceDescriptor;
  projectId: number | null;
  sourceSha256: string | null;
  projectName: string;
  projectTypeName: string;
  requestGeneration: number;
  nativeFilePath?: string;
  sourceBuffer?: ArrayBuffer;
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
  const {
    state,
    showMessage,
    source,
    projectId,
    sourceSha256,
    requestGeneration,
    nativeFilePath,
    sourceBuffer,
  } = input;

  const { cleanupBeforeOpenNewProject } = await import('./projectCleanupService.js');
  const cleanupOk = await cleanupBeforeOpenNewProject(state, requestGeneration);
  if (!cleanupOk) return;

  const session = state.activateProject(projectId, sourceSha256);
  perfUpdateSessionIdentity({
    generation: session.generation,
    projectId: session.projectId,
    sourceSha256: session.sourceSha256,
  });
  // Project name is a shared identity field; domain-specific type/UI state is
  // committed by the selected Runtime after dispatch.
  state.projectName = input.projectName;

  let routingType: GimRuntimeType | 'unknown' = source.runtimeType;
  let extractedPromise: Promise<ExtractedGimSource> | null = null;
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
        extractedPromise = extractAndValidateSource();
      }
      return extractedPromise;
    },
  };

  const extractAndValidateSource = async (): Promise<ExtractedGimSource> => {
    const perfSession = perfCurrentSession();
    let extracted: ExtractedGimSource;

    if (nativeFilePath) {
      let endNative: ReturnType<typeof perfBegin> | null = null;
      try {
        const { extractGimArchiveNative } = await import('@desktop/gimExtract.js');
        endNative = perfBegin('解压（Rust 原生）', undefined, perfSession);
        const native = await extractGimArchiveNative(nativeFilePath, projectId ?? undefined);
        if (!state.isCurrentSession(session)) {
          endNative?.('（取消）');
          return { magic: source.magic, files: new Map() };
        }
        endNative(undefined, {
          files: native.files.size,
          extraction: native.extractionProfile ?? null,
        });
        recordNativeExtractionStages(native.extractionProfile, perfSession);
        extracted = native;
      } catch (nativeError) {
        const nativeMessage = nativeError instanceof Error ? nativeError.message : String(nativeError);
        endNative?.('（失败）', { error: nativeMessage });
        // 资源配额是安全边界，不得通过 WASM 回退绕过。
        if (/超出资源配额|资源配额|压缩比超限|条目数超限|单文件.*超限|总解压量.*超限/i.test(nativeMessage)) {
          throw nativeError;
        }
        console.warn('[Shared Core] 原生解压不可用，回退 libarchive.js WASM 路径:', nativeError);
        const { readFileBytes } = await import('@desktop/fileReader.js');
        showLoading('正在读取 GIM 文件...');
        const endRead = perfBegin('冷启动：读取 GIM 原始文件（WASM 回退）', undefined, perfSession);
        const bytes = sourceBuffer ?? await readFileBytes(nativeFilePath);
        if (!state.isCurrentSession(session)) return {
          magic: source.magic,
          files: new Map(),
        };
        endRead(undefined, { bytes: bytes.byteLength });
        const endExtract = perfBegin('解压（WASM 回退）', undefined, perfSession);
        const files = await extractGimFile(bytes);
        if (!state.isCurrentSession(session)) return {
          magic: source.magic,
          files: new Map(),
        };
        endExtract('（首开）', { files: files.size });
        extracted = {
          magic: source.magic,
          projectId: source.projectId,
          projectName: source.projectName,
          files,
        };
      }
    } else {
      if (!sourceBuffer) throw new Error('缺少浏览器 GIM 数据');
      showLoading('正在解压 GIM 文件...');
      const endExtract = perfBegin('解压（WASM）', undefined, perfSession);
      const files = await extractGimFile(sourceBuffer);
      if (!state.isCurrentSession(session)) return {
        magic: source.magic,
        files: new Map(),
      };
      endExtract('（首开）', { files: files.size });
      extracted = {
        magic: source.magic,
        projectId: source.projectId,
        projectName: source.projectName,
        files,
      };
    }

    if (!state.isCurrentSession(session)) return extracted;

    if (extracted.magic && source.magic && extracted.magic !== source.magic) {
      console.warn('[GIM] source magic changed between inspection and extraction:', {
        inspected: source.magic,
        extracted: extracted.magic,
      });
    }
    context.projectName = resolveProjectName(
      extracted.projectName || source.projectName,
      extracted.projectId || source.projectId,
      source.fileName,
    );
    context.projectTypeName = getProjectTypeName(extracted.magic || source.magic);

    showLoading('正在校验解压后的工程类型...');
    const endDetect = perfBegin('工程类型内容校验', undefined, perfSession);
    let detectedType: GimContentProjectType = 'unknown';
    try {
      const projectTypeResult = await detectGimProjectType(extracted.files);
      detectedType = projectTypeResult.type;
      endDetect(undefined, { type: projectTypeResult.type });
      debugLog(DEBUG_RUNTIME_LOGS, '[GIM Runtime Detect]', {
        sourceMagic: source.magic,
        extractedMagic: extracted.magic,
        sourceType: describeType(source.runtimeType),
        detectedType: projectTypeResult.type,
        details: projectTypeResult.details,
        samplePaths: Array.from(extracted.files.keys()).slice(0, 80),
      });
      if (projectTypeResult.type !== 'transmission_line') {
        const cbmSamples = Array.from(extracted.files.entries())
          .filter(([path]) => /\.cbm$/i.test(path))
          .slice(0, 5);
        for (const [path, file] of cbmSamples) {
          debugLog(DEBUG_RUNTIME_LOGS, '[GIM Runtime Detect] cbm sample', path, (await file.text()).slice(0, 500));
        }
      }
    } catch (error) {
      endDetect('（失败）', { error: error instanceof Error ? error.message : String(error) });
      console.warn('[GIM] 解压内容工程类型校验失败:', error);
    }

    const detectedRuntime = resolveGimRuntimeType('unknown', detectedType);
    if (source.runtimeType === 'unknown') {
      routingType = resolveGimRuntimeType(source.runtimeType, detectedType);
      if (detectedType === 'hybrid') {
        console.warn('[GIM] hybrid content detected; using Substation Runtime as the diagnostic fallback');
      }
    } else if (detectedRuntime !== 'unknown' && detectedRuntime !== source.runtimeType) {
      console.warn('[GIM] source magic/content type mismatch; source magic wins routing:', {
        sourceMagic: source.magic,
        sourceType: source.runtimeType,
        detectedType,
      });
    } else if (detectedType === 'hybrid') {
      console.warn('[GIM] hybrid content detected; source magic selects the runtime');
    }

    return extracted;
  };

  // Unknown magic has no cache domain to validate. Extract once for fallback
  // detection, then dispatch the same cached extraction result to one Runtime.
  if (routingType === 'unknown') {
    await context.getExtracted();
    if (!state.isCurrentSession(session)) return;
  }

  if (routingType === 'unknown') {
    showLoading('无法识别 GIM 工程类型：既未检测到 IFC，也未检测到线路工程特征');
    setTimeout(hideLoading, 4000);
    return;
  }

  if (routingType === 'transmission_line') {
    await openPowerlineProject(context);
  } else {
    await openSubstationProject(context);
  }
}

async function openTauriGim(
  state: AppState,
  showMessage: (text: string) => void,
): Promise<void> {
  const filePath = getDevPerformanceFilePath() ?? await openGimFilePath();
  if (!filePath) return;

  state.invalidatePendingLoads();
  const requestGeneration = state.projectGeneration;
  perfReset({ generation: requestGeneration, projectId: null, sourceSha256: null });
  btnLoadGim.disabled = true;

  try {
    showLoading('正在读取 GIM 文件信息...');
    const { getFileInfo, readFileHead } = await import('@desktop/fileReader.js');
    const endInfo = perfBegin('冷启动：读取 GIM 文件信息');
    const info = await getFileInfo(filePath);
    if (state.projectGeneration !== requestGeneration) return;

    const endHead = perfBegin('冷启动：读取 GIM source header');
    const head = await readFileHead(filePath);
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
      console.warn('[GIM] GIM source magic is unknown; content detector will be the fallback');
    }

    showLoading('正在写入本地项目索引...');
    const { upsertGimProject } = await import('@desktop/database.js');
    const endUpsert = perfBegin('冷启动：项目索引登记');
    const record = await upsertGimProject(info);
    if (state.projectGeneration !== requestGeneration) return;
    endUpsert(undefined, { projectId: record.id });

    const sourceWithIdentity: GimSourceDescriptor = {
      ...source,
      sha256: record.sha256,
    };
    const projectName = resolveProjectName(
      sourceWithIdentity.projectName,
      sourceWithIdentity.projectId,
      info.name,
    );
    await openInspectedSource({
      state,
      showMessage,
      source: sourceWithIdentity,
      projectId: record.id,
      sourceSha256: record.sha256,
      projectName,
      projectTypeName: getProjectTypeName(sourceWithIdentity.magic),
      requestGeneration,
      nativeFilePath: filePath,
    });
  } catch (error) {
    console.error(error);
    showLoading(`GIM 解析失败: ${error instanceof Error ? error.message : String(error)}`);
    setTimeout(hideLoading, 3000);
  } finally {
    btnLoadGim.disabled = false;
  }
}

async function openBrowserGim(
  state: AppState,
  showMessage: (text: string) => void,
): Promise<void> {
  state.invalidatePendingLoads();
  const requestGeneration = state.projectGeneration;
  perfReset({ generation: requestGeneration, projectId: null, sourceSha256: null });

  return new Promise<void>((resolve) => {
    const handler = async () => {
      gimFileInput.removeEventListener('change', handler);
      const files = Array.from(gimFileInput.files || []);
      if (files.length === 0) {
        resolve();
        return;
      }
      if (state.projectGeneration !== requestGeneration) {
        resolve();
        return;
      }
      btnLoadGim.disabled = true;
      try {
        const file = files[0];
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
          sourceBuffer: bytes,
        });
      } catch (error) {
        console.error(error);
        showLoading(`GIM 解析失败: ${error instanceof Error ? error.message : String(error)}`);
        setTimeout(hideLoading, 3000);
      } finally {
        gimFileInput.value = '';
        btnLoadGim.disabled = false;
        resolve();
      }
    };
    gimFileInput.addEventListener('change', handler);
    gimFileInput.click();
  });
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
): Promise<void> {
  if (isTauri()) {
    await openTauriGim(state, showMessage);
  } else {
    await openBrowserGim(state, showMessage);
  }
}
