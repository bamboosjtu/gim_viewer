import { logger } from '../../../utils/logger.js';
import type { IfcEntry } from '../../../gim/types.js';
import type { AppState, ProjectLoadSession } from '../../../app/state.js';
import { DEBUG_GIM_CACHE } from '../../../config/debug.js';
import { debugLog } from '../../../utils/logger.js';
import type { FamPropertyPayload } from '@desktop/database.js';
import { perfMark, perfMarkProductMoment } from '../../../utils/perfTimings.js';
import { showLoadingBeforeInteractive } from '../presentation/substationPresentation.js';
import type { SessionScope } from '../../../shared/sessionScope.js';
import type { PerfSession } from '../../../utils/perfTimings.js';
import type { ExtractionResult } from '../../../services/gimOpenCore.js';
import type { CbmNode, FileDevEntry } from '../../../gim/types.js';

type ColdPersistenceInput = {
  state: AppState;
  scope: SessionScope;
  session: ProjectLoadSession;
  perfSession: PerfSession;
  preExtracted: Extract<ExtractionResult, { status: 'ok' }>;
  persistProjectId: number | null;
  filesForPersist: Map<string, File>;
  ifcEntriesForPersist: IfcEntry[];
  cbmTreeForPersist: CbmNode | null;
  fileDevRelationsForPersist: FileDevEntry[];
};

/** Semantic publication keeps original FAM rows available to source tools;
 * it does not launch or invalidate the retired business-tree projection. */
export function publishFamSourceRows(state: AppState, rows: readonly FamPropertyPayload[]): void {
  // Cold inspectors read the immutable currentFiles source first. Expanding
  // every persisted FAM JSON row into a second main-isolate object graph is
  // unused on that path and can overlap the engineering Worker/geometry peak.
  // Warm repair still needs the restored property cache when no source map exists.
  if (state.currentFiles) {
    state.properties.cachedFamSourceProperties.clear();
    return;
  }
  const families = new Map<string, import('../../../gim/famParser.js').FamSourceProperty[]>();
  for (const row of rows)
    if (row.raw_property_json) {
      try {
        const list = families.get(row.source_path) ?? [];
        list.push(
          JSON.parse(
            row.raw_property_json,
          ) as import('../../../gim/famParser.js').FamSourceProperty,
        );
        families.set(row.source_path, list);
      } catch {
        /* The original database row remains available; malformed JSON is not semantic evidence. */
      }
    }
  state.properties.cachedFamSourceProperties = families;
}

export function prepareSubstationColdPersistence({
  state,
  scope,
  session,
  perfSession,
  preExtracted,
  persistProjectId,
  filesForPersist,
  ifcEntriesForPersist,
  cbmTreeForPersist,
  fileDevRelationsForPersist,
}: ColdPersistenceInput): () => Promise<void> {
  let persistPromise: Promise<void> | null = null;
  const startCachePersistence = (): Promise<void> => {
    if (persistPromise) return persistPromise;
    perfMarkProductMoment(
      'cachePersistenceStart',
      {
        enabled: persistProjectId != null,
        projectId: persistProjectId,
      },
      perfSession,
    );
    const persistTask =
      persistProjectId != null
        ? (async () => {
            const projectId = persistProjectId;
            // Early session sources are never a published source cache or a v26 receipt.
            await scope.read(async () => preExtracted.sourceMaterialization);
            if (!scope.isCurrent()) return;
            let localCachePathMap = new Map<string, string>();
            if (!scope.isCurrent()) return;

            if (
              preExtracted &&
              ((preExtracted.cachePaths?.size ?? 0) > 0 ||
                (preExtracted.packedPaths?.size ?? 0) > 0)
            ) {
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
                const { cacheIfcEntries } = await scope.read(
                  async () => import('../../../services/gimExtractedCacheService.js'),
                );
                const cacheResult = await scope.read(async () =>
                  cacheIfcEntries(projectId, filesForPersist, ifcEntriesForPersist),
                );
                if (!scope.isCurrent()) return;
                localCachePathMap = cacheResult.pathMap;
                debugLog(DEBUG_GIM_CACHE, '[Tauri] IFC 缓存结果:', {
                  expected: ifcEntriesForPersist.length,
                  cached: localCachePathMap.size,
                  errors: cacheResult.errors,
                });
                if (cacheResult.errors.length > 0) {
                  logger.warn('[Tauri] 部分 IFC 缓存失败:', cacheResult.errors);
                }
              } catch (err) {
                logger.error('[Tauri] IFC 文件缓存失败:', err);
              }

              // WASM 回退把全部原始条目持久化，避免只缓存已知扩展名
              // 造成索引清单与可恢复来源不一致。
              if (filesForPersist) {
                showLoadingBeforeInteractive('正在缓存 GIM 来源文件...');
                try {
                  const { cacheExtractedFiles } = await scope.read(
                    async () => import('../../../services/gimExtractedCacheService.js'),
                  );
                  const geoCacheResult = await scope.read(async () =>
                    cacheExtractedFiles(projectId, filesForPersist, localCachePathMap),
                  );
                  if (!scope.isCurrent()) return;
                  debugLog(DEBUG_GIM_CACHE, '[Tauri] 来源文件缓存结果:', {
                    cached: geoCacheResult.cachedCount,
                    errors: geoCacheResult.errors,
                  });
                  for (const [path, localPath] of geoCacheResult.pathMap)
                    localCachePathMap.set(path, localPath);
                  if (geoCacheResult.errors.length > 0) {
                    logger.warn('[Tauri] 部分来源文件缓存失败:', geoCacheResult.errors);
                  }
                } catch (err) {
                  logger.error('[Tauri] 来源文件缓存失败:', err);
                }
              }
            }

            if (!scope.isCurrent()) return;
            const { publishSubstationCore, publishSubstationRest } = await scope.read(
              async () => import('../runtime/substationIndexPublication.js'),
            );
            const { saveGimIndex, saveGeometryRefs, saveSubstationSemanticRest, validateGimCache } =
              await scope.read(async () => import('@desktop/database.js'));
            const { createCachePublishStatus } = await scope.read(
              async () => import('../../../services/cachePublishStatus.js'),
            );
            const publication = createCachePublishStatus(() => scope.isCurrent());
            scope.own(publication.resetCachePublishStatus);
            const { beginCachePublish, setCachePublishPhase, failCachePublish } = publication;
            const publicationInput = {
              projectId,
              sourceSha256: session.sourceSha256 ?? '',
              files: filesForPersist,
              cachePaths: localCachePathMap,
              packedPaths: preExtracted.packedPaths,
              tree: cbmTreeForPersist,
              ifcs: ifcEntriesForPersist,
              relations: fileDevRelationsForPersist,
            };
            const isCurrent = () => scope.isCurrent();
            const onPhase = (phase: string, counts?: Record<string, number>) =>
              perfMark(
                `变电 semantic persistence · ${phase}`,
                { projectId, ...counts },
                perfSession,
              );
            // 第一阶段：内存中的树/关系/IFC 清单 + receipt，交互后数秒内提交，
            // 让暖启动立即可用；第二阶段再补写 FAM/DEV 属性与几何引用。
            if (!isCurrent()) return;
            beginCachePublish('core');
            let corePublished = false;
            try {
              corePublished = await scope.read(async () =>
                publishSubstationCore(publicationInput, {
                  isCurrent,
                  saveIndex: saveGimIndex,
                  saveRefs: saveGeometryRefs,
                  validate: () => validateGimCache(projectId, 'substation'),
                  onPhase,
                }),
              );
            } catch (error) {
              if (!isCurrent()) {
                failCachePublish('会话已切换');
                return;
              }
              failCachePublish(error instanceof Error ? error.message : String(error));
              throw error;
            }
            if (!corePublished || !isCurrent()) {
              if (!isCurrent()) failCachePublish('会话已切换');
              return;
            }
            setCachePublishPhase('rest');
            try {
              const restPublished = await scope.read(async () =>
                publishSubstationRest(publicationInput, {
                  isCurrent,
                  saveRest: saveSubstationSemanticRest,
                  onPublished: (payload) => {
                    scope.withSession(() => {
                      publishFamSourceRows(state, payload.fam_properties);
                    });
                  },
                  onPhase,
                }),
              );
              if (restPublished && isCurrent()) setCachePublishPhase('ready');
              else if (isCurrent()) failCachePublish('属性补写未完成');
            } catch (error) {
              if (isCurrent())
                failCachePublish(error instanceof Error ? error.message : String(error));
              throw error;
            }
          })()
        : Promise.resolve();
    persistPromise = persistTask
      .then(() => {
        if (!scope.isCurrent()) return;
        perfMarkProductMoment(
          'cachePersistenceReady',
          {
            enabled: persistProjectId != null,
            projectId: persistProjectId,
          },
          perfSession,
        );
      })
      .catch((err) => {
        if (scope.isCurrent()) {
          perfMarkProductMoment(
            'cachePersistenceReady',
            {
              enabled: persistProjectId != null,
              projectId: persistProjectId,
              available: false,
              error: err instanceof Error ? err.message : String(err),
            },
            perfSession,
          );
        }
        logger.error('[Tauri] 缓存/索引入库后台任务失败:', err);
      });
    return persistPromise;
  };
  return startCachePersistence;
}
