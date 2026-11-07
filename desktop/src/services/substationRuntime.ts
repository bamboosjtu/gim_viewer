import { reportBackgroundError } from '../utils/backgroundErrors.js';
/** Substation cold/warm project orchestration and core semantic publication. */
import type { IfcEntry } from '../gim/types.js';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import { scanIfcFiles, discoverIfcFromCBM, buildIfcGuidIndex } from '../gim/gimIndexer.js';
import { buildCbmTree, buildCbmNodeIndex } from '../gim/cbmParser.js';
import { parseFileDevRelation } from '../gim/fileDevParser.js';
import { beginEngineeringBuild } from './engineeringService.js';
import { isTauri } from '@desktop/runtime.js';
import { DEBUG_GIM_CACHE } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { setProjectIdentity, refreshNavigatorTitle } from './presentation/shell_projectBar.js';
import type { GimRuntimeOpenContext } from './gimOpenCore.js';
import { validateGimCache, type FamPropertyPayload } from '@desktop/database.js';
import { hydrateNativeSmallFiles } from './nativeSmallFileHydration.js';
import { readSubstationSpatialSemanticCache, SUBSTATION_PARSER_DOMAIN_VERSION } from './substationSpatialSemanticCache.js';
import { SubstationBackgroundCoordinator, type SubstationBackgroundGate } from './substationBackgroundRuntime.js';
import { perfCurrentSession, perfBegin, perfMark, perfMarkProductMoment } from '../utils/perfTimings.js';
import { showLoading, hideLoading } from './gimOpenCore.js';
import { sampleSubstationMemory } from './substationRuntimeTelemetry.js';
import { collectCbmNodeCount, markSubstationCoreSemanticReady, renderSubstationCoreUi, showLoadingBeforeInteractive } from './substationPresentation.js';
import { buildAndCommitSubstationSpatialSemantic, commitCachedSubstationSpatialSemantic, scheduleSubstationSpatialSemantic } from './substationSpatialRuntime.js';
import { buildAndCommitSubstationStdSld } from './substationDocumentRuntime.js';
import { loadAllIfcFiles } from './substationIfcRuntime.js';
export { createNodeClickHandler, setupSldGridIdInteraction } from './substationPresentation.js';
export { loadAllIfcFiles } from './substationIfcRuntime.js';

interface SubstationSemanticOptions {
  sourcePublication?: Promise<unknown>;
  /**
   * The spatial IFC index is useful for the spatial navigation projection,
   * but it is not part of the minimum CBM/FAM/DEV semantic contract.  Cold
   * open uses this switch to let the core navigation start before the index
   * finishes; direct callers keep the historical await behaviour by default.
   */
  deferSpatialSemantic?: boolean;
  /**
   * Production opening supplies this callback so the deferred spatial task is
   * started by the Substation Runtime only after first interactive.  Keeping
   * the starter opaque here avoids coupling core semantic parsing to IFC
   * scheduling details.
   */
  onSpatialSemanticStart?: (start: () => Promise<boolean>) => void;
  /** Start STD/SLD parsing or cache restore only after first interactive. */
  onStdSldStart?: (start: () => Promise<boolean>) => void;
}

export async function onGimExtracted(
  state: AppState,
  files: Map<string, File>,
  showMessage: (text: string) => void,
  projectName?: string,
  projectTypeName?: string,
  session: ProjectLoadSession = state.captureProjectSession(),
  options: SubstationSemanticOptions = {},
): Promise<IfcEntry[]> {
  if (!state.isCurrentSession(session)) return [];
  const perfSession = perfCurrentSession();
  state.currentFiles = files;
  state.substationEntryPaths = [...files.keys()];
  state.projectName = projectName || '';

  // 发现 IFC 文件
  const endIfcDiscovery = perfBegin('变电 IFC discovery', undefined, perfSession);
  let ifcEntries = await discoverIfcFromCBM(files);
  if (!state.isCurrentSession(session)) return [];
  if (ifcEntries.length === 0) ifcEntries = scanIfcFiles(files);
  endIfcDiscovery(undefined, { count: ifcEntries.length });
  await sampleSubstationMemory(state, 'IFC discovery 后', perfSession, { ifcCount: ifcEntries.length });
  state.currentIfcEntries = ifcEntries;

  // 构建 CBM 层级树（F1System 根节点名称由 projectTypeName 设置，F2System 保留原始分类码并使用可读来源名称）
  const endCbmCore = perfBegin('变电 CBM/FAM/DEV/FileDevRelation', undefined, perfSession);
  const cbmTree = await buildCbmTree(files, projectTypeName);
  if (!state.isCurrentSession(session)) return [];
  if (!cbmTree) return [];
  // 解析结果先保存在局部变量；只有 await 返回后仍属于当前工程才提交。
  state.currentCbmTree = cbmTree;
  state.ifcGuidIndex = buildIfcGuidIndex(cbmTree, ifcEntries);
  state.cbmNodeIndex = buildCbmNodeIndex(cbmTree);

  // FileDevRelation 是空间资产“来源图纸”证据的一部分，必须在构建空间索引
  // 之前解析；否则 Bentley 的 DGN 设备列表和 BIMBase 的同条目 IFC 关系会
  // 被空间视图遗漏。解析失败只影响来源标注，不阻断 IFC/CBM 主流程。
  let fileDevRelations: Awaited<ReturnType<typeof parseFileDevRelation>> = [];
  try {
    fileDevRelations = await parseFileDevRelation(files);
  } catch (err) {
    // 旧工程的异常不能清空新工程已经提交的关系；失效会话直接放弃。
    if (!state.isCurrentSession(session)) return [];
    console.warn('[GIM] FileDevRelation 解析失败，保留空间/功能系统视图:', err);
  }
  if (!state.isCurrentSession(session)) return [];
  state.fileDevRelations = fileDevRelations;
  state.deviceToIfcFile.clear();
  for (const entry of fileDevRelations) {
    // DGN/非 IFC 来源的 modelId 为空，不能写入 deviceToIfcFile，避免把图纸
    // 名称误当作可加载的 IFC 模型。
    if (!entry.modelId || !/\.ifc$/i.test(entry.ifcFile)) continue;
    for (const devCbm of entry.deviceCbms) {
      state.deviceToIfcFile.set(devCbm, entry.modelId);
    }
  }
  endCbmCore(undefined, {
    cbmNodes: collectCbmNodeCount(cbmTree),
    fileDevRelations: fileDevRelations.length,
    deviceIfcLinks: state.deviceToIfcFile.size,
  });
  // 诊断采样不能阻塞首屏：冷路径上 await/同步采样曾引入约 30 s 隐性等待。
  await sampleSubstationMemory(state, 'CBM/FAM/DEV/FileDevRelation 后', perfSession, {
    cbmNodes: collectCbmNodeCount(cbmTree),
    fileDevRelations: fileDevRelations.length,
  });
  markSubstationCoreSemanticReady(state, perfSession); await renderSubstationCoreUi(state, showMessage, session, perfSession, '变电 navigation/UI（core semantic）');
  void Promise.resolve(sampleSubstationMemory(state, 'coreSemanticReady', perfSession, {
    source: 'cold',
    cbmNodes: collectCbmNodeCount(cbmTree),
    ifcEntries: ifcEntries.length,
    fileDevRelations: fileDevRelations.length,
  })).catch(reportBackgroundError);

  let spatialSemanticPromise: Promise<boolean> | null = null;
  const startSpatialSemantic = (): Promise<boolean> => {
    if (!spatialSemanticPromise) {
      spatialSemanticPromise = buildAndCommitSubstationSpatialSemantic(
        state,
        files,
        ifcEntries,
        cbmTree,
        fileDevRelations,
        session,
        perfSession,
        showMessage,
        '变电 IFC 空间索引',
      );
    }
    return spatialSemanticPromise;
  };
  void Promise.resolve(beginEngineeringBuild(state, files, { beforeCacheWrite: options.sourcePublication, ensureIfcSemantics: startSpatialSemantic })).catch(reportBackgroundError);
  if (options.deferSpatialSemantic) {
    // The entity build and the legacy scene path share this idempotent starter.
    // Source normalization can request semantics before geometry readiness;
    // neither caller starts a second IFC semantic parser.
    options.onSpatialSemanticStart?.(startSpatialSemantic);
  } else {
    // Preserve the historical direct-call contract: callers that do not opt
    // into deferred spatial semantic receive completion before returning.
    await startSpatialSemantic();
  }

  let stdSldPromise: Promise<boolean> | null = null;
  const startStdSld = (): Promise<boolean> => {
    if (!stdSldPromise) {
      stdSldPromise = buildAndCommitSubstationStdSld(
        state,
        files,
        [],
        session,
        perfSession,
        showMessage,
        'cold',
      );
    }
    return stdSldPromise;
  };
  if (options.onStdSldStart) {
    // Production passes this starter to loadAllIfcFiles.  Registering it is
    // deliberately side-effect free before first interactive.
    options.onStdSldStart(startStdSld);
  } else if (!options.deferSpatialSemantic) {
    // Preserve the direct-call contract for callers that do not use the
    // deferred Runtime opening path.
    await startStdSld();
  }

  return ifcEntries;
}

/** 从 ArrayBuffer 加载 GIM 文件的完整流程（浏览器和 Tauri 共用，不创建 Viewer） */


/**
 * Substation Runtime owns the CBM/IFC/Fragments/DEV/MOD/STL lifecycle.
 * The Shared Core has already inspected the source and activated the session.
 */


/** Semantic publication keeps original FAM rows available to source tools;
 * it does not launch or invalidate the retired business-tree projection. */
function publishFamSourceRows(state: AppState, rows: readonly FamPropertyPayload[]): void {
  const families = new Map<string, import('../gim/famParser.js').FamSourceProperty[]>();
  for (const row of rows) if (row.raw_property_json) {
    try { const list = families.get(row.source_path) ?? []; list.push(JSON.parse(row.raw_property_json)); families.set(row.source_path, list); }
    catch { /* The original database row remains available; malformed JSON is not semantic evidence. */ }
  }
  state.cachedFamSourceProperties = families;
}

export async function openSubstationProject(context: GimRuntimeOpenContext): Promise<void> {
  const { state, session, showMessage } = context;
  const perfSession = perfCurrentSession();
  let validation: Awaited<ReturnType<typeof validateGimCache>> | null = null;

  if (context.projectId != null && isTauri()) {
    showLoading('正在检查本地缓存...');
    const endValidation = perfBegin('变电缓存校验（快速路径）', undefined, perfSession);
    try {
      validation = await validateGimCache(context.projectId, 'substation');
      endValidation(undefined, {
        valid: validation.valid,
        missReason: validation.cache_miss_reason,
        ifcEntries: validation.ifc_entry_count,
        cachedIfc: validation.cached_ifc_count,
        geometryManifest: validation.geometry_cache_manifest_valid,
        geometryVersion: validation.geometry_cache_version_file_match,
      });
    } catch (error) {
      endValidation('（失败）', { error: error instanceof Error ? error.message : String(error) });
      console.warn('[Substation Runtime] cache validation failed, falling back to cold path:', error);
    }
    if (!state.isCurrentSession(session)) return;
  }

  if (!validation?.valid) showLoading('正在解压并校验 GIM 文件...');

  if (validation?.valid) {
    try {
      const { getGimIndex } = await import('@desktop/database.js');
      // 变电工程缓存命中 → 恢复 GIM 索引（原有逻辑）
      state.currentProjectType = 'substation';
      setProjectIdentity(context.projectName || null, 'substation');
      refreshNavigatorTitle();

      showLoading('正在从本地缓存恢复 GIM 索引...');
      const { restoreGimIndexToState } = await import('./gimIndexRestoreService.js');

      const endRestoreCore = perfBegin('变电 CBM/FAM/DEV/FileDevRelation（缓存命中）', undefined, perfSession);
      const index = await getGimIndex(context.projectId!);
      if (!state.isCurrentSession(session)) return;
      restoreGimIndexToState(state, index);
      const { createDiskBackedFile: createEngineeringSourceFile } = await import('@desktop/gimExtract.js');
      if (!state.isCurrentSession(session)) return;
      const engineeringFiles = new Map(index.entries.map(entry => [entry.entry_path,
      createEngineeringSourceFile(context.projectId!, entry.entry_path, entry.file_size)]));
      endRestoreCore(undefined, {
        entries: index.entries.length,
        cbmNodes: index.cbm_nodes.length,
        ifcModels: index.ifc_models.length,
        fileDevRelations: index.file_dev_entries.length,
        famProperties: index.fam_properties.length,
        devProperties: index.dev_properties.length,
      });
      await sampleSubstationMemory(state, 'CBM/FAM/DEV/FileDevRelation 后（缓存命中）', perfSession, {
        cbmNodes: index.cbm_nodes.length,
        fileDevRelations: index.file_dev_entries.length,
      });
      // 工程身份已在清理后激活，确保首个 IFC/几何 await 期间也使用正确 project_id。

      debugLog(DEBUG_GIM_CACHE, '[Restore Debug]', {
        indexCounts: {
          entries: index.entries.length,
          cbmNodes: index.cbm_nodes.length,
          ifcModels: index.ifc_models.length,
          fileDevEntries: index.file_dev_entries.length,
          famProperties: index.fam_properties.length,
          devProperties: index.dev_properties.length,
        },
        stateCounts: {
          currentIfcEntries: state.currentIfcEntries.length,
          currentCbmTree: state.currentCbmTree?.path || null,
          cachedIfcPaths: state.cachedIfcPaths.size,
          fileDevRelations: state.fileDevRelations.length,
          cbmNodeIndex: state.cbmNodeIndex.size,
          deviceToIfcFile: state.deviceToIfcFile.size,
        },
      });

      debugLog(DEBUG_GIM_CACHE, '[Tauri] 已从缓存恢复 GIM:', {
        project_id: context.projectId!,
        ifc_entries: state.currentIfcEntries.length,
        cbm_root: state.currentCbmTree?.path || null,
        cached_ifc_paths: state.cachedIfcPaths.size,
        file_dev_relations: state.fileDevRelations.length,
      });

      if (!state.currentCbmTree) {
        throw new Error('缓存索引中没有 CBM 层级树');
      }

      if (state.fileDevRelations.length === 0) {
        console.warn('[Tauri] 缓存索引中没有文件设备关系');
      }

      // Core navigation is available before optional IFC semantics. Entity
      // construction and scene navigation share one semantic restore/build.
      markSubstationCoreSemanticReady(state, perfSession, { cacheHit: true });
      await renderSubstationCoreUi(state, showMessage, session, perfSession, '变电 navigation/UI（core semantic，缓存命中）');
      if (!state.isCurrentSession(session)) return;
      void Promise.resolve(sampleSubstationMemory(state, 'coreSemanticReady', perfSession, {
        source: 'warm',
        cacheHit: true,
        cbmNodes: state.currentCbmTree ? collectCbmNodeCount(state.currentCbmTree) : 0,
        ifcEntries: state.currentIfcEntries.length,
        fileDevRelations: state.fileDevRelations.length,
      })).catch(reportBackgroundError);

      const cbmTree = state.currentCbmTree;
      if (!cbmTree) throw new Error('缓存索引中没有 CBM 层级树');
      const fileDevRelations = state.fileDevRelations.slice();
      const cachedIfcEntries = state.currentIfcEntries.slice();
      const { createDiskBackedFile } = await import('@desktop/gimExtract.js');
      const cachedIfcFiles = new Map<string, File>();
      for (const cachedEntry of index.entries) {
        if (!/^ifc$/i.test(cachedEntry.entry_type)) continue;
        cachedIfcFiles.set(
          cachedEntry.entry_path,
          createDiskBackedFile(context.projectId!, cachedEntry.entry_path, cachedEntry.file_size),
        );
      }

      let sourceSpatialPromise: Promise<boolean> | undefined;
      const startSourceSpatial = (): Promise<boolean> => sourceSpatialPromise ??= (async () => {
        if (!state.isCurrentSession(session)) return false;
        if (state.substationSpatialIndex) return true;
        const cached = await readSubstationSpatialSemanticCache(session.projectId, session.sourceSha256, SUBSTATION_PARSER_DOMAIN_VERSION);
        if (!state.isCurrentSession(session)) return false;
        if (cached.hit) return commitCachedSubstationSpatialSemantic(state, cached, session, perfSession, showMessage);
        return buildAndCommitSubstationSpatialSemantic(state, cachedIfcFiles, cachedIfcEntries, cbmTree, fileDevRelations,
          session, perfSession, showMessage, '变电 IFC 来源语义（缓存重建）',
          { projectId: session.projectId, sourceSha256: session.sourceSha256, cacheMissReason: cached.reason });
      })();
      void Promise.resolve(beginEngineeringBuild(state, engineeringFiles, { ensureIfcSemantics: startSourceSpatial })).catch(reportBackgroundError);

      const cachedStdSldEntryPaths = index.entries.map((entry) => entry.entry_path);
      // STD/SLD restore is a feature-local background task.  A missing or
      // stale STD/SLD cache must not discard an otherwise valid IFC cache hit;
      // the helper records the degradation and clears only that projection.
      const startStdSld = (): Promise<boolean> => buildAndCommitSubstationStdSld(
        state,
        null,
        cachedStdSldEntryPaths,
        session,
        perfSession,
        showMessage,
        'warm',
      );
      const scheduleSpatialSemantic = (coordinator: SubstationBackgroundCoordinator, gate: SubstationBackgroundGate): void => {
        scheduleSubstationSpatialSemantic(
          coordinator,
          state,
          cachedIfcFiles,
          cachedIfcEntries,
          cbmTree,
          fileDevRelations,
          session,
          perfSession,
          showMessage,
          '变电 IFC 空间索引（缓存命中）',
          gate,
          startSourceSpatial,
        );
      };
      const scheduleStdSld = (coordinator: SubstationBackgroundCoordinator): void => {
        coordinator.enqueue({
          task: 'stdSld',
          priority: 2,
          heavy: false,
          startAfter: 'interactive',
          run: async () => {
            const ready = await startStdSld();
            if (!ready && state.isCurrentSession(session)) {
              throw new Error('STD/SLD 未生成可用结果');
            }
          },
        });
      };

      // GIM 视为整体：直接加载全部 IFC + MOD + STL，不弹选择框
      // loadAllIfcFiles 内部会创建 ViewerRuntime、加载 IFC、渲染树、触发 MOD/STL
      if (cachedIfcEntries.length === 0) {
        state.endIfcBackgroundLoading();
        const { startGeometryOnlyView } = await import('./equipmentRuntime.js');
        if (!state.isCurrentSession(session)) return;
        await startGeometryOnlyView(context);
        if (state.isCurrentSession(session)) void startStdSld().catch(reportBackgroundError);
      } else await loadAllIfcFiles(state, cachedIfcEntries, showMessage, {
        session,
        ifcSourceSizes: new Map([...cachedIfcFiles].map(([path, file]) => [path.toLowerCase(), file.size])),
        startStdSld,
        scheduleSpatialSemantic,
        scheduleStdSld,
        geometryCacheValid: validation.geometry_cache_valid ?? validation.geometry_cache_version_match,
        geometryCacheManifestValid: validation.geometry_cache_manifest_valid,
        geometryCacheVersionFileMatch: validation.geometry_cache_version_file_match,
      });
      debugLog(DEBUG_GIM_CACHE, '[Tauri] 变电工程缓存命中：自动加载全部 IFC + MOD + STL');
      if (validation?.substation_properties_complete === false && context.projectId != null) {
        // 两阶段发布的第二阶段可能在上次会话被中断：树/IFC 已可暖用，
        // 这里用已解压源在后台补写属性与几何引用，完成后置为已发布。
        const projectId = context.projectId;
        void Promise.resolve((async () => {
          const { publishSubstationRest } = await import('./substationIndexPublication.js');
          const { saveSubstationSemanticRest } = await import('@desktop/database.js');
          const { createCachePublishStatus } = await import('./cachePublishStatus.js');
          const publication = createCachePublishStatus(() => state.isCurrentSession(session));
          state.sessionDisposables.add(publication.resetCachePublishStatus);
          const { beginCachePublish, setCachePublishPhase, failCachePublish } = publication;
          const { createDiskBackedFile } = await import('@desktop/gimExtract.js');
          const files = new Map<string, File>();
          for (const entry of index.entries) {
            files.set(entry.entry_path, createDiskBackedFile(projectId, entry.entry_path, entry.file_size));
          }
          beginCachePublish('rest', '上次会话未完成属性补写');
          try {
            const published = await publishSubstationRest({
              projectId, sourceSha256: session.sourceSha256 ?? '', files,
              cachePaths: new Map(), tree: state.currentCbmTree,
              ifcs: state.currentIfcEntries, relations: state.fileDevRelations,
            }, {
              isCurrent: () => state.isCurrentSession(session),
              saveRest: saveSubstationSemanticRest,
              onPublished: payload => publishFamSourceRows(state, payload.fam_properties),
              onPhase: (phase, counts) => perfMark(`变电 semantic repair · ${phase}`, { projectId, ...counts }, perfSession),
            });
            if (published && state.isCurrentSession(session)) setCachePublishPhase('ready');
            else if (state.isCurrentSession(session)) failCachePublish('属性补写未完成');
          } catch (error) {
            if (state.isCurrentSession(session)) {
              failCachePublish(error instanceof Error ? error.message : String(error));
            }
          }
        })()).catch(reportBackgroundError);
      }
      return; // 缓存命中，短路完成
    } catch (err) {
      if (!state.isCurrentSession(session)) return;
      console.warn('[Substation Runtime] warm cache restore failed, falling back to cold path:', err);
    }
  }

  const extractedSource = await context.getExtracted();
  if (extractedSource.status === 'cancelled') return;
  if (!state.isCurrentSession(session)) return;
  if (extractedSource.projectType === 'equipment') {
    const { openEquipmentProject } = await import('./equipmentRuntime.js');
    if (state.isCurrentSession(session)) await openEquipmentProject(context);
    return;
  }
  let extracted = extractedSource.files;
  if (extractedSource.cacheProjectId != null) {
    const endHydrate = perfBegin('变电小文件批量物化', undefined, perfSession);
    const hydrated = await hydrateNativeSmallFiles(
      extracted,
      extractedSource.cacheProjectId,
      { isCurrent: () => state.isCurrentSession(session), parseCopy: extractedSource.parseCopy },
    );
    if (hydrated.cancelled || !state.isCurrentSession(session)) return;
    extracted = hydrated.files;
    endHydrate(undefined, {
      requested: hydrated.requested,
      hydrated: hydrated.hydrated,
      bytes: hydrated.bytes,
      batches: hydrated.batches,
      misses: hydrated.misses,
    });
  }
  state.currentProjectType = 'substation';
  setProjectIdentity(context.projectName || null, 'substation');
  refreshNavigatorTitle();

  // Cold path: CBM/FAM/DEV/FileDevRelation and IFC discovery stay entirely in
  // this Runtime. The parser implementation is unchanged; only ownership moved.
  showLoading('正在解析 GIM 层级结构...');
  let startSpatialSemantic: (() => Promise<boolean>) | undefined;
  let startStdSld: (() => Promise<boolean>) | undefined;
  const entries = await onGimExtracted(
    state,
    extracted,
    showMessage,
    context.projectName,
    context.projectTypeName,
    session,
    {
      deferSpatialSemantic: true,
      sourcePublication: extractedSource.sourceMaterialization,
      onSpatialSemanticStart: (start) => {
        startSpatialSemantic = start;
      },
      onStdSldStart: (start) => {
        startStdSld = start;
      },
    },
  );
  if (!state.isCurrentSession(session)) return;
  if (entries.length === 0 && !state.currentCbmTree) {
    showLoading('该工程没有可用的 CBM 模型入口或 IFC 文件');
    setTimeout(() => { if (state.isCurrentSession(session)) hideLoading(); }, 4000);
    return;
  }

  const preExtracted = extractedSource;
  const persistProjectId = context.projectId != null && isTauri() ? context.projectId : null;
  // 异步持久化只使用本次打开捕获的不可变输入，避免切换工程后读取新 state。
  const filesForPersist = extracted;
  const ifcEntriesForPersist = entries.slice();
  const cbmTreeForPersist = state.currentCbmTree;
  const fileDevRelationsForPersist = state.fileDevRelations.slice();
  let persistPromise: Promise<void> | null = null;
  const startCachePersistence = (): Promise<void> => {
    if (persistPromise) return persistPromise;
    perfMarkProductMoment('cachePersistenceStart', {
      enabled: persistProjectId != null,
      projectId: persistProjectId,
    }, perfSession);
    const persistTask =
      persistProjectId != null
        ? (async () => {
          const projectId = persistProjectId;
          // Early session sources are never a published source cache or a v26 receipt.
          await preExtracted.sourceMaterialization;
          if (!state.isCurrentSession(session)) return;
          let localCachePathMap = new Map<string, string>();
          if (!state.isCurrentSession(session)) return;

          if (preExtracted && preExtracted.cachePaths && preExtracted.cachePaths.size > 0) {
            // 原生解压已由 Rust 直接落盘全部条目——直接复用路径，
            // 跳过逐文件 IPC 字节回传（writeCacheFile Array.from 路径会
            // 把数百 MB IFC 序列化为 JSON 数组，主线程长时间假死）
            localCachePathMap = preExtracted.cachePaths ?? localCachePathMap;
            debugLog(DEBUG_GIM_CACHE, '[Tauri] 原生解压已落盘缓存文件:', {
              cached: localCachePathMap.size,
            });
          } else {
            // WASM 回退路径：逐文件 IPC 字节回传（慢，仅作兜底）
            showLoadingBeforeInteractive('正在缓存 IFC 文件...');
            try {
              const { cacheIfcEntries } = await import('./gimExtractedCacheService.js');
              const cacheResult = await cacheIfcEntries(
                projectId,
                filesForPersist,
                ifcEntriesForPersist,
              );
              if (!state.isCurrentSession(session)) return;
              localCachePathMap = cacheResult.pathMap;
              debugLog(DEBUG_GIM_CACHE, '[Tauri] IFC 缓存结果:', {
                expected: ifcEntriesForPersist.length,
                cached: localCachePathMap.size,
                errors: cacheResult.errors,
              });
              if (cacheResult.errors.length > 0) {
                console.warn('[Tauri] 部分 IFC 缓存失败:', cacheResult.errors);
              }
            } catch (err) {
              console.error('[Tauri] IFC 文件缓存失败:', err);
            }

            // WASM 回退把全部原始条目持久化，避免只缓存已知扩展名
            // 造成索引清单与可恢复来源不一致。
            if (filesForPersist) {
              showLoadingBeforeInteractive('正在缓存 GIM 来源文件...');
              try {
                const { cacheExtractedFiles } = await import('./gimExtractedCacheService.js');
                const geoCacheResult = await cacheExtractedFiles(
                  projectId,
                  filesForPersist,
                  localCachePathMap,
                );
                if (!state.isCurrentSession(session)) return;
                debugLog(DEBUG_GIM_CACHE, '[Tauri] 来源文件缓存结果:', {
                  cached: geoCacheResult.cachedCount,
                  errors: geoCacheResult.errors,
                });
                for (const [path, localPath] of geoCacheResult.pathMap) localCachePathMap.set(path, localPath);
                if (geoCacheResult.errors.length > 0) {
                  console.warn('[Tauri] 部分来源文件缓存失败:', geoCacheResult.errors);
                }
              } catch (err) {
                console.error('[Tauri] 来源文件缓存失败:', err);
              }
            }
          }

          if (!state.isCurrentSession(session)) return;
          const { publishSubstationCore, publishSubstationRest } = await import('./substationIndexPublication.js');
          const { saveGimIndex, saveGeometryRefs, saveSubstationSemanticRest, validateGimCache } = await import('@desktop/database.js');
          const { createCachePublishStatus } = await import('./cachePublishStatus.js');
          const publication = createCachePublishStatus(() => state.isCurrentSession(session));
          state.sessionDisposables.add(publication.resetCachePublishStatus);
          const { beginCachePublish, setCachePublishPhase, failCachePublish } = publication;
          const publicationInput = {
            projectId, sourceSha256: session.sourceSha256 ?? '', files: filesForPersist,
            cachePaths: localCachePathMap, packedPaths: preExtracted.packedPaths,
            tree: cbmTreeForPersist,
            ifcs: ifcEntriesForPersist, relations: fileDevRelationsForPersist,
          };
          const isCurrent = () => state.isCurrentSession(session);
          const onPhase = (phase: string, counts?: Record<string, number>) =>
            perfMark(`变电 semantic persistence · ${phase}`, { projectId, ...counts }, perfSession);
          // 第一阶段：内存中的树/关系/IFC 清单 + receipt，交互后数秒内提交，
          // 让暖启动立即可用；第二阶段再补写 FAM/DEV 属性与几何引用。
          if (!isCurrent()) return;
          beginCachePublish('core');
          let corePublished = false;
          try {
            corePublished = await publishSubstationCore(publicationInput, {
              isCurrent,
              saveIndex: saveGimIndex,
              saveRefs: saveGeometryRefs,
              validate: () => validateGimCache(projectId, 'substation'),
              onPhase,
            });
          } catch (error) {
            if (!isCurrent()) { failCachePublish('会话已切换'); return; }
            failCachePublish(error instanceof Error ? error.message : String(error));
            throw error;
          }
          if (!corePublished || !isCurrent()) {
            if (!isCurrent()) failCachePublish('会话已切换');
            return;
          }
          setCachePublishPhase('rest');
          try {
            const restPublished = await publishSubstationRest(publicationInput, {
              isCurrent,
              saveRest: saveSubstationSemanticRest,
              onPublished: payload => publishFamSourceRows(state, payload.fam_properties),
              onPhase,
            });
            if (restPublished && isCurrent()) setCachePublishPhase('ready');
            else if (isCurrent()) failCachePublish('属性补写未完成');
          } catch (error) {
            if (isCurrent()) failCachePublish(error instanceof Error ? error.message : String(error));
            throw error;
          }
        })()
        : Promise.resolve();
    persistPromise = persistTask
      .then(() => {
        if (!state.isCurrentSession(session)) return;
        perfMarkProductMoment('cachePersistenceReady', {
          enabled: persistProjectId != null,
          projectId: persistProjectId,
        }, perfSession);
      })
      .catch((err) => {
        if (state.isCurrentSession(session)) {
          perfMarkProductMoment('cachePersistenceReady', {
            enabled: persistProjectId != null,
            projectId: persistProjectId,
            available: false,
            error: err instanceof Error ? err.message : String(err),
          }, perfSession);
        }
        console.error('[Tauri] 缓存/索引入库后台任务失败:', err);
      });
    return persistPromise;
  };

  const scheduleSpatialSemantic = (coordinator: SubstationBackgroundCoordinator, gate: SubstationBackgroundGate): void => {
    const cbmTree = state.currentCbmTree;
    if (!cbmTree) return;
    scheduleSubstationSpatialSemantic(
      coordinator,
      state,
      extracted,
      entries,
      cbmTree,
      fileDevRelationsForPersist,
      session,
      perfSession,
      showMessage,
      '变电 IFC 空间索引',
      gate,
    );
  };
  const scheduleStdSld = (coordinator: SubstationBackgroundCoordinator): void => {
    if (!startStdSld) return;
    const starter = startStdSld;
    coordinator.enqueue({
      task: 'stdSld',
      priority: 2,
      heavy: false,
      startAfter: 'interactive',
      run: async () => { await starter(); },
    });
  };
  const scheduleCachePersistence = (coordinator: SubstationBackgroundCoordinator, _gate: SubstationBackgroundGate): void => {
    coordinator.enqueue({
      task: 'cachePersistence',
      priority: 10,
      heavy: !preExtracted?.cachePaths?.size,
      startAfter: 'interactive',
      run: async () => { await startCachePersistence(); },
    });
  };

  // Native extraction already atomically finished source files on disk. The
  // small semantic/reference transactions do not depend on DEV.
  if (persistProjectId != null && preExtracted?.cachePaths?.size) {
    void Promise.resolve(startCachePersistence()).catch(reportBackgroundError);
  }

  if (entries.length === 0) {
    // A project represented entirely by DEV has the same semantic publication
    // contract. Rendering remains independent of background cache completion.
    void startCachePersistence().catch(reportBackgroundError);
    state.endIfcBackgroundLoading();
    const { startGeometryOnlyView } = await import('./equipmentRuntime.js');
    if (!state.isCurrentSession(session)) return;
    await startGeometryOnlyView(context);
    if (state.isCurrentSession(session) && startStdSld) void startStdSld().catch(reportBackgroundError);
    return;
  }

  // GIM 视为整体：直接加载全部 IFC + MOD + STL，不弹选择框。
  // loadAllIfcFiles 在首个可用 IFC 后返回；剩余 IFC、几何和这里的缓存
  // 持久化都继续作为当前 session 的后台工作，不重新成为 interactive barrier。
  await loadAllIfcFiles(state, entries, showMessage, {
    session,
    startSpatialSemantic,
    startStdSld,
    startCachePersistence,
    scheduleSpatialSemantic,
    scheduleStdSld,
    scheduleCachePersistence,
  });
}
