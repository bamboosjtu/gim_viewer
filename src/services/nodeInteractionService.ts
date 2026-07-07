import type { CbmNode } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import * as THREE from 'three';
import { collectIfcRefs } from '../gim/cbmParser.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { applyProjectSourceToViewer } from './coordinateAlignmentService.js';

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
    // 无 IFC 关联但有 devPath → 尝试 MOD/STL 加载路径（变电工程典型）
    if (!ifcModelId && node.devPath) {
      await loadModStlForNode(state, node, showMessage);
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
 * 确保 MOD/STL 图层根节点存在。
 * 与 modAutoLoadService 的图层机制一致。
 */
function ensureModStlLayer(
  state: AppState,
  scene: THREE.Scene,
  layer: 'mod' | 'stl',
): THREE.Group {
  if (layer === 'mod') {
    if (!state.modRootGroup) {
      state.modRootGroup = new THREE.Group();
      state.modRootGroup.name = '__GIM_MOD_LAYER__';
      state.modRootGroup.visible = true;
      scene.add(state.modRootGroup);
    }
    return state.modRootGroup;
  } else {
    if (!state.stlRootGroup) {
      state.stlRootGroup = new THREE.Group();
      state.stlRootGroup.name = '__GIM_STL_LAYER__';
      state.stlRootGroup.visible = true;
      scene.add(state.stlRootGroup);
    }
    return state.stlRootGroup;
  }
}

/**
 * 节点点击时加载 MOD/STL 几何（变电工程无 IFC 设备的回退路径）。
 *
 * 流程：
 * 1. discoverGeometriesFromNode 走 CBM → DEV → PHM → MOD/STL 引用链
 * 2. 对每个未加载的 MOD，loadXmlModFromFiles 转 Three.js Group
 * 3. 对每个未加载的 STL，parseStlBinary 转 Three.js Group
 * 4. applyPlacementTransformToSceneUnits 应用 CBM/DEV/SUBDEVICE/PHM 累积放置矩阵
 * 5. 加入 scene 并跟踪到 state.loadedXmlModGroups / loadedStlGroups
 * 6. 首次加载时 fitCameraToScene 定位相机
 *
 * 文件来源（v6 起）：
 * - currentFiles 非空（首次打开）：直接从内存 Map 读取
 * - currentFiles=null（缓存命中）：按需从磁盘 readCachedIfc 读取 DEV/PHM/MOD 文件
 *
 * @param state 全局 AppState
 * @param node CBM 节点（必须带 devPath）
 * @param showMessage 消息回调
 */
async function loadModStlForNode(
  state: AppState,
  node: CbmNode,
  showMessage: (text: string) => void,
): Promise<void> {
  // 准备文件读取适配器：currentFiles 优先，缓存命中时回退磁盘
  const files = state.currentFiles;
  const projectId = state.currentProjectId;

  if (!files && projectId == null) {
    debugLog(DEBUG_IFC_LOAD, '[xml-mod] 无文件来源可用（currentFiles=null 且 projectId=null）:', node.devPath);
    return;
  }

  const { discoverGeometriesFromNode } = await import('./modGeometryDiscovery.js');
  // discoverGeometriesFromNode 在 files=null 时返回空，因此缓存命中场景需要先构建临时 Map
  const discoveryFiles = files ?? await buildGeometryFilesMapFromCache(projectId!, node);
  if (!discoveryFiles || discoveryFiles.size === 0) {
    debugLog(DEBUG_IFC_LOAD, '[xml-mod] 无法获取 DEV/PHM/MOD 文件:', node.devPath);
    return;
  }

  const { mods, stls } = await discoverGeometriesFromNode(node, discoveryFiles);

  if (mods.length === 0 && stls.length === 0) {
    debugLog(DEBUG_IFC_LOAD, '[xml-mod] 未发现 MOD/STL 几何来源:', node.devPath);
    return;
  }

  // 缓存命中场景下，确保所有需要的 MOD/STL 文件也在 discoveryFiles 中
  if (!files) {
    await ensureModFilesInCacheMap(projectId!, mods, discoveryFiles);
    await ensureStlFilesInCacheMap(projectId!, stls, discoveryFiles);
  }

  // 获取 ViewerRuntime（懒加载，与 IFC 路径共用同一引擎）
  const { getViewerRuntime } = await import('../viewer/viewerRuntime.js');
  const runtime = await getViewerRuntime(state, showMessage);
  const { ctx } = runtime;
  // OBC BaseScene.three 类型为 Object3D，实际为 THREE.Scene，与 viewerEngine.ts 一致用 as any
  const scene = (ctx.world.scene as any).three as import('three').Scene;

  const {
    loadXmlModFromFiles,
    applyPlacementTransformToSceneUnits,
  } = await import('../viewer/xmlModLoader.js');

  let loadedCount = 0;
  let stlLoadedCount = 0;

  // ── 加载 MOD ──
  for (const geo of mods) {
    if (state.loadedXmlModGroups.has(geo.instanceKey)) {
      debugLog(DEBUG_IFC_LOAD, '[xml-mod] MOD 实例已加载，跳过:', geo.instanceKey);
      continue;
    }

    const group = await loadXmlModFromFiles(geo.modPath, discoveryFiles);
    if (!group) continue;

    applyPlacementTransformToSceneUnits(group, geo.placementTransformMatrix);
    applyProjectSourceToViewer(group, state.projectSourceToViewerMatrix);
    // 加入 MOD 图层（独立于 IFC scene 根节点）
    const modRoot = ensureModStlLayer(state, scene, 'mod');
    modRoot.add(group);
    state.loadedXmlModGroups.set(geo.instanceKey, group);
    loadedCount++;
  }

  // ── 加载 STL ──
  const { parseStlBinary } = await import('../viewer/stlLoader.js');
  for (const geo of stls) {
    if (state.loadedStlGroups.has(geo.instanceKey)) {
      debugLog(DEBUG_IFC_LOAD, '[xml-mod] STL 实例已加载，跳过:', geo.instanceKey);
      continue;
    }

    const stlFile = discoveryFiles.get(geo.stlPath);
    if (!stlFile) {
      console.warn(`[xml-mod] STL 文件不存在: ${geo.stlPath}`);
      continue;
    }
    const buffer = await stlFile.arrayBuffer();
    const group = parseStlBinary(buffer, geo.stlPath);
    if (!group) continue;

    applyPlacementTransformToSceneUnits(group, geo.placementTransformMatrix);
    applyProjectSourceToViewer(group, state.projectSourceToViewerMatrix);
    // 加入 STL 图层
    const stlRoot = ensureModStlLayer(state, scene, 'stl');
    stlRoot.add(group);
    state.loadedStlGroups.set(geo.instanceKey, group);
    stlLoadedCount++;
  }

  const totalLoaded = loadedCount + stlLoadedCount;
  if (totalLoaded > 0) {
    const parts: string[] = [];
    if (loadedCount > 0) parts.push(`${loadedCount} 个 MOD`);
    if (stlLoadedCount > 0) parts.push(`${stlLoadedCount} 个 STL`);
    showMessage(`已加载 ${parts.join(' + ')} 模型`);
    // 首次加载时定位相机到场景包围盒
    if (!state.hasFittedCamera) {
      const { fitCameraToScene } = await import('../viewer/camera.js');
      fitCameraToScene(ctx, state);
    }
  }
}

/**
 * 缓存命中场景下，从磁盘读取 DEV/PHM/MOD 文件构建临时 Map<string, File>。
 *
 * 读取范围：
 * - DEV/{node.devPath}（必需）
 * - PHM/{devDoc.solidModels[].solidModelPath}（必需）
 * - MOD/{phmDoc.solidModels[].solidModelPath}（延迟到 ensureModFilesInCacheMap 补充）
 *
 * 一次点击只读取该节点引用链需要的文件，避免一次性读取全部 DEV/PHM/MOD。
 *
 * @param projectId 数据库 gim_project.id
 * @param node CBM 节点（必须带 devPath）
 * @returns 包含 DEV + PHM 文件的 Map；找不到时返回空 Map
 */
async function buildGeometryFilesMapFromCache(
  projectId: number,
  node: CbmNode,
): Promise<Map<string, File>> {
  const result = new Map<string, File>();
  const { readCachedIfc } = await import('../desktop/database.js');
  const { parseDev } = await import('../gim/geometry/devParser.js');

  if (!node.devPath) return result;
  const visitedDevs = new Set<string>();

  async function readFileIntoMap(path: string, label: string): Promise<File | null> {
    if (result.has(path)) return result.get(path)!;
    try {
      const bytes = await readCachedIfc(projectId, path);
      const file = bytesToFile(bytes, path);
      result.set(path, file);
      debugLog(DEBUG_IFC_LOAD, `[xml-mod] 从磁盘读取 ${label}:`, path, `(${bytes.byteLength} bytes)`);
      return file;
    } catch (err) {
      console.warn(`[xml-mod] ${label} 文件读取失败: ${path}`, err);
      return null;
    }
  }

  async function visitDev(devPathInput: string): Promise<void> {
    const devPath = normalizeCachedDevPath(devPathInput);
    if (visitedDevs.has(devPath)) return;
    visitedDevs.add(devPath);

    const devFile = await readFileIntoMap(devPath, 'DEV');
    if (!devFile) return;

    const devBuffer = await devFile.arrayBuffer();
    const devText = new TextDecoder().decode(devBuffer);
    const devDoc = parseDev(devText, devPath);

    for (const solid of devDoc.solidModels) {
      const solidPath = solid.solidModelPath;
      const lower = solidPath.toLowerCase();
      if (lower.endsWith('.dev')) {
        await visitDev(solidPath);
      } else if (lower.endsWith('.phm')) {
        await readFileIntoMap(normalizeCachedPhmPath(solidPath), 'PHM');
      }
    }

    for (const sub of devDoc.subDevices) {
      await visitDev(sub.devPath);
    }
  }

  await visitDev(node.devPath);

  return result;
}

function normalizeCachedDevPath(path: string): string {
  const p = path.replace(/\\/g, '/');
  return p.toLowerCase().startsWith('dev/') ? p : `DEV/${p}`;
}

function normalizeCachedPhmPath(path: string): string {
  const p = path.replace(/\\/g, '/');
  return p.toLowerCase().startsWith('phm/') ? p : `PHM/${p}`;
}

/**
 * 补充 discovery Map 中缺失的 MOD 文件（缓存命中场景专用）。
 *
 * discoverGeometriesFromNode 返回的 DiscoveredModGeometry.mods 包含 modPath，
 * 但 discoveryFiles Map 中可能尚未包含 MOD 文件（buildGeometryFilesMapFromCache 只读 DEV/PHM）。
 * 本函数遍历 discovered 列表，按需读取 MOD 文件并加入 discoveryFiles。
 *
 * @param projectId 数据库 gim_project.id
 * @param discovered discoverGeometriesFromNode 返回的 mods 列表
 * @param files 文件 Map（会被原地修改）
 */
async function ensureModFilesInCacheMap(
  projectId: number,
  discovered: Array<{ modPath: string }>,
  files: Map<string, File>,
): Promise<void> {
  const { readCachedIfc } = await import('../desktop/database.js');
  for (const geo of discovered) {
    if (files.has(geo.modPath)) continue;
    try {
      const bytes = await readCachedIfc(projectId, geo.modPath);
      const file = bytesToFile(bytes, geo.modPath);
      files.set(geo.modPath, file);
      debugLog(DEBUG_IFC_LOAD, '[xml-mod] 从磁盘读取 MOD:', geo.modPath, `(${bytes.byteLength} bytes)`);
    } catch (err) {
      console.warn(`[xml-mod] MOD 文件读取失败: ${geo.modPath}`, err);
    }
  }
}

/**
 * 补充 discovery Map 中缺失的 STL 文件（缓存命中场景专用）。
 *
 * @param projectId 数据库 gim_project.id
 * @param discovered discoverGeometriesFromNode 返回的 STL 列表
 * @param files 文件 Map（会被原地修改）
 */
async function ensureStlFilesInCacheMap(
  projectId: number,
  discovered: Array<{ stlPath: string }>,
  files: Map<string, File>,
): Promise<void> {
  const { readCachedIfc } = await import('../desktop/database.js');
  for (const geo of discovered) {
    if (files.has(geo.stlPath)) continue;
    try {
      const bytes = await readCachedIfc(projectId, geo.stlPath);
      const file = bytesToFile(bytes, geo.stlPath);
      files.set(geo.stlPath, file);
      debugLog(DEBUG_IFC_LOAD, '[xml-mod] 从磁盘读取 STL:', geo.stlPath, `(${bytes.byteLength} bytes)`);
    } catch (err) {
      console.warn(`[xml-mod] STL 文件读取失败: ${geo.stlPath}`, err);
    }
  }
}

/**
 * 把 Uint8Array 转换为 File 对象。
 *
 * 通过 slice 复制到一个独立的 ArrayBuffer，避免 Uint8Array<ArrayBufferLike>
 * 与 BlobPart 类型不兼容（SharedArrayBuffer 不被 Blob 接受）。
 */
function bytesToFile(bytes: Uint8Array, path: string): File {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new File([ab], path, { type: 'application/octet-stream' });
}

/**
 * 遍历 CBM 树，收集所有有 devPath 的节点（不论是否有 IFC）。
 *
 * 设计决策：IFC 可能不包含该设备的完整几何（或 GUID 不匹配），
 * MOD/STL 作为补充/回退几何源，应始终加载。
 *
 * @param root CBM 根节点
 * @returns 符合条件的节点列表（devPath 去重）
 */
export function collectXmlModNodes(root: CbmNode | null): CbmNode[] {
  if (!root) return [];
  const seen = new Set<string>();
  const result: CbmNode[] = [];
  function walk(n: CbmNode) {
    // 收集所有有 devPath 的节点，不论是否有 IFC
    if (n.devPath && !seen.has(n.devPath)) {
      seen.add(n.devPath);
      result.push(n);
    }
    for (const child of n.children) walk(child);
  }
  walk(root);
  return result;
}

/**
 * 自动加载 CBM 树中所有"无 IFC 引用但有 devPath"的节点的 xml-mod 几何。
 *
 * 在 IFC 加载完成后调用，遍历 CBM 树收集符合条件节点，
 * 对每个节点调用 loadXmlModForNode，把 DEV → PHM → MOD 引用链的几何加入场景。
 *
 * 设计动机：
 * - GIM 文件是一个整体，IFC 和 MOD 共同构成完整工程
 * - 用户期望打开 GIM 后看到完整几何，而不是只有 IFC
 * - LOD（Level of Detail）和系统高亮是未来需求，不影响当前整体加载策略
 *
 * @param state 全局 AppState
 * @param showMessage 消息回调
 * @returns 已加载的 MOD 模型数量
 */
export async function autoLoadAllXmlModGeometries(
  state: AppState,
  showMessage: (text: string) => void,
): Promise<number> {
  const nodes = collectXmlModNodes(state.currentCbmTree);
  if (nodes.length === 0) {
    debugLog(DEBUG_IFC_LOAD, '[xml-mod] 自动加载：CBM 树中无符合条件的节点');
    return 0;
  }
  debugLog(DEBUG_IFC_LOAD, '[xml-mod] 自动加载：开始遍历', { nodeCount: nodes.length });

  let totalLoaded = 0;
  for (const node of nodes) {
    try {
      // loadModStlForNode 内部会跳过已加载的 MOD/STL（state 索引去重）
      await loadModStlForNode(state, node, showMessage);
    } catch (err) {
      console.warn('[xml-mod] 自动加载节点失败:', node.path, err);
    }
  }
  totalLoaded = state.loadedXmlModGroups.size + state.loadedStlGroups.size;
  debugLog(DEBUG_IFC_LOAD, '[xml-mod] 自动加载完成', {
    totalLoaded,
    mods: state.loadedXmlModGroups.size,
    stls: state.loadedStlGroups.size,
  });
  return totalLoaded;
}
