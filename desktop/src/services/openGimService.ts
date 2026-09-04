import type { IfcEntry } from '../gim/types.js';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import type { CbmNode } from '../gim/types.js';
import { scanIfcFiles, discoverIfcFromCBM, buildIfcGuidIndex } from '../gim/gimIndexer.js';
import { buildCbmTree, buildCbmNodeIndex } from '../gim/cbmParser.js';
import {
  buildSubstationSpatialIndexFromFiles,
  type SubstationSpatialIndexObserver,
} from '../gim/ifcSpatialParser.js';
import { parseFileDevRelation } from '../gim/fileDevParser.js';
import { buildAndRenderCbmTree } from '../ui/cbmTreeView.js';
import { renderFileDevPanel } from '../ui/fileDevView.js';
import { loadingEl, emptyTipEl, gimFileInput, btnLoadGim } from '../ui/dom.js';
import { isTauri } from '@desktop/runtime.js';
import { openGimFilePath } from '@desktop/fileDialog.js';
import { DEBUG_IFC_LOAD, DEBUG_GIM_CACHE, DEBUG_RUNTIME_LOGS } from '../config/debug.js';
import { isFragmentsCacheEnabled } from '../config/features.js';
import { debugLog } from '../utils/logger.js';
import {
  perfReset,
  perfCurrentSession,
  perfUpdateSessionIdentity,
  perfBegin,
  perfMark,
  perfMarkProductMoment,
  perfProductMomentSnapshot,
  perfRecordExternalSpan,
  perfRecordMemorySample,
  perfRecordSubstationIfcRead,
  perfRecordSubstationIfcProfile,
  perfRecordSubstationFinalizeProfile,
  perfIsCurrentSession,
  type PerfSession,
} from '../utils/perfTimings.js';
import { pushBusy, popBusy } from '../ui/shell/statusBar.js';
import { setProjectIdentity, refreshNavigatorTitle } from '../ui/shell/projectBar.js';
import type { NativeExtractionProfile } from '@desktop/gimExtract.js';
import type { LineParserWorkerResult } from './lineParserWorkerClient.js';
import type { LineParserWorkerFile } from './lineParserWorker.js';
import { hydrateNativeSmallFiles } from './nativeSmallFileHydration.js';

/**
 * 线路 cold Worker 与 warm semantic-pack fast path 共用的状态提交边界。
 * Worker/读取完成后先检查 ProjectLoadSession，再一次性提交 graph、文件
 * 来源和 FAM/DEV 属性，避免旧工程迟到结果覆盖当前工程。
 */
export async function commitLineParserResult(
  state: AppState,
  result: LineParserWorkerResult,
  files: Map<string, File>,
  session: ProjectLoadSession,
): Promise<boolean> {
  // 动态 import 也属于异步边界；必须在任何 AppState 写入前完成，避免
  // 工程切换恰好发生在 import 期间时留下“图已是 A、属性仍是 B”的半提交。
  const { restoreLineAttributesToState } = await import('./lineAttrRestoreService.js');
  if (!state.isCurrentSession(session)) return false;
  state.currentGimGraph = result.graph;
  state.currentFiles = files;
  restoreLineAttributesToState({
    fam_properties: result.attributes.famPayloads,
    dev_properties: result.attributes.devPayloads,
  }, state);
  return state.isCurrentSession(session);
}

/** 将 full semantic-pack 响应转换为 Worker 输入 + lazy currentFiles。 */
export function buildLineSemanticWarmFiles(
  projectId: number,
  items: Array<{ entry_path: string; packed: boolean; size: number; bytes: Uint8Array | null }>,
  createDiskFile: (projectId: number, entryPath: string, size: number, semanticPackBacked?: boolean) => File,
): { files: Map<string, File>; workerFiles: LineParserWorkerFile[] } {
  const files = new Map<string, File>();
  const workerFiles: LineParserWorkerFile[] = [];
  for (const item of items) {
    const path = item.entry_path;
    // currentFiles 永远保持 lazy；即使语义 bytes 已返回给 Worker，也不再
    // 复制到 Blob/File。大 MOD/STL 的 metadata-only 条目同样可按需来源追溯。
    files.set(path, createDiskFile(projectId, path, item.size, item.packed));
    if (item.packed && item.bytes) {
      const bytes = item.bytes;
      const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer as ArrayBuffer
        : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      workerFiles.push({ path, bytes: buffer });
    } else {
      // Worker 只需要路径元数据来保持 filesByType（尤其 MOD/STL）统计，
      // 不把大几何文件送入解析线程。
      workerFiles.push({ path, bytes: new ArrayBuffer(0) });
    }
  }
  return { files, workerFiles };
}

function showLoading(text: string) { loadingEl.textContent = text; loadingEl.style.display = 'block'; pushBusy(text); }
function hideLoading() { loadingEl.style.display = 'none'; popBusy('就绪'); }

/**
 * 采集变电阶段内存。WebView 的 performance.memory（若可用）只代表 JS
 * heap；Tauri command 返回的是后端进程 RSS，两者分别记录，绝不互换。
 * RSS 读取在阶段计时结束后执行，采样 IPC 不会混入业务 span。
 */
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

function recordNativeExtractionStages(
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

/** 取得可读工程名；不能让缺失 GIM header 的线路退化为“未命名线路”。 */
function resolveProjectName(
  headerName: string | undefined,
  headerId: string | undefined,
  fileName: string,
): string {
  const fileStem = (fileName.split(/[\\/]/).pop() || fileName).replace(/\.gim$/i, '').trim();
  return [headerName, headerId, fileStem].map((value) => String(value ?? '').trim()).find(Boolean) || '';
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

/**
 * 线路性能采集的开发期覆盖项。
 *
 * 这些值只从 DEV WebView 的 globalThis 读取，生产构建中的分支会被 Vite
 * 常量折叠掉。这样可以在同一个真实 Tauri WebView 中做 catenary 与 batch
 * 规模 A/B，而不会把实验开关暴露成用户可配置的产品行为。
 */
function getDevLineBatchOptions(): { maxFiles?: number; maxBytes?: number } {
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

function getDevLineCatenaryMode(): boolean | undefined {
  if (!import.meta.env.DEV) return undefined;
  const value = (globalThis as { __GIM_DEV_CATENARY_MODE__?: unknown }).__GIM_DEV_CATENARY_MODE__;
  return typeof value === 'boolean' ? value : undefined;
}

/** 创建统一的节点点击回调 */
function createNodeClickHandler(state: AppState, showMessage: (text: string) => void): (node: CbmNode) => void {
  return (node: CbmNode) => {
    import('./nodeInteractionService.js').then(({ handleNodeClick }) => {
      handleNodeClick(state, node, showMessage);
    });
  };
}

/**
 * 注册 SLD gridId 点击联动回调（阶段 4：SLD → CBM 联动）。
 *
 * 在 GIM 打开后（首次或缓存命中）调用一次：
 * - 用户点击 SLD SVG 元素或 STD 拓扑项 → 通过 gridId 查找 CBM 节点 → 触发 handleNodeClick
 * - 失败时仅 warn，不影响 SLD 自身的高亮
 *
 * 配套：nodeInteractionService 在 handleNodeClick 末尾调用 highlightSldByGridId 实现 CBM → SLD 反向联动
 */
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

/** GIM 文件解压后的处理流程 */
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
  options: { session?: ProjectLoadSession } = {},
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
    await autoLoadModStlPostIfc(state, showMessage, undefined, { session });
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
  options?: { token?: number; includeMod?: boolean; includeStl?: boolean; session?: ProjectLoadSession },
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

      finishModStl(undefined, {
        path: 'progressive-dev-glb',
        compiledDevs: result.compiledDevs,
        renderedInstances: result.renderedInstances,
        interrupted: result.interrupted,
      });
      if (!result.interrupted && (result.renderedInstances > 0)) {
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
          modInstances: result.renderedInstances,
          compiledDevs: result.compiledDevs,
          stlInstances: 0,
        }, perfSession);
        await sampleSubstationMemory('full ready 后', perfSession, {
          path: 'progressive-dev-glb',
          renderedInstances: result.renderedInstances,
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
async function openGimFromArrayBuffer(
  state: AppState,
  fileName: string,
  ab: ArrayBuffer | null,
  showMessage: (text: string) => void,
  options?: {
    projectId?: number;
    sourceSha256?: string | null;
    persistIndex?: boolean;
    /** 创建打开请求时捕获的代次；请求被新打开动作取代时立即放弃。 */
    requestGeneration?: number;
  },
  preExtracted?: {
    files: Map<string, File>;
    magic: string;
    projectName?: string;
    projectId?: string;
    /** native extraction 的 SQLite project id，用于批量物化小文件 */
    cacheProjectId?: number;
    nativeExtractionMs?: number;
    extractionProfile?: NativeExtractionProfile;
    cachePaths?: Map<string, string>;
  },
): Promise<void> {
  const requestGeneration = options?.requestGeneration ?? state.projectGeneration;
  const requestIsCurrent = () => state.projectGeneration === requestGeneration;
  if (!requestIsCurrent()) return;
  let perfSession: PerfSession = perfCurrentSession();
  let extracted: Map<string, File>;
  let projectTypeName: string;
  let projectName: string;
  let gimHeader: ReturnType<typeof import('../gim/gimExtractor.js').extractGimHeader>;

  if (preExtracted) {
    // acc-plan P0-2：Rust 原生解压已完成，直接使用结果
    extracted = preExtracted.files;
    const { getProjectTypeName } = await import('../gim/gimExtractor.js');
    projectTypeName = getProjectTypeName(preExtracted.magic);
    gimHeader = {
      magic: preExtracted.magic,
      archiveOffset: 0,
      projectId: preExtracted.projectId,
      projectName: preExtracted.projectName,
    };
    projectName = resolveProjectName(preExtracted.projectName, preExtracted.projectId, fileName);
  } else {
    // Tauri fallback（WASM）和浏览器路径都已经在打开请求入口处建立了
    // 性能 session。只更新身份，不重置起点，保留“文件读取/解压模块/
    // 解压”这些冷启动前半段 span；若调用方没有同一代次的 session，
    // 再建立一个新的会话作为安全兜底。
    const currentPerf = perfCurrentSession();
    if (currentPerf.generation === requestGeneration) {
      perfUpdateSessionIdentity({
        projectId: options?.projectId ?? null,
        sourceSha256: options?.sourceSha256 ?? null,
      });
    } else {
      perfReset({
        generation: requestGeneration,
        projectId: options?.projectId ?? null,
        sourceSha256: options?.sourceSha256 ?? null,
      });
    }
    perfSession = perfCurrentSession();
    const endExtract = perfBegin('解压', undefined, perfSession);
    showLoading('正在加载 GIM 解压模块...');
    const { extractGimFile, extractGimHeader, getProjectTypeName } = await import('../gim/gimExtractor.js');
    // 先解析 GIM 头部提取工程类型名（F1System 根节点显示用）和工程名称
    gimHeader = extractGimHeader(ab!);
    projectName = resolveProjectName(gimHeader?.projectName, gimHeader?.projectId, fileName);
    projectTypeName = getProjectTypeName(gimHeader?.magic || '');
    showLoading('正在解压 GIM 文件...');
    extracted = await extractGimFile(ab!);
    if (!requestIsCurrent()) return;
    endExtract('（首开）', { files: extracted.size });
    await sampleSubstationMemory('extraction 后', perfSession, {
      mode: 'wasm',
      files: extracted.size,
      bytes: ab?.byteLength ?? 0,
    });
  }

  // native preExtracted 路径和 Tauri WASM 回退路径都沿用打开请求入口处的
  // 性能 session；浏览器路径也只在没有同代 session 时新建。此时
  // perfSession 已是本次流程的 immutable 快照。

  if (!requestIsCurrent()) return;

  // 清空上一次 GIM 的状态，避免变电 ↔ 线路切换时残留
  // 统一走 cleanupBeforeOpenNewProject：销毁线路地图 + dispose 旧 fragments 模型 +
  // 重置高亮 + 清空 model-list UI + resetGimState + hasFittedCamera=false
  // 关键：必须先 dispose ctx.fragments 中的旧模型，再 resetGimState（否则 ctx 残留）
  const { cleanupBeforeOpenNewProject } = await import('./projectCleanupService.js');
  const cleanupOk = await cleanupBeforeOpenNewProject(state, requestGeneration);
  if (!cleanupOk) return;

  // 清理完成后再激活新工程身份；所有后续异步任务都以该快照为边界。
  const session = state.activateProject(options?.projectId ?? null, options?.sourceSha256 ?? null);
  // cleanup 会递增 projectGeneration；将性能会话身份同步到真正激活的
  // session，但不要重置起点，否则会再次丢失冷启动解压和前置检查耗时。
  perfUpdateSessionIdentity({
    generation: session.generation,
    projectId: session.projectId,
    sourceSha256: session.sourceSha256,
  });
  perfSession = perfCurrentSession();
  // 两类工程共用工程身份；线路分支不会经过 onGimExtracted，必须在类型
  // 分支之前写入 state，避免导航树回退到“未命名线路”。
  state.projectName = projectName;

  // 工程类型识别：线路工程走独立流程，不弹 IFC 模态框，不创建 Viewer
  showLoading('正在识别工程类型...');
  const endDetect = perfBegin('工程类型识别', undefined, perfSession);
  const { detectGimProjectType } = await import('../gim/projectType.js');
  const projectTypeResult = await detectGimProjectType(extracted);
  if (!state.isCurrentSession(session)) return;
  endDetect(undefined, { type: projectTypeResult.type });
  state.currentProjectType = projectTypeResult.type;

  // Native manifest-only 解压之后，变电流程会在 CBM/FAM/DEV、STD/SLD、
  // 几何引用链等阶段重复读取同一批小文本文件。先用既有 batch IPC
  // 物化有界小文件，避免“解压一次 + 数万次单条 read_cached_entry”；
  // IFC、大文件和线路 semantic-pack 条目仍保持 lazy，不改变其内存边界。
  if (projectTypeResult.type !== 'transmission_line' && preExtracted?.cacheProjectId != null) {
    const endHydrate = perfBegin('变电小文件批量物化', undefined, perfSession);
    const hydrated = await hydrateNativeSmallFiles(
      extracted,
      preExtracted.cacheProjectId,
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

  // M0 设计系统：顶栏工程身份 + 导航器标题
  const kind = projectTypeResult.type === 'transmission_line' ? 'transmission_line'
    : projectTypeResult.type === 'substation' ? 'substation' : null;
  setProjectIdentity(projectName || null, kind);
  refreshNavigatorTitle();

  // 运行时诊断：打印识别结果与解压路径样本，便于排查真实解压结构
  debugLog(DEBUG_RUNTIME_LOGS, '[GIM Runtime Detect]', {
    type: projectTypeResult.type,
    details: projectTypeResult.details,
    samplePaths: Array.from(extracted.keys()).slice(0, 80),
  });
  // 非 transmission_line 时打印若干 cbm 文本样本，确认真实路径与 KEY
  if (projectTypeResult.type !== 'transmission_line') {
    const cbmSamples = Array.from(extracted.entries())
      .filter(([p]) => /\.cbm$/i.test(p))
      .slice(0, 5);
    for (const [p, f] of cbmSamples) {
      debugLog(DEBUG_RUNTIME_LOGS, '[GIM Runtime Detect] cbm sample', p, (await f.text()).slice(0, 500));
    }
  }

  // 无法识别工程类型：既未检测到 IFC，也未检测到线路工程特征。
  // 不进入变电流程，不调用 saveGimIndex，避免 project_type=substation 污染数据库。
  if (projectTypeResult.type === 'unknown') {
    showLoading('无法识别 GIM 工程类型：既未检测到 IFC，也未检测到线路工程特征');
    setTimeout(hideLoading, 4000);
    return;
  }

  if (projectTypeResult.type === 'transmission_line') {
    // 线路工程流程：先按批次准备可转移的文本输入，再由 Line Parser Worker
    // 一次完成 GimGraph + FAM/DEV 属性解析；不走 IFC/Viewer 流程。
    showLoading('正在批量读取线路 CBM/FAM/DEV 文件...');
    const endInput = perfBegin('线路解析输入', undefined, perfSession);
    const { readLineParserInput } = await import('./lineParserInput.js');
    const lineBatchOptions = getDevLineBatchOptions();
    const parserInput = await readLineParserInput(extracted, session.projectId, {
      ...lineBatchOptions,
      isCurrent: () => state.isCurrentSession(session),
    });
    if (parserInput.cancelled || !state.isCurrentSession(session)) return;
    endInput(undefined, {
      files: parserInput.files.length,
      requested: parserInput.requested,
      bytes: parserInput.bytes,
      batches: parserInput.batches,
      semanticPackReads: parserInput.semanticPackReads,
      skippedLargeModFiles: parserInput.skippedLargeModFiles,
      skippedLargeModBytes: parserInput.skippedLargeModBytes,
      maxFiles: lineBatchOptions.maxFiles ?? 1024,
      maxBytes: lineBatchOptions.maxBytes ?? 8 * 1024 * 1024,
    });
    showLoading('正在后台解析线路 CBM 与属性...');
    const endGraph = perfBegin('线路图构建+属性解析', undefined, perfSession);
    const { parseLineInWorker } = await import('./lineParserWorkerClient.js');
    let workerResult: Awaited<ReturnType<typeof parseLineInWorker>>;
    try {
      workerResult = await parseLineInWorker(parserInput.files, session);
    } catch (error) {
      // 清理工程时主动终止旧 Worker 会拒绝其 promise；这是正常的取消，
      // 不应被外层打开流程误报为“GIM 解析失败”。当前工程的真实错误仍上抛。
      if (!state.isCurrentSession(session)) return;
      throw error;
    }
    if (!state.isCurrentSession(session)) return;
    const graph = workerResult.graph;
    const attrResult = workerResult.attributes;
    endGraph(undefined, {
      nodes: graph.stats.total,
      files: parserInput.files.length,
      bytes: parserInput.bytes,
      batches: parserInput.batches,
      worker: workerResult.timings.worker,
      workerMs: Math.round(workerResult.timings.totalMs),
      graphMs: Math.round(workerResult.timings.graphMs),
      attributesMs: Math.round(workerResult.timings.attributesMs),
    });
    perfMark('线路图就绪', { nodes: graph.stats.total }, perfSession);
    // Worker 的属性结果与缓存命中结构同构；cold/warm 共用同一提交边界。
    if (!await commitLineParserResult(state, workerResult, extracted, session)) return;

    // v5: 首次导入 → 解析 FAM/DEV 属性 → 恢复到 state → 渲染面板。
    // 注意：render 必须在 restore attrs 之后，否则 extractLineMapData 拿不到
    //       FAM/DEV 属性，塔位编号/塔型/呼高/转角等 tooltip 字段会缺失。
    // SQLite 事务写入移到首帧之后，避免数万节点/属性的 JSON + IPC 把“可交互”
    // 阻塞数秒；save_line_project_finish 仍是缓存提交点，写入失败不会把
    // 半成品标记为有效缓存。
    if (options?.persistIndex && options.projectId != null && isTauri()) {
      if (import.meta.env.DEV) {
        // 真实 Tauri 性能采集需要知道后台入库何时完成，才能在诊断快照中
        // 同时看到该 span，并避免下一次 cold run 删除缓存时与旧写入交错。
        (globalThis as { __GIM_DEV_LINE_CACHE_PERSIST_DONE__?: boolean }).__GIM_DEV_LINE_CACHE_PERSIST_DONE__ = false;
      }
      const persistLineCache = async (): Promise<void> => {
        if (!state.isCurrentSession(session)) return;
        try {
          const { estimatePayloadSizeMB } = await import('./lineAttrPersistenceService.js');
          const { buildLineGraphPayload } = await import('./lineGraphPersistenceService.js');
          const { saveLineProjectCache } = await import('@desktop/database.js');
          if (!state.isCurrentSession(session)) return;

          const graphPayload = buildLineGraphPayload(options.projectId!, graph, session.sourceSha256);

          // 性能日志：payload 统计 + 风险评估。graphPayloadJson 同时作为
          // invokeTimed 的已知 requestBytes，避免监控再次 JSON.stringify。
          const graphPayloadJson = JSON.stringify(graphPayload);
          const graphPayloadBytes = new TextEncoder().encode(graphPayloadJson).byteLength;
          const estimatedMB = estimatePayloadSizeMB(
            graphPayloadJson,
            attrResult.famPayloads,
            attrResult.devPayloads,
          );
          debugLog(DEBUG_GIM_CACHE, '[LineCache] 线路后台入库 payload 统计:', {
            nodes: graphPayload.nodes.length,
            children: graphPayload.children.length,
            refs: graphPayload.refs.length,
            fam_props: attrResult.famPayloads.length,
            dev_props: attrResult.devPayloads.length,
            estimatedJsonSizeMB: Math.round(estimatedMB * 100) / 100,
          });
          if (estimatedMB > 50) {
            console.warn(
              `[LineCache] payload 较大 (${Math.round(estimatedMB * 100) / 100} MB)，后台一次性 invoke 可能较慢`,
            );
          }

          const endSave = perfBegin('线路 SQLite 入库（后台）', undefined, perfSession);
          const t0 = performance.now();
          if (!state.isCurrentSession(session)) return;
          await saveLineProjectCache(
            options.projectId!,
            graphPayload,
            attrResult.famPayloads,
            attrResult.devPayloads,
            undefined,
            session.sourceSha256,
            graphPayloadBytes,
          );
          if (!state.isCurrentSession(session)) return;
          const elapsedMs = Math.round(performance.now() - t0);
          endSave(undefined, { ms: elapsedMs, background: true });
          debugLog(DEBUG_GIM_CACHE, '[LineCache] 后台 save_line_project_cache 完成，耗时', elapsedMs, 'ms');
        } catch (err) {
          // 工程切换后的旧任务不应在新工程控制台制造错误噪声。
          if (state.isCurrentSession(session)) {
            console.error('[Tauri] 线路工程缓存后台写入失败:', err);
          }
        } finally {
          if (import.meta.env.DEV && state.isCurrentSession(session)) {
            (globalThis as { __GIM_DEV_LINE_CACHE_PERSIST_DONE__?: boolean }).__GIM_DEV_LINE_CACHE_PERSIST_DONE__ = true;
          }
        }
      };
      // 让浏览器先完成首帧绘制并返回可交互状态，再开始 JSON/SQLite IPC。
      window.setTimeout(() => { void persistLineCache(); }, 0);
    } else if (import.meta.env.DEV) {
      (globalThis as { __GIM_DEV_LINE_CACHE_PERSIST_DONE__?: boolean }).__GIM_DEV_LINE_CACHE_PERSIST_DONE__ = true;
    }

    // 渲染面板（在属性恢复之后，确保地图 tooltip/标签有完整 FAM/DEV 属性）
    if (!state.isCurrentSession(session)) return;
    const endRender = perfBegin('线路面板+地图渲染', undefined, perfSession);
    const { renderLineProjectPanels } = await import('../ui/lineProjectView.js');
    renderLineProjectPanels(state, graph, showMessage, {
      perfSession,
      enableCatenary: getDevLineCatenaryMode(),
    });
    endRender();
    perfMark('线路工程可交互', undefined, perfSession);

    hideLoading();
    // 轻量状态提示
    showLoading('线路工程已加载，当前为地图浏览模式');
    setTimeout(hideLoading, 3000);
    debugLog(DEBUG_RUNTIME_LOGS, '[GIM] 线路工程已加载（地图浏览模式），跳过 IFC 模态框');
    return;
  }

  if (projectTypeResult.type === 'hybrid') {
    console.warn('[GIM] hybrid project detected, using substation IFC flow first');
  }

  // 变电工程流程（含 hybrid）：解析 CBM 树 + FileDevRelation + IFC 发现
  showLoading('正在解析 GIM 层级结构...');
  const entries = await onGimExtracted(state, extracted, showMessage, projectName, projectTypeName, session);
  if (!state.isCurrentSession(session)) return;

  // 无 IFC entry：可能是线路工程被误识别为 substation。
  // 不写入 saveGimIndex（避免 project_type=substation 污染），提示检查识别日志。
  if (entries.length === 0) {
    showLoading('该工程未检测到 IFC 文件；如果这是线路工程，请检查工程类型识别日志');
    setTimeout(hideLoading, 4000);
    return;
  }

  // Tauri 模式：写入 GIM 索引到 SQLite（仅当存在 IFC entry 时才允许写入）
  // P2 评审后优化：缓存写入与 IFC 加载并行执行——IFC 文件不可变，
  // 缓存落盘（IO/IPC 密集）与 web-ifc 解析渲染（CPU 密集）互不依赖，
  // 不必串行等待。persistPromise 在 IFC 加载完成后统一 await。
  const persistProjectId = options?.persistIndex && session.projectId != null && isTauri() ? session.projectId : null;
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

  // GIM 视为整体：直接加载全部 IFC + MOD + STL，不弹选择框
  // loadAllIfcFiles 内部最后以后台任务启动渐进式 DEV GLB 管线
  // （序列化 → 落盘 → 逐实例渲染一体，替代原"MOD 逐实例加载 + GLB 序列化"两遍解析）
  // 与缓存/索引入库并行：IFC 渲染不再等待磁盘缓存写入
  await Promise.all([loadAllIfcFiles(state, entries, showMessage, { session }), persistPromise]);
}

/**
 * 打开 GIM 文件的动作函数（供 bootstrap 懒加载调用）。
 * - 对话框立即打开，不等待 3D 引擎
 * - FileInfo / 缓存校验不需要 3D
 * - 完整解压路径也不创建 Viewer，只做读取+解压+索引+渲染树
 * - Viewer 仅在节点点击 / IFC 弹窗加载 / 本地 IFC 打开时按需创建
 */
export async function openGimWithDialog(
  state: AppState,
  showMessage: (text: string) => void,
): Promise<void> {
  if (isTauri()) {
    // 1. 对话框立即打开（无 3D 依赖）
    const filePath = getDevPerformanceFilePath() ?? await openGimFilePath();
    if (!filePath) return;
    // 文件选择完成即失效旧工程的在途任务，避免读取/解压期间旧几何继续写入场景。
    state.invalidatePendingLoads();
    const requestGeneration = state.projectGeneration;
    // 性能会话也必须在请求开始的同步边界失效；否则旧工程的迟到 invoke/span
    // 可能在缓存校验或原生解压期间继续写入上一会话。
    perfReset({ generation: requestGeneration, projectId: null, sourceSha256: null });
    const requestPerfSession = perfCurrentSession();
    btnLoadGim.disabled = true;
    try {
      // 2. FileInfo + 缓存校验（无 3D 依赖）
      showLoading('正在读取 GIM 文件信息...');
      const { getFileInfo, readFileBytes } = await import('@desktop/fileReader.js');
      const endFileInfo = perfBegin('冷启动：读取 GIM 文件信息', undefined, requestPerfSession);
      const info = await getFileInfo(filePath);
      if (state.projectGeneration !== requestGeneration) return;
      endFileInfo(undefined, { bytes: info.size });
      debugLog(DEBUG_GIM_CACHE, '[Tauri] GIM 文件信息:', info);
      showLoading('正在写入本地项目索引...');
      const { upsertGimProject, validateGimCache, getGimIndex } = await import('@desktop/database.js');
      const endUpsert = perfBegin('冷启动：项目索引登记', undefined, requestPerfSession);
      const record = await upsertGimProject(info);
      if (state.projectGeneration !== requestGeneration) return;
      endUpsert(undefined, { projectId: record.id });
      perfUpdateSessionIdentity({ projectId: record.id, sourceSha256: record.sha256 });
      debugLog(DEBUG_GIM_CACHE, '[Tauri] GIM 项目记录:', record);

      showLoading('正在检查本地缓存...');
      const endValidate = perfBegin('冷启动：缓存校验', undefined, requestPerfSession);
      const validation = await validateGimCache(record.id);
      if (state.projectGeneration !== requestGeneration) return;
      endValidate(undefined, {
        valid: validation.valid,
        type: validation.project_type ?? null,
        cacheMissReason: validation.cache_miss_reason ?? null,
        storedParserVersion: validation.stored_parser_version ?? null,
        currentParserVersion: validation.current_parser_version,
        parserVersionMatch: validation.parser_version_match,
        storedLineParserVersion: validation.stored_line_parser_version ?? null,
        currentLineParserVersion: validation.current_line_parser_version,
        lineParserVersionMatch: validation.line_parser_version_match,
        storedSubstationParserVersion: validation.stored_substation_parser_version ?? null,
        currentSubstationParserVersion: validation.current_substation_parser_version,
        substationParserVersionMatch: validation.substation_parser_version_match,
        lineSemanticPackStatus: validation.line_semantic_pack_status,
        lineSemanticPackError: validation.line_semantic_pack_error ?? null,
        geometryCacheVersionMatch: validation.geometry_cache_version_match,
      });
      debugLog(DEBUG_GIM_CACHE, '[Tauri] GIM 缓存校验:', validation);

      // 3. 缓存命中短路：不 readFileBytes、不 extractGimFile、不创建 Viewer
      if (validation.valid) {
        try {
          // 保留文件信息/项目登记/缓存校验 span；这里仅同步最终工程身份。
          perfUpdateSessionIdentity({
            generation: requestGeneration,
            projectId: record.id,
            sourceSha256: record.sha256,
          });
          const perfSession = perfCurrentSession();
          // 清空上一次 GIM 的状态，避免残留
          // 统一走 cleanupBeforeOpenNewProject：销毁线路地图 + dispose 旧 fragments 模型 +
          // 重置高亮 + 清空 model-list UI + resetGimState + hasFittedCamera=false
          const { cleanupBeforeOpenNewProject } = await import('./projectCleanupService.js');
          const cleanupOk = await cleanupBeforeOpenNewProject(state, requestGeneration);
          if (!cleanupOk) return;
          const session = state.activateProject(record.id, record.sha256);
          state.projectName = resolveProjectName(record.name, undefined, record.name);

          // 线路工程缓存命中：优先从完整 semantic pack 读取并复用 Line Parser
          // Worker；pack/index 不可用时才回退旧 SQLite graph/attribute restore。
          if (validation.project_type === 'transmission_line') {
            state.currentProjectType = 'transmission_line';
            setProjectIdentity(record.name || null, 'transmission_line');
            refreshNavigatorTitle();
            let graph!: Awaited<ReturnType<typeof import('./lineParserWorkerClient.js').parseLineInWorker>>['graph'];
            let attrStats!: { famCount: number; devCount: number; famSources: number; devSources: number };
            let usedSemanticFastPath = false;

            if (validation.line_semantic_pack_status === 'valid') {
              try {
                showLoading('正在读取线路 semantic pack...');
                const endPack = perfBegin('线路 semantic pack 读取（缓存命中）', undefined, perfSession);
                const { readLineSemanticPackAll } = await import('@desktop/database.js');
                const full = await readLineSemanticPackAll(record.id);
                if (!state.isCurrentSession(session)) return;
                endPack(undefined, {
                  entries: full.profile.entryCount,
                  packed: full.profile.packedCount,
                  bytes: full.profile.bytes,
                  indexMs: full.profile.indexMs,
                  resolveMs: full.profile.resolveMs,
                  readMs: full.profile.readMs,
                  encodeMs: full.profile.encodeMs,
                  totalMs: full.profile.totalMs,
                });

                const { createDiskBackedFile } = await import('@desktop/gimExtract.js');
                const prepared = buildLineSemanticWarmFiles(record.id, full.items, createDiskBackedFile);
                showLoading('正在由 Worker 恢复线路图与属性...');
                const endWorker = perfBegin('线路图构建+属性解析（semantic warm Worker）', undefined, perfSession);
                const { parseLineInWorker } = await import('./lineParserWorkerClient.js');
                const workerResult = await parseLineInWorker(prepared.workerFiles, session);
                if (!state.isCurrentSession(session)) return;
                endWorker(undefined, {
                  nodes: workerResult.graph.stats.total,
                  worker: workerResult.timings.worker,
                  workerMs: Math.round(workerResult.timings.totalMs),
                  graphMs: Math.round(workerResult.timings.graphMs),
                  attributesMs: Math.round(workerResult.timings.attributesMs),
                });
                if (!await commitLineParserResult(state, workerResult, prepared.files, session)) return;
                graph = workerResult.graph;
                attrStats = {
                  famCount: workerResult.attributes.famPayloads.length,
                  devCount: workerResult.attributes.devPayloads.length,
                  famSources: new Set(workerResult.attributes.famPayloads.map((item) => item.normalized_path)).size,
                  devSources: new Set(workerResult.attributes.devPayloads.map((item) => item.normalized_path)).size,
                };
                usedSemanticFastPath = true;
                if (import.meta.env.DEV) {
                  (globalThis as { __GIM_DEV_LINE_SEMANTIC_FAST_PATH__?: boolean }).__GIM_DEV_LINE_SEMANTIC_FAST_PATH__ = true;
                }
              } catch (error) {
                const kind = (error as { kind?: unknown } | null)?.kind;
                const message = error instanceof Error ? error.message : String(error);
                const integrityFailure = kind === 'PACK_INVALID'
                  || kind === 'INDEX_INVALID'
                  || kind === 'PACK_TRUNCATED'
                  || /^(PACK_INVALID|INDEX_INVALID|PACK_TRUNCATED)\s*:/i.test(message);
                if (integrityFailure) {
                  // validation 后 pack 仍可能被外部删除/截断；整体失效，
                  // 交给外层回退完整解压重建，禁止 SQLite partial Runtime。
                  throw error;
                }
                console.warn('[Tauri] semantic pack fast path 不可用，回退 SQLite 线路缓存:', error);
              }
            }

            if (!usedSemanticFastPath) {
              showLoading('正在从本地缓存恢复线路工程索引...');
              const endRestoreGraph = perfBegin('线路图恢复（SQLite 缓存命中）', undefined, perfSession);
              const { getLineGraph, getLineAttributes } = await import('@desktop/database.js');
              const { restoreLineGraphToState } = await import('./lineGraphRestoreService.js');
              const { restoreLineAttributesToState } = await import('./lineAttrRestoreService.js');
              const result = await getLineGraph(record.id);
              if (!state.isCurrentSession(session)) return;
              graph = restoreLineGraphToState(state, result);
              endRestoreGraph(undefined, { nodes: graph.stats.total });
              showLoading('正在从本地缓存恢复线路 FAM/DEV 属性...');
              const endRestoreAttrs = perfBegin('线路属性恢复（SQLite 缓存命中）', undefined, perfSession);
              const attrResult = await getLineAttributes(record.id);
              if (!state.isCurrentSession(session)) return;
              attrStats = restoreLineAttributesToState(attrResult, state);
              endRestoreAttrs(undefined, { fam: attrStats.famCount, dev: attrStats.devCount });
              if (import.meta.env.DEV) {
                (globalThis as { __GIM_DEV_LINE_SEMANTIC_FAST_PATH__?: boolean }).__GIM_DEV_LINE_SEMANTIC_FAST_PATH__ = false;
              }
            }

            const { renderLineProjectPanels } = await import('../ui/lineProjectView.js');
            if (!state.isCurrentSession(session)) return;
            const endRestoreMap = perfBegin(
              usedSemanticFastPath ? '线路面板+地图渲染（semantic warm）' : '线路面板+地图渲染（SQLite 缓存命中）',
              undefined,
              perfSession,
            );
            renderLineProjectPanels(state, graph, showMessage, {
              perfSession,
              enableCatenary: getDevLineCatenaryMode(),
            });
            endRestoreMap(undefined, {
              nodes: graph.stats.total,
              towers: graph.stats.Tower_Device,
              wires: graph.stats.WIRE,
              crosses: graph.stats.CROSS,
            });
            perfMark(
              usedSemanticFastPath ? '线路工程可交互（semantic warm）' : '线路工程可交互（SQLite 缓存命中）',
              undefined,
              perfSession,
            );
            emptyTipEl.style.display = 'none';

            hideLoading();
            showLoading(usedSemanticFastPath ? '已从 semantic pack 恢复线路工程' : '已从本地缓存恢复线路工程索引');
            setTimeout(hideLoading, 3000);
            if (import.meta.env.DEV) {
              (globalThis as { __GIM_DEV_LINE_CACHE_PERSIST_DONE__?: boolean }).__GIM_DEV_LINE_CACHE_PERSIST_DONE__ = true;
            }
            debugLog(DEBUG_GIM_CACHE, '[Tauri] 线路工程缓存短路生效：未读取原始 GIM，未执行解压', {
              project_id: record.id,
              nodes: graph.stats.total,
              famProperties: attrStats.famCount,
              devProperties: attrStats.devCount,
              famSources: attrStats.famSources,
              devSources: attrStats.devSources,
              semanticFastPath: usedSemanticFastPath,
            });
            return; // 线路工程缓存命中，短路完成
          }

          // 变电工程缓存命中 → 恢复 GIM 索引（原有逻辑）
          state.currentProjectType = 'substation';
          setProjectIdentity(record.name || null, 'substation');
          refreshNavigatorTitle();

          showLoading('正在从本地缓存恢复 GIM 索引...');
          const { restoreGimIndexToState } = await import('./gimIndexRestoreService.js');

          const endRestoreCore = perfBegin('变电 CBM/FAM/DEV/FileDevRelation（缓存命中）', undefined, perfSession);
          const index = await getGimIndex(record.id);
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
            project_id: record.id,
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
                createDiskBackedFile(record.id, cachedEntry.entry_path, cachedEntry.file_size),
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
          await loadAllIfcFiles(state, state.currentIfcEntries, showMessage, { session });
          debugLog(DEBUG_GIM_CACHE, '[Tauri] 变电工程缓存命中：自动加载全部 IFC + MOD + STL');
          return; // 缓存命中，短路完成
        } catch (err) {
          if (state.projectGeneration !== requestGeneration) return;
          console.warn('[Tauri] 缓存恢复失败，回退完整解压流程:', err);
        }
      } else {
        debugLog(DEBUG_GIM_CACHE, '[Tauri] 缓存无效或不完整，继续完整解压流程:', validation);
        // 清理陈旧 GLB 缓存目录（如 _version.txt 缺失导致 geometry_cache_version_match=false），
        // 避免陈旧 GLB 文件残留造成"缓存已存在"的假象。仅 Tauri 环境下执行。
        if (isTauri() && !validation.geometry_cache_version_match) {
          try {
            const { deleteGlbCache } = await import('@desktop/database.js');
            await deleteGlbCache(record.id);
            debugLog(DEBUG_GIM_CACHE, '[Tauri] 已清理陈旧 GLB 缓存目录');
          } catch (err) {
            console.warn('[Tauri] 清理 GLB 缓存失败:', err);
          }
        }
      }

      // 4. 回退：完整解压流程（不创建 Viewer，只做读取+解压+索引+渲染树）
      debugLog(DEBUG_GIM_CACHE, '[Tauri] 缓存短路未生效：进入完整解压流程');
      // acc-plan P0-2：优先 Rust 原生解压（含资源配额），失败回退 libarchive.js WASM
      let preExtracted: Awaited<ReturnType<typeof import('@desktop/gimExtract.js').extractGimArchiveNative>> | undefined;
      let endNative: ((labelSuffix?: string, endMeta?: Record<string, unknown>) => void) | null = null;
      try {
        // 不重置性能会话，确保冷启动总时间包含文件信息/缓存校验和本次解压。
        perfUpdateSessionIdentity({
          generation: requestGeneration,
          projectId: record.id,
          sourceSha256: record.sha256,
        });
        const perfSession = perfCurrentSession();
        endNative = perfBegin('解压（Rust 原生）', undefined, perfSession);
        const { extractGimArchiveNative } = await import('@desktop/gimExtract.js');
        preExtracted = await extractGimArchiveNative(filePath, record.id);
        if (state.projectGeneration !== requestGeneration) return;
        endNative(undefined, {
          files: preExtracted.files.size,
          extraction: preExtracted.extractionProfile ?? null,
        });
        recordNativeExtractionStages(preExtracted.extractionProfile, perfSession);
        perfMark('原生解压完成', {
          files: preExtracted.files.size,
          extraction: preExtracted.extractionProfile ?? null,
        }, perfSession);
        await sampleSubstationMemory('extraction 后', perfSession, {
          mode: 'native',
          files: preExtracted.files.size,
          extraction: preExtracted.extractionProfile ?? null,
        });
      } catch (nativeErr) {
        const nativeMessage = nativeErr instanceof Error ? nativeErr.message : String(nativeErr);
        endNative?.('（失败）', { error: nativeMessage });
        // 资源配额是安全边界，不得通过 WASM 回退绕过；仅能力/格式/运行时
        // 不可用时才允许走前端解压器。
        if (/超出资源配额|资源配额|压缩比超限|条目数超限|单文件.*超限|总解压量.*超限/i.test(nativeMessage)) {
          throw nativeErr;
        }
        console.warn('[Tauri] 原生解压不可用，回退 libarchive.js WASM 路径:', nativeErr);
        preExtracted = undefined;
      }

      let ab: ArrayBuffer | null = null;
      if (!preExtracted) {
        showLoading('正在读取 GIM 文件...');
        const perfSession = perfCurrentSession();
        const endFallbackRead = perfBegin('冷启动：读取 GIM 原始文件（WASM 回退）', undefined, perfSession);
        ab = await readFileBytes(filePath);
        if (state.projectGeneration !== requestGeneration) return;
        endFallbackRead(undefined, { bytes: ab.byteLength });
      }

      const fileName = filePath.split(/[\\/]/).pop() || 'project.gim';
      await openGimFromArrayBuffer(state, fileName, ab, showMessage, {
        projectId: record.id,
        sourceSha256: record.sha256,
        persistIndex: true,
        requestGeneration,
      }, preExtracted);
    } catch (err) {
      console.error(err);
      showLoading(`GIM 解析失败: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(hideLoading, 3000);
    } finally { btnLoadGim.disabled = false; }
    return;
  }

  // 浏览器模式：input.click() 立即触发，change 后读取+解压（不创建 Viewer）
  state.invalidatePendingLoads();
  const requestGeneration = state.projectGeneration;
  perfReset({ generation: requestGeneration, projectId: null, sourceSha256: null });
  return new Promise<void>((resolve) => {
    const handler = async () => {
      gimFileInput.removeEventListener('change', handler);
      const files = Array.from(gimFileInput.files || []);
      if (files.length === 0) { resolve(); return; }
      if (state.projectGeneration !== requestGeneration) { resolve(); return; }
      btnLoadGim.disabled = true;
      try {
        const ab = await files[0].arrayBuffer();
        if (state.projectGeneration !== requestGeneration) return;
        await openGimFromArrayBuffer(state, files[0].name, ab, showMessage, { requestGeneration });
      } catch (err) {
        console.error(err);
        showLoading(`GIM 解析失败: ${err instanceof Error ? err.message : String(err)}`);
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
