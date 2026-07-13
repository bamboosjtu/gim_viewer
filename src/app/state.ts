import type { IfcEntry, CbmNode, FileDevEntry } from '../gim/types.js';
import type * as OBCF from '@thatopen/fragments';
import type * as THREE from 'three';
import type { GimProjectType } from '../gim/projectType.js';
import type { GimGraph } from '../gim/gimGraphTypes.js';
import type {
  LineFamPropertyRecord,
  LineDevPropertyRecord,
} from '../desktop/database.js';
import type { StdDocument } from '../gim/stdParser.js';
import type { SldDocument } from '../gim/sldParser.js';
import type { StdSldIndex } from '../gim/stdSldIndex.js';

/** 应用全局状态（由 bootstrap.ts 创建唯一实例，通过参数注入各模块） */
export class AppState {
  // GIM 文件相关
  currentFiles: Map<string, File> | null = null;
  currentIfcEntries: IfcEntry[] = [];
  currentCbmTree: CbmNode | null = null;
  /** GIM 头部提取的工程名称（如"XX变电站"），用于 F1System 根节点显示 */
  projectName: string = '';

  // 工程类型 + 线路图（线路工程专用；变电工程保持 null）
  currentProjectType: GimProjectType | null = null;
  currentGimGraph: GimGraph | null = null;

  // 索引
  ifcGuidIndex = new Map<string, CbmNode>(); // "ifcFile:ifcGuid" → CbmNode
  cbmNodeIndex = new Map<string, CbmNode>(); // cbmFileName → CbmNode
  ifcGuidToName = new Map<string, string>(); // "modelId:guid" → displayName

  // 文件-设备关系
  fileDevRelations: FileDevEntry[] = [];
  deviceToIfcFile = new Map<string, string>(); // deviceCbmName → ifcModelId

  // STD/SLD 电气拓扑与单线图（变电工程专用，线路工程保持 null）
  // currentStdDoc/currentSldDoc：解析后的文档（首次打开从 currentFiles 解析，缓存命中从磁盘缓存读取）
  // currentStdSldIndex：CBM/STD/SLD 三向 gridId 索引（用于交互联动高亮）
  currentStdDoc: StdDocument | null = null;
  currentSldDoc: SldDocument | null = null;
  currentStdSldIndex: StdSldIndex | null = null;

  // 缓存命中时的 IFC 本地缓存路径（entry_path → local_cache_path）
  cachedIfcPaths = new Map<string, string>();

  // 缓存命中时的 FAM/DEV 基础属性（currentFiles = null 时使用）
  // cachedFamProperties: sourcePath → sectionName → key → value
  cachedFamProperties = new Map<string, Map<string, Map<string, string>>>();
  // cachedDevProperties: devPath → key → value
  cachedDevProperties = new Map<string, Record<string, string>>();

  // v5: 线路工程 FAM/DEV 属性缓存（缓存命中 + 首次导入后均写入）
  // cachedLineFamProperties: normalizedPath → propKey → LineFamPropertyRecord[]
  cachedLineFamProperties = new Map<string, Map<string, LineFamPropertyRecord[]>>();
  // cachedLineFamDisplayKeys: normalizedPath → propKey → displayKey（中文展示键）
  cachedLineFamDisplayKeys = new Map<string, Map<string, string | null>>();
  // cachedLineDevProperties: normalizedPath → propKey → LineDevPropertyRecord[]
  cachedLineDevProperties = new Map<string, Map<string, LineDevPropertyRecord[]>>();

  // 当前 GIM 项目数据库 ID（Tauri 缓存命中时使用）
  currentProjectId: number | null = null;

  // 模型
  loadedModels = new Map<string, { modelId: string; visible: boolean }>();

  // xml-mod Group 跟踪（key = instanceKey；同一 MOD 文件可有多个放置实例）
  // 与 IFC loadedModels 分开管理：xml-mod 不使用 OBC Fragments
  // 由 nodeInteractionService 在节点点击时懒加载，projectCleanupService 在切换项目时 dispose
  loadedXmlModGroups = new Map<string, THREE.Group>();

  // STL Group 跟踪（key = instanceKey；同一 STL 文件可有多个放置实例）
  // 与 loadedXmlModGroups 分开管理，便于 P1 阶段单独控制 STL 渲染
  // 由 modAutoLoadService 在自动加载时填充，projectCleanupService 在切换项目时 dispose
  loadedStlGroups = new Map<string, THREE.Group>();

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
    groups: THREE.Group[];
    originalMaterials: Map<THREE.Mesh, THREE.Material | THREE.Material[]>;
  } | null = null;

  // 引擎
  initialized = false;
  eventsRegistered = false;
  hasFittedCamera = false;

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
  resetGimState() {
    this.currentFiles = null;
    this.currentIfcEntries = [];
    this.currentCbmTree = null;
    this.projectName = '';
    this.currentProjectType = null;
    this.currentGimGraph = null;
    this.ifcGuidIndex.clear();
    this.cbmNodeIndex.clear();
    this.ifcGuidToName.clear();
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
    // 相机 fit 状态一并重置，确保新项目加载后 fitCameraToScene 能重新执行
    // （否则切换项目后中间只剩网格，IFC 几何不显示）
    this.hasFittedCamera = false;
    // xml-mod Group 的 dispose 由 projectCleanupService 负责（需要 Viewer scene 引用）
    // 这里只清空索引，避免 stale 引用
    this.loadedXmlModGroups.clear();
    this.loadedStlGroups.clear();
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
