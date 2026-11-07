import { reportBackgroundError } from '../utils/backgroundErrors.js';
import { ProjectPropertyCache } from '../services/projectPropertyCache.js';
import { ProjectViewState } from '../shared/projectViewState.js';
import { RuntimeSlot } from '../shared/runtimeSlot.js';
import type { DeviceRuntime } from '../shared/deviceRuntime.js';
import type { IfcRegionalRuntime } from '../viewer/ifcRegionalRuntime.js';
import type { SubstationCapabilitySummary } from '../gim/substationEvidence.js';
import type { IfcEntry, CbmNode, FileDevEntry } from '../gim/types.js';
import type * as OBCF from '@thatopen/fragments';
import type * as THREE from 'three';
import type { GimProjectType } from '../gim/projectType.js';
import type { GimGraph } from '../gim/gimGraphTypes.js';
import type { StdDocument } from '../gim/stdParser.js';
import type { SldDocument } from '../gim/sldParser.js';
import type { StdSldIndex } from '../gim/stdSldIndex.js';
import type { SubstationSpatialIndex } from '../gim/ifcSpatialParser.js';
import { createIfcRuntimeModelId, isCurrentProject } from '../shared/projectSession.js';
import type { GeometryDiagnostic } from '../gim/geometry/geometryDiagnostics.js';
import type { ViewerViewHistory } from '../viewer/viewHistory.js';

import type { SubstationFineQueue } from '../shared/selectionContracts.js';
export type { SubstationFineQueue } from '../shared/selectionContracts.js';

/** Session-owned incremental IFC connection preview; optional in browser tests. */
export interface SubstationConnectionPreview {
  acceptBatch(batch: unknown): boolean;
  markComplete(modelId: string, meta: { objectCount: number; sequence: number }): void;
  markFailed?(modelId: string): void;
  markModelReady(modelId: string, sourceObjects?: readonly import('../viewer/ifcRegionalData.js').RegionalObject[]): void;
  sourceObjects?(): ReadonlyArray<{modelId: string; objects: readonly import('../viewer/ifcRegionalData.js').RegionalObject[]}>;
  setTransform?(matrix: THREE.Matrix4): void;
  setSelectionScope?(only: boolean, scopes: ReadonlyMap<string, import('../viewer/ifcModelVisibility.js').IfcSelectionScope>): void;
  diagnostics?: Record<string, number>;
  release(): void;
}

import type { ProjectLoadSession } from '../shared/projectSession.js';
export type { ProjectLoadSession } from '../shared/projectSession.js';
import type { SelectionRequest, EngineeringSelectionScope, SelectionCommitGuard, SelectionGeometryState } from '../shared/selectionContracts.js';
export type { SelectionRequest, EngineeringSelectionScope, SelectionCommitGuard, SelectionGeometryState } from '../shared/selectionContracts.js';

/** 应用全局状态（由 bootstrap.ts 创建唯一实例，通过参数注入各模块） */
export class AppState {
  readonly properties = new ProjectPropertyCache();
  readonly sessionDisposables = new Set<() => void>();
  deviceUnknownBounds = new Set<string>();
  /** Session-owned priority lane for explicit IFC precision requests. */
  substationFineQueue: SubstationFineQueue | null = null;
  /** Cheap connection-line previews are discarded with the project session. */
  substationConnectionPreview: SubstationConnectionPreview | null = null;
  substationConnectionPorts: import('../gim/glConnectionPorts.js').GlConnectionPortIndex | null = null;
  substationResourceMonitor: { release(): void } | null = null;
  substationMemoryPressure: import('../utils/memoryPressure.js').MemoryPressure = 'unknown';
  viewHistory: ViewerViewHistory | null = null;
  stationOverview: (() => void) | null = null;
  onlySelected = false;
  autoLocate = true;
  cameraNavigationVersion = 0;
  hoverCleanup: (() => void) | null = null;
  selectionDecorationCleanup: (() => void) | null = null;
  selectionVisibility: ReturnType<typeof import('../services/selectionVisibility.js').createSelectionVisibility> | null = null;
  selectionHighlightRequestId: number | null = null;
  engineeringSelection: EngineeringSelectionScope | null = null;
  representationSelection: import('../shared/representationSelection.js').RepresentationSelectionScope | null = null;
  engineeringGeometryFilter: ((root?: THREE.Object3D) => void) | null = null;
  engineeringRepresentationChanged: ((rootOccurrence?: string) => void) | null = null;
  engineeringGeometryEvidenceChanged: (()=>void) | null = null;
  engineeringSelectionCleanup: (() => void) | null = null;
  engineeringNavigationCleanup: (() => void) | null = null;
  private readonly deviceRuntimeSlot = new RuntimeSlot<DeviceRuntime>();
  get deviceLodRuntime():DeviceRuntime|null { return this.deviceRuntimeSlot.value; }
  set deviceLodRuntime(runtime:DeviceRuntime|null) { this.deviceRuntimeSlot.value=runtime; }
  selectionRequest: SelectionRequest | null = null;
  selectionGeometry: SelectionGeometryState | null = null;
  selectionMessage = '';
  private selectionSequence = 0;
  private selectionAbort: AbortController | null = null;

  beginSelection(target: SelectionRequest['target'], origin: SelectionRequest['origin'] = 'tree'): SelectionRequest {
    this.hoverCleanup?.();
    this.selectionAbort?.abort();
    // While a new target is resolving, the previous isolated range remains
    // visible. Its request is obsolete, so it cannot publish any late results.
    const retainRange = this.onlySelected && target !== null;
    if (!retainRange) {
      this.engineeringSelection = null;
      this.representationSelection = null;
      this.engineeringGeometryFilter?.();
      this.deviceLodRuntime?.clearSelection();
      for (const runtime of this.ifcRegionalRuntimes.values()) { runtime.clearFineSelection?.(); runtime.clearSelectionFilter?.(); }
    }
    this.selectionAbort = new AbortController();
    const request: SelectionRequest = { id: ++this.selectionSequence, session: this.captureProjectSession(), signal: this.selectionAbort.signal, target, origin, cameraNavigationVersion: this.cameraNavigationVersion };
    this.selectionRequest = request;
    if (!retainRange) {
      this.deviceLodRuntime?.setOnlySelected?.(this.onlySelected);
      for (const runtime of this.ifcRegionalRuntimes.values()) runtime.setOnlySelected?.(this.onlySelected);
    }
    this.selectionGeometry = null;
    this.selectionMessage = '';
    return request;
  }

  isCurrentSelection(request: SelectionRequest): boolean {
    return this.selectionRequest?.id === request.id && !request.signal.aborted && this.isCurrentSession(request.session);
  }
  canAutoLocate(request: SelectionRequest): boolean {
    return this.autoLocate && request.origin !== 'viewport' && (request.cameraNavigationVersion === undefined || request.cameraNavigationVersion === this.cameraNavigationVersion);
  }

  selectionGuard(request: SelectionRequest): SelectionCommitGuard {
    return { isCurrent: () => this.isCurrentSelection(request), isSessionCurrent: () => this.isCurrentSession(request.session), signal: request.signal };
  }

  invalidateSelection(): void {
    this.selectionAbort?.abort();
    for (const runtime of this.ifcRegionalRuntimes.values()) { runtime.clearFineSelection?.(); runtime.clearSelectionFilter?.(); }
    this.selectionSequence++;
    this.selectionRequest = null;
    this.engineeringSelection = null;
    this.representationSelection = null;
    this.engineeringGeometryFilter?.();
    this.selectionGeometry = null;
    this.selectionMessage = '';
  }
  /** Session-only visibility filter for focused browser inspection. */
  get canIsolateSelection(): boolean {
    const request = this.selectionRequest, kind = request?.target?.kind;
    if (!request?.target) return false;
    if (kind !== 'engineering' && kind !== 'engineering-source' && kind !== 'engineering-group') return true;
    const scope = this.engineeringSelection;
    return !!scope && scope.requestId === request!.id && scope.snapshot === this.engineeringSnapshot && scope.sourceIds.size > 0;
  }
  setOnlySelected(only: boolean): void {
    if (only && !this.canIsolateSelection) return;
    this.onlySelected = only;
    this.engineeringGeometryFilter?.();
    this.deviceLodRuntime?.setOnlySelected?.(only);
    for (const runtime of this.ifcRegionalRuntimes.values()) runtime.setOnlySelected?.(only);
    void Promise.resolve(this.selectionVisibility?.sync().catch(error => console.warn('[Selection visibility]', error))).catch(reportBackgroundError);
    this.viewHistory?.recordVisibility();
  }
  // GIM 文件相关
  currentFiles: Map<string, File> | null = null;
  currentIfcEntries: IfcEntry[] = [];
  currentCbmTree: CbmNode | null = null;
  /** 变电 IFC 空间对象图；线路工程保持 null。 */
  substationSpatialIndex: SubstationSpatialIndex | null = null;
  engineeringSources: import('../gim/engineering/buildSources.js').EngineeringSources | null = null;
  engineeringSnapshot: import('../engineering/types.js').EngineeringSnapshot | null = null;
  engineeringNavigation: import('../gim/engineering/navigation.js').EngineeringNavigationData | null = null;
  engineeringNavigationCacheHit = false;
  engineeringTreeStatus: 'none' | 'loading' | 'ready' | 'error' = 'none';
  engineeringIfcGeometryFinished = false;
  engineeringGeometryCatalog: import('../gim/engineering/geometryOccurrences.js').SourceGeometryOccurrenceCatalog | null = null;
  engineeringGeometryReady: Promise<import('../gim/engineering/geometryOccurrences.js').SourceGeometryOccurrenceCatalog | null> | null = null;
  engineeringStatus: 'none' | 'loading' | 'partial' | 'ready' | 'error' = 'none';
  engineeringError = '';
  engineeringCacheStatus: 'none' | 'hit' | 'miss' | 'saving' | 'saved' | 'partial' | 'disabled' | 'error' = 'none';
  engineeringPipelineMetrics: (NonNullable<import('../services/engineeringWorkerProtocol.js').EngineeringBuildResult['metrics']> & {caches:Array<{domain:string;encodeMs:number;plainBytes:number;encodedBytes:number}>}) | null = null;
  engineeringCacheError = '';
  engineeringCleanup: (() => void) | null = null;
  engineeringListeners = new Set<() => void>();
  readonly viewState = new ProjectViewState();
  get engineeringNavMode() {return this.viewState.mode;}
  set engineeringNavMode(mode:ProjectViewState['mode']) {this.viewState.mode=mode;}
  get engineeringExpandedRows() {return this.viewState.expanded;}
  set engineeringExpandedRows(rows:ProjectViewState['expanded']) {this.viewState.expanded=rows;}
  notifyEngineeringChanged(): void { for (const listener of [...this.engineeringListeners]) listener(); }
  /** GIM 头部提取的工程名称（如"XX变电站"），用于 F1System 根节点显示 */
  projectName: string = '';

  // 工程类型 + 线路图（线路工程专用；变电工程保持 null）
  currentProjectType: GimProjectType | null = null;
  lineCachePersistence: 'idle' | 'saving' | 'saved' | 'failed' | 'not-applicable' = 'idle';
  currentGimGraph: GimGraph | null = null;

  // 索引
  ifcGuidIndex = new Map<string, CbmNode>(); // "logicalModelId:ifcGuid" → CbmNode
  cbmNodeIndex = new Map<string, CbmNode>(); // cbmFileName → CbmNode
  ifcGuidToName = new Map<string, string>(); // "modelId:guid" → displayName

  /** logical modelId（包内稳定身份）→ Fragments runtime modelId（会话身份）。 */
  ifcRuntimeModelIds = new Map<string, string>();
  /** Fragments runtime modelId → logical modelId，供拾取/生命周期回调反查。 */
  ifcLogicalModelIds = new Map<string, string>();
  /** 在途 IFC 的会话所有者；本地 IFC 也绑定捕获时的会话以便清理时失效。 */
  ifcRuntimeModelOwners = new Map<string, ProjectLoadSession>();

  // 文件-设备关系
  substationCapabilities: SubstationCapabilitySummary | null = null;
  substationEntryPaths: string[] = [];
  /** Source index sizes, also available when the semantic cache is restored. */
  substationEntrySizes = new Map<string, number>();
  get cachedFamSourceProperties() { return this.properties.cachedFamSourceProperties; }
  set cachedFamSourceProperties(value:ProjectPropertyCache['cachedFamSourceProperties']) {this.properties.cachedFamSourceProperties=value;}
  fileDevRelations: FileDevEntry[] = [];
  deviceToIfcFile = new Map<string, string>(); // deviceCbmName → ifcModelId

  // STD/SLD 电气拓扑与单线图（变电工程专用，线路工程保持 null）
  // currentStdDoc/currentSldDoc：解析后的文档（首次打开从 currentFiles 解析，缓存命中从磁盘缓存读取）
  // currentStdSldIndex：CBM/STD/SLD 三向 gridId 索引（用于交互联动高亮）
  currentStdDoc: StdDocument | null = null;
  currentSldDoc: SldDocument | null = null;
  currentStdSldIndex: StdSldIndex | null = null;

  // 缓存命中时的 IFC 本地缓存路径（entry_path → local_cache_path）
  get cachedIfcPaths() { return this.properties.cachedIfcPaths; }
  set cachedIfcPaths(value:ProjectPropertyCache['cachedIfcPaths']) {this.properties.cachedIfcPaths=value;}

  // 缓存命中时的 FAM/DEV 基础属性（currentFiles = null 时使用）
  // cachedFamProperties: sourcePath → sectionName → key → value
  get cachedFamProperties() { return this.properties.cachedFamProperties; }
  set cachedFamProperties(value:ProjectPropertyCache['cachedFamProperties']) {this.properties.cachedFamProperties=value;}
  // cachedDevProperties: devPath → key → value
  get cachedDevProperties() { return this.properties.cachedDevProperties; }
  set cachedDevProperties(value:ProjectPropertyCache['cachedDevProperties']) {this.properties.cachedDevProperties=value;}

  // v5: 线路工程 FAM/DEV 属性缓存（缓存命中 + 首次导入后均写入）
  // cachedLineFamProperties: normalizedPath → propKey → LineFamPropertyRecord[]
  get cachedLineFamProperties() { return this.properties.cachedLineFamProperties; }
  set cachedLineFamProperties(value:ProjectPropertyCache['cachedLineFamProperties']) {this.properties.cachedLineFamProperties=value;}
  // cachedLineFamDisplayKeys: normalizedPath → propKey → displayKey（中文展示键）
  get cachedLineFamDisplayKeys() { return this.properties.cachedLineFamDisplayKeys; }
  set cachedLineFamDisplayKeys(value:ProjectPropertyCache['cachedLineFamDisplayKeys']) {this.properties.cachedLineFamDisplayKeys=value;}
  // cachedLineDevProperties: normalizedPath → propKey → LineDevPropertyRecord[]
  get cachedLineDevProperties() { return this.properties.cachedLineDevProperties; }
  set cachedLineDevProperties(value:ProjectPropertyCache['cachedLineDevProperties']) {this.properties.cachedLineDevProperties=value;}

  // 当前 GIM 项目数据库 ID（Tauri 缓存命中时使用）
  currentProjectId: number | null = null;
  /** 当前源 GIM 的内容身份（SHA-256）。用于防止旧几何缓存跨源复用。 */
  currentSourceSha256: string | null = null;

  /**
   * 工程加载代次。每次开始清理/激活工程都会递增；异步任务必须携带
   * 捕获的代次，避免旧工程在切换后把结果写入新工程。
   */
  projectGeneration = 0;

  // 模型
  /** 以 logical modelId 为 key，值中同时保留 Fragments runtime ID。 */
  loadedModels = new Map<string, { modelId: string; runtimeModelId: string; visible: boolean }>();
  ifcRegionalRuntimes=new Map<string,IfcRegionalRuntime>();
  private releaseIfcRuntimes(): void {
    for(const runtime of this.ifcRegionalRuntimes.values())this.safelyRelease(() => runtime.release());
    this.ifcRegionalRuntimes.clear();
    this.safelyRelease(() => this.selectionVisibility?.reset());
    this.selectionHighlightRequestId = null;
  }

  // xml-mod Group 跟踪（key = instanceKey；同一 MOD 文件可有多个放置实例）
  // 与 IFC loadedModels 分开管理：xml-mod 不使用 OBC Fragments
  // 由 nodeInteractionService 在节点点击时懒加载，projectCleanupService 在切换项目时 dispose
  loadedXmlModGroups = new Map<string, THREE.Group>();

  // STL Group 跟踪（key = instanceKey；同一 STL 文件可有多个放置实例）
  // 与 loadedXmlModGroups 分开管理，便于 P1 阶段单独控制 STL 渲染
  // 由 modAutoLoadService 在自动加载时填充，projectCleanupService 在切换项目时 dispose
  loadedStlGroups = new Map<string, THREE.Group>();

  /**
   * DEV 几何降级结果（key = normalized DEV path）。
   *
   * 这是当前工程会话内的轻量诊断索引，不是第二份 geometry model；
   * cold serialization、warm manifest 和按需 raw path 都写入同一 contract，
   * 让属性面板能够区分 empty/partial/unsupported/failed，而不猜测场景状态。
   */
  geometryDiagnosticsByDevPath = new Map<string, GeometryDiagnostic>();

  // MOD/STL 图层根节点（挂在 scene 下，与 IFC 平级）
  // 用于一键开关、异常隔离、bbox 诊断
  modRootGroup: THREE.Group | null = null;
  stlRootGroup: THREE.Group | null = null;

  // 项目级坐标转换矩阵（GIM 工程坐标 → viewer 坐标）
  // IFC loader 使用 coordinateToOrigin=true 把 IFC 归一化到 viewer 原点，
  // MOD/STL 保留 GIM 原始工程坐标，需要通过此矩阵对齐到 IFC/viewer 空间。
  // null 表示未设置（MOD/STL 将保留原始坐标，可能与 IFC 错位）。
  // 优先从 FragmentsManager.baseCoordinationMatrix 自动同步；
  // GIM_COORD_OFFSET localStorage 仍可作为手工调试入口。
  projectSourceToViewerMatrix: THREE.Matrix4 | null = null;

  // 后台几何加载 token（递增防竞态：项目切换后旧任务检测 token 不匹配则停止）
  geometryLoadToken = 0;

  // 高亮
  highlightedItems: OBCF.ModelIdMap | null = null;

  // MOD/STL 高亮状态（保存 mesh 原始材质，用于恢复）
  // MOD 材质是共享的（_sharedMaterialCache），高亮时必须 clone 后修改，
  // reset 时恢复原始材质并 dispose clone，避免影响其他使用同一共享材质的 mesh。
  highlightedModState: {
    groups: THREE.Object3D[];
    originalMaterials: Map<THREE.Mesh, THREE.Material | THREE.Material[]>;
  } | null = null;

  /** 取得当前工程的不可变身份快照，供异步任务在 await 前后校验。 */
  captureProjectSession(): ProjectLoadSession {
    return {
      generation: this.projectGeneration,
      projectId: this.currentProjectId,
      sourceSha256: this.currentSourceSha256,
      geometryToken: this.geometryLoadToken,
    };
  }

  private safelyRelease(run: () => void): void {
    try { run(); } catch (error) { console.error('[Session] 资源释放失败', error); }
  }

  /** Invalidate first: release callbacks cannot publish into the outgoing session. */
  invalidatePendingLoads(): void {
    this.projectGeneration += 1;
    this.geometryLoadToken += 1;
    this.releaseSessionResources();
  }

  private releaseSessionResources(): void {
    const disposables = [...this.sessionDisposables]; this.sessionDisposables.clear();
    for (const dispose of disposables) this.safelyRelease(dispose);
    for (const key of ['hoverCleanup', 'selectionDecorationCleanup', 'engineeringCleanup',
      'engineeringSelectionCleanup', 'engineeringNavigationCleanup'] as const) {
      const cleanup = this[key]; this[key] = null;
      if (cleanup) this.safelyRelease(cleanup);
    }
    this.deviceLodRuntime = null;
    const monitor = this.substationResourceMonitor; this.substationResourceMonitor = null;
    if (monitor) this.safelyRelease(() => monitor.release());
    const preview = this.substationConnectionPreview; this.substationConnectionPreview = null;
    if (preview) this.safelyRelease(() => preview.release());
    this.substationMemoryPressure = 'unknown';
    this.substationFineQueue = null; this.substationConnectionPorts = null;
    this.safelyRelease(() => this.viewHistory?.clear());
    this.stationOverview = null; this.onlySelected = false;
    this.safelyRelease(() => this.invalidateSelection());
    this.releaseIfcRuntimes();
  }

  activateProject(projectId: number | null, sourceSha256?: string | null): ProjectLoadSession {
    this.invalidatePendingLoads();
    this.currentProjectId = projectId;
    this.currentSourceSha256 = sourceSha256 ?? null;
    return this.captureProjectSession();
  }

  /** 检查快照是否仍代表当前工程；几何 token 可单独由后台批次递增。 */
  isCurrentSession(session: ProjectLoadSession): boolean {
    return isCurrentProject(this, session);
  }

  /** 为当前会话取得 logical → runtime 的映射，并登记反向索引。 */
  getRuntimeModelId(logicalModelId: string, session: ProjectLoadSession = this.captureProjectSession()): string {
    const sourceIdentity = session.sourceSha256?.trim()
      || `project:${session.projectId ?? 'none'}:generation:${session.generation}`;
    const runtimeModelId = createIfcRuntimeModelId(sourceIdentity, logicalModelId, session.generation);
    this.ifcRuntimeModelIds.set(logicalModelId, runtimeModelId);
    this.ifcLogicalModelIds.set(runtimeModelId, logicalModelId);
    return runtimeModelId;
  }

  /** 登记一次 IFC 加载的所有者；在 onItemSet 到达时用于拒绝过期模型。 */
  registerIfcRuntimeModel(
    logicalModelId: string,
    runtimeModelId: string,
    owner: ProjectLoadSession,
  ): void {
    this.ifcRuntimeModelIds.set(logicalModelId, runtimeModelId);
    this.ifcLogicalModelIds.set(runtimeModelId, logicalModelId);
    this.ifcRuntimeModelOwners.set(runtimeModelId, owner);
  }

  /** 反查 Fragments runtime ID 对应的 logical ID。 */
  resolveLogicalModelId(runtimeModelId: string): string | null {
    return this.ifcLogicalModelIds.get(runtimeModelId) ?? null;
  }

  /** 判断 runtime ID 是否属于当前工程，避免旧任务迟到后进入新 scene。 */
  isCurrentRuntimeModel(runtimeModelId: string): boolean {
    if (this.ifcRuntimeModelOwners.has(runtimeModelId)) {
      const owner = this.ifcRuntimeModelOwners.get(runtimeModelId);
      return owner != null && this.isCurrentSession(owner);
    }
    const session = this.captureProjectSession();
    return this.currentIfcEntries.some((entry) =>
      createIfcRuntimeModelId(
        session.sourceSha256?.trim() || `project:${session.projectId ?? 'none'}:generation:${session.generation}`,
        entry.modelId,
        session.generation,
      ) === runtimeModelId);
  }

  // 视图已可交互（含 DEV-only）；IFC WASM/worker 的初始化由 ifcLoader 独立管理。
  initialized = false;
  eventsRegistered = false;
  hasFittedCamera = false;
  /** 用户是否手动操作过相机；为 true 时不再自动改全景。 */
  viewerUserInteracted = false;
  /**
   * 首个 IFC 交互后仍在后台加载剩余 IFC。
   * DEV 几何源预取要等它结束，否则大批次 IPC 会挤占剩余 IFC 的读取/转换。
   */
  ifcBackgroundPending = false;
  private ifcBackgroundWaiters: Array<() => void> = [];
  /** 本次打开被“跳过超大 IFC”设置排除的文件（显式记录，不静默）。 */
  ifcSkippedLargeIfc: string[] = [];

  beginIfcBackgroundLoading(): void {
    this.ifcBackgroundPending = true;
  }

  endIfcBackgroundLoading(): void {
    this.ifcBackgroundPending = false;
    const waiters = this.ifcBackgroundWaiters;
    this.ifcBackgroundWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** 等待剩余 IFC 加载结束；没有后台 IFC 时立即返回。 */
  waitForIfcBackgroundLoading(): Promise<void> {
    if (!this.ifcBackgroundPending) return Promise.resolve();
    return new Promise((resolve) => this.ifcBackgroundWaiters.push(resolve));
  }

  /**
   * 重置所有 GIM 相关状态（保留引擎初始化状态）。
   *
   * 集中 mutator：所有"项目切换 / 清空场景"路径统一调用此方法，
   * 避免 state 字段在多处分散清理导致漏清。
   *
   * 包含：currentFiles / CBM 树 / 索引 / FAM-DEV 缓存 / 线路属性缓存 /
   *       loadedModels / loadedXmlModGroups / loadedStlGroups / highlightedItems /
   *       hasFittedCamera / projectSourceToViewerMatrix
   *
   * 注意：loadedModels.clear() 仅清空 state 侧索引，不 dispose Three.js 对象；
   * ctx.fragments 中的实际模型需由 projectCleanupService 在调用本方法前显式 dispose。
   */
  resetGimState(invalidate = true) {
    if (invalidate) this.invalidatePendingLoads(); else this.releaseSessionResources();
    this.deviceUnknownBounds.clear();
    this.currentFiles = null;
    this.currentIfcEntries = [];
    this.currentCbmTree = null;
    this.substationSpatialIndex = null;
    this.engineeringSources = null; this.engineeringSnapshot = null;
    this.engineeringNavigation = null; this.engineeringNavigationCacheHit = false;
    this.engineeringGeometryCatalog = null; this.engineeringGeometryReady = null;
    this.engineeringTreeStatus = 'none'; this.engineeringIfcGeometryFinished = false;
    this.engineeringStatus = 'none'; this.engineeringError = '';
    this.engineeringCacheStatus = 'none'; this.engineeringCacheError = '';
    this.engineeringPipelineMetrics=null;
    this.engineeringListeners.clear();
    this.engineeringNavMode = 'inventory';
    this.engineeringExpandedRows = { composition: new Set<string>(), source: new Set<string>(), inventory:new Set<string>() };
    this.engineeringGeometryFilter = null; this.engineeringRepresentationChanged = null;
    this.projectName = '';
    this.currentProjectType = null;
    this.lineCachePersistence = 'idle';
    this.currentGimGraph = null;
    this.ifcGuidIndex.clear();
    this.cbmNodeIndex.clear();
    this.ifcGuidToName.clear();
    this.ifcRuntimeModelIds.clear();
    this.ifcLogicalModelIds.clear();
    this.ifcRuntimeModelOwners.clear();
    this.substationCapabilities = null;
    this.substationEntryPaths = [];
    this.substationEntrySizes.clear();
    this.cachedFamSourceProperties.clear();
    this.fileDevRelations = [];
    this.deviceToIfcFile.clear();
    // 清空 STD/SLD 拓扑与单线图（变电工程专用）
    this.currentStdDoc = null;
    this.currentSldDoc = null;
    this.currentStdSldIndex = null;
    this.cachedIfcPaths.clear();
    this.cachedFamProperties.clear();
    this.cachedDevProperties.clear();
    // v5: 清空线路工程属性缓存
    this.cachedLineFamProperties.clear();
    this.cachedLineFamDisplayKeys.clear();
    this.cachedLineDevProperties.clear();
    this.currentProjectId = null;
    this.currentSourceSha256 = null;
    // 相机 fit 状态一并重置，确保新项目加载后 fitCameraToScene 能重新执行
    // （否则切换项目后中间只剩网格，IFC 几何不显示）
    this.hasFittedCamera = false;
    this.viewerUserInteracted = false;
    this.ifcBackgroundPending = false;
    this.ifcBackgroundWaiters = [];
    this.ifcSkippedLargeIfc = [];
    // xml-mod Group 的 dispose 由 projectCleanupService 负责（需要 Viewer scene 引用）
    // 这里只清空索引，避免 stale 引用
    this.loadedXmlModGroups.clear();
    this.loadedStlGroups.clear();
    this.geometryDiagnosticsByDevPath.clear();
    this.modRootGroup = null;
    this.stlRootGroup = null;
    // 清空项目级坐标转换矩阵（新项目需重新自动同步或手动设置）
    this.projectSourceToViewerMatrix = null;
    // 清空 IFC 模型索引：若 dispose 未触发 onItemDeleted，
    // state.loadedModels 会残留 stale modelId，导致 loadIfcEntry 误判"模型已加载，跳过"
    this.loadedModels.clear();
    // 清空高亮索引，避免切换项目后旧高亮状态残留
    this.highlightedItems = null;
    // 清空 MOD/STL 高亮状态（clone 材质由 resetModHighlight dispose）
    this.highlightedModState = null;
  }
}
