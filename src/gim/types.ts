/** IFC 文件条目 */
export interface IfcEntry {
  name: string;
  path: string;
  modelId: string;
}

/** CBM 层级树节点 */
export interface CbmNode {
  path: string;
  name: string;
  entityName: string;
  children: CbmNode[];
  famPath: string;
  devPath: string;
  ifcFile: string;
  ifcGuid: string;
  classifyName: string;
  transformMatrix: string;
  /**
   * CBM 节点的 SYSTEMNAME1..4 字段（变电工程特有，比 SYSCLASSIFYNAME 编码更可读）。
   * 例如：["交流电气系统", "110kV系统", "#2主变 110kV进线间隔"]
   * 非变电工程或缺失时为空数组。
   */
  systemNames: string[];
  /**
   * 来自 DEV 文件 SYMBOLNAME 字段（设备名称，如"柜体"）。
   * 由 buildCbmTreeEnhanced 异步解析 DEV 文件后填入；传统 buildCbmTree 不填充此字段。
   * 缺失时为空字符串。
   */
  devSymbolName: string;
  /**
   * 来自 DEV 文件 TYPE 字段（设备类型，如"OTHERS"）。
   * 由 buildCbmTreeEnhanced 异步解析 DEV 文件后填入。
   */
  devType: string;
  /**
   * 此节点是否展开过 DEV SUBDEVICES（防止重复解析）。
   * 由 buildCbmTreeEnhanced 在解析 DEV 后设置。
   */
  devExpanded: boolean;
}

/** FileDevRelation 条目 */
export interface FileDevEntry {
  ifcName: string;
  ifcFile: string;
  modelId: string;
  deviceCount: number;
  deviceCbms: string[];
}
