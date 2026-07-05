import type { IfcEntry, CbmNode, FileDevEntry } from '../gim/types.js';
import type * as OBCF from '@thatopen/fragments';
import type * as THREE from 'three';
import type { GimProjectType } from '../gim/projectType.js';
import type { GimGraph } from '../gim/gimGraphTypes.js';
import type {
  LineFamPropertyRecord,
  LineDevPropertyRecord,
} from '../desktop/database.js';

/** 应用全局状态（由 bootstrap.ts 创建唯一实例，通过参数注入各模块） */
export class AppState {
  // GIM 文件相关
  currentFiles: Map<string, File> | null = null;
  currentIfcEntries: IfcEntry[] = [];
  currentCbmTree: CbmNode | null = null;

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

  // xml-mod Group 跟踪（key = modPath，如 "MOD/abc.mod"）
  // 与 IFC loadedModels 分开管理：xml-mod 不使用 OBC Fragments
  // 由 nodeInteractionService 在节点点击时懒加载，projectCleanupService 在切换项目时 dispose
  loadedXmlModGroups = new Map<string, THREE.Group>();

  // STL Group 跟踪（key = stlPath，如 "MOD/abc.stl"）
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
  // MVP: translation-only，由 GIM_COORD_OFFSET localStorage 手动调试；
  // 后续可基于共同 CBM 节点的 IFC bbox 与 MOD bbox 自动估算。
  projectSourceToViewerMatrix: THREE.Matrix4 | null = null;

  // 后台几何加载 token（递增防竞态：项目切换后旧任务检测 token 不匹配则停止）
  geometryLoadToken = 0;

  // 高亮
  highlightedItems: OBCF.ModelIdMap | null = null;

  // 引擎
  initialized = false;
  eventsRegistered = false;
  hasFittedCamera = false;

  /** 重置所有 GIM 相关状态（保留引擎初始化状态） */
  resetGimState() {
    this.currentFiles = null;
    this.currentIfcEntries = [];
    this.currentCbmTree = null;
    this.currentProjectType = null;
    this.currentGimGraph = null;
    this.ifcGuidIndex.clear();
    this.cbmNodeIndex.clear();
    this.ifcGuidToName.clear();
    this.fileDevRelations = [];
    this.deviceToIfcFile.clear();
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
    // 清空项目级坐标转换矩阵（新项目需重新估算或手动设置）
    this.projectSourceToViewerMatrix = null;
  }

  /** 重置全部状态 */
  reset() {
    this.resetGimState();
    this.loadedModels.clear();
    this.highlightedItems = null;
    this.hasFittedCamera = false;
  }
}
