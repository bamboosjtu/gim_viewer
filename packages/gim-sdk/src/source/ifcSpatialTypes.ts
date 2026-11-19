/** IFC 空间容器的业务类型。 */
export type SpatialKind =
  "project" | "site" | "building" | "storey" | "space" | "zone" | "container";

/** CBM/IFC 关联证据。证据必须和置信度一起保存，禁止把推断当成事实。 */
export type SpatialEvidence =
  | "ifc-contained"
  | "ifc-boundary"
  | "ifc-guid"
  | "cbm-transform"
  | "unresolved";
export type SpatialConfidence = "confirmed" | "inferred" | "unresolved";
export type SpatialPlacementKind = "translated" | "rotated" | "identity";
/** IFC 构件进入空间树的证据层级。boundary 代表 IFC 空间边界关系，不等同于直接包含。 */
export type IfcSpatialContainment = "direct" | "inherited" | "boundary";
export type IfcSpatialRelationKind =
  "containment" | "space-boundary" | "decomposition" | "host-relation";
export type IfcSpatialInheritanceKind = "decomposition" | "host-relation";

export type SpatialUnlocatedReason =
  | "no-ifc-guid"
  | "ifc-guid-not-found"
  | "no-spatial-container"
  | "no-transform"
  | "parser-unsupported";

/** IFC 属性值；保留原始属性名、值类型和单位，避免只显示属性集名称。 */
export interface IfcPropertyValue {
  name: string;
  value: string;
  dataType?: string;
  unit?: string;
}

/** IFC 属性集或工程量集。kind 用于在检查器中区分 Pset 与数量。 */
export interface IfcPropertyGroup {
  id: number;
  name: string;
  kind: "property" | "quantity";
  applicability?: "instance" | "type" | "unknown";
  values: IfcPropertyValue[];
  truncated?: boolean;
}

/** IFC 构件在 IFC 原生坐标系中的放置结果。position 不做单位换算，unit 描述原始单位。 */
export interface IfcPlacementSummary {
  placementRef: string;
  matrix: number[];
  position: [number, number, number];
  unit?: string;
  unitScaleToMetres?: number;
}

export interface IfcSpatialObject {
  key: string;
  modelId: string;
  expressId: number;
  ifcType: string;
  globalId: string;
  name: string;
  /** Original decoded IFC Name, separate from the readable fallback label. */
  sourceName?: string;
  /** IFC 原生身份字段；Name 为 -- 时仍保留 Description/ObjectType/Tag。 */
  description?: string;
  objectType?: string;
  tag?: string;
  predefinedType?: string;
  placementRef?: string;
  placement?: IfcPlacementSummary;
  /** Representation 引用用于判断 IFC 是否提供了可渲染形状。 */
  representationRef?: string;
  geometryStatus: "represented" | "unrepresented";
  /** 属性/材质/类型等由 Fragments 在选择时按需读取，启动语义索引不展开。 */
  propertyDataDeferred?: boolean;
  propertySets?: IfcPropertyGroup[];
  propertySetNames?: string[];
  materials?: string[];
  classifications?: string[];
  typeName?: string;
  groupNames?: string[];
  /** IFCRELAGGREGATES/IFCRELNESTS/IFCRELDECOMPOSES 形成的对象分解关系。 */
  parentObjectKey: string | null;
  childObjectKeys: string[];
  relationshipCount: number;
  relationshipTypes?: Record<string, number>;
  /** 开洞/端口等关系指向的宿主构件；不是 IFC 分解父子关系。 */
  hostObjectKey: string | null;
  /** 主空间键向后兼容；多个 IFC 空间关系通过 spatialKeys 全量保留。 */
  spatialKey: string | null;
  spatialKeys: string[];
  spatialContainment: IfcSpatialContainment | null;
  spatialRelation?: IfcSpatialRelationKind;
  spatialInheritanceKind?: IfcSpatialInheritanceKind;
  sourcePath: string;
}

export interface IfcSpatialNode {
  key: string;
  modelId: string;
  expressId: number;
  ifcType: string;
  kind: SpatialKind;
  globalId: string;
  name: string;
  description?: string;
  objectType?: string;
  longName?: string;
  compositionType?: string;
  placementRef?: string;
  placement?: IfcPlacementSummary;
  representationRef?: string;
  geometryStatus: "represented" | "unrepresented";
  /** 空间容器属性同样不在启动 Spatial Core 展开。 */
  propertyDataDeferred?: boolean;
  propertySets?: IfcPropertyGroup[];
  materials?: string[];
  classifications?: string[];
  typeName?: string;
  groupNames?: string[];
  elevation?: number;
  parentKey: string | null;
  childKeys: string[];
  /** 直接被 IFCREL*SPATIAL* 包含的构件。 */
  directObjectKeys: string[];
  /** 通过 IFCRELSPACEBOUNDARY 关联到空间的构件；不冒充直接包含。 */
  boundaryObjectKeys: string[];
  /** 沿 IFC 对象分解关系继承到空间的构件；按空间节点保留，支持多空间关系。 */
  decompositionObjectKeys: string[];
  /** 沿开洞/端口等宿主关系继承到空间的构件；按空间节点保留，支持多空间关系。 */
  hostObjectKeys: string[];
  objectKeys: string[];
  sourcePath: string;
}

export interface SpatialModelSummary {
  modelId: string;
  entryPath: string;
  spatialEntityCount: number;
  /** IFC 产品/构件实体数量（不含属性值、几何资源和关系记录）。 */
  objectCount: number;
  directContainedObjectCount?: number;
  /** 空间树实际可达的构件数，包含通过对象分解关系继承的构件。 */
  spatialObjectCount?: number;
  containedObjectCount: number;
  /** 被过滤为模型资源的 IFC 记录数量。 */
  resourceCount: number;
  /** 资源类型计数（用于诊断，不把属性值展开成导航节点）。 */
  resourceTypeCounts?: Record<string, number>;
  lengthUnit?: string;
  lengthUnitScaleToMetres?: number;
  propertyValueCount: number;
  quantityValueCount: number;
  objectsWithProperties: number;
  objectsWithMaterials: number;
  parseError?: string;
}
