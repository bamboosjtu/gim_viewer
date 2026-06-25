import type { IfcEntry, CbmNode, FileDevEntry } from '../gim/types.js';
import type * as OBCF from '@thatopen/fragments';
import type { GimProjectType } from '../gim/projectType.js';
import type { GimGraph } from '../gim/gimGraphTypes.js';

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

  // 当前 GIM 项目数据库 ID（Tauri 缓存命中时使用）
  currentProjectId: number | null = null;

  // 模型
  loadedModels = new Map<string, { modelId: string; visible: boolean }>();

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
    this.currentProjectId = null;
  }

  /** 重置全部状态 */
  reset() {
    this.resetGimState();
    this.loadedModels.clear();
    this.highlightedItems = null;
    this.hasFittedCamera = false;
  }
}
