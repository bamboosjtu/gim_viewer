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
}

/** FileDevRelation 条目 */
export interface FileDevEntry {
  ifcName: string;
  ifcFile: string;
  modelId: string;
  deviceCount: number;
  deviceCbms: string[];
}
