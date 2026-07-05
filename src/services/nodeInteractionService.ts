import type { CbmNode } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import { collectIfcRefs } from '../gim/cbmParser.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';

/**
 * 节点点击交互服务（用于缓存命中、无 Viewer 场景）。
 *
 * 行为：
 * 1. 立即显示基础属性 + 打开属性面板（纯 UI，无 Viewer）
 * 2. 如果节点有 ifcFile/ifcGuid：
 *    a. 检查对应 IFC 模型是否已加载
 *    b. 未加载 → getViewerRuntime() → ensureEngineReady() → loadIfcBuffer() → buildIfcNameIndex()
 *    c. 已加载 → getViewerRuntime()
 *    d. highlightIfcFromNode() + 刷新完整属性
 * 3. 如果节点无 IFC 关联，只显示基础属性
 */
export async function handleNodeClick(
  state: AppState,
  node: CbmNode,
  showMessage: (text: string) => void,
): Promise<void> {
  // 1. 立即显示基础属性（无 Viewer）
  const { showNodePropertiesBasic, openPropsDrawerUI } = await import('../ui/propsDrawer.js');
  showNodePropertiesBasic(state, node);
  openPropsDrawerUI();

  // 2. 收集节点引用的 IFC 模型
  const refs = collectIfcRefs(node);
  const cbmFileName = node.path.split('/').pop() || '';
  const ifcModelId = node.ifcFile
    ? node.ifcFile.replace(/\.ifc$/i, '')
    : state.deviceToIfcFile.get(cbmFileName);

  // 需要加载的 IFC modelId 集合
  const modelsToLoad = new Set<string>();
  for (const modelId of refs.keys()) {
    if (!state.loadedModels.has(modelId)) {
      modelsToLoad.add(modelId);
    }
  }
  // 如果节点本身有 ifcFile 但没有 ifcGuid，也确保对应 IFC 加载
  if (ifcModelId && !state.loadedModels.has(ifcModelId) && !modelsToLoad.has(ifcModelId)) {
    modelsToLoad.add(ifcModelId);
  }

  // 3. 如果没有需要加载的 IFC 且没有需要高亮的，直接返回
  if (modelsToLoad.size === 0 && refs.size === 0) {
    if (ifcModelId && state.loadedModels.has(ifcModelId)) {
      // IFC 已加载但无 GUID → 只定位
      const { getViewerRuntime } = await import('../viewer/viewerRuntime.js');
      const runtime = await getViewerRuntime(state, showMessage);
      const { highlightIfcFromNode } = await import('../viewer/highlight.js');
      await highlightIfcFromNode(runtime.ctx, state, node, showMessage);
      return;
    }
    // 无 IFC 关联但有 devPath → 尝试 xml-mod 加载路径（变电工程典型）
    if (!ifcModelId && node.devPath) {
      await loadXmlModForNode(state, node, showMessage);
    }
    return;
  }

  // 4. 需要加载 IFC 或高亮 → 获取 ViewerRuntime
  const { getViewerRuntime } = await import('../viewer/viewerRuntime.js');
  const runtime = await getViewerRuntime(state, showMessage);
  const { ctx, modelCallbacks } = runtime;

  // 5. 加载未加载的 IFC 模型
  if (modelsToLoad.size > 0) {
    const { ensureEngineReady } = await import('../viewer/ifcLoader.js');
    const { loadIfcEntry } = await import('../viewer/ifcEntryLoader.js');
    await ensureEngineReady(ctx, state, modelCallbacks);

    for (const modelId of modelsToLoad) {
      const entry = state.currentIfcEntries.find((e) => e.modelId === modelId);
      if (!entry) {
        console.warn(`[懒加载] 找不到 IFC entry: ${modelId}`);
        continue;
      }
      showMessage(`正在加载 ${entry.name}...`);
      try {
        await loadIfcEntry(
          ctx,
          state,
          entry,
          () => getIfcBufferForEntry(entry, state),
          (p) => showMessage(`${entry.name}: ${Math.round(p * 100)}%`),
        );
        debugLog(DEBUG_IFC_LOAD, `[懒加载] IFC 已加载: ${modelId}`);
      } catch (err) {
        console.error(`[懒加载] IFC 加载失败 (${modelId}):`, err);
      }
    }

    // 构建 IFC 名称索引
    const { buildIfcNameIndex } = await import('../viewer/ifcNameIndex.js');
    await buildIfcNameIndex(ctx, state);

    // 刷新树显示（更新名称）— 统一使用 handleNodeClick 作为点击回调
    const { buildAndRenderCbmTree } = await import('../ui/cbmTreeView.js');
    const { renderFileDevPanel } = await import('../ui/fileDevView.js');
    const clickHandler = (n: CbmNode) => { handleNodeClick(state, n, showMessage); };
    buildAndRenderCbmTree(state, clickHandler);
    renderFileDevPanel(state, clickHandler);
  }

  // 6. 高亮 + 显示完整属性
  const { highlightIfcFromNode } = await import('../viewer/highlight.js');
  const { showNodeProperties, openPropsDrawer } = await import('../ui/propsDrawer.js');
  await highlightIfcFromNode(ctx, state, node, showMessage);
  await showNodeProperties(ctx, state, node);
  openPropsDrawer(ctx);
}

/**
 * 获取 IFC 文件内容。
 * 1. 优先从完整解压流程的 currentFiles 读取
 * 2. 缓存命中时从 cachedIfcPaths + readCachedIfc 读取
 * 3. 找不到返回 null
 */
async function getIfcBufferForEntry(
  entry: { name: string; path: string; modelId: string },
  state: AppState,
): Promise<Uint8Array | null> {
  // 1. 完整解压流程
  if (state.currentFiles) {
    const file = state.currentFiles.get(entry.path);
    if (file) {
      debugLog(DEBUG_IFC_LOAD, '[IFC Buffer] 使用 GIM 解压内存文件:', { name: entry.name, path: entry.path });
      return new Uint8Array(await file.arrayBuffer());
    }
  }

  // 2. Tauri 缓存命中
  const { isTauri } = await import('../desktop/runtime.js');
  if (isTauri() && state.cachedIfcPaths.has(entry.path)) {
    const projectId = state.currentProjectId;
    if (projectId != null) {
      const cachePath = state.cachedIfcPaths.get(entry.path)!;
      debugLog(DEBUG_IFC_LOAD, '[IFC Buffer] 使用本地 IFC 缓存:', { name: entry.name, path: entry.path, cachePath });
      const { readCachedIfc } = await import('../desktop/database.js');
      return await readCachedIfc(projectId, entry.path);
    }
  }

  console.warn('[IFC Buffer] 找不到 IFC 文件内容或缓存:', entry);
  return null;
}

/**
 * 节点点击时加载 xml-mod 几何（变电工程无 IFC 设备的回退路径）。
 *
 * 流程：
 * 1. discoverModGeometriesFromNode 走 CBM → DEV → PHM → MOD 引用链
 * 2. 对每个未加载的 modPath，loadXmlModFromFiles 转 Three.js Group
 * 3. applyExternalTransforms 应用 DEV + PHM 变换矩阵
 * 4. 加入 scene 并跟踪到 state.loadedXmlModGroups
 * 5. 首次加载时 fitCameraToScene 定位相机
 *
 * P0 范围：
 * - 仅处理 currentFiles 非空场景（首次打开）
 * - 缓存命中场景（currentFiles=null）由 P2 实现
 * - STL 引用由 modGeometryDiscovery 跳过（P1）
 *
 * @param state 全局 AppState
 * @param node CBM 节点（必须带 devPath）
 * @param showMessage 消息回调
 */
async function loadXmlModForNode(
  state: AppState,
  node: CbmNode,
  showMessage: (text: string) => void,
): Promise<void> {
  if (!state.currentFiles) {
    // 缓存命中场景，P2 处理
    debugLog(DEBUG_IFC_LOAD, '[xml-mod] 缓存命中场景跳过（P2 实现）:', node.devPath);
    return;
  }

  const { discoverModGeometriesFromNode } = await import('./modGeometryDiscovery.js');
  const discovered = await discoverModGeometriesFromNode(node, state.currentFiles);

  if (discovered.length === 0) {
    debugLog(DEBUG_IFC_LOAD, '[xml-mod] 未发现 MOD 几何来源:', node.devPath);
    return;
  }

  // 获取 ViewerRuntime（懒加载，与 IFC 路径共用同一引擎）
  const { getViewerRuntime } = await import('../viewer/viewerRuntime.js');
  const runtime = await getViewerRuntime(state, showMessage);
  const { ctx } = runtime;
  // OBC BaseScene.three 类型为 Object3D，实际为 THREE.Scene，与 viewerEngine.ts 一致用 as any
  const scene = (ctx.world.scene as any).three as import('three').Scene;

  const { loadXmlModFromFiles, applyExternalTransforms } = await import('../viewer/xmlModLoader.js');

  let loadedCount = 0;
  for (const geo of discovered) {
    // 已加载则跳过
    if (state.loadedXmlModGroups.has(geo.modPath)) {
      debugLog(DEBUG_IFC_LOAD, '[xml-mod] 已加载，跳过:', geo.modPath);
      continue;
    }

    const group = await loadXmlModFromFiles(geo.modPath, state.currentFiles);
    if (!group) continue;

    // 应用外部变换（PHM + DEV）
    applyExternalTransforms(group, geo.devTransformMatrix, geo.phmTransformMatrix);

    // 加入场景并跟踪
    scene.add(group);
    state.loadedXmlModGroups.set(geo.modPath, group);
    loadedCount++;
  }

  if (loadedCount > 0) {
    showMessage(`已加载 ${loadedCount} 个 MOD 模型`);
    // 首次加载时定位相机到场景包围盒
    if (!state.hasFittedCamera) {
      const { fitCameraToScene } = await import('../viewer/camera.js');
      fitCameraToScene(ctx, state);
    }
  }
}
