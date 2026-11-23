import { ProjectSelectionState } from './session/projectSelectionState.js';
import { IfcRuntimeState } from '../shared/ifcRuntimeState.js';
import { SourceGeometryState } from '../shared/sourceGeometryState.js';
import { IfcLoadingState } from '../shared/ifcLoadingState.js';

import { ProjectPropertyCache } from '../services/project/projectPropertyCache.js';
import { ProjectViewState } from '../shared/projectViewState.js';
import { EngineeringSessionState } from './session/engineeringSessionState.js';
import { RuntimeSlot } from '../shared/runtimeSlot.js';
import type { DeviceRuntime } from '../shared/deviceRuntime.js';

import type { SubstationCapabilitySummary } from '../gim/substationEvidence.js';
import type { IfcEntry, CbmNode, FileDevEntry } from '../gim/types.js';
import type * as THREE from 'three';
import type { GimProjectType } from '../gim/projectType.js';
import type { GimGraph } from '@gim/powerline-core/gimGraphTypes.js';
import type { StdDocument } from '../gim/stdParser.js';
import type { SldDocument } from '../gim/sldParser.js';
import type { StdSldIndex } from '../gim/stdSldIndex.js';
import type { SubstationSpatialIndex } from '../gim/ifcSpatialParser.js';
import type { GeometryDiagnostic } from '../gim/geometry/geometryDiagnostics.js';

import type { SubstationFineQueue } from '../shared/selectionContracts.js';
export type { SubstationFineQueue } from '../shared/selectionContracts.js';

/** Session-owned incremental IFC connection preview; optional in browser tests. */
export interface SubstationConnectionPreview {
  acceptBatch(batch: unknown): boolean;
  markComplete(modelId: string, meta: { objectCount: number; sequence: number }): void;
  markFailed?(modelId: string): void;
  markModelReady(
    modelId: string,
    sourceObjects?: readonly import('../viewer/ifcRegionalData.js').RegionalObject[],
  ): void;
  sourceObjects?(): ReadonlyArray<{
    modelId: string;
    objects: readonly import('../viewer/ifcRegionalData.js').RegionalObject[];
  }>;
  setTransform?(matrix: THREE.Matrix4): void;
  setBrowsePredicate?(
    predicate: ((model: string, id: number, guid: string) => boolean) | null,
  ): void;
  setSelectionScope?(
    only: boolean,
    scopes: ReadonlyMap<string, import('../viewer/ifcModelVisibility.js').IfcSelectionScope>,
  ): void;
  diagnostics?: Record<string, number>;
  release(): void;
}

import { ViewerCommands } from '../shared/viewerCommands.js';
import type { ProjectLoadSession } from '../shared/projectSession.js';
import type { SessionScope } from '../shared/sessionScope.js';
import { ProjectSessionState } from './session/projectSessionState.js';
import { releaseProjectResources } from './session/releaseProjectResources.js';
export type { ProjectLoadSession } from '../shared/projectSession.js';
export type {
  SelectionRequest,
  EngineeringSelectionScope,
  SelectionCommitGuard,
  SelectionGeometryState,
} from '../shared/selectionContracts.js';

/** 应用全局状态（由 bootstrap.ts 创建唯一实例，通过参数注入各模块） */
export class AppState {
  toolGeometryFilter:
    | ((root: string, mesh: import('three').Mesh, group: import('three').Object3D) => boolean)
    | null = null;
  toolModelChanged?: (id?: string) => void;
  readonly viewerCommands = new ViewerCommands();
  readonly ifc = new IfcRuntimeState({
    captureSession: () => this.captureProjectSession(),
    isCurrentSession: (session) => this.isCurrentSession(session),
    entries: () => this.currentIfcEntries,
  });
  readonly selection = new ProjectSelectionState({
    captureSession: () => this.captureProjectSession(),
    isCurrentSession: (session) => this.isCurrentSession(session),
    cameraNavigationVersion: () => this.viewState.cameraNavigationVersion,
    snapshot: () => this.engineering.snapshot,
    deviceRuntime: () => this.deviceLodRuntime,
    runtimes: () => this.ifc.regionalRuntimes.values(),
    applyGeometryFilter: () => this.engineeringGeometryFilter?.(),
    recordVisibility: () => this.viewState.viewHistory?.recordVisibility(),
    selectionChanged: () => this.viewerCommands.dispatchEvent(new Event('selectionchange')),
  });
  readonly properties = new ProjectPropertyCache();
  readonly sourceGeometry = new SourceGeometryState();
  readonly ifcLoading = new IfcLoadingState();
  readonly projectSession = new ProjectSessionState((current) =>
    releaseProjectResources(this, current),
  );
  deviceUnknownBounds = new Set<string>();
  /** Session-owned priority lane for explicit IFC precision requests. */
  substationFineQueue: SubstationFineQueue | null = null;
  /** Cheap connection-line previews are discarded with the project session. */
  substationConnectionPreview: SubstationConnectionPreview | null = null;
  substationConnectionPorts: import('../gim/glConnectionPorts.js').GlConnectionPortIndex | null =
    null;
  substationResourceMonitor: { release(): void } | null = null;
  substationMemoryPressure: import('../utils/memoryPressure.js').MemoryPressure = 'unknown';

  engineeringGeometryFilter: ((root?: THREE.Object3D) => void) | null = null;
  engineeringRepresentationChanged: ((rootOccurrence?: string) => void) | null = null;
  engineeringGeometryEvidenceChanged: (() => void) | null = null;
  private readonly deviceRuntimeSlot = new RuntimeSlot<DeviceRuntime>();
  get deviceLodRuntime(): DeviceRuntime | null {
    return this.deviceRuntimeSlot.value;
  }
  set deviceLodRuntime(runtime: DeviceRuntime | null) {
    this.deviceRuntimeSlot.value = runtime;
  }
  // GIM 文件相关
  currentFiles: Map<string, File> | null = null;
  currentIfcEntries: IfcEntry[] = [];
  currentCbmTree: CbmNode | null = null;
  /** 变电 IFC 空间对象图；线路工程保持 null。 */
  substationSpatialIndex: SubstationSpatialIndex | null = null;
  readonly engineering = new EngineeringSessionState();
  readonly viewState = new ProjectViewState();
  notifyEngineeringChanged(): void {
    this.engineering.notify();
  }
  /** GIM 头部提取的工程名称（如"XX变电站"），用于 F1System 根节点显示 */
  projectName: string = '';

  // 工程类型 + 线路图（线路工程专用；变电工程保持 null）
  currentProjectType: GimProjectType | null = null;
  lineCachePersistence: 'idle' | 'saving' | 'saved' | 'failed' | 'not-applicable' = 'idle';
  currentGimGraph: GimGraph | null = null;

  // 索引
  ifcGuidIndex = new Map<string, CbmNode>(); // "logicalModelId:ifcGuid" → CbmNode
  cbmNodeIndex = new Map<string, CbmNode>(); // cbmFileName → CbmNode
  ifcGuidToName = new Map<string, string>();

  // 文件-设备关系
  substationCapabilities: SubstationCapabilitySummary | null = null;
  substationEntryPaths: string[] = [];
  /** Source index sizes, also available when the semantic cache is restored. */
  substationEntrySizes = new Map<string, number>();
  fileDevRelations: FileDevEntry[] = [];
  deviceToIfcFile = new Map<string, string>(); // deviceCbmName → ifcModelId

  // STD/SLD 电气拓扑与单线图（变电工程专用，线路工程保持 null）
  // currentStdDoc/currentSldDoc：解析后的文档（首次打开从 currentFiles 解析，缓存命中从磁盘缓存读取）
  // currentStdSldIndex：CBM/STD/SLD 三向 gridId 索引（用于交互联动高亮）
  currentStdDoc: StdDocument | null = null;
  currentSldDoc: SldDocument | null = null;
  currentStdSldIndex: StdSldIndex | null = null;

  get currentProjectId(): number | null {
    return this.projectSession.currentProjectId;
  }
  get currentSourceSha256(): string | null {
    return this.projectSession.currentSourceSha256;
  }
  get projectGeneration(): number {
    return this.projectSession.projectGeneration;
  }

  // xml-mod Group 跟踪（key = instanceKey；同一 MOD 文件可有多个放置实例）
  // 与 IFC loadedModels 分开管理：xml-mod 不使用 OBC Fragments
  // 由 nodeInteractionService 在节点点击时懒加载，projectCleanupService 在切换项目时 dispose
  loadedXmlModGroups = new Map<string, THREE.Group>();

  // STL Group 跟踪（key = instanceKey；同一 STL 文件可有多个放置实例）
  // 与 loadedXmlModGroups 分开管理，便于 P1 阶段单独控制 STL 渲染
  // 由 DEV LOD runtime 在按需加载时填充，projectCleanupService 在切换项目时 dispose
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

  get geometryLoadToken(): number {
    return this.projectSession.geometryLoadToken;
  }

  advanceGeometryBatch(): void {
    this.projectSession.advanceGeometryBatch();
  }

  captureProjectSession(): ProjectLoadSession {
    return this.projectSession.capture();
  }

  sessionScope(session: ProjectLoadSession): SessionScope {
    return this.projectSession.scopeFor(session);
  }

  withSession(session: ProjectLoadSession, commit: () => undefined): boolean {
    return this.sessionScope(session).withSession(commit);
  }

  invalidatePendingLoads(): number {
    return this.projectSession.invalidate();
  }

  activateProject(projectId: number | null, sourceSha256?: string | null): ProjectLoadSession {
    return this.projectSession.activate(projectId, sourceSha256);
  }

  isCurrentSession(session: ProjectLoadSession): boolean {
    return this.projectSession.isCurrent(session);
  }

  // 视图已可交互（含 DEV-only）；IFC WASM/worker 的初始化由 ifcLoader 独立管理。
  initialized = false;
  eventsRegistered = false;

  resetGimState(): void {
    this.finishProjectCleanup(this.invalidatePendingLoads(), true);
  }

  /** Scene resources are disposed by projectCleanup before these indexes are cleared. */
  finishProjectCleanup(generation: number, admitEmptySession: boolean): boolean {
    if (!this.projectSession.finishCleanup(generation, admitEmptySession)) return false;
    this.engineering.reset();
    this.viewState.reset();
    this.deviceUnknownBounds.clear();
    this.currentFiles = null;
    this.currentIfcEntries = [];
    this.currentCbmTree = null;
    this.substationSpatialIndex = null;
    this.sourceGeometry.reset();
    this.engineeringGeometryFilter = null;
    this.engineeringRepresentationChanged = null;
    this.projectName = '';
    this.currentProjectType = null;
    this.lineCachePersistence = 'idle';
    this.currentGimGraph = null;
    this.ifcGuidIndex.clear();
    this.cbmNodeIndex.clear();
    this.ifcGuidToName.clear();
    this.ifc.reset();
    this.substationCapabilities = null;
    this.substationEntryPaths = [];
    this.substationEntrySizes.clear();
    this.properties.reset();
    this.fileDevRelations = [];
    this.deviceToIfcFile.clear();
    // 清空 STD/SLD 拓扑与单线图（变电工程专用）
    this.currentStdDoc = null;
    this.currentSldDoc = null;
    this.currentStdSldIndex = null;

    // 相机 fit 状态一并重置，确保新项目加载后 fitCameraToScene 能重新执行
    // （否则切换项目后中间只剩网格，IFC 几何不显示）

    this.ifcLoading.reset();
    // xml-mod Group 的 dispose 由工程会话负责（需要 Viewer scene 引用）
    // 这里只清空索引，避免 stale 引用
    this.loadedXmlModGroups.clear();
    this.loadedStlGroups.clear();
    this.geometryDiagnosticsByDevPath.clear();
    this.modRootGroup = null;
    this.stlRootGroup = null;
    // 清空项目级坐标转换矩阵（新项目需重新自动同步或手动设置）
    this.projectSourceToViewerMatrix = null;
    this.selection.resetHighlightState();
    return true;
  }
}
