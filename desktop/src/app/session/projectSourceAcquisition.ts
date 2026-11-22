import { hasErrorCode, type EarlySemanticEligibility } from '@desktop/contracts.js';
import { isTauri } from '@desktop/runtime.js';
import type { AppState } from '../state.js';
import type { SessionScope } from '../../shared/sessionScope.js';
import type { ProjectLoadSession } from '../../shared/projectSession.js';
import { SUBSTATION_EARLY_SEMANTIC_DEFAULT } from '../../config/features.js';
import { DEBUG_RUNTIME_LOGS } from '../../config/debug.js';
import { debugLog, logger } from '../../utils/logger.js';
import { perfBegin, perfCurrentSession } from '../../utils/perfTimings.js';
import {
  recordNativeExtractionStages,
  resolveProjectName,
  showLoading,
  type ExtractedGimSource,
  type ExtractionResult,
  type GimRuntimeOpenContext,
} from '../../services/gimOpenCore.js';
import {
  assertGimSourceMagicStable,
  detectGimProjectType,
  extractGimFile,
  getProjectTypeName,
  inspectGimSourceBuffer,
  resolveGimRuntimeType,
  type GimContentProjectType,
  type GimSourceDescriptor,
} from '../../services/gimSourceService.js';

export interface EarlyProjectSource {
  inspectEarlySemanticEligibility(
    filePath: string,
    projectId: number,
    sourceSha256: string,
  ): Promise<EarlySemanticEligibility>;
  withEarlySemanticCapability(
    capability: EarlySemanticEligibility,
    early: () => Promise<ExtractedGimSource>,
    full: () => Promise<ExtractedGimSource>,
  ): Promise<ExtractedGimSource>;
  startSubstationExtractionJob(
    state: AppState,
    session: ProjectLoadSession,
    path: string,
    projectId: number,
  ): Promise<ExtractedGimSource>;
}

export interface ProjectSourceInput {
  state: AppState;
  source: GimSourceDescriptor;
  projectId: number | null;
  nativeFilePath?: string;
  sourceBuffer?: ArrayBuffer;
  loadEarlySubstation: () => Promise<EarlyProjectSource>;
}

export function canFallbackFromNativeExtraction(error: unknown): boolean {
  return hasErrorCode(error, 'BACKEND_UNAVAILABLE', 'UNSUPPORTED_FORMAT', 'IO');
}
export function canRecoverNativeExtractionReceipt(error: unknown): boolean {
  return canFallbackFromNativeExtraction(error) || hasErrorCode(error, 'RESPONSE_INVALID');
}

/**
 * 复用上次解压结果。
 *
 * 变电首开会先解压、再在后台发布语义索引；若用户在发布完成前切换工程，
 * 索引不会提交，但已解压的 pack/IFC 仍然有效。这里读取解压清单并按同一
 * 源 SHA 复用，避免把“索引未提交”退化成重新解压全部条目。
 */
async function reuseExtractedSources(
  projectId: number | null,
  sourceSha256: string | null,
  magic: string,
  isCurrent: () => boolean,
): Promise<ExtractedGimSource | null> {
  if (projectId == null || !sourceSha256 || !isTauri()) return null;
  try {
    const { readExtractionManifest, createDiskBackedFile } =
      await import('../../infrastructure/native/gimExtract.js');
    const manifest = await readExtractionManifest(projectId, isCurrent);
    if (
      !isCurrent() ||
      !manifest ||
      manifest.source_sha256 !== sourceSha256 ||
      manifest.entries.length === 0
    )
      return null;
    const files = new Map<string, File>();
    const cachePaths = new Map<string, string>();
    const packedPaths = new Set<string>();
    for (const entry of manifest.entries) {
      if (!entry || typeof entry.path !== 'string' || !Number.isFinite(entry.size)) continue;
      files.set(
        entry.path,
        createDiskBackedFile(projectId, entry.path, entry.size, false, isCurrent),
      );
      if (entry.packed) packedPaths.add(entry.path);
      if (entry.cache_path) cachePaths.set(entry.path, entry.cache_path);
    }
    if (files.size === 0) return null;
    return { magic, files, cachePaths, packedPaths, cacheProjectId: projectId };
  } catch {
    return null;
  }
}

async function detectSourceContent(
  source: GimSourceDescriptor,
  extracted: ExtractedGimSource,
  context: GimRuntimeOpenContext,
  perfSession: ReturnType<typeof perfCurrentSession>,
): Promise<GimContentProjectType> {
  showLoading('正在校验解压后的工程类型...');
  const endDetect = perfBegin('工程类型内容校验', undefined, perfSession);
  let detectedType: GimContentProjectType = 'unknown';
  try {
    const projectTypeResult = await detectGimProjectType(extracted.files);
    detectedType = projectTypeResult.type;
    extracted.projectType = detectedType;
    if (detectedType === 'equipment') context.projectTypeName = '设备模型';
    endDetect(undefined, { type: projectTypeResult.type });
    const endPostDetect = perfBegin('工程类型校验后调度', undefined, perfSession);
    if (DEBUG_RUNTIME_LOGS) {
      debugLog(true, '[GIM Runtime Detect]', {
        sourceMagic: source.magic,
        extractedMagic: extracted.magic,
        sourceType: source.runtimeType,
        detectedType: projectTypeResult.type,
        details: projectTypeResult.details,
        samplePaths: (() => {
          const paths: string[] = [];
          for (const path of extracted.files.keys()) {
            if (paths.length >= 80) break;
            paths.push(path);
          }
          return paths;
        })(),
      });
      if (projectTypeResult.type !== 'transmission_line') {
        let sampled = 0;
        for (const [path, file] of extracted.files) {
          if (!/\.cbm$/i.test(path)) continue;
          debugLog(
            true,
            '[GIM Runtime Detect] cbm sample',
            path,
            (await file.text()).slice(0, 500),
          );
          if (++sampled === 5) break;
        }
      }
    }
    endPostDetect(undefined, { diagnosticReads: DEBUG_RUNTIME_LOGS });
  } catch (error) {
    endDetect('（失败）', { error: error instanceof Error ? error.message : String(error) });
    logger.warn('[GIM] 解压内容工程类型校验失败:', error);
  }

  return detectedType;
}

async function extractNativeSource(
  input: ProjectSourceInput,
  nativeFilePath: string,
  session: ProjectLoadSession,
  scope: SessionScope,
  perfSession: ReturnType<typeof perfCurrentSession>,
): Promise<ExtractedGimSource | null> {
  const { state, projectId, source, sourceBuffer } = input;
  let endNative: ReturnType<typeof perfBegin> | null = null;
  const earlySourceSha = session.sourceSha256;
  const earlyRequested =
    source.magic === 'GIMPKGS' &&
    projectId != null &&
    !!earlySourceSha &&
    (SUBSTATION_EARLY_SEMANTIC_DEFAULT ||
      localStorage.getItem('gim-debug-substation-early-semantic') === '1');
  try {
    const { extractGimArchiveNative } = await import('../../infrastructure/native/gimExtract.js');
    // 上次解压成功但语义索引尚未提交时（首开期间切换/关闭工程），
    // 复用同一源 SHA 的已解压文件，避免再次解压 3.6 万条目。
    const reused = await reuseExtractedSources(
      projectId,
      session.sourceSha256,
      source.magic,
      scope.isCurrent,
    );
    if (!scope.isCurrent()) return null;
    if (reused) {
      (await import('../../utils/perfTimings.js')).perfMark(
        '解压复用（已解压缓存，索引未提交）',
        {
          files: reused.files.size,
        },
        perfSession,
      );
      return reused;
    } else {
      endNative = perfBegin('解压（Rust 原生）', undefined, perfSession);
      const fullNative = () =>
        extractGimArchiveNative(
          nativeFilePath,
          projectId ?? undefined,
          {
            ...(session.sourceSha256 ? { expectedSourceSha256: session.sourceSha256 } : {}),
            traceEntries: localStorage.getItem('gim-debug-substation-extraction-trace') === '1',
            substationParseCopy: localStorage.getItem('gim-debug-substation-parse-copy') === '1',
          },
          scope.isCurrent,
        );
      let native: Awaited<ReturnType<typeof extractGimArchiveNative>> | ExtractedGimSource;
      if (earlyRequested) {
        const policy = await input.loadEarlySubstation();
        const capability = await policy.inspectEarlySemanticEligibility(
          nativeFilePath,
          projectId,
          earlySourceSha,
        );
        (await import('../../utils/perfTimings.js')).perfMark(
          'early semantic eligibility',
          { ...capability },
          perfSession,
        );
        if (!state.isCurrentSession(session)) return null;
        native = await policy.withEarlySemanticCapability(
          capability,
          () => policy.startSubstationExtractionJob(state, session, nativeFilePath, projectId),
          fullNative,
        );
      } else native = await fullNative();
      if (!state.isCurrentSession(session)) {
        endNative?.('（取消）');
        return null;
      }
      endNative(undefined, {
        files: native.files.size,
        extraction: native.extractionProfile ?? null,
        entryTrace: native.entryTrace ?? null,
        parseCopy: native.parseCopy ?? null,
        earlySemantic: native.earlySemantic ?? false,
        semanticCheckpoint: native.semanticCheckpoint ?? null,
      });
      recordNativeExtractionStages(
        native.extractionProfile,
        perfSession,
        source.magic === 'GIMPKGS',
      );
      if (source.magic === 'GIMPKGS' && !native.earlySemantic) {
        (await import('../../utils/perfTimings.js')).perfMark(
          'sourceMaterializationComplete',
          { files: native.files.size },
          perfSession,
        );
      }
      return native;
    }
  } catch (nativeError) {
    if (!scope.isCurrent()) {
      endNative?.('（取消）');
      return null;
    }
    const nativeMessage = nativeError instanceof Error ? nativeError.message : String(nativeError);
    endNative?.('（失败）', { error: nativeMessage });
    if (earlyRequested) throw nativeError;
    // 资源配额是安全边界，不得通过 WASM 回退绕过。
    if (!canRecoverNativeExtractionReceipt(nativeError)) {
      throw nativeError;
    }
    // The native command may have committed its source cache before a
    // manifest transport error. Its SHA-bound receipt is authoritative;
    // do not decode the same archive again or abandon a reusable cache.
    const recovered = await reuseExtractedSources(
      projectId,
      session.sourceSha256,
      source.magic,
      scope.isCurrent,
    );
    if (!scope.isCurrent()) return null;
    if (recovered) {
      return recovered;
    } else {
      if (!canFallbackFromNativeExtraction(nativeError)) throw nativeError;
      logger.warn('[Shared Core] 原生解压不可用，回退 libarchive.js WASM 路径:', nativeError);
      const { readFileBytes } = await import('../../infrastructure/native/fileReader.js');
      if (!scope.isCurrent()) return null;
      showLoading('正在读取 GIM 文件...');
      const endRead = perfBegin('冷启动：读取 GIM 原始文件（WASM 回退）', undefined, perfSession);
      const bytes = sourceBuffer ?? (await readFileBytes(nativeFilePath, scope.isCurrent));
      if (!state.isCurrentSession(session)) return null;
      const observed = inspectGimSourceBuffer(source.fileName, bytes);
      assertGimSourceMagicStable(source.magic, observed.magic);
      endRead(undefined, { bytes: bytes.byteLength });
      const endExtract = perfBegin('解压（WASM 回退）', undefined, perfSession);
      const files = await extractGimFile(bytes);
      if (!state.isCurrentSession(session)) return null;
      endExtract('（首开）', { files: files.size });
      return {
        magic: observed.magic || source.magic,
        projectId: observed.projectId || source.projectId,
        projectName: observed.projectName || source.projectName,
        files,
      };
    }
  }
}

async function extractBrowserSource(
  { state, source, sourceBuffer }: ProjectSourceInput,
  session: ProjectLoadSession,
  perfSession: ReturnType<typeof perfCurrentSession>,
): Promise<ExtractedGimSource | null> {
  if (!sourceBuffer) throw new Error('缺少浏览器 GIM 数据');
  showLoading('正在解压 GIM 文件...');
  const endExtract = perfBegin('解压（WASM）', undefined, perfSession);
  const files = await extractGimFile(sourceBuffer);
  if (!state.isCurrentSession(session)) return null;
  endExtract('（首开）', { files: files.size });
  return {
    magic: source.magic,
    projectId: source.projectId,
    projectName: source.projectName,
    files,
  };
}

/** Resolve, read and validate the source once for the active open workflow. */
export async function acquireProjectSource(
  input: ProjectSourceInput,
  context: GimRuntimeOpenContext,
  scope: SessionScope,
): Promise<ExtractionResult> {
  const { state, source, nativeFilePath } = input;
  const { session } = context;
  if (!scope.isCurrent()) return { status: 'cancelled' };
  const perfSession = perfCurrentSession();
  let extracted = nativeFilePath
    ? await extractNativeSource(input, nativeFilePath, session, scope, perfSession)
    : await extractBrowserSource(input, session, perfSession);
  if (!extracted) return { status: 'cancelled' };
  if (!state.isCurrentSession(session)) return { status: 'cancelled' };
  if (extracted.files.size === 0) throw new Error('GIM 归档为空');

  assertGimSourceMagicStable(source.magic, extracted.magic);
  // Type detection reads CBM/DEV/FAM text. On a native manifest-only cold
  // open, doing so one File at a time can spend tens of seconds on IPC,
  // while the substation runtime would batch-hydrate the same inputs later.
  // Early semantic extraction may still be materializing: preserve its
  // independent fast path and hydrate only completed native sources here.
  if (nativeFilePath && extracted.cacheProjectId != null && !extracted.earlySemantic) {
    const endHydrate = perfBegin('工程类型判定前小文件批量物化', undefined, perfSession);
    const { hydrateNativeSmallFiles } = await import('../../services/nativeSmallFileHydration.js');
    const hydrated = await hydrateNativeSmallFiles(extracted.files, extracted.cacheProjectId, {
      isCurrent: () => state.isCurrentSession(session),
      parseCopy: extracted.parseCopy,
    });
    if (hydrated.cancelled || !state.isCurrentSession(session)) return { status: 'cancelled' };
    extracted = {
      ...extracted,
      files: hydrated.files,
      preHydrated: hydrated.requested === hydrated.hydrated,
    };
    endHydrate(undefined, {
      requested: hydrated.requested,
      hydrated: hydrated.hydrated,
      bytes: hydrated.bytes,
      batches: hydrated.batches,
      misses: hydrated.misses,
    });
  }
  context.projectName = resolveProjectName(
    extracted.projectName || source.projectName,
    extracted.projectId || source.projectId,
    source.fileName,
  );
  context.projectTypeName = getProjectTypeName(extracted.magic || source.magic);

  const detectedType = await detectSourceContent(source, extracted, context, perfSession);
  if (!scope.isCurrent()) return { status: 'cancelled' };

  const detectedRuntime = resolveGimRuntimeType('unknown', detectedType);
  if (source.runtimeType === 'unknown') {
    if (detectedType === 'hybrid') {
      logger.warn(
        '[GIM] hybrid content detected; using Substation Runtime as the diagnostic fallback',
      );
    }
  } else if (
    !(source.runtimeType === 'substation' && detectedType === 'equipment') &&
    detectedRuntime !== 'unknown' &&
    detectedRuntime !== source.runtimeType
  ) {
    logger.warn('[GIM] source magic/content type mismatch; source magic wins routing:', {
      sourceMagic: source.magic,
      sourceType: source.runtimeType,
      detectedType,
    });
  } else if (detectedType === 'hybrid') {
    logger.warn('[GIM] hybrid content detected; source magic selects the runtime');
  }

  if (!state.isCurrentSession(session)) return { status: 'cancelled' };
  return { ...extracted, status: 'ok' };
}
