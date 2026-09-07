import type { IfcEntry, CbmNode } from '../gim/types.js';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import { scanIfcFiles, discoverIfcFromCBM, buildIfcGuidIndex } from '../gim/gimIndexer.js';
import { buildCbmTree, buildCbmNodeIndex } from '../gim/cbmParser.js';
import {
  buildSubstationSpatialIndexFromFiles,
  type SubstationSpatialIndexObserver,
} from '../gim/ifcSpatialParser.js';
import { parseFileDevRelation } from '../gim/fileDevParser.js';
import { buildAndRenderCbmTree } from '../ui/cbmTreeView.js';
import { renderFileDevPanel } from '../ui/fileDevView.js';
import { emptyTipEl } from '../ui/dom.js';
import { isTauri } from '@desktop/runtime.js';
import { DEBUG_GIM_CACHE, DEBUG_IFC_LOAD } from '../config/debug.js';
import { isFragmentsCacheEnabled } from '../config/features.js';
import { debugLog } from '../utils/logger.js';
import { setProjectIdentity, refreshNavigatorTitle } from '../ui/shell/projectBar.js';
import type { GimRuntimeOpenContext } from './gimOpenCore.js';
import { validateGimCache } from '@desktop/database.js';
import { hydrateNativeSmallFiles } from './nativeSmallFileHydration.js';
import {
  perfCurrentSession,
  perfBegin,
  perfMark,
  perfMarkProductMoment,
  perfProductMomentSnapshot,
  perfRecordMemorySample,
  perfRecordSubstationIfcRead,
  perfRecordSubstationIfcProfile,
  perfRecordSubstationFinalizeProfile,
  perfIsCurrentSession,
  type PerfSession,
} from '../utils/perfTimings.js';
import { showLoading, hideLoading } from './gimOpenCore.js';


async function sampleSubstationMemory(
  label: string,
  session: PerfSession,
  meta?: Record<string, unknown>,
): Promise<void> {
  if (!perfIsCurrentSession(session)) return;
  const memory = (typeof performance !== 'undefined'
    ? (performance as Performance & {
      memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
    }).memory
    : undefined);
  let rssBytes: number | null = null;
  let rssSource: string | undefined;
  if (isTauri()) {
    try {
      const { getProcessMemory } = await import('@desktop/database.js');
      const processMemory = await getProcessMemory();
      if (!perfIsCurrentSession(session)) return;
      rssBytes = processMemory.rssBytes ?? null;
      rssSource = processMemory.source;
    } catch (error) {
      // 采样失败不能影响工程加载；记录原因供报告识别“不可测”而非 0。
      if (perfIsCurrentSession(session)) {
        perfRecordMemorySample(label, {
          rssBytes: null,
          jsHeapUsedBytes: memory?.usedJSHeapSize,
          jsHeapTotalBytes: memory?.totalJSHeapSize,
          jsHeapLimitBytes: memory?.jsHeapSizeLimit,
          meta: { ...meta, rssError: error instanceof Error ? error.message : String(error) },
        }, session);
      }
      return;
    }
  }
  if (!perfIsCurrentSession(session)) return;
  perfRecordMemorySample(label, {
    rssBytes,
    ...(rssSource ? { rssSource } : {}),
    jsHeapUsedBytes: memory?.usedJSHeapSize,
    jsHeapTotalBytes: memory?.totalJSHeapSize,
    jsHeapLimitBytes: memory?.jsHeapSizeLimit,
    meta,
  }, session);
}

function createSubstationSpatialObserver(session: PerfSession): SubstationSpatialIndexObserver {
  // 只采一次阶段内存，避免大型工程的每个 IFC 都增加一个 RSS IPC。
  // 回调本身保持同步，采样异步执行且在 sampleSubstationMemory 内再次做
  // session 校验；这样不会阻塞纯解析层。
  let textSampled = false;
  let stepSampled = false;
  return {
    onModelRead: (profile) => {
      perfRecordSubstationIfcRead(profile, session);
      if (!textSampled && profile.bytes > 0) {
        textSampled = true;
        void sampleSubstationMemory('IFC text 读入后', session, {
          entryPath: profile.entryPath,
          bytes: profile.bytes,
          readMs: profile.readMs,
          decodeMs: profile.decodeMs,
        });
      }
    },
    onStepScan: (profile) => {
      if (!stepSampled) {
        stepSampled = true;
        void sampleSubstationMemory('STEP scan 后', session, {
          entryPath: profile.entryPath,
          bytes: profile.sourceBytes,
          rawEntityCount: profile.rawEntityCount,
          stepScanMs: profile.stepScanMs,
        });
      }
    },
    onModelParsed: (profile) => {
      perfRecordSubstationIfcProfile(profile, session);
    },
    onFinalize: (profile) => {
      perfRecordSubstationFinalizeProfile(profile, session);
    },
  };
}

function collectCbmNodeCount(root: CbmNode | null): number {
  if (!root) return 0;
  let count = 0;
  const walk = (node: CbmNode): void => {
    count += 1;
    for (const child of node.children) walk(child);
  };
  walk(root);
  return count;
}

function createNodeClickHandler(state: AppState, showMessage: (text: string) => void): (node: CbmNode) => void {
  return (node: CbmNode) => {
    import('./nodeInteractionService.js').then(({ handleNodeClick }) => {
      handleNodeClick(state, node, showMessage);
    });
  };
}

function setupSldGridIdInteraction(
  state: AppState,
  showMessage: (text: string) => void,
  session?: ProjectLoadSession,
): void {
  import('../ui/sldView.js').then(({ setSldGridIdClickHandler }) => {
    if (session && !state.isCurrentSession(session)) return;
    setSldGridIdClickHandler(async (gridId: string) => {
      if (session && !state.isCurrentSession(session)) return;
      if (!state.currentStdSldIndex) return;
      try {
        const { getCbmNodesByGridId } = await import('../gim/stdSldIndex.js');
        if (session && !state.isCurrentSession(session)) return;
        const nodes = getCbmNodesByGridId(state.currentStdSldIndex, gridId);
        if (nodes.length === 0) {
          console.log('[SLD→CBM] gridId 无对应 CBM 节点:', gridId);
          return;
        }
        // 取首个匹配节点触发联动（高亮 CBM 树 + 加载 IFC + 3D 高亮 + 相机定位）
        const { handleNodeClick } = await import('./nodeInteractionService.js');
        if (session && !state.isCurrentSession(session)) return;
        await handleNodeClick(state, nodes[0], showMessage);
      } catch (err) {
        console.warn('[SLD→CBM] 联动失败:', err);
      }
    });
  }).catch((err) => {
    console.warn('[SLD→CBM] 注册联动回调失败:', err);
  });
}

export async function onGimExtracted(
  state: AppState,
  files: Map<string, File>,
  showMessage: (text: string) => void,
  projectName?: string,
  projectTypeName?: string,
  session: ProjectLoadSession = state.captureProjectSession(),
): Promise<IfcEntry[]> {
  if (!state.isCurrentSession(session)) return [];
  const perfSession = perfCurrentSession();
  state.currentFiles = files;
  state.projectName = projectName || '';

  // 发现 IFC 文件
  const endIfcDiscovery = perfBegin('变电 IFC discovery', undefined, perfSession);
  let ifcEntries = await discoverIfcFromCBM(files);
  if (!state.isCurrentSession(session)) return [];
  if (ifcEntries.length === 0) ifcEntries = scanIfcFiles(files);
  endIfcDiscovery(undefined, { count: ifcEntries.length });
  await sampleSubstationMemory('IFC discovery 后', perfSession, { ifcCount: ifcEntries.length });

  state.currentIfcEntries = ifcEntries;

  // 构建 CBM 层级树（F1System 根节点名称由 projectTypeName 设置，F2System 由 SYSCLASSIFYNAME 映射）
  const endCbmCore = perfBegin('变电 CBM/FAM/DEV/FileDevRelation', undefined, perfSession);
  const cbmTree = await buildCbmTree(files, projectTypeName);
  if (!state.isCurrentSession(session)) return [];
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
  await sampleSubstationMemory('CBM/FAM/DEV/FileDevRelation 后', perfSession, {
    cbmNodes: collectCbmNodeCount(cbmTree),
    fileDevRelations: fileDevRelations.length,
  });

  // IFC 空间结构与 CBM 树是两种不同事实视图：在解析阶段建立共享索引，
  // 左侧导航可以按站区/建筑/楼层浏览，同时保留功能系统视图和未关联设备。
  // 单个 IFC 解析失败只降级该模型，不能阻断整个 GIM 打开流程。
  try {
    const endSpatial = perfBegin('变电 IFC 空间索引', undefined, perfSession);
    const spatialIndex = await buildSubstationSpatialIndexFromFiles(
      files,
      ifcEntries,
      cbmTree,
      fileDevRelations,
      createSubstationSpatialObserver(perfSession),
    );
    if (!state.isCurrentSession(session)) return [];
    endSpatial(undefined, {
      models: spatialIndex.models.length,
      spatialNodes: spatialIndex.nodes.length,
      containedObjects: spatialIndex.models.reduce((sum, m) => sum + m.containedObjectCount, 0),
      uncontainedIfcObjects: spatialIndex.coverage.uncontainedIfcObjects,
      resourceRecords: spatialIndex.models.reduce((sum, m) => sum + m.resourceCount, 0),
      cbmLinks: spatialIndex.links.length,
    });
    state.substationSpatialIndex = spatialIndex;
    await sampleSubstationMemory('SpatialIndex finalize 后', perfSession, {
      models: spatialIndex.models.length,
      spatialNodes: spatialIndex.nodes.length,
      objects: spatialIndex.objects.length,
    });
  } catch (err) {
    if (!state.isCurrentSession(session)) return [];
    state.substationSpatialIndex = null;
    console.warn('[GIM] IFC 空间索引构建失败，保留功能系统视图:', err);
  }

  // STD/SLD 解析：在 CBM 树构建完成后并行执行（不阻塞 IFC 加载）
  // 失败时仅 warn，不影响主流程
  try {
    const { parseStdSldOnGimExtracted, commitStdSldResult } = await import('./stdSldService.js');
    const stdSldResult = await parseStdSldOnGimExtracted(state, files);
    if (!state.isCurrentSession(session)) return [];
    commitStdSldResult(state, stdSldResult);
  } catch (err) {
    if (state.isCurrentSession(session)) console.warn('[GIM] STD/SLD 解析失败:', err);
  }
  if (!state.isCurrentSession(session)) return [];

  perfMarkProductMoment('semanticReady', {
    ifcModels: state.substationSpatialIndex?.models.length ?? 0,
    spatialNodes: state.substationSpatialIndex?.nodes.length ?? 0,
    cbmNodes: collectCbmNodeCount(state.currentCbmTree),
  }, perfSession);

  // 渲染层级树和文件设备面板（统一使用 handleNodeClick）
  const endSubstationUi = perfBegin('变电 navigation/UI（语义）', undefined, perfSession);
  const clickHandler = createNodeClickHandler(state, showMessage);
  buildAndRenderCbmTree(state, clickHandler);
  renderFileDevPanel(state, clickHandler);

  // 渲染 SLD 电气单线图与 STD 拓扑列表
  try {
    const { renderSldView } = await import('../ui/sldView.js');
    if (!state.isCurrentSession(session)) return [];
    renderSldView(state);
  } catch (err) {
    if (state.isCurrentSession(session)) console.warn('[GIM] SLD 视图渲染失败:', err);
  }

  // 阶段 4：注册 SLD gridId → CBM 联动回调
  setupSldGridIdInteraction(state, showMessage, session);
  endSubstationUi(undefined, {
    cbmNodes: collectCbmNodeCount(state.currentCbmTree),
    ifcModels: state.currentIfcEntries.length,
  });

  return ifcEntries;
}

/**
 * 获取 IFC 文件内容。
 * 1. 优先从完整解压流程的 currentFiles 读取
 * 2. 缓存命中时从 cachedIfcPaths + readCachedIfc 读取
 * 3. 找不到返回 null（调用方跳过）
 */

async function getIfcBufferForEntry(
  entry: IfcEntry,
  state: AppState,
  session: ProjectLoadSession = state.captureProjectSession(),
): Promise<Uint8Array | null> {
  if (!state.isCurrentSession(session)) return null;
  // 1. 完整解压流程
  if (state.currentFiles) {
    const file = state.currentFiles.get(entry.path);
    if (file) {
      debugLog(DEBUG_IFC_LOAD, '[IFC Buffer] 使用 GIM 解压内存文件:', {
        name: entry.name,
        path: entry.path,
      });
      const bytes = new Uint8Array(await file.arrayBuffer());
      return state.isCurrentSession(session) ? bytes : null;
    }
  }

  // 2. Tauri 缓存命中
  if (isTauri() && state.cachedIfcPaths.has(entry.path)) {
    const projectId = session.projectId;
    if (projectId != null) {
      const cachePath = state.cachedIfcPaths.get(entry.path)!;
      debugLog(DEBUG_IFC_LOAD, '[IFC Buffer] 使用本地 IFC 缓存:', {
        name: entry.name,
        path: entry.path,
        cachePath,
      });
      const { readCachedIfc } = await import('@desktop/database.js');
      const bytes = await readCachedIfc(projectId, entry.path);
      if (!state.isCurrentSession(session)) return null;

      // 可疑缓存定位日志：MVP 阶段用于排查缓存 IFC 是否被截断/损坏
      // IFC 文件应以 "ISO-103021;;" 文本头开头（HEX: 49 53 4F 2D 31 30 33 32 31 3B）
      // byteLength === 0 或 head 不符 → 缓存损坏，返回 null 让上层回退/报错
      const byteLength = bytes?.byteLength ?? 0;
      const head = bytes
        ? Array.from(bytes.slice(0, 32))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ')
        : '';
      debugLog(DEBUG_IFC_LOAD, '[IFC Buffer] cached IFC bytes', {
        name: entry.name,
        path: entry.path,
        byteLength,
        head,
      });
      if (byteLength === 0) {
        // 缓存损坏：始终输出（非 debug），便于用户定位
        console.warn(`[IFC Buffer] 缓存 IFC 字节为空，缓存损坏: ${entry.path}`);
        return null;
      }
      // IFC 文件头 ASCII "ISO-103021;;" 前 4 字节应为 49 53 4F 2D（"ISO-"）
      // 不强制校验（部分 IFC 可能含 BOM 或前导空白），仅 warn 提示可疑
      if (
        bytes.length >= 4 &&
        !(bytes[0] === 0x49 && bytes[1] === 0x53 && bytes[2] === 0x4f && bytes[3] === 0x2d)
      ) {
        console.warn(`[IFC Buffer] 缓存 IFC 文件头非 'ISO-' 前缀，可能损坏: ${entry.path}`, { head });
      }
      return bytes;
    }
  }

  // 3. 找不到：始终输出（非 debug），便于定位
  console.warn('[IFC Buffer] 找不到 IFC 文件内容或缓存:', entry);
  return null;
}

/**
 * 自动加载全部 IFC 文件 + MOD/STL 几何（无需弹窗选择）。
 *
 * 用于 GIM 文件打开流程：GIM 被视为一个整体，
 * 打开后直接显示所有 IFC + MOD + STL，无需用户手动选择。
 *
 * - 内部创建 ViewerRuntime（调用方无需预先持有 ctx）
 * - 同时适用于首次打开（currentFiles 非空）和缓存命中（currentFiles=null）
 *
 * @param state 全局 AppState（currentIfcEntries / currentFiles / cachedIfcPaths 必须就绪）
 * @param entries 要加载的 IFC 条目列表（全部，而非用户选择子集）
 * @param showMessage 消息回调（更新 loading 文案）
 */

export async function loadAllIfcFiles(
  state: AppState,
  entries: IfcEntry[],
  showMessage: (text: string) => void,
  options: {
    session?: ProjectLoadSession;
    geometryCacheValid?: boolean;
    geometryCacheManifestValid?: boolean;
    geometryCacheVersionFileMatch?: boolean;
  } = {},
): Promise<void> {
  const session = options.session ?? state.captureProjectSession();
  const perfSession = perfCurrentSession();
  const isCurrent = () => state.isCurrentSession(session);
  if (!isCurrent()) return;
  // 调试入口：从 localStorage 读取手动坐标偏移（GIM_COORD_OFFSET="dx,dy,dz"）
  // 仅作为调试功能，不写入数据库，不作为最终算法。
  // resetGimState 会清空 projectSourceToViewerMatrix，因此每次打开项目时重新解析。
  try {
    const { loadManualCoordOffsetFromLocalStorage } = await import('./coordinateAlignmentService.js');
    if (!isCurrent()) return;
    loadManualCoordOffsetFromLocalStorage(state);
  } catch {
    // 忽略：coordinateAlignmentService 不可用时不影响主流程
  }

  if (entries.length === 0) {
    // 无 IFC 但仍触发 MOD/STL 自动加载（纯 xml-mod 工程）
    await autoLoadModStlPostIfc(state, showMessage, undefined, {
      session,
      geometryCacheValid: options.geometryCacheValid,
      geometryCacheManifestValid: options.geometryCacheManifestValid,
      geometryCacheVersionFileMatch: options.geometryCacheVersionFileMatch,
    });
    return;
  }

  showLoading('正在加载 3D 引擎...');
  const endEngine = perfBegin('3D 引擎创建', undefined, perfSession);
  const { getViewerRuntimeWithUI } = await import('./viewerUIBinding.js');
  if (!isCurrent()) return;
  const runtime = await getViewerRuntimeWithUI(state, showMessage);
  if (!isCurrent()) return;
  const { ctx, modelCallbacks } = runtime;
  endEngine();

  showLoading('正在加载 IFC 模型...');
  const failed: Array<{ name: string; message: string }> = [];

  try {
    const { ensureEngineReady } = await import('../viewer/ifcLoader.js');
    if (!isCurrent()) return;
    const endEngineInit = perfBegin('web-ifc / Fragments engine 初始化', undefined, perfSession);
    await ensureEngineReady(ctx, state, modelCallbacks);
    if (!isCurrent()) return;
    endEngineInit(undefined, { initialized: true });
    const { loadIfcEntry } = await import('../viewer/ifcEntryLoader.js');
    if (!isCurrent()) return;

    let firstIfcReady = true;
    for (const entry of entries) {
      if (!isCurrent()) return;
      showLoading(`正在加载 ${entry.name}...`);
      let readEnded = false;
      let loadEnded = false;
      const loadSource: { value: 'fragments-cache' | 'ifc' | 'unknown' } = { value: 'unknown' };
      const endRead = perfBegin(`变电 IFC read · ${entry.path}`, undefined, perfSession);
      const endIfcLoad = perfBegin(`变电 web-ifc / Fragments load · ${entry.path}`, undefined, perfSession);
      try {
        const ifcBytes: { value: Uint8Array | null } = { value: null };
        await loadIfcEntry(
          ctx,
          state,
          entry,
          async () => {
            ifcBytes.value = await getIfcBufferForEntry(entry, state, session);
            if (!isCurrent()) return null;
            endRead(undefined, {
              bytes: ifcBytes.value?.byteLength ?? 0,
              source: state.currentFiles ? 'extracted' : 'disk-cache',
              found: ifcBytes.value != null,
            });
            readEnded = true;
            return ifcBytes.value;
          },
          (p) => showLoading(`${entry.name}: ${Math.round(p * 100)}%`),
          {
            session,
            perfSessionId: perfSession.id,
            onLoadSource: (source) => { loadSource.value = source; },
          },
        );
        if (!isCurrent()) return;
        if (!readEnded) {
          // Fragments cache 命中时不会调用 getIfcBuffer；显式记录“未读取 IFC”。
          endRead(undefined, {
            bytes: 0,
            source: loadSource.value === 'fragments-cache' ? 'fragments-cache' : 'not-read',
            found: false,
          });
          readEnded = true;
        }
        endIfcLoad(undefined, {
          bytes: ifcBytes.value?.byteLength ?? 0,
          source: loadSource.value,
          fragmentsCacheEnabled: isFragmentsCacheEnabled(),
          cacheHit: loadSource.value === 'fragments-cache',
        });
        loadEnded = true;
        if (firstIfcReady) {
          firstIfcReady = false;
          perfMark('首个 IFC 就绪', {
            name: entry.name,
            source: loadSource.value,
            cacheHit: loadSource.value === 'fragments-cache',
          }, perfSession);
          perfMarkProductMoment('firstGeometryReady', {
            kind: 'ifc',
            name: entry.name,
            source: loadSource.value,
            cacheHit: loadSource.value === 'fragments-cache',
          }, perfSession);
          void sampleSubstationMemory('第一个 Fragments model 后', perfSession, {
            name: entry.name,
            source: loadSource,
          });
        }
      } catch (err) {
        if (!readEnded) {
          endRead('（失败）', { source: loadSource.value, error: err instanceof Error ? err.message : String(err) });
          readEnded = true;
        }
        if (!loadEnded) {
          endIfcLoad('（失败）', {
            source: loadSource.value,
            fragmentsCacheEnabled: isFragmentsCacheEnabled(),
            cacheHit: loadSource.value === 'fragments-cache',
            error: err instanceof Error ? err.message : String(err),
          });
          loadEnded = true;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error('[GIM] IFC 加载失败:', entry, err);
        // IFC 加载可能在工程切换后才 reject；不要让旧工程继续进入
        // 后续坐标同步、名称索引或 UI 渲染阶段。
        if (!isCurrent()) return;
        failed.push({ name: entry.name, message });
        // 防御性清理
        try {
          const modelId = entry.modelId;
          const runtimeModelId = state.ifcRuntimeModelIds.get(modelId) ?? modelId;
          if (ctx.fragments.list.has(runtimeModelId)) {
            ctx.fragments.core.disposeModel(runtimeModelId);
          }
          state.loadedModels.delete(modelId);
          const modelRow = document.getElementById(`model-${modelId}`)
            ?? document.getElementById(`model-${runtimeModelId}`);
          if (modelRow) modelRow.remove();
        } catch (cleanupErr) {
          console.warn('[GIM] cleanup failed model after load error', entry, cleanupErr);
        }
        continue;
      }
    }

    // IFC 必须保持 coordinate=true；MOD/STL 用同一个 Fragments 基准矩阵对齐到 viewer 空间。
    const endCoordinate = perfBegin('变电 coordinate alignment', undefined, perfSession);
    try {
      const { syncProjectSourceToViewerFromFragments } = await import('./coordinateAlignmentService.js');
      if (!isCurrent()) return;
      await syncProjectSourceToViewerFromFragments(state, ctx.fragments, { session });
      if (!isCurrent()) return;
      endCoordinate(undefined, {
        hasMatrix: state.projectSourceToViewerMatrix != null,
      });
    } catch (err) {
      endCoordinate('（失败）', { error: err instanceof Error ? err.message : String(err) });
      console.warn('[CoordAlign] IFC 基准坐标同步失败，MOD/STL 将使用原始坐标或手工 offset:', err);
    }

    // buildIfcNameIndex 失败不应阻断 UI 渲染
    const { buildIfcNameIndex } = await import('../viewer/ifcNameIndex.js');
    if (!isCurrent()) return;
    const endNameIndex = perfBegin('变电 IFC name index', undefined, perfSession);
    await buildIfcNameIndex(ctx, state, { session }).catch((err) => {
      console.warn('[GIM] buildIfcNameIndex failed', err);
    });
    if (!isCurrent()) return;
    endNameIndex(undefined, { models: state.loadedModels.size });

    // 渲染层级树和文件设备面板
    const endTreeRender = perfBegin('变电 navigation/UI（3D）', undefined, perfSession);
    const clickHandler = createNodeClickHandler(state, (text) => showLoading(text));
    buildAndRenderCbmTree(state, clickHandler);
    renderFileDevPanel(state, clickHandler);
    emptyTipEl.style.display = 'none';
    endTreeRender();

    // 首次 fit 相机
    const { fitCameraToScene } = await import('../viewer/camera.js');
    if (!isCurrent()) return;
    fitCameraToScene(ctx, state);
    perfMark('变电工程可交互（IFC 全部就绪）', undefined, perfSession);

  } catch (err) {
    if (!isCurrent()) return;
    console.error('[GIM] IFC 加载失败 (outer)', {
      error: err,
      message: err instanceof Error ? err.message : String(err),
    });
    showLoading(`IFC 加载失败: ${err instanceof Error ? err.message : String(err)}`);
    setTimeout(hideLoading, 3000);
    return;
  }

  // IFC 加载完成 → 立即 hideLoading，让用户可交互
  if (failed.length > 0) {
    showLoading(`部分 IFC 加载失败：${failed.length}/${entries.length}，详见控制台`);
    setTimeout(hideLoading, 4000);
  } else {
    hideLoading();
  }

  // MOD 自动加载作为后台任务，不阻塞主流程
  // token 机制防止项目切换后旧任务继续往新 scene 添加对象
  state.geometryLoadToken++;
  const token = state.geometryLoadToken;
  const bgCtx = ctx; // 捕获当前 ctx 引用

  queueMicrotask(() => {
    void autoLoadModStlPostIfc(state, showMessage, bgCtx, {
      token,
      includeMod: true,
      includeStl: false,
      session,
      geometryCacheValid: options.geometryCacheValid,
      geometryCacheManifestValid: options.geometryCacheManifestValid,
      geometryCacheVersionFileMatch: options.geometryCacheVersionFileMatch,
    })
      .catch((err) => {
        console.warn('[GIM] 后台 MOD 加载失败:', err);
      });
  });
}

/**
 * MOD/STL 自动加载（IFC 加载后置步骤，同时用于无 IFC 的纯 MOD 工程）。
 *
 * 若 ctx 未传入（无 IFC 场景），内部创建 ViewerRuntime。
 *
 * 双路径：
 * - 首次打开（currentFiles 非空）→ 渐进式 DEV GLB 管线：
 *   序列化 → 落盘 → 逐 CBM 实例渲染一体化，MOD 只解析 1 遍（原流程解析 2 遍）
 * - 缓存命中（currentFiles=null）→ 原有 autoLoadModAndStlGeometry
 *   （GLB 快速路径 → SQLite 直通回退）
 */

async function autoLoadModStlPostIfc(
  state: AppState,
  showMessage: (text: string) => void,
  existingCtx?: ViewerContext,
  options?: {
    token?: number;
    includeMod?: boolean;
    includeStl?: boolean;
    session?: ProjectLoadSession;
    geometryCacheValid?: boolean;
    geometryCacheManifestValid?: boolean;
    geometryCacheVersionFileMatch?: boolean;
  },
): Promise<void> {
  let endModStl: ((labelSuffix?: string, endMeta?: Record<string, unknown>) => void) | null = null;
  let modStlEnded = false;
  try {
    const session = options?.session ?? state.captureProjectSession();
    const perfSession = perfCurrentSession();
    if (!state.isCurrentSession(session)) return;
    endModStl = perfBegin('变电 MOD/STL', undefined, perfSession);
    const finishModStl = (suffix?: string, meta?: Record<string, unknown>): void => {
      if (modStlEnded) return;
      modStlEnded = true;
      endModStl?.(suffix, meta);
    };
    // 获取 scene：优先用已有 ctx，否则创建 ViewerRuntime
    let scene: import('three').Scene;
    if (existingCtx) {
      scene = (existingCtx.world.scene as any).three as import('three').Scene;
    } else {
      const { getViewerRuntimeWithUI } = await import('./viewerUIBinding.js');
      if (!state.isCurrentSession(session)) return;
      const runtime = await getViewerRuntimeWithUI(state, showMessage);
      if (!state.isCurrentSession(session)) return;
      scene = (runtime.ctx.world.scene as any).three as import('three').Scene;
    }

    // 首次打开：渐进式 DEV GLB 管线（编译→落盘→渐进渲染一体）
    if (state.currentFiles) {
      const { runProgressiveDevGlbPipeline } = await import('./progressiveGeometryService.js');
      if (!state.isCurrentSession(session)) return;
      const result = await runProgressiveDevGlbPipeline(
        state,
        scene,
        (p) => {
          if (!state.isCurrentSession(session)) return;
          if (p.phase === 'compiling') {
            showLoading(`正在后台编译几何模型 (${p.compiledDevs}/${p.totalDevs})...`);
          } else if (p.phase === 'done') {
            perfMark('渐进式 DEV GLB 管线完成', {
              compiledDevs: p.compiledDevs,
              renderedInstances: p.renderedInstances,
            }, perfSession);
            hideLoading();
          }
        },
        {
          token: options?.token,
          generation: session.generation,
          projectId: session.projectId,
          sourceSha256: session.sourceSha256,
          session,
        },
      );

      if (!state.isCurrentSession(session)) return;

      // 渐进 GLB 编译同样按 DEV 做失败隔离。无法产生 GLB 的 DEV 只在
      // 当前解压文件源上做定向 raw fallback；已成功渲染的其它 DEV 不得
      // 被清理或重新解析。
      const devGlbProfile = result.devGlbProfile;
      let scopedRaw = { modCount: 0, stlCount: 0, rows: 0 };
      if (!result.interrupted && result.rawFallbackDevs.length > 0 && state.currentFiles) {
        try {
          const {
            collectCbmDeviceInstances,
            loadScopedRawFallbackGeometry,
          } = await import('./modAutoLoadService.js');
          const fallbackNodes = collectCbmDeviceInstances(state.currentCbmTree);
          scopedRaw = await loadScopedRawFallbackGeometry(
            state,
            scene,
            (p) => {
              if (!state.isCurrentSession(session)) return;
              if (p.phase === 'loading_mod') {
                showLoading(`正在定向回退失败 DEV 的 MOD 模型 ${p.loadedMods}/${p.totalMods}...`);
              } else if (p.phase === 'loading_stl') {
                showLoading(`正在定向回退失败 DEV 的 STL 模型 ${p.loadedStls}/${p.totalStls}...`);
              }
            },
            result.rawFallbackDevs,
            true,
            false,
            options?.token,
            session.generation,
            session.projectId,
            session.sourceSha256,
            session,
            devGlbProfile,
            state.currentFiles,
            fallbackNodes,
          );
        } catch (error) {
          // 定向回退失败不应清理已经成功的 GLB；把错误留在控制台与
          // 性能 span 中，后续诊断可以区分“部分回退失败”和全项目失败。
          console.warn('[GIM] 渐进几何 scoped raw fallback 失败:', error);
        }
      }

      finishModStl(undefined, {
        path: 'progressive-dev-glb',
        compiledDevs: result.compiledDevs,
        renderedInstances: result.renderedInstances,
        rawFallbackDevs: result.rawFallbackDevs.length,
        rawFallbackInstances: scopedRaw.modCount + scopedRaw.stlCount,
        rawFallbackRows: scopedRaw.rows,
        interrupted: result.interrupted,
        ...(devGlbProfile ? { devGlbProfile } : {}),
      });
      const totalGeometryInstances = result.renderedInstances
        + scopedRaw.modCount
        + scopedRaw.stlCount;
      if (!result.interrupted && totalGeometryInstances > 0) {
        debugLog(DEBUG_IFC_LOAD, '[GIM] 渐进几何管线完成', result);
        // 编译完成后强制重新 fit 相机（bbox 可能显著变化）
        if (existingCtx) {
          const { fitCameraToScene } = await import('../viewer/camera.js');
          if (!state.isCurrentSession(session)) return;
          fitCameraToScene(existingCtx, state, { force: true });
        }
      }
      if (!result.interrupted) {
        perfMarkProductMoment('fullModelReady', {
          ifcModels: state.loadedModels.size,
          modInstances: result.renderedInstances + scopedRaw.modCount,
          compiledDevs: result.compiledDevs,
          stlInstances: scopedRaw.stlCount,
        }, perfSession);
        await sampleSubstationMemory('full ready 后', perfSession, {
          path: 'progressive-dev-glb',
          renderedInstances: totalGeometryInstances,
        });
      }
      return;
    }

    // 缓存命中：原有路径（GLB 快速路径 → SQLite 直通回退）
    const { autoLoadModAndStlGeometry } = await import('./modAutoLoadService.js');
    if (!state.isCurrentSession(session)) return;
    const result = await autoLoadModAndStlGeometry(
      state,
      scene,
      (p) => {
        if (!state.isCurrentSession(session)) return;
        if (p.phase === 'discovering') {
          showLoading(`正在发现几何引用... (${p.currentPath || ''})`);
        } else if (p.phase === 'loading_mod') {
          showLoading(`正在加载 MOD 模型 ${p.processedMods ?? p.loadedMods}/${p.totalMods}...`);
        } else if (p.phase === 'loading_stl') {
          showLoading(`正在加载 STL 模型 ${p.loadedStls}/${p.totalStls}...`);
        } else if (p.phase === 'done') {
          // 后台几何加载结束必须隐藏提示，否则 toast 永久停留在最后一批的批前计数
          hideLoading();
        }
      },
      {
        token: options?.token,
        generation: session.generation,
        projectId: session.projectId,
        sourceSha256: session.sourceSha256,
        session,
        geometryCacheValid: options?.geometryCacheValid,
        geometryCacheManifestValid: options?.geometryCacheManifestValid,
        geometryCacheVersionFileMatch: options?.geometryCacheVersionFileMatch,
        includeMod: options?.includeMod ?? true,
        includeStl: options?.includeStl ?? false,
      },
    );

    if (!state.isCurrentSession(session)) return;

    if (result.modCount > 0 || result.stlCount > 0) {
      debugLog(DEBUG_IFC_LOAD, '[GIM] MOD/STL 自动加载完成', result);
      // MOD/STL 加载后强制重新 fit 相机（bbox 可能显著变化）
      if (existingCtx) {
        const { fitCameraToScene } = await import('../viewer/camera.js');
        if (!state.isCurrentSession(session)) return;
        fitCameraToScene(existingCtx, state, { force: true });
      }
    }
    finishModStl(undefined, {
      path: 'cached-geometry',
      modCount: result.modCount,
      stlCount: result.stlCount,
      ...(result.devGlbProfile ? { devGlbProfile: result.devGlbProfile } : {}),
    });
    if (!state.isCurrentSession(session)) return;
    if (!perfProductMomentSnapshot().firstGeometryReady
      && (result.modCount > 0 || result.stlCount > 0)) {
      perfMarkProductMoment('firstGeometryReady', {
        kind: 'mod-stl',
        modCount: result.modCount,
        stlCount: result.stlCount,
      }, perfSession);
      void sampleSubstationMemory('第一个几何模型后', perfSession, {
        kind: 'mod-stl',
        modCount: result.modCount,
        stlCount: result.stlCount,
      });
    }
    perfMarkProductMoment('fullModelReady', {
      ifcModels: state.loadedModels.size,
      modInstances: result.modCount,
      stlInstances: result.stlCount,
      path: 'cached-geometry',
    }, perfSession);
    await sampleSubstationMemory('full ready 后', perfSession, {
      path: 'cached-geometry',
      modCount: result.modCount,
      stlCount: result.stlCount,
    });
  } catch (err) {
    if (!modStlEnded) {
      endModStl?.('（失败）', { error: err instanceof Error ? err.message : String(err) });
      modStlEnded = true;
    }
    console.warn('[GIM] MOD/STL 自动加载失败:', err);
  }
}

/** 从 ArrayBuffer 加载 GIM 文件的完整流程（浏览器和 Tauri 共用，不创建 Viewer） */


/**
 * Substation Runtime owns the CBM/IFC/Fragments/DEV/MOD/STL lifecycle.
 * The Shared Core has already inspected the source and activated the session.
 */
export async function openSubstationProject(context: GimRuntimeOpenContext): Promise<void> {
  const { state, session, showMessage } = context;
  const perfSession = perfCurrentSession();
  let validation: Awaited<ReturnType<typeof validateGimCache>> | null = null;

  if (context.projectId != null && isTauri()) {
    try {
      validation = await validateGimCache(context.projectId, 'substation');
    } catch (error) {
      console.warn('[Substation Runtime] cache validation failed, falling back to cold path:', error);
    }
    if (!state.isCurrentSession(session)) return;
  }

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
      endRestoreCore(undefined, {
        entries: index.entries.length,
        cbmNodes: index.cbm_nodes.length,
        ifcModels: index.ifc_models.length,
        fileDevRelations: index.file_dev_entries.length,
        famProperties: index.fam_properties.length,
        devProperties: index.dev_properties.length,
      });
      await sampleSubstationMemory('CBM/FAM/DEV/FileDevRelation 后（缓存命中）', perfSession, {
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

      if (state.currentIfcEntries.length === 0) {
        throw new Error('缓存索引中没有 IFC 文件');
      }

      if (state.fileDevRelations.length === 0) {
        console.warn('[Tauri] 缓存索引中没有文件设备关系');
      }

      // 缓存索引保留了 CBM/IFC 文件路径，但空间关系来自 IFC 原文；
      // 在不重新解压 GIM 的情况下从 IFC 磁盘缓存恢复同一空间对象图。
      // 使用与 cold path 完全相同的增量 builder/observer，避免缓存命中
      // 产生另一套解析结果或重新累积所有 IFC 文本。
      try {
        showLoading('正在从缓存 IFC 恢复空间结构...');
        const endSpatial = perfBegin('变电 IFC 空间索引（缓存命中）', undefined, perfSession);
        const cbmTree = state.currentCbmTree;
        const fileDevRelations = state.fileDevRelations;
        const { createDiskBackedFile } = await import('@desktop/gimExtract.js');
        const cachedIfcFiles = new Map<string, File>();
        for (const cachedEntry of index.entries) {
          if (!/^ifc$/i.test(cachedEntry.entry_type)) continue;
          cachedIfcFiles.set(
            cachedEntry.entry_path,
            createDiskBackedFile(context.projectId!, cachedEntry.entry_path, cachedEntry.file_size),
          );
        }
        const spatialIndex = await buildSubstationSpatialIndexFromFiles(
          cachedIfcFiles,
          state.currentIfcEntries,
          cbmTree,
          fileDevRelations,
          createSubstationSpatialObserver(perfSession),
        );
        if (!state.isCurrentSession(session)) return;
        endSpatial(undefined, {
          models: spatialIndex.models.length,
          spatialNodes: spatialIndex.nodes.length,
          containedObjects: spatialIndex.models.reduce((sum, model) => sum + model.containedObjectCount, 0),
          uncontainedIfcObjects: spatialIndex.coverage.uncontainedIfcObjects,
          resourceRecords: spatialIndex.models.reduce((sum, model) => sum + model.resourceCount, 0),
          cbmLinks: spatialIndex.links.length,
        });
        state.substationSpatialIndex = spatialIndex;
        await sampleSubstationMemory('SpatialIndex finalize 后（缓存命中）', perfSession, {
          models: spatialIndex.models.length,
          spatialNodes: spatialIndex.nodes.length,
          objects: spatialIndex.objects.length,
        });
      } catch (err) {
        if (!state.isCurrentSession(session)) return;
        state.substationSpatialIndex = null;
        console.warn('[GIM] 缓存 IFC 空间索引恢复失败，保留功能系统视图:', err);
      }

      // STD/SLD 从磁盘缓存恢复：CBM 树就绪后并行执行（不阻塞 IFC 加载）
      // 失败时仅 warn，不影响主流程
      try {
        const { restoreStdSldFromCache, findMissingStdSldCacheParts } =
          await import('./stdSldService.js');
        const stdSldResult = await restoreStdSldFromCache(state);
        if (!state.isCurrentSession(session)) return;
        const missingParts = findMissingStdSldCacheParts(
          index.entries.map((entry) => entry.entry_path),
          stdSldResult,
        );
        if (missingParts.length > 0) {
          throw new Error(
            `本地缓存缺少电气图数据（${missingParts.join('/')}），需要从原始 GIM 重新提取`,
          );
        }
        if (!state.isCurrentSession(session)) return;
        const { commitStdSldResult } = await import('./stdSldService.js');
        commitStdSldResult(state, stdSldResult);
      } catch (err) {
        console.warn('[GIM] STD/SLD 缓存恢复失败:', err);
        // 让外层缓存命中流程回退到完整解压。旧缓存可能有完整 IFC/MOD，
        // 但缺少后来新增的 project.sch / STD / SLD 落盘文件。
        throw err;
      }

      if (!state.isCurrentSession(session)) return;
      perfMarkProductMoment('semanticReady', {
        ifcModels: state.substationSpatialIndex?.models.length ?? 0,
        spatialNodes: state.substationSpatialIndex?.nodes.length ?? 0,
        cbmNodes: collectCbmNodeCount(state.currentCbmTree),
        cacheHit: true,
      }, perfSession);

      // 渲染 SLD 电气单线图与 STD 拓扑列表（缓存命中路径）
      try {
        const { renderSldView } = await import('../ui/sldView.js');
        if (!state.isCurrentSession(session)) return;
        renderSldView(state);
      } catch (err) {
        console.warn('[GIM] SLD 视图渲染失败（缓存命中）:', err);
      }

      // 阶段 4：注册 SLD gridId → CBM 联动回调（缓存命中路径）
      setupSldGridIdInteraction(state, showMessage, session);

      // GIM 视为整体：直接加载全部 IFC + MOD + STL，不弹选择框
      // loadAllIfcFiles 内部会创建 ViewerRuntime、加载 IFC、渲染树、触发 MOD/STL
      await loadAllIfcFiles(state, state.currentIfcEntries, showMessage, {
        session,
        geometryCacheValid: validation.geometry_cache_valid ?? validation.geometry_cache_version_match,
        geometryCacheManifestValid: validation.geometry_cache_manifest_valid,
        geometryCacheVersionFileMatch: validation.geometry_cache_version_file_match,
      });
      debugLog(DEBUG_GIM_CACHE, '[Tauri] 变电工程缓存命中：自动加载全部 IFC + MOD + STL');
      return; // 缓存命中，短路完成
    } catch (err) {
      if (!state.isCurrentSession(session)) return;
      console.warn('[Substation Runtime] warm cache restore failed, falling back to cold path:', err);
    }
  }

  const extractedSource = await context.getExtracted();
  if (!state.isCurrentSession(session)) return;
  let extracted = extractedSource.files;
  if (extractedSource.cacheProjectId != null) {
    const endHydrate = perfBegin('变电小文件批量物化', undefined, perfSession);
    const hydrated = await hydrateNativeSmallFiles(
      extracted,
      extractedSource.cacheProjectId,
      { isCurrent: () => state.isCurrentSession(session) },
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
  const entries = await onGimExtracted(
    state,
    extracted,
    showMessage,
    context.projectName,
    context.projectTypeName,
    session,
  );
  if (!state.isCurrentSession(session)) return;
  if (entries.length === 0) {
    showLoading('该工程未检测到 IFC 文件；如果这是线路工程，请检查工程类型识别日志');
    setTimeout(hideLoading, 4000);
    return;
  }

  const preExtracted = extractedSource;
  const persistProjectId = context.projectId != null && isTauri() ? context.projectId : null;
    // 异步持久化只使用本次打开捕获的不可变输入，避免切换工程后读取新 state。
    const filesForPersist = extracted;
    const ifcEntriesForPersist = entries.slice();
    const cbmTreeForPersist = state.currentCbmTree;
    const fileDevRelationsForPersist = state.fileDevRelations.slice();
    const persistPromise =
      persistProjectId != null
        ? (async () => {
      const projectId = persistProjectId;
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
        showLoading('正在缓存 IFC 文件...');
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

        // v6: 缓存 DEV/PHM/MOD 几何文件到本地磁盘
        if (filesForPersist) {
          showLoading('正在缓存几何文件（DEV/PHM/MOD）...');
          try {
            const { cacheGeometryFiles } = await import('./gimExtractedCacheService.js');
            const geoCacheResult = await cacheGeometryFiles(
              projectId,
              filesForPersist,
            );
            if (!state.isCurrentSession(session)) return;
            debugLog(DEBUG_GIM_CACHE, '[Tauri] 几何文件缓存结果:', {
              cached: geoCacheResult.cachedCount,
              errors: geoCacheResult.errors,
            });
            if (geoCacheResult.errors.length > 0) {
              console.warn('[Tauri] 部分几何文件缓存失败:', geoCacheResult.errors);
            }
          } catch (err) {
            console.error('[Tauri] 几何文件缓存失败:', err);
          }
        }
      }

      // 方案 C：MOD → glTF 离线预序列化缓存
      // 移到 IFC 加载之后作为后台任务（见下方 queueMicrotask），避免阻塞渲染
      // 此处仅记录 files 引用，实际序列化在 loadAllIfcFiles 完成后执行

      showLoading('正在写入 GIM 索引...');
      try {
        if (!state.isCurrentSession(session)) return;
        const { buildGimIndexPayload } = await import('./gimIndexPersistenceService.js');
        const { saveGimIndex } = await import('@desktop/database.js');
        const payload = await buildGimIndexPayload(
          projectId,
          filesForPersist,
          ifcEntriesForPersist,
          cbmTreeForPersist,
          fileDevRelationsForPersist,
          localCachePathMap,
          session.sourceSha256,
        );

        // 校验：即将写入的 IFC local_cache_path 数量
        const payloadIfcEntries = payload.entries.filter((e) => e.entry_type === 'IFC');
        debugLog(DEBUG_GIM_CACHE, '[Tauri] 即将写入 SQLite 的 IFC local_cache_path:', {
          ifc_entries: payloadIfcEntries.length,
          with_cache_path: payloadIfcEntries.filter((e) => !!e.local_cache_path).length,
        });

        if (!state.isCurrentSession(session)) return;
        await saveGimIndex(payload);
        if (!state.isCurrentSession(session)) return;
        debugLog(DEBUG_GIM_CACHE, '[Tauri] GIM 索引已写入:', {
          entries: payload.entries.length,
          cbm_nodes: payload.cbm_nodes.length,
          ifc_models: payload.ifc_models.length,
          file_dev_entries: payload.file_dev_entries.length,
          fam_properties: payload.fam_properties.length,
          dev_properties: payload.dev_properties.length,
        });

        // v6: 同时写入 DEV/PHM 几何引用链索引，用于缓存命中时快速查询
        if (filesForPersist) {
          showLoading('正在索引几何引用链...');
          try {
            const { buildGeometryRefsPayload } = await import('./gimIndexPersistenceService.js');
            const { saveGeometryRefs } = await import('@desktop/database.js');
            const geoPayload = await buildGeometryRefsPayload(projectId, filesForPersist, session.sourceSha256);
            if (!state.isCurrentSession(session)) return;
            debugLog(DEBUG_GIM_CACHE, '[Tauri] 几何引用链索引:', {
              dev_solid_models: geoPayload.dev_solid_models.length,
              dev_sub_devices: geoPayload.dev_sub_devices.length,
              phm_solid_models: geoPayload.phm_solid_models.length,
            });
            await saveGeometryRefs(geoPayload);
            if (!state.isCurrentSession(session)) return;
            debugLog(DEBUG_GIM_CACHE, '[Tauri] 几何引用链索引已写入');
          } catch (geoErr) {
            console.warn('[Tauri] 几何引用链索引写入失败:', geoErr);
          }
        }
      } catch (err) {
        console.error('[Tauri] GIM 索引写入失败:', err);
      }
        })().catch((err) => {
          console.error('[Tauri] 缓存/索引入库后台任务失败:', err);
        })
      : Promise.resolve();

  // GIM 视为整体：直接加载全部 IFC + MOD + STL，不弹选择框。
  // loadAllIfcFiles 内部保留原有 DEV GLB/MOD-STL 策略。
  await Promise.all([loadAllIfcFiles(state, entries, showMessage, { session }), persistPromise]);
}
