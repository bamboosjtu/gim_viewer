import { buildSubstationAliasIndex, deviceOccurrenceScope, type DeviceOccurrenceScope } from '../gim/substationEvidence.js';
import type { CbmNode } from '../gim/types.js';
import type { AppState, ProjectLoadSession, SelectionRequest, SelectionGeometryState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import * as THREE from 'three';
import { collectIfcRefs } from '../gim/cbmParser.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { applyProjectSourceToViewer } from './coordinateAlignmentService.js';
import { getFileByPath, hasFileByPath } from '../gim/fileLookup.js';
import { getGeometryDiagnostic, geometryStatusLabel, geometryReasonLabel, diagnosticForFailure, setGeometryDiagnostic } from '../gim/geometry/geometryDiagnostics.js';
import { resolveIfcModelId } from '../gim/modelIdentity.js';
import {
  attachDevGlbTemplatePool,
  getDevGlbTemplatePool,
  DevGlbTemplatePool,
  DEV_GLB_LEGACY_PLACEMENT_USER_DATA_KEY,
  getLoadedDevOccurrenceKind,
} from './devGlbTemplateRuntime.js';

/**
 * 节点点击交互服务（用于缓存命中、无 Viewer 场景）。
 *
 * 行为：
 * 1. 立即显示基础属性 + 打开属性面板（纯 UI，无 Viewer）
 * 2. 如果节点有 ifcFile/ifcGuid：
 *    a. 检查对应 IFC 模型是否已加载
 *    b. 未加载 → getViewerRuntimeWithUI() → ensureEngineReady() → loadIfcBuffer() → buildIfcNameIndex()
 *    c. 已加载 → getViewerRuntimeWithUI()
 *    d. highlightIfcFromNode() + 刷新完整属性
 * 3. 如果节点无 IFC 关联，只显示基础属性
 */
/** Only the current request may publish selection messages. */
export function selectionMessage(state: AppState, request: SelectionRequest, sink: (text: string) => void) {
  return (text: string): void => {
    if (!state.isCurrentSelection(request)) return;
    state.selectionMessage=text;
    sink(text);
  };
}

export function describeNodeSelectionGeometry(state: AppState, node: CbmNode, attempted=false): SelectionGeometryState {
  const scope=deviceOccurrenceScope(state.currentCbmTree,node);
  if (scope.assemblyPaths?.length === 0) return {status:'unlinked',detail:'部件未关联到真实 DEV 装配路径；保留相机位置。'};
  const diagnostic=getGeometryDiagnostic(state,node.devPath);
  if ((scope.assemblyPaths?.length ?? 0)>1) return {status:'ambiguous',detail:`部件存在 ${scope.assemblyPaths!.length} 条装配路径，将定位所属设备内的全部候选。${diagnostic ? `几何状态：${geometryStatusLabel(diagnostic.status)}；${diagnostic.detail ?? ''}` : '部件完整性尚未获得确定性诊断。'}`};
  if (diagnostic) return {status:diagnostic.status,detail:`${geometryStatusLabel(diagnostic.status)}${diagnostic.reason ? `：${geometryReasonLabel(diagnostic.reason)}` : ''}${diagnostic.detail ? `；${diagnostic.detail}` : ''}`};
  if (node.devPath) {
    const groups=collectDeviceGroups(state,node.devPath,scope);
    if (groups.some(hasRenderableGeometry)) return {status:'available',detail:'已有可显示几何；完整性尚未获得确定性诊断。'};
    const owner=resolveGeometryLoadNode(state.currentCbmTree,node);
    const parentDiagnostic=owner!==node ? getGeometryDiagnostic(state,owner.devPath) : undefined;
    if (parentDiagnostic && ['failed','empty','unsupported'].includes(parentDiagnostic.status)) return {status:parentDiagnostic.status,detail:`所属装配设备${geometryStatusLabel(parentDiagnostic.status)}：${parentDiagnostic.detail ?? '当前部件没有可显示几何'}`};
    return attempted ? {status:'unknown',detail:'当前没有可显示几何；尚无确定性诊断，不能判为空模型。'}
      : {status:'not-loaded',detail:'当前设备几何尚未加载。'};
  }
  if (collectIfcRefs(node,state.currentIfcEntries).size>0) return {status:attempted ? 'unknown':'not-loaded',detail:attempted ? '未找到可显示的直接 GUID 关联构件。':'正在读取直接 IFC 对象关联。'};
  if (node.ifcFile || state.deviceToIfcFile.has(node.path.split('/').pop() || '')) return {status:'file-only',detail:'只有 IFC 文件来源，没有直接对象 GUID 关联；保留相机位置。'};
  return {status:'unassociated',detail:'此对象没有可定位的设备几何或直接 IFC 对象关联；保留相机位置。'};
}

function hasRenderableGeometry(group: THREE.Object3D): boolean {
  let found=false;
  group.traverse((o) => { const mesh=o as THREE.Mesh; if (mesh.isMesh && (mesh.geometry?.getAttribute('position')?.count ?? 0)>0) found=true; });
  return found;
}

/** Clear selection effects without creating a viewer just for an empty object. */
export async function clearSelectionHighlight(state: AppState, request: SelectionRequest, showMessage: (text: string) => void): Promise<void> {
  if (!state.isCurrentSelection(request)) return;
  if (!state.initialized && !state.highlightedItems && !state.highlightedModState) return;
  const { getViewerRuntimeWithUI }=await import('./viewerUIBinding.js');
  const { ctx }=await getViewerRuntimeWithUI(state,showMessage);
  const { commitSelectionHighlight }=await import('../viewer/highlight.js');
  await commitSelectionHighlight(ctx,state,state.selectionGuard(request));
}

/** UI projections follow the request; rendering a tree never starts a selection. */
export async function syncSelectionNavigation(state: AppState, request: SelectionRequest): Promise<void> {
  const [{syncSelectedTreeRow},{highlightSldByGridId},{getGridIdByCbmPath}]=await Promise.all([
    import('../ui/cbmTreeView.js'),import('../ui/sldView.js'),import('../gim/stdSldIndex.js'),
  ]);
  if (!state.isCurrentSelection(request)) return;
  syncSelectedTreeRow(state);
  const target=request.target;
  const gridId=target?.kind==='sld' ? target.key : target?.kind==='cbm' && state.currentStdSldIndex
    ? getGridIdByCbmPath(state.currentStdSldIndex,target.key) : null;
  highlightSldByGridId(gridId);
}

/** Spatial navigation already opens the inspector; it has no implicit 3D fit. */
export async function handleSpatialSelection(
  state: AppState,
  object: import('../gim/ifcSpatialParser.js').IfcSpatialObject | import('../gim/ifcSpatialParser.js').IfcSpatialNode,
  index: import('../gim/ifcSpatialParser.js').SubstationSpatialIndex,
  request: SelectionRequest,
): Promise<void> {
  if (!state.isCurrentSelection(request)) return;
  const {showSpatialNodePropertiesBasic,showIfcSpatialObjectPropertiesBasic,openPropsDrawerUI}=await import('../ui/propsDrawer.js');
  if (!state.isCurrentSelection(request)) return;
  openPropsDrawerUI();
  await Promise.all([
    request.target?.kind==='spatial-node' ? showSpatialNodePropertiesBasic(state,object as import('../gim/ifcSpatialParser.js').IfcSpatialNode,index,request)
      : showIfcSpatialObjectPropertiesBasic(state,object as import('../gim/ifcSpatialParser.js').IfcSpatialObject,index,request),
    clearSelectionHighlight(state,request,() => {}),syncSelectionNavigation(state,request),
  ]);
}

export async function handleNodeClick(
  state: AppState, node: CbmNode, showMessage: (text: string) => void,
  request: SelectionRequest = state.beginSelection({kind:'cbm',key:node.path}),
): Promise<void> {
  const session=request.session;
  const isSessionCurrent=() => state.isCurrentSession(session);
  const isSelected=() => state.isCurrentSelection(request);
  if (!isSessionCurrent()) return;
  const message=selectionMessage(state,request,showMessage);
  const {showNodePropertiesBasic,openPropsDrawerUI}=await import('../ui/propsDrawer.js');
  if (isSelected()) {
    state.selectionGeometry=describeNodeSelectionGeometry(state,node);
    openPropsDrawerUI();
  }
  const basic=showNodePropertiesBasic(state,node,request);
  // Resource loading and property reads are concurrent. Only the short visual
  // reset/apply commit waits behind an already-started external operation.
  const cleared=clearSelectionHighlight(state,request,message);
  await syncSelectionNavigation(state,request);

  const refs=collectIfcRefs(node,state.currentIfcEntries);
  const ifcModelId=node.ifcFile ? resolveIfcModelId(node.ifcFile,state.currentIfcEntries) : state.deviceToIfcFile.get(node.path.split('/').pop() || '');
  try {
    if (refs.size===0 && node.devPath) {
      await loadModStlForNode(state,node,message,session,request);
      await basic;
      if (isSelected()) await showNodePropertiesBasic(state,node,request);
      return;
    }
    const modelsToLoad=new Set([...refs.keys()].filter((id) => !state.loadedModels.has(id)));
    if (ifcModelId && !state.loadedModels.has(ifcModelId)) modelsToLoad.add(ifcModelId);
    if (modelsToLoad.size===0 && refs.size===0) {
      if (isSelected()) { state.selectionGeometry=describeNodeSelectionGeometry(state,node,true); message(state.selectionGeometry.detail); }
      return;
    }
    const {getViewerRuntimeWithUI}=await import('./viewerUIBinding.js');
    const {ctx,modelCallbacks}=await getViewerRuntimeWithUI(state,message);
    if (!isSessionCurrent()) return;
    let ifcFailure:string | undefined;
    if (modelsToLoad.size>0) {
      const {ensureEngineReady}=await import('../viewer/ifcLoader.js');
      const {loadIfcEntry}=await import('../viewer/ifcEntryLoader.js');
      await ensureEngineReady(ctx,state,modelCallbacks);
      if (!isSessionCurrent()) return;
      for (const id of modelsToLoad) {
        if (!isSessionCurrent()) return;
        const entry=state.currentIfcEntries.find((e) => e.modelId===id);
        if (!entry) { ifcFailure=`IFC 来源引用未找到：${id}`;continue; }
        message(`正在加载 ${entry.name}…`);
        try { await loadIfcEntry(ctx,state,entry,() => getIfcBufferForEntry(entry,state,session),(p) => message(`${entry.name}: ${Math.round(p*100)}%`),{session}); }
        catch (error) { ifcFailure=`IFC 加载失败：${entry.name}`;if (isSessionCurrent()) message(ifcFailure); }
      }
      if (!isSessionCurrent()) return;
      const {buildIfcNameIndex}=await import('../viewer/ifcNameIndex.js');
      await buildIfcNameIndex(ctx,state,{session});
      if (!isSessionCurrent()) return;
      const {buildAndRenderCbmTree}=await import('../ui/cbmTreeView.js');
      const {renderFileDevPanel}=await import('../ui/fileDevView.js');
      // This callback handles future user clicks; it is scoped to the project,
      // not to the old selection which happened to refresh the names.
      const click=(n:CbmNode) => { if (isSessionCurrent()) void handleNodeClick(state,n,showMessage); };
      buildAndRenderCbmTree(state,click); renderFileDevPanel(state,click);
    }
    if (!isSelected()) return;
    const {highlightIfcFromNode}=await import('../viewer/highlight.js');
    const {showNodeProperties,openPropsDrawer}=await import('../ui/propsDrawer.js');
    await highlightIfcFromNode(ctx,state,node,message,request);
    if (!isSelected()) return;
    state.selectionGeometry=refs.size>0 && state.highlightedItems
      ? ifcFailure ? {status:'partial',detail:`已定位当前可用的直接 GUID 构件；${ifcFailure}`} : {status:'available',detail:'已定位直接 GUID 关联的 IFC 构件。'}
      : ifcFailure ? {status:'failed',detail:ifcFailure} : describeNodeSelectionGeometry(state,node,true);
    await basic;
    await showNodeProperties(ctx,state,node,request);
    if (isSelected()) openPropsDrawer(ctx);
  } finally { await Promise.all([basic,cleared]); }
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
  session: ProjectLoadSession = state.captureProjectSession(),
): Promise<Uint8Array | null> {
  if (!state.isCurrentSession(session)) return null;
  // 1. 完整解压流程
  if (state.currentFiles) {
    const file = getFileByPath(state.currentFiles, entry.path);
    if (file) {
      debugLog(DEBUG_IFC_LOAD, '[IFC Buffer] 使用 GIM 解压内存文件:', { name: entry.name, path: entry.path });
      const bytes = new Uint8Array(await file.arrayBuffer());
      return state.isCurrentSession(session) ? bytes : null;
    }
  }

  // 2. Tauri 缓存命中
  const { isTauri } = await import('@desktop/runtime.js');
  const cachedEntryPath = findCachedPath(state.cachedIfcPaths, entry.path);
  if (isTauri() && cachedEntryPath) {
    const projectId = session.projectId;
    if (projectId != null) {
      const cachePath = state.cachedIfcPaths.get(cachedEntryPath)!;
      debugLog(DEBUG_IFC_LOAD, '[IFC Buffer] 使用本地 IFC 缓存:', { name: entry.name, path: entry.path, cachePath });
      const { readCachedIfc } = await import('@desktop/database.js');
      const bytes = await readCachedIfc(projectId, cachedEntryPath);
      return state.isCurrentSession(session) ? bytes : null;
    }
  }

  console.warn('[IFC Buffer] 找不到 IFC 文件内容或缓存:', entry);
  return null;
}

/** cachedIfcPaths 保留缓存索引的原始路径；跨厂商引用查找忽略大小写和分隔符。 */
function findCachedPath(paths: Map<string, string>, requestedPath: string): string | undefined {
  if (paths.has(requestedPath)) return requestedPath;
  const normalized = requestedPath.replace(/\\/g, '/').toLowerCase();
  for (const path of paths.keys()) {
    if (path.replace(/\\/g, '/').toLowerCase() === normalized) return path;
  }
  return undefined;
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
 * 将 devPath 归一化为可比较的形式（去除 DEV/ 前缀，小写）。
 *
 * 用于 collectDeviceGroups 匹配：
 * - geometryNode.devPath 形如 "abc.dev"（无 DEV/ 前缀）
 * - group.userData.devPath 形如 "DEV/abc.dev"（glbCacheService / modAutoLoadService 标记）
 * 归一化后两者可正确比较。
 */
function normalizeDevPathForCompare(devPath: string | undefined): string {
  if (!devPath) return '';
  const p = devPath.replace(/\\/g, '/').toLowerCase();
  return p.startsWith('dev/') ? p.slice(4) : p;
}

/**
 * 收集指定 devPath 对应的所有已加载 Group（MOD + STL）。
 *
 * 遍历 state.loadedXmlModGroups 和 state.loadedStlGroups，查找
 * scope 指定根放置实例和实际装配候选子树。无 scope 时才显式按 DEV
 * 模板收集全部实例。用于相机定位和高亮。
 */
export function collectDeviceGroups(state: AppState, devPath: string, scope?: DeviceOccurrenceScope): THREE.Object3D[] {
  const normalized = normalizeDevPathForCompare(devPath);
  if (!normalized) return [];
  const result: THREE.Object3D[] = [];
  const seen = new Set<THREE.Object3D>();
  for (const root of [...state.loadedXmlModGroups.values(), ...state.loadedStlGroups.values()]) {
    root.traverse((object) => {
      // GLTFLoader restores source group nodes as Object3D, which still owns
      // the complete renderable subtree. Identity must not depend on isGroup.
      const group = object;
      if (seen.has(group)) return;
      let owner: THREE.Object3D | null = group;
      while (owner && !owner.userData.rootOccurrence) owner = owner.parent;
      const inRoot = !scope || owner?.userData.rootOccurrence === scope.rootOccurrence;
      const assembly = String(group.userData.assemblyPath ?? '');
      const inAssembly = !scope?.assemblyPaths || scope.assemblyPaths.some((path) => assembly === path || assembly.startsWith(`${path}/`));
      const matches = scope
        ? !!group.userData.devPath : normalizeDevPathForCompare(group.userData.devPath as string | undefined) === normalized;
      if (inRoot && inAssembly && matches) {
        // A selected ancestor already contains these meshes; returning both
        // would highlight them twice and overwrite original material tracking.
        for (let parent = group.parent; parent; parent = parent.parent) {
          if (seen.has(parent)) return;
        }
        seen.add(group); result.push(group);
      }
    });
  }
  return result;
}

/**
 * 将相机定位到指定 devPath 对应的已加载几何并高亮。
 *
 * 流程：
 * 1. collectDeviceGroups 收集匹配的 Group
 * 2. 合并包围盒，调用 frameBox 定位相机
 * 3. resetHighlight 清除旧高亮（IFC + MOD）
 * 4. highlightModGroups 高亮该设备的所有 MOD/STL Group
 *
 * 设计动机：
 * - 替代旧的 fitCameraToScene（仅首次加载时定位整个场景）
 * - 用户每次点击 MOD 设备节点都应将视点聚焦到该设备并高亮
 */
export async function frameAndHighlightDevice(
  ctx: ViewerContext, state: AppState, devPath: string, scope: DeviceOccurrenceScope,
  session: ProjectLoadSession = state.captureProjectSession(),
  request?: SelectionRequest,
): Promise<void> {
  if (!state.isCurrentSession(session)) return;
  request ??= state.beginSelection({kind:'cbm',key:scope.rootOccurrence});
  const guard=state.selectionGuard(request);
  if (!state.isCurrentSession(session) || !guard.isCurrent()) return;
  const groups=collectDeviceGroups(state,devPath,scope).filter(hasRenderableGeometry);
  const {commitSelectionHighlight,highlightModGroups}=await import('../viewer/highlight.js');
  await commitSelectionHighlight(ctx,state,guard,() => highlightModGroups(state,groups));
  if (!guard.isCurrent() || groups.length===0) return;
  const box=new THREE.Box3(); groups.forEach((g) => box.expandByObject(g));
  const {frameBox}=await import('../viewer/camera.js');
  const owned=state.highlightedModState;
  const {resetModHighlight}=await import('../viewer/highlight.js');
  const clearOwned=() => { if (state.highlightedModState===owned) resetModHighlight(state); };
  request.signal.addEventListener('abort',clearOwned,{once:true});
  try { await frameBox(ctx,box,guard); } finally { request.signal.removeEventListener('abort',clearOwned); }
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
 * 6. frameAndHighlightDevice 将相机定位到该设备并高亮所有 MOD/STL
 *
 * 文件来源（v6 起）：
 * - currentFiles 非空（首次打开）：直接从内存 Map 读取
 * - currentFiles=null（缓存命中）：按需从磁盘 readCachedIfc 读取 DEV/PHM/MOD 文件
 *
 * @param state 全局 AppState
 * @param node CBM 节点（必须带 devPath）
 * @param showMessage 消息回调
 */
const pendingOccurrenceLoads = new WeakMap<AppState, Map<string, Promise<void>>>();

export async function loadModStlForNode(
  state: AppState, node: CbmNode, showMessage: (text: string) => void,
  session: ProjectLoadSession = state.captureProjectSession(),
  request?: SelectionRequest,
): Promise<void> {
  if (!state.isCurrentSession(session)) return;
  request ??= state.beginSelection({kind:'cbm',key:node.path});
  const root=resolveGeometryLoadNode(state.currentCbmTree,node);
  const scope=deviceOccurrenceScope(state.currentCbmTree,node);
  const message=selectionMessage(state,request,showMessage);
  const known=getGeometryDiagnostic(state,node.devPath);
  const alreadyLoaded=scope.assemblyPaths?.length && scope.assemblyPaths.every((path) => collectDeviceGroups(state,node.devPath,{...scope,assemblyPaths:[path]}).some(hasRenderableGeometry));
  const noLoad=alreadyLoaded || scope.assemblyPaths?.length===0 || known?.status==='empty' || known?.status==='unsupported';
  if (!noLoad) {
    const key=`${session.generation}:${session.geometryToken}:${root.path}`;
    const pending=pendingOccurrenceLoads.get(state) ?? new Map(); pendingOccurrenceLoads.set(state,pending);
    let task=pending.get(key);
    if (!task) {
      // No messages, camera or highlight in this shared resource promise.
      task=loadModStlForNodeImpl(state,root,() => {},session).catch((error) => {
        if (state.isCurrentSession(session)) setGeometryDiagnostic(state,diagnosticForFailure(root.devPath,'parse-failed','raw',error instanceof Error ? error.message : String(error)));
      });
      pending.set(key,task);
    }
    try { await task; } finally { if (pending.get(key)===task) pending.delete(key); }
  }
  if (!state.isCurrentSelection(request)) return;
  state.selectionGeometry=describeNodeSelectionGeometry(state,node,true);
  message(state.selectionGeometry.detail);
  const {getViewerRuntimeWithUI}=await import('./viewerUIBinding.js');
  const {ctx}=await getViewerRuntimeWithUI(state,message);
  await frameAndHighlightDevice(ctx,state,node.devPath,scope,session,request);
}


async function loadModStlForNodeImpl(
  state: AppState,
  node: CbmNode,
  showMessage: (text: string) => void,
  session: ProjectLoadSession = state.captureProjectSession(),
): Promise<void> {
  if (!state.isCurrentSession(session)) return;
  // PARTINDEX 是父设备 DEV SUBDEVICE 的 CBM 语义别名。它自身没有
  // SUBDEVICE 局部矩阵，直接从它发现几何会得到错误 placement。
  // 回退到最近的真实设备祖先，由 DEV 递归一次性计算该设备及部件的正确矩阵。
  const geometryNode = resolveGeometryLoadNode(state.currentCbmTree, node);
  const scope = deviceOccurrenceScope(state.currentCbmTree, node);
  if (scope.assemblyPaths?.length === 0) { showMessage('部件未关联到真实 DEV 装配路径'); return; }
  if ((scope.assemblyPaths?.length ?? 0) > 1) showMessage(`部件存在 ${scope.assemblyPaths!.length} 条装配路径，将定位全部候选`);
  if (geometryNode !== node) {
    debugLog(DEBUG_IFC_LOAD, '[xml-mod] PARTINDEX 使用设备祖先作为几何入口:', {
      partIndex: node.path,
      geometryRoot: geometryNode.path,
    });
  }

  // 准备文件读取适配器：currentFiles 优先，缓存命中时回退磁盘
  const files = state.currentFiles;
  const projectId = session.projectId;

  if (!files && projectId == null) {
    debugLog(DEBUG_IFC_LOAD, '[xml-mod] 无文件来源可用（currentFiles=null 且 projectId=null）:', node.devPath);
    return;
  }

  // 获取 ViewerRuntime（懒加载，与 IFC 路径共用同一引擎）
  const { getViewerRuntimeWithUI } = await import('./viewerUIBinding.js');
  const runtime = await getViewerRuntimeWithUI(state, showMessage);
  if (!state.isCurrentSession(session)) return;
  const { ctx } = runtime;
  const scene = (ctx.world.scene as any).three as import('three').Scene;

  if (node.entityName.toUpperCase() === 'PARTINDEX' && scope.assemblyPaths!.every((path) =>
    collectDeviceGroups(state, node.devPath, { ...scope, assemblyPaths: [path] }).length > 0)) {
    return;
  }

  // 方案 C v2：优先尝试 DEV 粒度 GLB 快速路径
  // 如果 DEV.glb 命中，直接加载整个 DEV 的几何，跳过 MOD 逐个解析
  if (projectId != null && geometryNode.devPath) {
    const devGlbLoaded = await tryLoadDevGlbForNode(state, scene, geometryNode, projectId, showMessage, session);
    if (!state.isCurrentSession(session)) return;
    if (devGlbLoaded) {
      if (!state.isCurrentSession(session)) return;
      return;
    }
  }

  // 回退：MOD 粒度加载（XML 解析 + 方案 C 旧路径）
  const { discoverGeometriesFromNode, computeCbmParentTransform } = await import('./modGeometryDiscovery.js');
  // discoverGeometriesFromNode 在 files=null 时返回空，因此缓存命中场景需要先构建临时 Map
  const discoveryFiles = files ?? await buildGeometryFilesMapFromCache(projectId!, geometryNode, state, session);
  if (!state.isCurrentSession(session)) return;
  if (!discoveryFiles || discoveryFiles.size === 0) {
    debugLog(DEBUG_IFC_LOAD, '[xml-mod] 无法获取 DEV/PHM/MOD 文件:', geometryNode.devPath);
    return;
  }

  // DEV_SUBDEVICE 虚拟节点的 transformMatrix 仅含 SUBDEVICE 局部变换，
  // 需补上乘以父 CBM 链累积矩阵，否则点击加载的 MOD 会丢失父级位置。
  const parentCbmTransform = geometryNode.entityName === 'DEV_SUBDEVICE'
    ? computeCbmParentTransform(state.currentCbmTree, geometryNode.path)
    : undefined;
  const { mods, stls } = await discoverGeometriesFromNode(geometryNode, discoveryFiles, parentCbmTransform);
  if (!state.isCurrentSession(session)) return;

  if (mods.length === 0 && stls.length === 0) {
    // The permissive discovery path may hide missing dependencies. Confirm
    // reachability with the existing strict traversal before calling it empty.
    const {discoverGeometriesFromDevPath}=await import('./modGeometryDiscovery.js');
    try {
      await discoverGeometriesFromDevPath(geometryNode.devPath,discoveryFiles,new THREE.Matrix4().toArray(),new Set(),0,{instances:0},{strictDependencies:true});
      if (state.isCurrentSession(session) && !getGeometryDiagnostic(state,geometryNode.devPath)) {
        setGeometryDiagnostic(state,{devPath:geometryNode.devPath,status:'empty',source:'raw',unsupportedPrimitiveTypeCounts:{},detail:'引用遍历已完成，没有可达 MOD/STL 主几何源。'});
      }
    } catch (error) {
      if (state.isCurrentSession(session)) setGeometryDiagnostic(state,diagnosticForFailure(geometryNode.devPath,'missing-dependency','raw',String(error)));
    }
    debugLog(DEBUG_IFC_LOAD, '[xml-mod] 未发现 MOD/STL 几何来源:', geometryNode.devPath);
    return;
  }

  // 缓存命中场景下，确保所有需要的 MOD/STL 文件也在 discoveryFiles 中
  if (!files) {
    await ensureModFilesInCacheMap(projectId!, mods, discoveryFiles, state, session);
    if (!state.isCurrentSession(session)) return;
    await ensureStlFilesInCacheMap(projectId!, stls, discoveryFiles, state, session);
    if (!state.isCurrentSession(session)) return;
  }

  const {
    loadXmlModFromFiles,
    applyPlacementTransformToSceneUnits,
    XML_MOD_GEOMETRY_DIAGNOSTICS_KEY,
  } = await import('../viewer/xmlModLoader.js');

  let loadedCount = 0;
  let stlLoadedCount = 0;

  // ── 加载 MOD（XML 解析） ──
  for (const geo of mods) {
    if (state.loadedXmlModGroups.has(geo.instanceKey)) {
      debugLog(DEBUG_IFC_LOAD, '[xml-mod] MOD 实例已加载，跳过:', geo.instanceKey);
      continue;
    }

    const group = await loadXmlModFromFiles(geo.modPath, discoveryFiles, geo.phmColor, geo.phmColorMaxA);
    if (!state.isCurrentSession(session)) {
      group?.traverse((object) => (object as THREE.Mesh).geometry?.dispose?.());
      return;
    }
    if (!group) continue;

    applyPlacementTransformToSceneUnits(group, geo.placementTransformMatrix);
    applyProjectSourceToViewer(group, state.projectSourceToViewerMatrix);
    const modRoot = ensureModStlLayer(state, scene, 'mod');
    group.userData.devPath = geo.devPath;
    if (getLoadedDevOccurrenceKind(state,geo.rootOccurrence) === 'glb' || state.loadedXmlModGroups.has(geo.instanceKey)) {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.()); continue;
    }
    group.userData.rootOccurrence = geo.rootOccurrence;
    group.userData.assemblyPath = geo.assemblyPath;
    group.userData.referencePath = geo.referencePath;
    modRoot.add(group);
    state.loadedXmlModGroups.set(geo.instanceKey, group);
    loadedCount++;
  }

  // ── 加载 STL（直接解析） ──
  const { parseStlBinary } = await import('../viewer/stlLoader.js');
  const { applyPhmColorOverride } = await import('../viewer/xmlModGeometry.js');
  for (const geo of stls) {
    if (state.loadedStlGroups.has(geo.instanceKey)) {
      debugLog(DEBUG_IFC_LOAD, '[xml-mod] STL 实例已加载，跳过:', geo.instanceKey);
      continue;
    }

    const stlFile = getFileByPath(discoveryFiles, geo.stlPath);
    if (!stlFile) {
      console.warn(`[xml-mod] STL 文件不存在: ${geo.stlPath}`);
      continue;
    }
    const buffer = await stlFile.arrayBuffer();
    if (!state.isCurrentSession(session)) return;
    const group = parseStlBinary(buffer, geo.stlPath);
    if (!group) continue;
    applyPhmColorOverride(group, geo.phmColor, geo.phmColorMaxA);

    applyPlacementTransformToSceneUnits(group, geo.placementTransformMatrix);
    applyProjectSourceToViewer(group, state.projectSourceToViewerMatrix);
    const stlRoot = ensureModStlLayer(state, scene, 'stl');
    group.userData.devPath = geo.devPath;
    if (getLoadedDevOccurrenceKind(state,geo.rootOccurrence) === 'glb' || state.loadedStlGroups.has(geo.instanceKey)) {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.()); continue;
    }
    group.userData.rootOccurrence = geo.rootOccurrence;
    group.userData.assemblyPath = geo.assemblyPath;
    group.userData.referencePath = geo.referencePath;
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
  }
  // Reuse actual loader diagnostics; no unknown source is labelled empty.
  const groups=[...mods.map((geo) => state.loadedXmlModGroups.get(geo.instanceKey)),...stls.map((geo) => state.loadedStlGroups.get(geo.instanceKey))];
  const visible=groups.filter((group) => group && hasRenderableGeometry(group)).length;
  const missing=groups.filter((group) => !group).length;
  let reachabilityError:string | undefined;
  try {
    const {discoverGeometriesFromDevPath}=await import('./modGeometryDiscovery.js');
    await discoverGeometriesFromDevPath(geometryNode.devPath,discoveryFiles,new THREE.Matrix4().toArray(),new Set(),0,{instances:0},{strictDependencies:true});
  } catch (error) { reachabilityError=String(error); }
  if (!state.isCurrentSession(session)) return;
  const xml=groups.flatMap((group) => group?.userData[XML_MOD_GEOMETRY_DIAGNOSTICS_KEY] ? [group.userData[XML_MOD_GEOMETRY_DIAGNOSTICS_KEY] as import('../viewer/xmlModLoader.js').XmlModGeometryDiagnostics] : []);
  const degraded=xml.some((diagnostic) => diagnostic.status==='partial' || diagnostic.status==='unsupported');
  const types:Record<string,number>={};
  for (const diagnostic of xml) for (const [type,count] of Object.entries(diagnostic.unsupportedPrimitiveTypeCounts)) types[type]=(types[type] ?? 0)+count;
  if (visible || missing || xml.length===groups.length) {
    const status=visible ? missing || reachabilityError || degraded ? 'partial':'renderable' : missing || reachabilityError ? 'failed' : degraded ? 'unsupported':'empty';
    setGeometryDiagnostic(state,{devPath:geometryNode.devPath,status,source:'raw',unsupportedPrimitiveTypeCounts:types,
      ...(missing || reachabilityError ? {reason:'missing-dependency' as const,detail:`${missing} 个几何源加载失败；${visible} 个来源可显示。${reachabilityError ?? ''}`} :
        degraded ? {reason:'parser-unsupported' as const,detail:'部分来源或 primitive 暂不支持；只定位当前实例中可显示的几何。'} : {}),
      discoveredModCount:mods.length,discoveredStlCount:stls.length,
    });
  }
  // This shared task only commits resources/diagnostics. Each selection waiter
  // independently decides whether it may frame and highlight these resources.
  if (!state.isCurrentSession(session)) return;
}

/**
 * 方案 C v2：节点点击时尝试 DEV 粒度 GLB 快速路径。
 *
 * 如果 DEV.glb 命中，加载整个 DEV 的几何并应用 CBM 矩阵，返回 true。
 * 如果未命中，返回 false，调用方回退到 MOD 粒度加载。
 */
async function tryLoadDevGlbForNode(
  state: AppState,
  scene: THREE.Scene,
  geometryNode: CbmNode,
  projectId: number,
  showMessage: (text: string) => void,
  session: ProjectLoadSession,
): Promise<boolean> {
  if (!state.isCurrentSession(session)) return false;
  if (!geometryNode.devPath) return false;
  const existing = getLoadedDevOccurrenceKind(state,geometryNode.path);
  if (existing) return existing === 'glb';

  const normalized = geometryNode.devPath.replace(/\\/g, '/');
  const devPath = normalized.toLowerCase().startsWith('dev/')
    ? normalized
    : `DEV/${normalized}`;

  // 读取 DEV.glb
  let glbBytes: Uint8Array | null = null;
  try {
    const { readGlbFile } = await import('@desktop/database.js');
    glbBytes = await readGlbFile(projectId, devPath);
    if (!state.isCurrentSession(session)) return false;
  } catch {
    return false;
  }
  if (!glbBytes || glbBytes.byteLength === 0) return false;

  // 检查是否已加载
  const instanceKey = `dev:${devPath}#${geometryNode.path}`;
  if (state.loadedXmlModGroups.has(instanceKey)) {
    debugLog(DEBUG_IFC_LOAD, `[xml-mod] DEV GLB 实例已加载，跳过: ${instanceKey}`);
    return true;
  }

  // 应用 CBM 累积矩阵
  const { applyPlacementTransformToSceneUnits } = await import('../viewer/xmlModLoader.js');
  const { computeCbmParentTransform } = await import('./modGeometryDiscovery.js');

  // DEV_SUBDEVICE 虚拟节点需要父链矩阵
  const parentCbmTransform = geometryNode.entityName === 'DEV_SUBDEVICE'
    ? computeCbmParentTransform(state.currentCbmTree, geometryNode.path)
    : undefined;

  // 计算 CBM 累积矩阵（parent × node.transformMatrix）
  const localTransform = parseMatrixFromString(geometryNode.transformMatrix);
  const cbmTransform = parentCbmTransform
    ? multiplyMatrices(parentCbmTransform, localTransform)
    : localTransform;

  // Reuse the current session's template pool when the automatic pipeline
  // already parsed this DEV.  A click that reaches a not-yet-loaded DEV also
  // creates the same pool abstraction, so lazy interaction does not introduce
  // a second placement/parse semantic.
  const { loadDevGlb, parseDevGlbAsset } = await import('./glbCacheService.js');
  const modRoot = ensureModStlLayer(state, scene, 'mod');
  const templatePool = getDevGlbTemplatePool(modRoot, session) ?? new DevGlbTemplatePool({
    session,
    isCurrent: () => state.isCurrentSession(session),
    parse: parseDevGlbAsset,
  });
  attachDevGlbTemplatePool(modRoot, templatePool);
  const preparation = await templatePool.prepare(devPath, glbBytes);
  if (!state.isCurrentSession(session)) return false;
  const afterPrepare = getLoadedDevOccurrenceKind(state,geometryNode.path);
  if (afterPrepare) return afterPrepare === 'glb';

  if (preparation?.kind === 'shared') {
    const sharedGroup = preparation.template.createPlacement({
      instanceKey,
      placementMatrix: cbmTransform,
      projectSourceToViewerMatrix: state.projectSourceToViewerMatrix,
    });
    if (!state.isCurrentSession(session)) return false;
    sharedGroup.userData.rootOccurrence = geometryNode.path;
    modRoot.add(sharedGroup);
    state.loadedXmlModGroups.set(instanceKey, sharedGroup);
    debugLog(DEBUG_IFC_LOAD, `[xml-mod] DEV GLB template placement 命中: ${devPath} (instance: ${instanceKey})`);
    showMessage(`已加载 DEV 几何模型: ${devPath}`);
    return true;
  }

  // A non-shareable hierarchy is isolated to this DEV and keeps the exact
  // legacy per-placement loader semantics.  A parse failure returns false so
  // the caller can continue with the existing raw MOD/STL path.
  const group = await loadDevGlb(devPath, glbBytes);
  if (!state.isCurrentSession(session)) {
    group?.traverse((object) => (object as THREE.Mesh).geometry?.dispose?.());
    return false;
  }
  if (!group) return false;

  applyPlacementTransformToSceneUnits(group, cbmTransform);
  if (!state.isCurrentSession(session)) {
    group.traverse((object) => (object as THREE.Mesh).geometry?.dispose?.());
    return false;
  }
  applyProjectSourceToViewer(group, state.projectSourceToViewerMatrix);

  const beforeCommit = getLoadedDevOccurrenceKind(state,geometryNode.path);
  if (beforeCommit) {
    group.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.());
    return beforeCommit === 'glb';
  }
  group.userData.rootOccurrence = geometryNode.path;
  group.userData.instanceKey = instanceKey;
  group.userData[DEV_GLB_LEGACY_PLACEMENT_USER_DATA_KEY] = true;
  if (!state.isCurrentSession(session)) {
    group.traverse((object) => (object as THREE.Mesh).geometry?.dispose?.());
    return false;
  }
  modRoot.add(group);
  state.loadedXmlModGroups.set(instanceKey, group);

  debugLog(DEBUG_IFC_LOAD, `[xml-mod] DEV GLB 命中: ${devPath} (instance: ${instanceKey})`);
  showMessage(`已加载 DEV 几何模型: ${devPath}`);

  return true;
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function parseMatrixFromString(raw: string | undefined): number[] {
  if (!raw) return IDENTITY_MATRIX.slice();
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 16) return IDENTITY_MATRIX.slice();
  const values = parts.map(Number);
  return values.some((n) => !Number.isFinite(n)) ? IDENTITY_MATRIX.slice() : values;
}

function multiplyMatrices(a: number[], b: number[]): number[] {
  const am = new THREE.Matrix4().fromArray(a.length === 16 ? a : IDENTITY_MATRIX);
  const bm = new THREE.Matrix4().fromArray(b.length === 16 ? b : IDENTITY_MATRIX);
  return am.multiply(bm).toArray();
}

/**
 * 为节点点击选择可用于发现几何的 CBM 节点。
 *
 * PARTINDEX 只描述父设备的一个组成部件，并不保存其 DEV SUBDEVICE
 * transform。选择最近的带 DEV 的祖先可复用完整 DEV 递归链，避免生成
 * 缺失局部矩阵的重复实例。
 */
export function resolveGeometryLoadNode(root: CbmNode | null, node: CbmNode): CbmNode {
  if (node.entityName.toUpperCase() === 'DEV_SUBDEVICE' && root) {
    const rootPath = node.path.split('#dev:')[0];
    const find = (n: CbmNode): CbmNode | undefined => n.path === rootPath ? n : n.children.map(find).find(Boolean);
    return find(root) ?? node;
  }
  if (node.entityName.toUpperCase() !== 'PARTINDEX' || !root) return node;
  return buildSubstationAliasIndex(root).partToRoot.get(node.path) ?? node;
}

/**
 * 缓存命中场景下，从磁盘读取 DEV/PHM/MOD 文件构建临时 Map<string, File>。
 *
 * 读取范围：
 * - DEV/{node.devPath}（必需）
 * - 递归 DEV / PHM 引用（批量读取，visited 与深度限制）
 * - 显式 MOD / GL / STL 叶子（缺失时仅隔离目标）
 *
 * 一次点击只读取该节点引用链需要的文件，避免一次性读取全部 DEV/PHM/MOD。
 *
 * @param projectId 数据库 gim_project.id
 * @param node CBM 节点（必须带 devPath）
 * @returns 包含可达引用源的 Map；找不到时返回空 Map
 */
async function buildGeometryFilesMapFromCache(
  projectId: number,
  node: CbmNode,
  state?: AppState,
  session?: ProjectLoadSession,
): Promise<Map<string, File>> {
  const { batchReadCachedFiles } = await import('@desktop/database.js');
  const { hydrateSubstationGeometryGraph } = await import('../gim/geometry/substationSourceGraph.js');
  if (!node.devPath) return new Map();
  return hydrateSubstationGeometryGraph([node.devPath], async (paths) => {
    if (state && session && !state.isCurrentSession(session)) return new Map();
    const bytes = await batchReadCachedFiles(projectId, paths);
    if (state && session && !state.isCurrentSession(session)) return new Map();
    return new Map([...bytes].filter(([, value]) => value && value.byteLength > 0)
      .map(([path, value]) => [path, bytesToFile(value!, path)]));
  });
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
  state?: AppState,
  session?: ProjectLoadSession,
): Promise<void> {
  const { readCachedIfc } = await import('@desktop/database.js');
  for (const geo of discovered) {
    if (state && session && !state.isCurrentSession(session)) return;
    if (hasFileByPath(files, geo.modPath)) continue;
    try {
      const bytes = await readCachedIfc(projectId, geo.modPath);
      if (state && session && !state.isCurrentSession(session)) return;
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
  state?: AppState,
  session?: ProjectLoadSession,
): Promise<void> {
  const { readCachedIfc } = await import('@desktop/database.js');
  for (const geo of discovered) {
    if (state && session && !state.isCurrentSession(session)) return;
    if (hasFileByPath(files, geo.stlPath)) continue;
    try {
      const bytes = await readCachedIfc(projectId, geo.stlPath);
      if (state && session && !state.isCurrentSession(session)) return;
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
