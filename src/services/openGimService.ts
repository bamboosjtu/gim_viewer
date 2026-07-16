import type { IfcEntry } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import type { ModelEventCallbacks } from '../viewer/ifcLoader.js';
import type { CbmNode } from '../gim/types.js';
import { scanIfcFiles, discoverIfcFromCBM, buildIfcGuidIndex } from '../gim/gimIndexer.js';
import { buildCbmTree, buildCbmNodeIndex } from '../gim/cbmParser.js';
import { parseFileDevRelation } from '../gim/fileDevParser.js';
import { ensureEngineReady } from '../viewer/ifcLoader.js';
import { buildIfcNameIndex } from '../viewer/ifcNameIndex.js';
import { fitCameraToScene } from '../viewer/camera.js';
import { getModalSelectedEntries, closeIfcModal } from '../ui/ifcSelectModal.js';
import { buildAndRenderCbmTree } from '../ui/cbmTreeView.js';
import { renderFileDevPanel } from '../ui/fileDevView.js';
import { loadingEl, emptyTipEl, gimFileInput, btnLoadGim } from '../ui/dom.js';
import { isTauri } from '../desktop/runtime.js';
import { openGimFilePath } from '../desktop/fileDialog.js';
import { DEBUG_IFC_LOAD, DEBUG_GIM_CACHE, DEBUG_RUNTIME_LOGS } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';

function showLoading(text: string) { loadingEl.textContent = text; loadingEl.style.display = 'block'; }
function hideLoading() { loadingEl.style.display = 'none'; }

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
function setupSldGridIdInteraction(state: AppState, showMessage: (text: string) => void): void {
  import('../ui/sldView.js').then(({ setSldGridIdClickHandler }) => {
    setSldGridIdClickHandler(async (gridId: string) => {
      if (!state.currentStdSldIndex) return;
      try {
        const { getCbmNodesByGridId } = await import('../gim/stdSldIndex.js');
        const nodes = getCbmNodesByGridId(state.currentStdSldIndex, gridId);
        if (nodes.length === 0) {
          console.log('[SLD→CBM] gridId 无对应 CBM 节点:', gridId);
          return;
        }
        // 取首个匹配节点触发联动（高亮 CBM 树 + 加载 IFC + 3D 高亮 + 相机定位）
        const { handleNodeClick } = await import('./nodeInteractionService.js');
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
export async function onGimExtracted(state: AppState, files: Map<string, File>, showMessage: (text: string) => void, projectName?: string, projectTypeName?: string): Promise<IfcEntry[]> {
  state.currentFiles = files;
  state.projectName = projectName || '';

  // 发现 IFC 文件
  let ifcEntries = await discoverIfcFromCBM(files);
  if (ifcEntries.length === 0) ifcEntries = scanIfcFiles(files);

  state.currentIfcEntries = ifcEntries;

  // 构建 CBM 层级树（F1System 根节点名称由 projectTypeName 设置，F2System 由 SYSCLASSIFYNAME 映射）
  state.currentCbmTree = await buildCbmTree(files, projectTypeName);
  state.ifcGuidIndex = buildIfcGuidIndex(state.currentCbmTree);
  state.cbmNodeIndex = buildCbmNodeIndex(state.currentCbmTree);

  // 解析 FileDevRelation
  state.fileDevRelations = await parseFileDevRelation(files);
  state.deviceToIfcFile.clear();
  for (const entry of state.fileDevRelations) {
    for (const devCbm of entry.deviceCbms) {
      state.deviceToIfcFile.set(devCbm, entry.modelId);
    }
  }

  // STD/SLD 解析：在 CBM 树构建完成后并行执行（不阻塞 IFC 加载）
  // 失败时仅 warn，不影响主流程
  try {
    const { parseStdSldOnGimExtracted } = await import('./stdSldService.js');
    await parseStdSldOnGimExtracted(state, files);
  } catch (err) {
    console.warn('[GIM] STD/SLD 解析失败:', err);
  }

  // 渲染层级树和文件设备面板（统一使用 handleNodeClick）
  const clickHandler = createNodeClickHandler(state, showMessage);
  buildAndRenderCbmTree(state, clickHandler);
  renderFileDevPanel(state, clickHandler);

  // 渲染 SLD 电气单线图与 STD 拓扑列表
  try {
    const { renderSldView } = await import('../ui/sldView.js');
    renderSldView(state);
  } catch (err) {
    console.warn('[GIM] SLD 视图渲染失败:', err);
  }

  // 阶段 4：注册 SLD gridId → CBM 联动回调
  setupSldGridIdInteraction(state, showMessage);

  return ifcEntries;
}

/**
 * 获取 IFC 文件内容。
 * 1. 优先从完整解压流程的 currentFiles 读取
 * 2. 缓存命中时从 cachedIfcPaths + readCachedIfc 读取
 * 3. 找不到返回 null（调用方跳过）
 */
async function getIfcBufferForEntry(entry: IfcEntry, state: AppState): Promise<Uint8Array | null> {
  // 1. 完整解压流程
  if (state.currentFiles) {
    const file = state.currentFiles.get(entry.path);
    if (file) {
      debugLog(DEBUG_IFC_LOAD, '[IFC Buffer] 使用 GIM 解压内存文件:', {
        name: entry.name,
        path: entry.path,
      });
      return new Uint8Array(await file.arrayBuffer());
    }
  }

  // 2. Tauri 缓存命中
  if (isTauri() && state.cachedIfcPaths.has(entry.path)) {
    const projectId = state.currentProjectId;
    if (projectId != null) {
      const cachePath = state.cachedIfcPaths.get(entry.path)!;
      debugLog(DEBUG_IFC_LOAD, '[IFC Buffer] 使用本地 IFC 缓存:', {
        name: entry.name,
        path: entry.path,
        cachePath,
      });
      const { readCachedIfc } = await import('../desktop/database.js');
      const bytes = await readCachedIfc(projectId, entry.path);

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
 * 与 loadSelectedIfcFiles 的区别：
 * - 不依赖 IFC 选择弹窗（不读 getModalSelectedEntries）
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
): Promise<void> {
  // 调试入口：从 localStorage 读取手动坐标偏移（GIM_COORD_OFFSET="dx,dy,dz"）
  // 仅作为调试功能，不写入数据库，不作为最终算法。
  // resetGimState 会清空 projectSourceToViewerMatrix，因此每次打开项目时重新解析。
  try {
    const { loadManualCoordOffsetFromLocalStorage } = await import('./coordinateAlignmentService.js');
    loadManualCoordOffsetFromLocalStorage(state);
  } catch {
    // 忽略：coordinateAlignmentService 不可用时不影响主流程
  }

  if (entries.length === 0) {
    // 无 IFC 但仍触发 MOD/STL 自动加载（纯 xml-mod 工程）
    await autoLoadModStlPostIfc(state, showMessage);
    return;
  }

  showLoading('正在加载 3D 引擎...');
  const { getViewerRuntimeWithUI } = await import('./viewerUIBinding.js');
  const runtime = await getViewerRuntimeWithUI(state, showMessage);
  const { ctx, modelCallbacks } = runtime;

  showLoading('正在加载 IFC 模型...');
  const failed: Array<{ name: string; message: string }> = [];

  try {
    await ensureEngineReady(ctx, state, modelCallbacks);
    const { loadIfcEntry } = await import('../viewer/ifcEntryLoader.js');

    for (const entry of entries) {
      showLoading(`正在加载 ${entry.name}...`);
      try {
        await loadIfcEntry(
          ctx,
          state,
          entry,
          async () => getIfcBufferForEntry(entry, state),
          (p) => showLoading(`${entry.name}: ${Math.round(p * 100)}%`),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[GIM] IFC 加载失败:', entry, err);
        failed.push({ name: entry.name, message });
        // 防御性清理
        try {
          const modelId = entry.modelId;
          if (ctx.fragments.list.has(modelId)) {
            ctx.fragments.core.disposeModel(modelId);
          }
          state.loadedModels.delete(modelId);
          const modelRow = document.getElementById(`model-${modelId}`);
          if (modelRow) modelRow.remove();
        } catch (cleanupErr) {
          console.warn('[GIM] cleanup failed model after load error', entry, cleanupErr);
        }
        continue;
      }
    }

    // IFC 必须保持 coordinate=true；MOD/STL 用同一个 Fragments 基准矩阵对齐到 viewer 空间。
    try {
      const { syncProjectSourceToViewerFromFragments } = await import('./coordinateAlignmentService.js');
      await syncProjectSourceToViewerFromFragments(state, ctx.fragments);
    } catch (err) {
      console.warn('[CoordAlign] IFC 基准坐标同步失败，MOD/STL 将使用原始坐标或手工 offset:', err);
    }

    // buildIfcNameIndex 失败不应阻断 UI 渲染
    await buildIfcNameIndex(ctx, state).catch((err) => {
      console.warn('[GIM] buildIfcNameIndex failed', err);
    });

    // 渲染层级树和文件设备面板
    const clickHandler = createNodeClickHandler(state, (text) => showLoading(text));
    buildAndRenderCbmTree(state, clickHandler);
    renderFileDevPanel(state, clickHandler);
    emptyTipEl.style.display = 'none';

    // 首次 fit 相机
    fitCameraToScene(ctx, state);

  } catch (err) {
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
    void autoLoadModStlPostIfc(state, showMessage, bgCtx, { token, includeMod: true, includeStl: false })
      .catch((err) => {
        console.warn('[GIM] 后台 MOD 加载失败:', err);
      });
  });
}

/**
 * MOD/STL 自动加载（IFC 加载后置步骤，同时用于无 IFC 的纯 MOD 工程）。
 *
 * 若 ctx 未传入（无 IFC 场景），内部创建 ViewerRuntime。
 * 缓存命中场景（currentFiles=null）自动回退磁盘缓存读取。
 */
async function autoLoadModStlPostIfc(
  state: AppState,
  showMessage: (text: string) => void,
  existingCtx?: ViewerContext,
  options?: { token?: number; includeMod?: boolean; includeStl?: boolean },
): Promise<void> {
  try {
    const { autoLoadModAndStlGeometry } = await import('./modAutoLoadService.js');
    // 获取 scene：优先用已有 ctx，否则创建 ViewerRuntime
    let scene: import('three').Scene;
    if (existingCtx) {
      scene = (existingCtx.world.scene as any).three as import('three').Scene;
    } else {
      const { getViewerRuntimeWithUI } = await import('./viewerUIBinding.js');
      const runtime = await getViewerRuntimeWithUI(state, showMessage);
      scene = (runtime.ctx.world.scene as any).three as import('three').Scene;
    }

    const result = await autoLoadModAndStlGeometry(
      state,
      scene,
      (p) => {
        if (p.phase === 'discovering') {
          showLoading(`正在发现几何引用... (${p.currentPath || ''})`);
        } else if (p.phase === 'loading_mod') {
          showLoading(`正在加载 MOD 模型 ${p.processedMods ?? p.loadedMods}/${p.totalMods}...`);
        } else if (p.phase === 'loading_stl') {
          showLoading(`正在加载 STL 模型 ${p.loadedStls}/${p.totalStls}...`);
        }
      },
      { token: options?.token, includeMod: options?.includeMod ?? true, includeStl: options?.includeStl ?? false },
    );

    if (result.modCount > 0 || result.stlCount > 0) {
      debugLog(DEBUG_IFC_LOAD, '[GIM] MOD/STL 自动加载完成', result);
      // MOD/STL 加载后强制重新 fit 相机（bbox 可能显著变化）
      if (existingCtx) {
        const { fitCameraToScene } = await import('../viewer/camera.js');
        fitCameraToScene(existingCtx, state, { force: true });
      }
    }
  } catch (err) {
    console.warn('[GIM] MOD/STL 自动加载失败:', err);
  }
}

/** 加载选中的 IFC 文件（IFC 选择弹窗回调，开发调试用） */
export async function loadSelectedIfcFiles(ctx: ViewerContext, state: AppState, modelCallbacks: ModelEventCallbacks): Promise<void> {
  const selected = getModalSelectedEntries(state.currentIfcEntries);
  debugLog(DEBUG_IFC_LOAD, '[IFC Modal] loadSelectedIfcFiles start', {
    selected,
    currentProjectId: state.currentProjectId,
    currentFiles: !!state.currentFiles,
    currentIfcEntries: state.currentIfcEntries,
    cachedIfcPaths: Array.from(state.cachedIfcPaths.keys()),
  });
  if (selected.length === 0) return;
  closeIfcModal();
  showLoading('正在加载 IFC 模型...');

  // 逐个 IFC 隔离加载：某一个 IFC 报 "Malformed tile" 不应阻断其他 IFC
  // 失败的 modelId 立即清理，避免后续"模型已加载，跳过"误判
  const failed: Array<{ name: string; message: string }> = [];

  try {
    debugLog(DEBUG_IFC_LOAD, '[IFC Modal] before ensureEngineReady');
    await ensureEngineReady(ctx, state, modelCallbacks);
    debugLog(DEBUG_IFC_LOAD, '[IFC Modal] after ensureEngineReady');
    const { loadIfcEntry } = await import('../viewer/ifcEntryLoader.js');

    for (const entry of selected) {
      showLoading(`正在加载 ${entry.name}...`);
      debugLog(DEBUG_IFC_LOAD, '[IFC Modal] before loadIfcEntry', entry);
      try {
        await loadIfcEntry(
          ctx,
          state,
          entry,
          async () => {
            debugLog(DEBUG_IFC_LOAD, '[IFC Modal] getIfcBuffer called', entry);
            return getIfcBufferForEntry(entry, state);
          },
          (p) => showLoading(`${entry.name}: ${Math.round(p * 100)}%`),
        );
        debugLog(DEBUG_IFC_LOAD, '[IFC Modal] loadIfcEntry done', entry);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 加载失败：始终输出 error（非 debug），便于用户定位
        console.error('[IFC Modal] loadIfcEntry failed', { entry, error: err });

        failed.push({ name: entry.name, message });

        // 防御性清理该 modelId：避免 state.loadedModels 残留 stale modelId，
        // 导致后续"模型已加载，跳过"误判
        try {
          const modelId = entry.modelId;
          if (ctx.fragments.list.has(modelId)) {
            ctx.fragments.core.disposeModel(modelId);
          }
          state.loadedModels.delete(modelId);
          const modelRow = document.getElementById(`model-${modelId}`);
          if (modelRow) modelRow.remove();
        } catch (cleanupErr) {
          console.warn('[IFC Modal] cleanup failed model after load error', entry, cleanupErr);
        }

        // 继续加载下一个 IFC，不中断循环
        continue;
      }
    }

    // IFC 必须保持 coordinate=true；MOD/STL 用同一个 Fragments 基准矩阵对齐到 viewer 空间。
    try {
      const { syncProjectSourceToViewerFromFragments } = await import('./coordinateAlignmentService.js');
      await syncProjectSourceToViewerFromFragments(state, ctx.fragments);
    } catch (err) {
      console.warn('[CoordAlign] IFC 基准坐标同步失败，MOD/STL 将使用原始坐标或手工 offset:', err);
    }

    // buildIfcNameIndex 失败不应阻断 UI 渲染（仅影响名称查询，模型已加载）
    await buildIfcNameIndex(ctx, state).catch((err) => {
      console.warn('[IFC Modal] buildIfcNameIndex failed', err);
    });

    // 统一使用 handleNodeClick 作为点击回调
    const clickHandler = createNodeClickHandler(state, (text) => showLoading(text));
    buildAndRenderCbmTree(state, clickHandler);
    renderFileDevPanel(state, clickHandler);
    emptyTipEl.style.display = 'none';

    // 对成功加载的模型执行 fitCameraToScene（即使部分失败也尝试 fit）
    const fitted = fitCameraToScene(ctx, state);
    debugLog(DEBUG_IFC_LOAD, '[IFC Modal] fitCameraToScene result', { fitted, failed: failed.length, total: selected.length });

    // IFC 加载完成后，自动加载 CBM 树中所有"无 IFC 引用但有 devPath"的节点的 MOD/STL 几何
    // 设计动机：GIM 是整体，IFC + MOD + STL 共同构成完整工程；用户期望打开后看到完整几何
    // 性能策略：仅加载 CBM→DEV→PHM→MOD/STL 引用链可达的文件（绝不遍历 MOD/ 全量）；
    //           去重 + 分批并发(4) + 批次间 yield 主线程，防止卡死
    try {
      const { autoLoadModAndStlGeometry } = await import('./modAutoLoadService.js');
      const scene = (ctx.world.scene as any).three as import('three').Scene;
      const result = await autoLoadModAndStlGeometry(
        state,
        scene,
        (p) => {
          if (p.phase === 'discovering') {
            showLoading(`正在发现几何引用... (${p.currentPath || ''})`);
          } else if (p.phase === 'loading_mod') {
            showLoading(`正在加载 MOD 模型 ${p.processedMods ?? p.loadedMods}/${p.totalMods}...`);
          } else if (p.phase === 'loading_stl') {
            showLoading(`正在加载 STL 模型 ${p.loadedStls}/${p.totalStls}...`);
          }
        },
      );
      if (result.modCount > 0 || result.stlCount > 0) {
        debugLog(DEBUG_IFC_LOAD, '[IFC Modal] MOD/STL 自动加载完成', result);
        // MOD/STL 加载后重新 fit 相机（几何可能改变包围盒）
        fitCameraToScene(ctx, state);
      }
    } catch (err) {
      console.warn('[IFC Modal] MOD/STL 自动加载失败:', err);
    }
  } catch (err) {
    // 外层 try 仅捕获 ensureEngineReady 等致命错误
    console.error('[IFC Modal] loadSelectedIfcFiles failed (outer)', {
      error: err,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : null,
    });
    showLoading(`IFC 加载失败: ${err instanceof Error ? err.message : String(err)}`);
    setTimeout(hideLoading, 3000);
    return;
  }

  // 根据失败数决定提示文案
  if (failed.length > 0) {
    showLoading(`部分 IFC 加载失败：${failed.length}/${selected.length}，详见控制台`);
    setTimeout(hideLoading, 4000);
  } else {
    hideLoading();
  }
}

/** 从 ArrayBuffer 加载 GIM 文件的完整流程（浏览器和 Tauri 共用，不创建 Viewer） */
async function openGimFromArrayBuffer(
  state: AppState,
  _fileName: string,
  ab: ArrayBuffer,
  showMessage: (text: string) => void,
  options?: { projectId?: number; persistIndex?: boolean },
): Promise<void> {
  showLoading('正在加载 GIM 解压模块...');
  const { extractGimFile, extractGimHeader, getProjectTypeName } = await import('../gim/gimExtractor.js');
  // 先解析 GIM 头部提取工程类型名（F1System 根节点显示用）和工程名称
  const gimHeader = extractGimHeader(ab);
  const projectName = gimHeader?.projectName || gimHeader?.projectId || '';
  const projectTypeName = getProjectTypeName(gimHeader?.magic || '');
  showLoading('正在解压 GIM 文件...');
  const extracted = await extractGimFile(ab);

  // 清空上一次 GIM 的状态，避免变电 ↔ 线路切换时残留
  // 统一走 cleanupBeforeOpenNewProject：销毁线路地图 + dispose 旧 fragments 模型 +
  // 重置高亮 + 清空 model-list UI + resetGimState + hasFittedCamera=false
  // 关键：必须先 dispose ctx.fragments 中的旧模型，再 resetGimState（否则 ctx 残留）
  const { cleanupBeforeOpenNewProject } = await import('./projectCleanupService.js');
  await cleanupBeforeOpenNewProject(state);

  // 工程类型识别：线路工程走独立流程，不弹 IFC 模态框，不创建 Viewer
  showLoading('正在识别工程类型...');
  const { detectGimProjectType } = await import('../gim/projectType.js');
  const projectTypeResult = await detectGimProjectType(extracted);
  state.currentProjectType = projectTypeResult.type;

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
    // 线路工程流程：构建 GimGraph + 解析 FAM/DEV 属性 + 渲染面板，不走 IFC/Viewer 流程
    showLoading('正在解析线路 CBM 层级...');
    const { buildLineGimGraph } = await import('../gim/lineCbmParser.js');
    const graph = await buildLineGimGraph(extracted);
    state.currentGimGraph = graph;
    state.currentFiles = extracted; // 保留文件供后续读取

    // v5: 首次导入 → 解析 FAM/DEV 属性 → 统一事务写入缓存 → 恢复到 state → 渲染面板
    // 顺序：extract → detect → buildLineGimGraph → parseLineAttributes
    //       → save_line_project_cache → restore attrs → render
    // 注意：render 必须在 restore attrs 之后，否则 extractLineMapData 拿不到
    //       FAM/DEV 属性，塔位编号/塔型/呼高/转角等 tooltip 字段会缺失
    if (options?.persistIndex && options.projectId != null && isTauri()) {
      try {
        showLoading('正在解析线路 FAM/DEV 属性...');
        const { parseLineAttributes, estimatePayloadSizeMB } = await import('./lineAttrPersistenceService.js');
        const { buildLineGraphPayload } = await import('./lineGraphPersistenceService.js');
        const { saveLineProjectCache } = await import('../desktop/database.js');
        const { restoreLineAttributesToState } = await import('./lineAttrRestoreService.js');

        const attrResult = await parseLineAttributes(graph, extracted);
        const graphPayload = buildLineGraphPayload(options.projectId, graph);

        // 性能日志：payload 统计 + 风险评估
        const graphPayloadJson = JSON.stringify(graphPayload);
        const estimatedMB = estimatePayloadSizeMB(
          graphPayloadJson,
          attrResult.famPayloads,
          attrResult.devPayloads,
        );
        debugLog(DEBUG_GIM_CACHE, '[LineCache] save_line_project_cache payload 统计:', {
          nodes: graphPayload.nodes.length,
          children: graphPayload.children.length,
          refs: graphPayload.refs.length,
          fam_props: attrResult.famPayloads.length,
          dev_props: attrResult.devPayloads.length,
          estimatedJsonSizeMB: Math.round(estimatedMB * 100) / 100,
        });
        if (estimatedMB > 50) {
          console.warn(
            `[LineCache] payload 较大 (${Math.round(estimatedMB * 100) / 100} MB)，一次性 invoke 可能较慢`,
          );
        }

        showLoading('正在写入线路工程缓存...');
        const t0 = performance.now();
        await saveLineProjectCache(
          options.projectId,
          graphPayload,
          attrResult.famPayloads,
          attrResult.devPayloads,
        );
        const elapsedMs = Math.round(performance.now() - t0);
        debugLog(DEBUG_GIM_CACHE, '[LineCache] save_line_project_cache 完成，耗时', elapsedMs, 'ms');

        // 恢复属性到 state（payload 与 record 字段一致，结构兼容可直接传入）
        restoreLineAttributesToState(
          {
            fam_properties: attrResult.famPayloads,
            dev_properties: attrResult.devPayloads,
          },
          state,
        );
      } catch (err) {
        console.error('[Tauri] 线路工程缓存写入失败:', err);
      }
    }

    // 渲染面板（在属性恢复之后，确保地图 tooltip/标签有完整 FAM/DEV 属性）
    const { renderLineProjectPanels } = await import('../ui/lineProjectView.js');
    renderLineProjectPanels(state, graph, showMessage);

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
  const entries = await onGimExtracted(state, extracted, showMessage, projectName, projectTypeName);

  // 无 IFC entry：可能是线路工程被误识别为 substation。
  // 不写入 saveGimIndex（避免 project_type=substation 污染），提示检查识别日志。
  if (entries.length === 0) {
    showLoading('该工程未检测到 IFC 文件；如果这是线路工程，请检查工程类型识别日志');
    setTimeout(hideLoading, 4000);
    return;
  }

  // Tauri 模式：写入 GIM 索引到 SQLite（仅当存在 IFC entry 时才允许写入）
  if (options?.persistIndex && options.projectId != null && isTauri()) {
    // 缓存 IFC 文件到本地磁盘（以 ifcEntries 为准，逐个 try/catch）
    showLoading('正在缓存 IFC 文件...');
    let localCachePathMap = new Map<string, string>();
    try {
      const { cacheIfcEntries } = await import('./gimExtractedCacheService.js');
      const cacheResult = await cacheIfcEntries(
        options.projectId,
        state.currentFiles ?? new Map<string, File>(),
        state.currentIfcEntries,
      );
      localCachePathMap = cacheResult.pathMap;
      debugLog(DEBUG_GIM_CACHE, '[Tauri] IFC 缓存结果:', {
        expected: state.currentIfcEntries.length,
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
    // 用于缓存命中场景下从磁盘读取这些文件以回放 xml-mod 几何（方案 B 回退路径）
    if (state.currentFiles) {
      showLoading('正在缓存几何文件（DEV/PHM/MOD）...');
      try {
        const { cacheGeometryFiles } = await import('./gimExtractedCacheService.js');
        const geoCacheResult = await cacheGeometryFiles(
          options.projectId,
          state.currentFiles,
        );
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

    // 方案 C：MOD → glTF 离线预序列化缓存
    // 移到 IFC 加载之后作为后台任务（见下方 queueMicrotask），避免阻塞渲染
    // 此处仅记录 files 引用，实际序列化在 loadAllIfcFiles 完成后执行

    showLoading('正在写入 GIM 索引...');
    try {
      const { buildGimIndexPayload } = await import('./gimIndexPersistenceService.js');
      const { saveGimIndex } = await import('../desktop/database.js');
      const payload = await buildGimIndexPayload(
        options.projectId,
        state.currentFiles ?? new Map<string, File>(),
        state.currentIfcEntries,
        state.currentCbmTree,
        state.fileDevRelations,
        localCachePathMap,
      );

      // 校验：即将写入的 IFC local_cache_path 数量
      const payloadIfcEntries = payload.entries.filter((e) => e.entry_type === 'IFC');
      debugLog(DEBUG_GIM_CACHE, '[Tauri] 即将写入 SQLite 的 IFC local_cache_path:', {
        ifc_entries: payloadIfcEntries.length,
        with_cache_path: payloadIfcEntries.filter((e) => !!e.local_cache_path).length,
      });

      await saveGimIndex(payload);
      debugLog(DEBUG_GIM_CACHE, '[Tauri] GIM 索引已写入:', {
        entries: payload.entries.length,
        cbm_nodes: payload.cbm_nodes.length,
        ifc_models: payload.ifc_models.length,
        file_dev_entries: payload.file_dev_entries.length,
        fam_properties: payload.fam_properties.length,
        dev_properties: payload.dev_properties.length,
      });

      // v6: 同时写入 DEV/PHM 几何引用链索引，用于缓存命中时快速查询
      if (state.currentFiles) {
        showLoading('正在索引几何引用链...');
        try {
          const { buildGeometryRefsPayload } = await import('./gimIndexPersistenceService.js');
          const { saveGeometryRefs } = await import('../desktop/database.js');
          const geoPayload = await buildGeometryRefsPayload(options.projectId, state.currentFiles);
          debugLog(DEBUG_GIM_CACHE, '[Tauri] 几何引用链索引:', {
            dev_solid_models: geoPayload.dev_solid_models.length,
            dev_sub_devices: geoPayload.dev_sub_devices.length,
            phm_solid_models: geoPayload.phm_solid_models.length,
          });
          await saveGeometryRefs(geoPayload);
          debugLog(DEBUG_GIM_CACHE, '[Tauri] 几何引用链索引已写入');
        } catch (geoErr) {
          console.warn('[Tauri] 几何引用链索引写入失败:', geoErr);
        }
      }
    } catch (err) {
      console.error('[Tauri] GIM 索引写入失败:', err);
    }
  }

  // GIM 视为整体：直接加载全部 IFC + MOD + STL，不弹选择框
  await loadAllIfcFiles(state, entries, showMessage);

  // 方案 C v2：GLB 序列化（IFC + MOD 渲染完成后执行）
  // 按 DEV 粒度缓存：收集 CBM seed devPaths，每个 DEV 序列化为一个 .glb
  // 必须等待完成以确保 _version.txt 写入，否则下次打开 geometry_cache_version_match=false
  const glbProjectId = options?.projectId;
  if (state.currentFiles && glbProjectId != null) {
    const glbFiles = state.currentFiles;
    const glbCbmTree = state.currentCbmTree;
    try {
      // 从 CBM 树收集所有 seed devPaths（去重）
      const { collectCbmDeviceInstances } = await import('./modAutoLoadService.js');
      const seeds = collectCbmDeviceInstances(glbCbmTree);
      const devPathSet = new Set<string>();
      for (const seed of seeds) {
        if (seed.devPath) {
          const normalized = seed.devPath.replace(/\\/g, '/');
          const devPath = normalized.toLowerCase().startsWith('dev/')
            ? normalized
            : `DEV/${normalized}`;
          devPathSet.add(devPath);
        }
      }
      const devPaths = Array.from(devPathSet);
      debugLog(DEBUG_GIM_CACHE, `[Tauri] GLB 序列化: ${devPaths.length} 个唯一 DEV（从 ${seeds.length} 个 seed）`);

      showLoading(`正在序列化 GLB 缓存（0/${devPaths.length}）...`);
      const { cacheGlbFiles } = await import('./glbCacheService.js');
      const glbResult = await cacheGlbFiles(glbProjectId, glbFiles, devPaths, (done, total) => {
        showLoading(`正在序列化 GLB 缓存（${done}/${total}）...`);
      });
      debugLog(DEBUG_GIM_CACHE, '[Tauri] GLB 序列化结果:', {
        cached: glbResult.cachedCount,
        skipped: glbResult.skippedCount,
        errors: glbResult.errors.length,
      });
      if (glbResult.errors.length > 0) {
        console.warn('[Tauri] 部分 GLB 序列化失败（前 5 个）:', glbResult.errors.slice(0, 5));
      }
    } catch (err) {
      console.error('[Tauri] GLB 序列化失败:', err);
    }
  }
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
    const filePath = await openGimFilePath();
    if (!filePath) return;
    btnLoadGim.disabled = true;
    try {
      // 2. FileInfo + 缓存校验（无 3D 依赖）
      showLoading('正在读取 GIM 文件信息...');
      const { getFileInfo, readFileBytes } = await import('../desktop/fileReader.js');
      const info = await getFileInfo(filePath);
      debugLog(DEBUG_GIM_CACHE, '[Tauri] GIM 文件信息:', info);
      showLoading('正在写入本地项目索引...');
      const { upsertGimProject, validateGimCache, getGimIndex } = await import('../desktop/database.js');
      const record = await upsertGimProject(info);
      debugLog(DEBUG_GIM_CACHE, '[Tauri] GIM 项目记录:', record);

      showLoading('正在检查本地缓存...');
      const validation = await validateGimCache(record.id);
      debugLog(DEBUG_GIM_CACHE, '[Tauri] GIM 缓存校验:', validation);

      // 3. 缓存命中短路：不 readFileBytes、不 extractGimFile、不创建 Viewer
      if (validation.valid) {
        try {
          // 清空上一次 GIM 的状态，避免残留
          // 统一走 cleanupBeforeOpenNewProject：销毁线路地图 + dispose 旧 fragments 模型 +
          // 重置高亮 + 清空 model-list UI + resetGimState + hasFittedCamera=false
          const { cleanupBeforeOpenNewProject } = await import('./projectCleanupService.js');
          await cleanupBeforeOpenNewProject(state);

          // v4: 线路工程缓存命中 → 从 SQLite 恢复 GimGraph + FAM/DEV 属性，跳过解压
          // v5: 缓存命中顺序：validate → get_line_graph → restoreLineGraphToState
          //     → get_line_attributes → restoreLineAttributesToState → render
          if (validation.project_type === 'transmission_line') {
            showLoading('正在从本地缓存恢复线路工程索引...');
            const { getLineGraph, getLineAttributes } = await import('../desktop/database.js');
            const { restoreLineGraphToState } = await import('./lineGraphRestoreService.js');
            const { restoreLineAttributesToState } = await import('./lineAttrRestoreService.js');
            const result = await getLineGraph(record.id);
            const graph = restoreLineGraphToState(state, result);
            state.currentProjectId = record.id;

            // v5: 恢复 FAM/DEV 属性（缓存命中，currentFiles 保持 null）
            showLoading('正在从本地缓存恢复线路 FAM/DEV 属性...');
            const attrResult = await getLineAttributes(record.id);
            const attrStats = restoreLineAttributesToState(attrResult, state);

            const { renderLineProjectPanels } = await import('../ui/lineProjectView.js');
            renderLineProjectPanels(state, graph, showMessage);
            emptyTipEl.style.display = 'none';

            hideLoading();
            showLoading('已从本地缓存恢复线路工程索引');
            setTimeout(hideLoading, 3000);
            debugLog(DEBUG_GIM_CACHE, '[Tauri] 线路工程缓存短路生效：未读取原始 GIM，未执行解压', {
              project_id: record.id,
              nodes: graph.stats.total,
              famProperties: attrStats.famCount,
              devProperties: attrStats.devCount,
              famSources: attrStats.famSources,
              devSources: attrStats.devSources,
            });
            return; // 线路工程缓存命中，短路完成
          }

          // 变电工程缓存命中 → 恢复 GIM 索引（原有逻辑）
          state.currentProjectType = 'substation';

          showLoading('正在从本地缓存恢复 GIM 索引...');
          const { restoreGimIndexToState } = await import('./gimIndexRestoreService.js');

          const index = await getGimIndex(record.id);
          restoreGimIndexToState(state, index);
          state.currentProjectId = record.id;

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

          // STD/SLD 从磁盘缓存恢复：CBM 树就绪后并行执行（不阻塞 IFC 加载）
          // 失败时仅 warn，不影响主流程
          try {
            const { restoreStdSldFromCache, findMissingStdSldCacheParts } =
              await import('./stdSldService.js');
            const stdSldResult = await restoreStdSldFromCache(state);
            const missingParts = findMissingStdSldCacheParts(
              index.entries.map((entry) => entry.entry_path),
              stdSldResult,
            );
            if (missingParts.length > 0) {
              throw new Error(
                `本地缓存缺少电气图数据（${missingParts.join('/')}），需要从原始 GIM 重新提取`,
              );
            }
          } catch (err) {
            console.warn('[GIM] STD/SLD 缓存恢复失败:', err);
            // 让外层缓存命中流程回退到完整解压。旧缓存可能有完整 IFC/MOD，
            // 但缺少后来新增的 project.sch / STD / SLD 落盘文件。
            throw err;
          }

          // 渲染 SLD 电气单线图与 STD 拓扑列表（缓存命中路径）
          try {
            const { renderSldView } = await import('../ui/sldView.js');
            renderSldView(state);
          } catch (err) {
            console.warn('[GIM] SLD 视图渲染失败（缓存命中）:', err);
          }

          // 阶段 4：注册 SLD gridId → CBM 联动回调（缓存命中路径）
          setupSldGridIdInteraction(state, showMessage);

          // GIM 视为整体：直接加载全部 IFC + MOD + STL，不弹选择框
          // loadAllIfcFiles 内部会创建 ViewerRuntime、加载 IFC、渲染树、触发 MOD/STL
          await loadAllIfcFiles(state, state.currentIfcEntries, showMessage);
          debugLog(DEBUG_GIM_CACHE, '[Tauri] 变电工程缓存命中：自动加载全部 IFC + MOD + STL');
          return; // 缓存命中，短路完成
        } catch (err) {
          console.warn('[Tauri] 缓存恢复失败，回退完整解压流程:', err);
        }
      } else {
        debugLog(DEBUG_GIM_CACHE, '[Tauri] 缓存无效或不完整，继续完整解压流程:', validation);
        // 清理陈旧 GLB 缓存目录（如 _version.txt 缺失导致 geometry_cache_version_match=false），
        // 避免陈旧 GLB 文件残留造成"缓存已存在"的假象。仅 Tauri 环境下执行。
        if (isTauri() && !validation.geometry_cache_version_match) {
          try {
            const { deleteGlbCache } = await import('../desktop/database.js');
            await deleteGlbCache(record.id);
            debugLog(DEBUG_GIM_CACHE, '[Tauri] 已清理陈旧 GLB 缓存目录');
          } catch (err) {
            console.warn('[Tauri] 清理 GLB 缓存失败:', err);
          }
        }
      }

      // 4. 回退：完整解压流程（不创建 Viewer，只做读取+解压+索引+渲染树）
      debugLog(DEBUG_GIM_CACHE, '[Tauri] 缓存短路未生效：进入完整解压流程');
      showLoading('正在读取 GIM 文件...');
      const ab = await readFileBytes(filePath);

      const fileName = filePath.split(/[\\/]/).pop() || 'project.gim';
      await openGimFromArrayBuffer(state, fileName, ab, showMessage, {
        projectId: record.id,
        persistIndex: true,
      });
    } catch (err) {
      console.error(err);
      showLoading(`GIM 解析失败: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(hideLoading, 3000);
    } finally { btnLoadGim.disabled = false; }
    return;
  }

  // 浏览器模式：input.click() 立即触发，change 后读取+解压（不创建 Viewer）
  return new Promise<void>((resolve) => {
    const handler = async () => {
      gimFileInput.removeEventListener('change', handler);
      const files = Array.from(gimFileInput.files || []);
      if (files.length === 0) { resolve(); return; }
      btnLoadGim.disabled = true;
      try {
        const ab = await files[0].arrayBuffer();
        await openGimFromArrayBuffer(state, files[0].name, ab, showMessage);
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
