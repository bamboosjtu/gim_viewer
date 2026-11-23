import { logger } from '../../../utils/logger.js';
import { reportBackgroundError } from '../../../utils/backgroundErrors.js';
import { beginEngineeringBuild } from '../../../services/engineering/engineeringService.js';
import { isTauri } from '@desktop/runtime.js';
import { DEBUG_GIM_CACHE } from '../../../config/debug.js';
import { debugLog } from '../../../utils/logger.js';
import {
  setProjectIdentity,
  refreshNavigatorTitle,
} from '../../../services/presentation/shell_projectBar.js';
import type { GimRuntimeOpenContext } from '../../../services/project/gimOpenCore.js';
import type { validateGimCache } from '@desktop/database.js';
import { hydrateNativeSmallFiles } from '../../../services/project/nativeSmallFileHydration.js';
import {
  SubstationBackgroundCoordinator,
  type SubstationBackgroundGate,
} from '../runtime/substationBackgroundRuntime.js';
import { perfBegin, perfMark } from '../../../utils/perfTimings.js';
import { showLoading, hideLoading } from '../../../services/project/gimOpenCore.js';
import {
  createWarmSpatialSemanticStarter,
  scheduleSubstationSpatialSemantic,
} from '../runtime/spatial/substationSpatialWorkflow.js';
import { buildAndCommitSubstationStdSld } from '../runtime/substationDocumentRuntime.js';
import { loadAllIfcFiles } from '../runtime/substationIfcRuntime.js';
import { publishSubstationWarmCore } from '../runtime/substationWarmCore.js';
import { releaseWarmIfcAttempt } from '../runtime/substationWarmAttempt.js';
import type { SessionScope } from '../../../shared/sessionScope.js';
import type { PerfSession } from '../../../utils/perfTimings.js';
import { onGimExtracted } from './substationColdSource.js';
import {
  prepareSubstationColdPersistence,
  publishFamSourceRows,
} from './substationColdPersistence.js';

export async function openSubstationCold(
  context: GimRuntimeOpenContext,
  scope: SessionScope,
  perfSession: PerfSession,
): Promise<'equipment' | void> {
  const { state, session, showMessage } = context;
  const extractedSource = await scope.read(async () => context.getExtracted());
  if (extractedSource.status === 'cancelled') return;

  if (extractedSource.projectType === 'equipment') return 'equipment';
  let extracted = extractedSource.files;
  if (extractedSource.cacheProjectId != null && !extractedSource.preHydrated) {
    const endHydrate = perfBegin('变电小文件批量物化', undefined, perfSession);
    const hydrated = await scope.read(async () =>
      hydrateNativeSmallFiles(extracted, extractedSource.cacheProjectId, {
        isCurrent: () => scope.isCurrent(),
        parseCopy: extractedSource.parseCopy,
      }),
    );
    if (hydrated.cancelled || !scope.isCurrent()) return;
    extracted = hydrated.files;
    endHydrate(undefined, {
      requested: hydrated.requested,
      hydrated: hydrated.hydrated,
      bytes: hydrated.bytes,
      batches: hydrated.batches,
      misses: hydrated.misses,
    });
  }
  scope.withSession(() => {
    state.currentProjectType = 'substation';
    setProjectIdentity(context.projectName || null, 'substation');
    refreshNavigatorTitle();
  });

  // Cold path: CBM/FAM/DEV/FileDevRelation and IFC discovery stay entirely in
  // this Runtime. The parser implementation is unchanged; only ownership moved.
  scope.withSession(() => {
    showLoading('正在解析 GIM 层级结构...');
  });
  let startSpatialSemantic: (() => Promise<boolean>) | undefined;
  let startStdSld: (() => Promise<boolean>) | undefined;
  const entries = await scope.read(async () =>
    onGimExtracted(
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
    ),
  );

  if (entries.length === 0 && !state.currentCbmTree) {
    scope.withSession(() => {
      showLoading('该工程没有可用的 CBM 模型入口或 IFC 文件');
    });
    setTimeout(() => {
      if (scope.isCurrent())
        scope.withSession(() => {
          hideLoading();
        });
    }, 4000);
    return;
  }

  const preExtracted = extractedSource;
  const persistProjectId = context.projectId != null && isTauri() ? context.projectId : null;
  const fileDevRelationsForPersist = state.fileDevRelations.slice();
  const startCachePersistence = prepareSubstationColdPersistence({
    state,
    scope,
    session,
    perfSession,
    preExtracted,
    persistProjectId,
    filesForPersist: extracted,
    ifcEntriesForPersist: entries.slice(),
    cbmTreeForPersist: state.currentCbmTree,
    fileDevRelationsForPersist,
  });

  const scheduleSpatialSemantic = (
    coordinator: SubstationBackgroundCoordinator,
    gate: SubstationBackgroundGate,
  ): void => {
    const cbmTree = state.currentCbmTree;
    if (!cbmTree) return;
    scheduleSubstationSpatialSemantic(
      coordinator,
      {
        state,
        files: extracted,
        ifcEntries: entries,
        cbmTree,
        fileDevRelations: fileDevRelationsForPersist,
        session,
        perfSession,
        showMessage,
      },
      '变电 IFC 空间索引',
      gate,
      startSpatialSemantic,
    );
  };
  const scheduleStdSld = (
    coordinator: SubstationBackgroundCoordinator,
    gate: SubstationBackgroundGate = 'interactive',
  ): void => {
    if (!startStdSld) return;
    const starter = startStdSld;
    coordinator.enqueue({
      task: 'stdSld',
      priority: 2,
      heavy: false,
      startAfter: gate,
      run: async () => {
        await scope.read(async () => starter());
      },
    });
  };
  const scheduleCachePersistence = (
    coordinator: SubstationBackgroundCoordinator,
    gate: SubstationBackgroundGate,
  ): void => {
    coordinator.enqueue({
      task: 'cachePersistence',
      priority: 10,
      heavy: !preExtracted?.cachePaths?.size,
      startAfter: gate,
      run: async () => {
        await scope.read(async () => startCachePersistence());
      },
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
    scope.withSession(() => {
      state.ifcLoading.pending = false;
    });
    const { startGeometryOnlyView } = await scope.read(
      async () => import('../../../services/dev-geometry/geometryOnlyRuntime.js'),
    );

    await scope.read(async () => startGeometryOnlyView(context));
    if (scope.isCurrent() && startStdSld) void startStdSld().catch(reportBackgroundError);
    return;
  }

  // GIM 视为整体：直接加载全部 IFC + MOD + STL，不弹选择框。
  // loadAllIfcFiles 在首个可用 IFC 后返回；剩余 IFC、几何和这里的缓存
  // 持久化都继续作为当前 session 的后台工作，不重新成为 interactive barrier。
  await scope.read(async () =>
    loadAllIfcFiles(state, entries, showMessage, {
      session,
      startSpatialSemantic,
      startStdSld,
      startCachePersistence,
      scheduleSpatialSemantic,
      scheduleStdSld,
      scheduleCachePersistence,
    }),
  );
}

export async function tryOpenSubstationWarm(
  context: GimRuntimeOpenContext,
  scope: SessionScope,
  perfSession: PerfSession,
  validation: Awaited<ReturnType<typeof validateGimCache>>,
): Promise<boolean> {
  const { state, session, showMessage } = context;

  let warmCorePublished = false;
  try {
    const warm = await publishSubstationWarmCore(context, showMessage, perfSession, validation);
    warmCorePublished = true;
    const { index, engineeringFiles, cbmTree, fileDevRelations, cachedIfcEntries } = warm;
    const { createDiskBackedFile } = await scope.read(
      async () => import('../../../infrastructure/native/gimExtract.js'),
    );
    const cachedIfcFiles = new Map<string, File>();
    for (const cachedEntry of index.entries) {
      if (!/^ifc$/i.test(cachedEntry.entry_type)) continue;
      cachedIfcFiles.set(
        cachedEntry.entry_path,
        createDiskBackedFile(
          context.projectId!,
          cachedEntry.entry_path,
          cachedEntry.file_size,
          false,
          scope.isCurrent,
        ),
      );
    }

    const spatialInput = {
      state,
      files: cachedIfcFiles,
      ifcEntries: cachedIfcEntries,
      cbmTree,
      fileDevRelations,
      session,
      perfSession,
      showMessage,
    };
    const sourceSpatial = createWarmSpatialSemanticStarter(spatialInput, scope);
    const startSourceSpatial = sourceSpatial.complete;
    scope.withSession(() => {
      void Promise.resolve(
        beginEngineeringBuild(state, engineeringFiles, {
          ensureIfcSemantics: sourceSpatial.ready,
        }),
      ).catch(reportBackgroundError);
    });

    const startStdSld = (): Promise<boolean> =>
      buildAndCommitSubstationStdSld(
        state,
        engineeringFiles,
        session,
        perfSession,
        showMessage,
        'warm',
      );
    const scheduleSpatialSemantic = (
      coordinator: SubstationBackgroundCoordinator,
      gate: SubstationBackgroundGate,
    ): void => {
      scheduleSubstationSpatialSemantic(
        coordinator,
        spatialInput,
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
          const ready = await scope.read(async () => startStdSld());
          if (!ready && scope.isCurrent()) {
            throw new Error('STD/SLD 未生成可用结果');
          }
        },
      });
    };

    // GIM 视为整体：直接加载全部 IFC + MOD + STL，不弹选择框
    // loadAllIfcFiles 内部会创建 ViewerRuntime、加载 IFC、渲染树、触发 MOD/STL
    if (cachedIfcEntries.length === 0) {
      scope.withSession(() => {
        state.ifcLoading.pending = false;
      });
      const { startGeometryOnlyView } = await scope.read(
        async () => import('../../../services/dev-geometry/geometryOnlyRuntime.js'),
      );

      await scope.read(async () => startGeometryOnlyView(context));
      if (scope.isCurrent()) void startStdSld().catch(reportBackgroundError);
    } else
      await scope.read(async () =>
        loadAllIfcFiles(state, cachedIfcEntries, showMessage, {
          session,
          ifcSourceSizes: new Map(
            [...cachedIfcFiles].map(([path, file]) => [path.toLowerCase(), file.size]),
          ),
          startStdSld,
          scheduleSpatialSemantic,
          scheduleStdSld,
        }),
      );
    debugLog(DEBUG_GIM_CACHE, '[Tauri] 变电工程缓存命中：自动加载全部 IFC + MOD + STL');
    if (validation?.substation_properties_complete === false && context.projectId != null) {
      // 两阶段发布的第二阶段可能在上次会话被中断：树/IFC 已可暖用，
      // 这里用已解压源在后台补写属性与几何引用，完成后置为已发布。
      const projectId = context.projectId;
      void Promise.resolve(
        (async () => {
          const { publishSubstationRest } = await scope.read(
            async () => import('../runtime/substationIndexPublication.js'),
          );
          const { saveSubstationSemanticRest } = await scope.read(
            async () => import('@desktop/database.js'),
          );
          const { createCachePublishStatus } = await scope.read(
            async () => import('../../../services/project/cachePublishStatus.js'),
          );
          const publication = createCachePublishStatus(() => scope.isCurrent());
          scope.own(publication.resetCachePublishStatus);
          const { beginCachePublish, setCachePublishPhase, failCachePublish } = publication;
          const { createDiskBackedFile } = await scope.read(
            async () => import('../../../infrastructure/native/gimExtract.js'),
          );
          const files = new Map<string, File>();
          for (const entry of index.entries) {
            files.set(
              entry.entry_path,
              createDiskBackedFile(
                projectId,
                entry.entry_path,
                entry.file_size,
                false,
                scope.isCurrent,
              ),
            );
          }
          beginCachePublish('rest', '上次会话未完成属性补写');
          try {
            const published = await scope.read(async () =>
              publishSubstationRest(
                {
                  projectId,
                  sourceSha256: session.sourceSha256 ?? '',
                  files,
                  cachePaths: new Map(),
                  tree: state.currentCbmTree,
                  ifcs: state.currentIfcEntries,
                  relations: state.fileDevRelations,
                },
                {
                  isCurrent: () => scope.isCurrent(),
                  saveRest: saveSubstationSemanticRest,
                  onPublished: (payload) => {
                    scope.withSession(() => {
                      publishFamSourceRows(state, payload.fam_properties);
                    });
                  },
                  onPhase: (phase, counts) =>
                    perfMark(
                      `变电 semantic repair · ${phase}`,
                      { projectId, ...counts },
                      perfSession,
                    ),
                },
              ),
            );
            if (published && scope.isCurrent()) setCachePublishPhase('ready');
            else if (scope.isCurrent()) failCachePublish('属性补写未完成');
          } catch (error) {
            if (scope.isCurrent()) {
              failCachePublish(error instanceof Error ? error.message : String(error));
            }
          }
        })(),
      ).catch(reportBackgroundError);
    }
    return true;
  } catch (err) {
    if (!scope.isCurrent()) return true;
    releaseWarmIfcAttempt(state);
    if (warmCorePublished) {
      // The cache was structurally valid and the semantic tree/UI were
      // already published. A viewer/loader failure cannot be repaired by
      // reparsing the same source; do not run a second core publication.
      logger.warn(
        '[Substation Runtime] warm viewer failed after core publication; not falling back to cold reparse:',
        err,
      );
      throw err;
    }
    logger.warn('[Substation Runtime] warm cache restore failed, falling back to cold path:', err);
  }
  return false;
}
