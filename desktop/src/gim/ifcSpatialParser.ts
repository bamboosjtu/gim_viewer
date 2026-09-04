import type { CbmNode, FileDevEntry, IfcEntry } from './types.js';
import { resolveIfcModelId } from './modelIdentity.js';

/** IFC 空间容器的业务类型。 */
export type SpatialKind = 'project' | 'site' | 'building' | 'storey' | 'space' | 'zone' | 'container';

/** CBM/IFC 关联证据。证据必须和置信度一起保存，禁止把推断当成事实。 */
export type SpatialEvidence = 'ifc-contained' | 'ifc-boundary' | 'ifc-guid' | 'cbm-transform' | 'unresolved';
export type SpatialConfidence = 'confirmed' | 'inferred' | 'unresolved';
export type SpatialPlacementKind = 'translated' | 'rotated' | 'identity';
/** IFC 构件进入空间树的证据层级。boundary 代表 IFC 空间边界关系，不等同于直接包含。 */
export type IfcSpatialContainment = 'direct' | 'inherited' | 'boundary';
export type IfcSpatialRelationKind = 'containment' | 'space-boundary' | 'decomposition' | 'host-relation';
export type IfcSpatialInheritanceKind = 'decomposition' | 'host-relation';

export type SpatialUnlocatedReason =
  | 'no-ifc-guid'
  | 'ifc-guid-not-found'
  | 'no-spatial-container'
  | 'no-transform'
  | 'parser-unsupported';

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
  kind: 'property' | 'quantity';
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
  /** IFC 原生身份字段；Name 为 -- 时仍保留 Description/ObjectType/Tag。 */
  description?: string;
  objectType?: string;
  tag?: string;
  predefinedType?: string;
  placementRef?: string;
  placement?: IfcPlacementSummary;
  /** Representation 引用用于判断 IFC 是否提供了可渲染形状。 */
  representationRef?: string;
  geometryStatus: 'represented' | 'unrepresented';
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
  geometryStatus: 'represented' | 'unrepresented';
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

export interface SpatialAssetLink {
  cbmPath: string;
  ifcObjectKey: string | null;
  spatialKey: string | null;
  evidence: SpatialEvidence;
  confidence: SpatialConfidence;
  sourceIfcFile?: string;
  sourceIfcGuid?: string;
  /** FileDevRelation 中声明的来源设计/图纸名称（不等同于 IFC 模型）。 */
  sourceDesignNames?: string[];
  /** FileDevRelation 中声明的真实 IFC 文件；DGN 等非 IFC 来源不会写入此字段。 */
  sourceDesignFiles?: string[];
  transformMatrix?: number[];
  position?: [number, number, number];
  placementKind?: SpatialPlacementKind;
  unlocatedReason?: SpatialUnlocatedReason;
}

/** 只有坐标证据的资产按网格聚合，避免三千个对象挤在一个扁平分组里。 */
export interface SpatialPlacementBucket {
  key: string;
  gridSize: number;
  xIndex: number;
  yIndex: number;
  zIndex: number;
  links: SpatialAssetLink[];
  minPosition: [number, number, number];
  maxPosition: [number, number, number];
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

export interface SpatialCoverage {
  hasSpatialEntities: boolean;
  hasSpatialContainment: boolean;
  hasSpaces: boolean;
  directCbmIfcLinks: number;
  directCbmIfcLinkCoverage: number;
  spatiallyContainedCbmLinks: number;
  spatiallyContainedCbmCoverage: number;
  /** IFC 直接包含的构件数；containedObjectCount 还包括分解关系继承项。 */
  directContainedIfcObjects: number;
  /** 通过 IFC 对象分解关系继承到空间的构件数。 */
  decompositionInheritedIfcObjects: number;
  /** 通过开洞/端口等宿主关系继承到空间的构件数。 */
  hostInheritedIfcObjects: number;
  /** 通过 IFCRELSPACEBOUNDARY 关联到空间的构件数。 */
  boundaryContainedIfcObjects: number;
  /** 兼容旧调用方的继承总数：分解继承 + 宿主关系继承。 */
  inheritedContainedIfcObjects: number;
  placementOnlyAssets: number;
  unlocatedAssets: number;
  /** IFC GUID 命中，但 IFC 没有把该对象放进任何空间容器。 */
  confirmedWithoutSpatialContainer: number;
  /** IFC 产品/构件实体存在，但没有任何空间容器关系。 */
  uncontainedIfcObjects: number;
  /** 至少一个 CBM/DEV 节点带可解析的 4×4 变换矩阵。 */
  hasPlacementCoordinates: boolean;
  /** 有非零平移坐标的 CBM/DEV 节点数。 */
  positionedAssets: number;
  /** 只有单位/旋转矩阵、平移仍在原点的 CBM/DEV 节点数。 */
  identityPlacementAssets: number;
  /** 坐标推断对象被聚合成的网格分组数。 */
  placementGroups: number;
  confidence: 'confirmed' | 'partial' | 'inferred' | 'none';
}

export interface SubstationSpatialIndex {
  models: SpatialModelSummary[];
  nodes: IfcSpatialNode[];
  objects: IfcSpatialObject[];
  links: SpatialAssetLink[];
  rootNodeKeys: string[];
  coverage: SpatialCoverage;
  nodeByKey: Map<string, IfcSpatialNode>;
  objectByKey: Map<string, IfcSpatialObject>;
  linksBySpatialKey: Map<string, SpatialAssetLink[]>;
  linksByCbmPath: Map<string, SpatialAssetLink>;
  /** 一个 IFC 构件可能被多个 CBM 节点引用，必须保留一对多关系。 */
  linksByIfcObjectKey: Map<string, SpatialAssetLink[]>;
  placementGroups: SpatialPlacementBucket[];
  identityPlacementLinks: SpatialAssetLink[];
}

interface RawIfcEntity {
  expressId: number;
  ifcType: string;
  args: string[];
}

/**
 * STEP 选择性扫描的中间结果。
 *
 * 注意：这里不保存非空间/导航实体的原始参数。关系记录仍需要保留，
 * 但属性、材质、分类、类型和组记录只计数，不进入长期对象图。
 */
interface SelectiveIfcScanResult {
  selectedById: Map<number, RawIfcEntity>;
  relationships: RawIfcEntity[];
  /** 关系记录的引用在首遍解析一次，后续关系计数/建图复用，避免二次 regex 扫描。 */
  relationshipRefsById: Map<number, number[]>;
  /** 空间关系的 parent/related 列表在首遍解析一次，末阶段直接投影。 */
  spatialRelationRefsById: Map<number, { parentId: number | null; relatedIds: number[] }>;
  /** 所有 placement 候选只保存文本偏移，不物化参数；供闭包按 ID 取值。 */
  /** 编码后的 placement 候选（bodyStart + 类型），避免为数百万候选分配对象。 */
  placementCandidates: Map<number, number>;
  rawEntityCount: number;
  totalTypeCounts: Map<string, number>;
  spatialContainedIds: Set<number>;
  hostObjectIdsByChildId: Map<number, number[]>;
  boundarySpaceIdsByObjectId: Map<number, number[]>;
  spatialRelationIds: Set<number>;
  placementRoots: Set<number>;
  propertyEntityCount: number;
  quantityEntityCount: number;
  materialEntityCount: number;
  classificationEntityCount: number;
}

interface ScannedIfcEntity {
  expressId: number;
  ifcType: string;
  bodyStart: number;
  bodyEnd: number;
}

type ScannedIfcEntityCallback = (
  expressId: number,
  ifcType: string,
  bodyStart: number,
  bodyEnd: number,
) => void;

interface ParsedIfcModel {
  summary: SpatialModelSummary;
  spatialEntities: IfcSpatialNode[];
  objects: IfcSpatialObject[];
  profile: IfcSpatialParseProfile;
}

/**
 * IFC Spatial Semantic 的可选诊断 profile。解析器仍保持纯函数/同步语义，
 * 只有调用方提供 observer 时才会消费这些计时与计数；不把诊断依赖反向
 * 引入 gim 层。
 */
export interface IfcSpatialParseProfile {
  modelId: string;
  entryPath: string;
  sourceBytes: number;
  totalMs: number;
  /** STEP 记录扫描耗时；仅选择性实体会构造 RawIfcEntity。 */
  stepScanMs: number;
  rawEntityCount: number;
  /** 仍驻留在语义索引中的实体（空间/导航/关系/单位/placement 闭包）。 */
  detailEntityCount: number;
  /** 选择性首遍保留的空间/导航/关系/单位实体数。 */
  retainedEntityCount?: number;
  placementEntityCount: number;
  /** 文件中 placement 候选总数，仅用于诊断，不代表长期驻留数量。 */
  placementCandidateCount?: number;
  placementDetailMs: number;
  /** 构建空间节点/构件对象耗时与数量。 */
  spatialEntityMs: number;
  spatialEntityCount: number;
  /** 属性、工程量、材料、分类仅保留扫描计数；启动 Spatial Core 不展开它们。 */
  propertyMs: number;
  propertyEntityCount: number;
  quantityEntityCount: number;
  propertyValueCount: number;
  quantityValueCount: number;
  materialEntityCount: number;
  classificationEntityCount: number;
  /** IFCREL* 关系扫描、对象分解/空间归属构建耗时与数量。 */
  relationshipMs: number;
  relationshipRecordCount: number;
  relationshipReferenceCount: number;
  /** 单模型语义 finalize（传播/汇总）耗时。 */
  finalizeMs: number;
  objectCount: number;
  containedObjectCount: number;
  parseError?: string;
}

export interface IfcSpatialReadProfile {
  modelId: string;
  entryPath: string;
  bytes: number;
  readMs: number;
  decodeMs: number;
  found: boolean;
  /** 文件存在但读取失败时保留错误；不会让单个 IFC 阻断其它模型。 */
  error?: string;
}

export interface SubstationSpatialIndexObserver {
  onModelRead?: (profile: IfcSpatialReadProfile) => void;
  /** STEP 选择性 scan 完成后触发；不会暴露全量 RawIfcEntity。 */
  onStepScan?: (profile: {
    modelId: string;
    entryPath: string;
    sourceBytes: number;
    rawEntityCount: number;
    stepScanMs: number;
    retainedEntityCount?: number;
    placementCandidateCount?: number;
    placementEntityCount?: number;
  }) => void;
  onModelParsed?: (profile: IfcSpatialParseProfile) => void;
  onFinalize?: (profile: {
    durationMs: number;
    modelCount: number;
    spatialNodeCount: number;
    objectCount: number;
    linkCount: number;
    cbmLinkCount: number;
    uncontainedIfcObjects: number;
  }) => void;
}

const SPATIAL_TYPES: ReadonlyMap<string, SpatialKind> = new Map([
  ['IFCPROJECT', 'project'],
  ['IFCSITE', 'site'],
  ['IFCBUILDING', 'building'],
  ['IFCBUILDINGSTOREY', 'storey'],
  ['IFCSPACE', 'space'],
  ['IFCZONE', 'zone'],
  ['IFCSPATIALZONE', 'zone'],
]);

function emptySpatialModelSummary(entry: IfcEntry, parseError: string): SpatialModelSummary {
  return {
    modelId: entry.modelId,
    entryPath: entry.path,
    spatialEntityCount: 0,
    objectCount: 0,
    directContainedObjectCount: 0,
    spatialObjectCount: 0,
    containedObjectCount: 0,
    resourceCount: 0,
    propertyValueCount: 0,
    quantityValueCount: 0,
    objectsWithProperties: 0,
    objectsWithMaterials: 0,
    parseError,
  };
}

/**
 * 增量构建变电 IFC 空间索引。
 *
 * `addIfcModel` 只保留单个 IFC 的语义节点/对象，绝不保存原始文本；调用方
 * 可以在每次 await 读取后立即解析并释放字符串。跨模型关系和覆盖率在
 * `finalize` 中统一计算，保持原有索引结果不变。
 */
export class SubstationSpatialIndexBuilder {
  private readonly models: SpatialModelSummary[] = [];
  private readonly nodes: IfcSpatialNode[] = [];
  private readonly objects: IfcSpatialObject[] = [];
  private readonly entries: IfcEntry[] = [];

  constructor(
    private readonly cbmTree: CbmNode | null,
    private readonly fileDevRelations: FileDevEntry[] = [],
    private readonly observer?: SubstationSpatialIndexObserver,
  ) {}

  addIfcModel(entry: IfcEntry, text: string | null, sourceBytes?: number): void {
    this.entries.push(entry);
    if (text == null) {
      this.models.push(emptySpatialModelSummary(entry, '无法读取 IFC 内容'));
      this.observer?.onModelParsed?.({
        modelId: entry.modelId,
        entryPath: entry.path,
        sourceBytes: sourceBytes ?? 0,
        totalMs: 0,
        stepScanMs: 0,
        rawEntityCount: 0,
        detailEntityCount: 0,
        placementEntityCount: 0,
        placementDetailMs: 0,
        spatialEntityMs: 0,
        spatialEntityCount: 0,
        propertyMs: 0,
        propertyEntityCount: 0,
        quantityEntityCount: 0,
        propertyValueCount: 0,
        quantityValueCount: 0,
        materialEntityCount: 0,
        classificationEntityCount: 0,
        relationshipMs: 0,
        relationshipRecordCount: 0,
        relationshipReferenceCount: 0,
        finalizeMs: 0,
        objectCount: 0,
        containedObjectCount: 0,
        parseError: '无法读取 IFC 内容',
      });
      return;
    }
    const parseStarted = performance.now();
    try {
      const parsed = parseIfcModel(entry, text, sourceBytes, this.observer);
      this.models.push(parsed.summary);
      this.observer?.onModelParsed?.(parsed.profile);
      // 不使用 push(...largeArray)：BIMBase/Bentley IFC 中单文件实体可超过
      // JS 引擎的函数参数上限，会以 RangeError 静默丢掉整个模型。
      for (const node of parsed.spatialEntities) this.nodes.push(node);
      for (const object of parsed.objects) this.objects.push(object);
    } catch (error) {
      const parseError = error instanceof Error ? error.message : String(error);
      this.models.push(emptySpatialModelSummary(entry, parseError));
      this.observer?.onModelParsed?.({
        modelId: entry.modelId,
        entryPath: entry.path,
        sourceBytes: sourceBytes ?? text.length,
        totalMs: performance.now() - parseStarted,
        stepScanMs: 0,
        rawEntityCount: 0,
        detailEntityCount: 0,
        placementEntityCount: 0,
        placementDetailMs: 0,
        spatialEntityMs: 0,
        spatialEntityCount: 0,
        propertyMs: 0,
        propertyEntityCount: 0,
        quantityEntityCount: 0,
        propertyValueCount: 0,
        quantityValueCount: 0,
        materialEntityCount: 0,
        classificationEntityCount: 0,
        relationshipMs: 0,
        relationshipRecordCount: 0,
        relationshipReferenceCount: 0,
        finalizeMs: 0,
        objectCount: 0,
        containedObjectCount: 0,
        parseError,
      });
    }
  }

  finalize(): SubstationSpatialIndex {
    const finalizeStarted = performance.now();
    const { models, nodes, objects } = this;

  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const objectByKey = new Map(objects.map((object) => [object.key, object]));
  const objectByGuid = new Map<string, IfcSpatialObject>();
  const duplicateGuid = new Set<string>();
  const objectByModelGuid = new Map<string, IfcSpatialObject>();
  for (const object of objects) {
    if (!object.globalId) continue;
    objectByModelGuid.set(`${normalizeModelId(object.modelId)}:${normalizeGuid(object.globalId)}`, object);
    const bare = normalizeGuid(object.globalId);
    if (objectByGuid.has(bare)) duplicateGuid.add(bare);
    else objectByGuid.set(bare, object);
  }

  const cbmNodes = collectCbmNodes(this.cbmTree);
  const ifcEntries = this.entries;
  // 空间索引与几何加载必须使用同一条 CBM 变换链。真实 CBM 文件中的
  // F4System 通常已经写入父链累积矩阵；PARTINDEX 往往没有自己的矩阵，
  // DEV_SUBDEVICE 虚拟节点则只保存 SUBDEVICE 局部矩阵。若这里只读取
  // 当前节点，会把所有部件误报为“没有坐标”，造成空间导航大量缺项。
  const cbmPlacementByPath = buildCbmPlacementMap(this.cbmTree);
  const links: SpatialAssetLink[] = [];
  let directGuidCandidates = 0;
  let directGuidMatches = 0;
  let spatiallyContainedMatches = 0;
  let placementOnlyAssets = 0;
  let unlocatedAssets = 0;
  let confirmedWithoutSpatialContainer = 0;
  const linksByCbmPath = new Map<string, SpatialAssetLink>();
  const linksBySpatialKey = new Map<string, SpatialAssetLink[]>();
  const linksByIfcObjectKey = new Map<string, SpatialAssetLink[]>();
  const fileDevRelationIndex = buildFileDevRelationIndex(this.fileDevRelations);

  for (const cbm of cbmNodes) {
    const matrix = cbmPlacementByPath.get(cbm.path) ?? null;
    const hasPlacement = matrix != null;
    let link: SpatialAssetLink | null = null;

    if (cbm.ifcFile && cbm.ifcGuid) {
      directGuidCandidates++;
      const modelId = resolveIfcModelId(cbm.ifcFile, ifcEntries)
        ?? (cbm.ifcFile.startsWith('ifc_') ? cbm.ifcFile : null);
      const guid = normalizeGuid(cbm.ifcGuid);
      const placementKind = matrix ? classifyPlacement(matrix) : undefined;
      // modelId 是首选且通常唯一。只有在整个样本中 GUID 没有跨模型重复时，
      // 才允许用裸 GUID 兜底，避免把同 GUID 的两个 IFC 模型错误串联。
      const object = modelId
        ? (objectByModelGuid.get(`${normalizeModelId(modelId)}:${guid}`)
          ?? (duplicateGuid.has(guid) ? undefined : objectByGuid.get(guid)))
        : undefined;
      if (object) {
        directGuidMatches++;
        if (object.spatialKey) spatiallyContainedMatches++;
        else confirmedWithoutSpatialContainer++;
        const objectSpatialEvidence = object.spatialContainment === 'boundary' ? 'ifc-boundary' : 'ifc-contained';
        link = {
          cbmPath: cbm.path,
          ifcObjectKey: object.key,
          spatialKey: object.spatialKey,
          evidence: object.spatialKey ? objectSpatialEvidence : 'ifc-guid',
          confidence: 'confirmed',
          sourceIfcFile: cbm.ifcFile,
          sourceIfcGuid: cbm.ifcGuid,
          ...(hasPlacement ? { transformMatrix: matrix!, position: matrixToPosition(matrix!) } : {}),
          ...(placementKind ? { placementKind } : {}),
          ...(object.spatialKey ? {} : { unlocatedReason: 'no-spatial-container' as const }),
        };
      } else {
        link = {
          cbmPath: cbm.path,
          ifcObjectKey: null,
          spatialKey: null,
          evidence: 'unresolved',
          confidence: 'unresolved',
          sourceIfcFile: cbm.ifcFile,
          sourceIfcGuid: cbm.ifcGuid,
          ...(hasPlacement ? { transformMatrix: matrix!, position: matrixToPosition(matrix!) } : {}),
          ...(placementKind ? { placementKind } : {}),
          unlocatedReason: 'ifc-guid-not-found',
        };
      }
    }

    if (!link && cbm.devPath) {
      if (hasPlacement) {
        placementOnlyAssets++;
        const placementKind = classifyPlacement(matrix!);
        link = {
          cbmPath: cbm.path,
          ifcObjectKey: null,
          spatialKey: null,
          evidence: 'cbm-transform',
          confidence: 'inferred',
          transformMatrix: matrix!,
          position: matrixToPosition(matrix!),
          placementKind,
        };
      } else {
        link = {
          cbmPath: cbm.path,
          ifcObjectKey: null,
          spatialKey: null,
          evidence: 'unresolved',
          confidence: 'unresolved',
          unlocatedReason: 'no-transform',
        };
      }
    }

    // F4/PARTINDEX/DEV_SUBDEVICE 是用户可见资产，即使没有 IFC/DEV 引用也不能从导航消失。
    // 这类节点进入未关联分组，原因明确标记为 no-ifc-guid。
    if (!link && isAssetNode(cbm)) {
      link = {
        cbmPath: cbm.path,
        ifcObjectKey: null,
        spatialKey: null,
        evidence: 'unresolved',
        confidence: 'unresolved',
        unlocatedReason: 'no-ifc-guid',
      };
    }
    if (!link) continue;
    const sourceDesign = resolveSourceDesign(cbm.path, fileDevRelationIndex);
    if (sourceDesign.names.length > 0) link.sourceDesignNames = sourceDesign.names;
    if (sourceDesign.files.length > 0) link.sourceDesignFiles = sourceDesign.files;
    if (link.confidence === 'unresolved') unlocatedAssets++;
    links.push(link);
    linksByCbmPath.set(link.cbmPath, link);
    if (link.spatialKey) {
      const bucket = linksBySpatialKey.get(link.spatialKey) ?? [];
      bucket.push(link);
      linksBySpatialKey.set(link.spatialKey, bucket);
    }
    if (link.ifcObjectKey) {
      const bucket = linksByIfcObjectKey.get(link.ifcObjectKey) ?? [];
      bucket.push(link);
      linksByIfcObjectKey.set(link.ifcObjectKey, bucket);
    }
  }

  for (const node of nodes) {
    node.objectKeys = node.objectKeys.filter((key) => objectByKey.has(key));
    node.directObjectKeys = node.directObjectKeys.filter((key) => objectByKey.has(key));
    node.boundaryObjectKeys = node.boundaryObjectKeys.filter((key) => objectByKey.has(key));
    node.decompositionObjectKeys = node.decompositionObjectKeys.filter((key) => objectByKey.has(key));
    node.hostObjectKeys = node.hostObjectKeys.filter((key) => objectByKey.has(key));
  }

  const rootNodeKeys = nodes.filter((node) => node.parentKey == null).map((node) => node.key);
  const containedObjectCount = objects.filter((object) => object.spatialKeys.length > 0).length;
  // 关系类别必须从空间节点级集合统计，而不是从 object.spatialContainment
  // 这个“主空间”兼容字段统计。一个 IFC 构件可能在空间 A 直接包含、在
  // 空间 B 通过分解/宿主关系继承；只看主空间会把 B 的证据静默丢掉。
  const directContainedKeys = collectNodeObjectKeys(nodes, 'directObjectKeys');
  const decompositionInheritedKeys = collectNodeObjectKeys(nodes, 'decompositionObjectKeys');
  const hostInheritedKeys = collectNodeObjectKeys(nodes, 'hostObjectKeys');
  const boundaryContainedKeys = collectNodeObjectKeys(nodes, 'boundaryObjectKeys');
  const inheritedContainedKeys = new Set<string>([
    ...decompositionInheritedKeys,
    ...hostInheritedKeys,
  ]);
  const directContainedObjectCount = directContainedKeys.size;
  const decompositionInheritedObjectCount = decompositionInheritedKeys.size;
  const hostInheritedObjectCount = hostInheritedKeys.size;
  const boundaryContainedObjectCount = boundaryContainedKeys.size;
  const inheritedContainedObjectCount = inheritedContainedKeys.size;
  const uncontainedIfcObjects = objects.length - containedObjectCount;
  const positionedLinks = links.filter(
    (link) => link.confidence === 'inferred' && link.placementKind === 'translated' && link.position,
  );
  const identityPlacementLinks = links.filter(
    (link) => link.confidence === 'inferred' && link.placementKind !== 'translated',
  );
  const placementGroups = buildPlacementBuckets(positionedLinks);
  const hasSpatialEntities = new Set(nodes.map((node) => node.kind)).size >= 2;
  const hasSpatialContainment = containedObjectCount > 0;
  const hasSpaces = nodes.some((node) => node.kind === 'space');
  const hasPlacementCoordinates = cbmPlacementByPath.size > 0;
  const coverageDenominator = directGuidCandidates || cbmNodes.filter((node) => node.devPath || node.ifcGuid).length;
  const spatialCoverage = coverageDenominator > 0
    ? spatiallyContainedMatches / coverageDenominator
    : 0;
  const directCoverage = directGuidCandidates > 0 ? directGuidMatches / directGuidCandidates : 0;

  const confidence: SpatialCoverage['confidence'] = hasSpatialEntities && hasSpatialContainment
    ? (directGuidMatches > 0 || placementOnlyAssets > 0 ? 'partial' : 'confirmed')
    : (placementOnlyAssets > 0 ? 'inferred' : 'none');

  // Keep the summary useful for diagnostics without adding a second object graph.
  for (const model of models) {
    const modelObjects = objects.filter((object) => object.modelId === model.modelId);
    const modelNodes = nodes.filter((node) => node.modelId === model.modelId);
    model.objectCount = modelObjects.length;
    model.directContainedObjectCount = collectNodeObjectKeys(modelNodes, 'directObjectKeys').size;
    model.spatialObjectCount = modelObjects.filter((object) => object.spatialKeys.length > 0).length;
    model.containedObjectCount = model.directContainedObjectCount;
    model.spatialEntityCount = modelNodes.length;
  }

  const result = {
    models,
    nodes,
    objects,
    links,
    rootNodeKeys,
    coverage: {
      hasSpatialEntities,
      hasSpatialContainment,
      hasSpaces,
      directCbmIfcLinks: directGuidMatches,
      directCbmIfcLinkCoverage: directCoverage,
      spatiallyContainedCbmLinks: spatiallyContainedMatches,
      spatiallyContainedCbmCoverage: spatialCoverage,
      directContainedIfcObjects: directContainedObjectCount,
      decompositionInheritedIfcObjects: decompositionInheritedObjectCount,
      hostInheritedIfcObjects: hostInheritedObjectCount,
      boundaryContainedIfcObjects: boundaryContainedObjectCount,
      inheritedContainedIfcObjects: inheritedContainedObjectCount,
      placementOnlyAssets,
      unlocatedAssets,
      confirmedWithoutSpatialContainer,
      uncontainedIfcObjects,
      hasPlacementCoordinates,
      positionedAssets: positionedLinks.length,
      identityPlacementAssets: identityPlacementLinks.length,
      placementGroups: placementGroups.length,
      confidence,
    },
    nodeByKey,
    objectByKey,
    linksBySpatialKey,
    linksByCbmPath,
    linksByIfcObjectKey,
    placementGroups,
    identityPlacementLinks,
  };
  this.observer?.onFinalize?.({
    durationMs: performance.now() - finalizeStarted,
    modelCount: models.length,
    spatialNodeCount: nodes.length,
    objectCount: objects.length,
    linkCount: links.length,
    cbmLinkCount: links.filter((link) => link.ifcObjectKey != null || link.spatialKey != null).length,
    uncontainedIfcObjects: result.coverage.uncontainedIfcObjects,
  });
  return result;
}
}

/** 解析多个 IFC 文本并建立变电空间索引。输入文本由调用方决定来自解压包还是缓存。 */
export function buildSubstationSpatialIndexFromTexts(
  sources: Array<{ entry: IfcEntry; text: string | null }>,
  cbmTree: CbmNode | null,
  fileDevRelations: FileDevEntry[] = [],
  observer?: SubstationSpatialIndexObserver,
): SubstationSpatialIndex {
  const builder = new SubstationSpatialIndexBuilder(cbmTree, fileDevRelations, observer);
  for (const source of sources) builder.addIfcModel(source.entry, source.text);
  return builder.finalize();
}

/** 从解压后的文件集合构建空间索引。路径匹配大小写不敏感，兼容不同导出工具目录布局。 */
export async function buildSubstationSpatialIndexFromFiles(
  files: Map<string, File>,
  entries: IfcEntry[],
  cbmTree: CbmNode | null,
  fileDevRelations: FileDevEntry[] = [],
  observer?: SubstationSpatialIndexObserver,
): Promise<SubstationSpatialIndex> {
  const byLowerPath = new Map<string, File>();
  for (const [path, file] of files) byLowerPath.set(normalizePath(path).toLowerCase(), file);
  const builder = new SubstationSpatialIndexBuilder(cbmTree, fileDevRelations, observer);
  for (const entry of entries) {
    const file = byLowerPath.get(normalizePath(entry.path).toLowerCase());
    // 逐条读取/解析，不让多个 IFC 原始文本同时驻留；addIfcModel 不保存 text。
    const readStarted = performance.now();
    let bytes: ArrayBuffer | null = null;
    let fallbackText: string | null = null;
    let readError: string | undefined;
    if (file) {
      try {
        // 生产路径使用 Blob.arrayBuffer()，但保留 text-only File 兼容性：
        // 样本回归和部分宿主会提供最小的 `text()` shim，而不是完整 Blob。
        const readable = file as File & {
          arrayBuffer?: () => Promise<ArrayBuffer>;
          text?: () => Promise<string>;
        };
        if (typeof readable.arrayBuffer === 'function') {
          bytes = await readable.arrayBuffer();
        } else if (typeof readable.text === 'function') {
          fallbackText = await readable.text();
        } else {
          throw new Error('IFC 文件对象不支持 arrayBuffer/text');
        }
      } catch (error) {
        readError = error instanceof Error ? error.message : String(error);
      }
    }
    const readMs = performance.now() - readStarted;
    const decodeStarted = performance.now();
    const text = fallbackText ?? (bytes == null ? null : new TextDecoder().decode(bytes));
    const decodeMs = performance.now() - decodeStarted;
    observer?.onModelRead?.({
      modelId: entry.modelId,
      entryPath: entry.path,
      bytes: bytes?.byteLength
        ?? (fallbackText == null ? file?.size ?? 0 : new TextEncoder().encode(fallbackText).byteLength),
      readMs,
      decodeMs,
      found: file != null,
      ...(readError ? { error: readError } : {}),
    });
    const sourceBytes = bytes?.byteLength
      ?? (fallbackText == null ? file?.size ?? 0 : new TextEncoder().encode(fallbackText).byteLength);
    // 释放此模型的原始 ArrayBuffer 引用，再进入下一个模型；解析器只保留
    // 语义对象和 profile。
    bytes = null;
    builder.addIfcModel(entry, text, sourceBytes);
  }
  return builder.finalize();
}

function parseIfcModel(
  entry: IfcEntry,
  text: string,
  sourceBytes?: number,
  observer?: SubstationSpatialIndexObserver,
): ParsedIfcModel {
  const parseStarted = performance.now();
  const stepStarted = performance.now();
  const scan = scanIfcSemanticPass1(text);
  const stepScanMs = performance.now() - stepStarted;
  const selectedRecords = [...scan.selectedById.values()];
  const placementStarted = performance.now();
  // 仅针对空间/导航对象实际引用的 placement 做第二阶段扫描。placement
  // 记录可能引用文件中更早出现的父级/点/方向，因此 helper 会在需要时
  // 重扫直到引用闭包稳定；任何 IFCCARTESIANPOINT/IFCDIRECTION 都不会
  // 进入全量 detail map。
  const placementById = collectIfcPlacementClosure(text, scan.placementRoots, scan.placementCandidates);
  const placementDetailMs = performance.now() - placementStarted;
  const placementEntityCount = placementById.size;
  const placementCandidateCount = countPlacementCandidates(scan.totalTypeCounts);
  observer?.onStepScan?.({
    modelId: entry.modelId,
    entryPath: entry.path,
    sourceBytes: sourceBytes ?? text.length,
    rawEntityCount: scan.rawEntityCount,
    stepScanMs,
    retainedEntityCount: selectedRecords.length + scan.relationships.length,
    placementCandidateCount,
    placementEntityCount,
  });
  const detailById = placementById;
  const lengthUnit = parseLengthUnit(selectedRecords);
  const placementResolver = createIfcPlacementResolver(detailById, lengthUnit);

  // 先收集空间包含关系，再决定哪些非空间记录值得进入导航。
  // IFC 导出中大量 IFCPROPERTYSINGLEVALUE / 几何资源也带有“第一参数”，
  // 不能把它误读成 GlobalId；只有被空间关系引用或属于 IFC 产品类型的记录
  // 才进入对象索引。
  const spatialContainedIds = scan.spatialContainedIds;
  const hostObjectIdsByChildId = scan.hostObjectIdsByChildId;
  const boundarySpaceIdsByObjectId = scan.boundarySpaceIdsByObjectId;
  const spatialRelationIds = scan.spatialRelationIds;
  const relationships = scan.relationships;
  const spatialEntities: IfcSpatialNode[] = [];
  const spatialById = new Map<number, IfcSpatialNode>();
  const objects: IfcSpatialObject[] = [];
  // 属性/材质/分类/类型/组在 Spatial Core 中只保留计数；实际面板详情
  // 由 Fragments getItemsData() 在选择时按需读取。
  const propertyMs = 0;
  const propertyEntityCount = scan.propertyEntityCount;
  const quantityEntityCount = scan.quantityEntityCount;
  const propertyValueCount = 0;
  const quantityValueCount = 0;
  const materialEntityCount = scan.materialEntityCount;
  const classificationEntityCount = scan.classificationEntityCount;

  const navigationIds = new Set<number>();
  for (const record of selectedRecords) {
    const kind = SPATIAL_TYPES.get(record.ifcType);
    if (kind) continue;
    const globalId = parseString(record.args[0]);
    if (
      spatialContainedIds.has(record.expressId)
      || spatialRelationIds.has(record.expressId)
      || (globalId && isIfcNavigationObjectType(record.ifcType))
    ) {
      navigationIds.add(record.expressId);
    }
  }
  const relationshipCountByObjectId = new Map<number, number>();
  const relationshipTypesByObjectId = new Map<number, Map<string, number>>();
  const childIdsByObjectId = new Map<number, number[]>();
  const parentIdByObjectId = new Map<number, number>();
  const relationshipStarted = performance.now();
  let relationshipRecordCount = 0;
  let relationshipReferenceCount = 0;
  for (const record of relationships) {
    if (record.ifcType.startsWith('IFCREL')) {
      relationshipRecordCount++;
      // Pass 1 已经为每条 IFCREL 解析过引用列表。复用该列表，避免在
      // relationship 阶段再次对所有参数执行 parseRefs；这对包含数千 Related
      // Elements 的关系记录尤其重要，同时保持原有“每个对象引用计数一次”的语义。
      const relationRefs = scan.relationshipRefsById.get(record.expressId) ?? [];
      for (const objectId of relationRefs) {
        if (!navigationIds.has(objectId)) continue;
        relationshipReferenceCount++;
        relationshipCountByObjectId.set(objectId, (relationshipCountByObjectId.get(objectId) ?? 0) + 1);
        const typeCounts = relationshipTypesByObjectId.get(objectId) ?? new Map<string, number>();
        typeCounts.set(record.ifcType, (typeCounts.get(record.ifcType) ?? 0) + 1);
        relationshipTypesByObjectId.set(objectId, typeCounts);
      }
    }
    if (record.ifcType !== 'IFCRELAGGREGATES'
      && record.ifcType !== 'IFCRELNESTS'
      && record.ifcType !== 'IFCRELDECOMPOSES') continue;
    const spatialRelation = scan.spatialRelationRefsById.get(record.expressId);
    const parentId = spatialRelation?.parentId ?? null;
    if (parentId == null || !navigationIds.has(parentId)) continue;
    const childIds = (spatialRelation?.relatedIds ?? []).filter((id) => navigationIds.has(id));
    if (childIds.length === 0) continue;
    const existing = childIdsByObjectId.get(parentId) ?? [];
    for (const childId of childIds) {
      if (!existing.includes(childId)) existing.push(childId);
      if (!parentIdByObjectId.has(childId)) parentIdByObjectId.set(childId, parentId);
    }
    childIdsByObjectId.set(parentId, existing);
  }

  const spatialStarted = performance.now();
  for (const record of selectedRecords) {
    const kind = SPATIAL_TYPES.get(record.ifcType);
    const globalId = parseString(record.args[0]);
    const name = displayIfcName(record.ifcType, record.args, record.expressId);
    if (kind) {
      const node: IfcSpatialNode = {
        key: spatialKey(entry.modelId, record.expressId),
        modelId: entry.modelId,
        expressId: record.expressId,
        ifcType: record.ifcType,
        kind,
        globalId,
        name,
        ...ifcSpatialMetadata(record.args),
        ...(spatialElevation(record.ifcType, record.args) != null
          ? { elevation: spatialElevation(record.ifcType, record.args)! }
          : {}),
        propertyDataDeferred: true,
        ...(placementResolver.resolve(parseRef(record.args[5]))
          ? { placement: placementResolver.resolve(parseRef(record.args[5]))! }
          : {}),
        parentKey: null,
        childKeys: [],
        directObjectKeys: [],
        boundaryObjectKeys: [],
        decompositionObjectKeys: [],
        hostObjectKeys: [],
        objectKeys: [],
        sourcePath: entry.path,
      };
      spatialEntities.push(node);
      spatialById.set(record.expressId, node);
      continue;
    }
    const isContained = spatialContainedIds.has(record.expressId);
    // 只将 IFC 产品/构件和空间关系明确引用的记录纳入可浏览对象集合。
    // `isContained` 允许兼容厂商扩展的 IFC 产品类型；产品类型判断则补齐
    // 没有空间容器但仍应在“未落入空间”分组中可检索的实体。
    if (isContained || (globalId && isIfcNavigationObjectType(record.ifcType))) {
      const placement = placementResolver.resolve(parseRef(record.args[5]));
      objects.push({
        key: objectKey(entry.modelId, record.expressId),
        modelId: entry.modelId,
        expressId: record.expressId,
        ifcType: record.ifcType,
        globalId: isContained || isIfcRootLikeType(record.ifcType) ? globalId : '',
        name,
        propertyDataDeferred: true,
        ...ifcObjectMetadata(record.args, undefined, placement ?? undefined, {}),
        parentObjectKey: parentIdByObjectId.has(record.expressId)
          ? objectKey(entry.modelId, parentIdByObjectId.get(record.expressId)!)
          : null,
        childObjectKeys: (childIdsByObjectId.get(record.expressId) ?? []).map((id) => objectKey(entry.modelId, id)),
        relationshipCount: relationshipCountByObjectId.get(record.expressId) ?? 0,
        ...(relationshipTypesByObjectId.has(record.expressId)
          ? { relationshipTypes: Object.fromEntries(relationshipTypesByObjectId.get(record.expressId)!) }
          : {}),
        hostObjectKey: hostObjectIdsByChildId.has(record.expressId)
          ? objectKey(entry.modelId, hostObjectIdsByChildId.get(record.expressId)![0])
          : null,
        spatialKey: null,
        spatialKeys: [],
        spatialContainment: null,
        sourcePath: entry.path,
      });
    }
  }
  const spatialEntityMs = performance.now() - spatialStarted;

  // resourceTypeCounts 仍反映完整 STEP 文件画像，但只扣除真正进入
  // Spatial Core 的空间/导航对象；属性、材质、分类、几何资源和关系
  // 记录不会被展开成长期对象。
  const resourceTypeCounts = new Map(scan.totalTypeCounts);
  const consumeResourceType = (ifcType: string): void => {
    const remaining = (resourceTypeCounts.get(ifcType) ?? 0) - 1;
    if (remaining > 0) resourceTypeCounts.set(ifcType, remaining);
    else resourceTypeCounts.delete(ifcType);
  };
  for (const node of spatialEntities) consumeResourceType(node.ifcType);
  for (const object of objects) consumeResourceType(object.ifcType);

  const objectById = new Map<number, IfcSpatialObject>();
  for (const object of objects) objectById.set(object.expressId, object);
  const objectByKey = new Map(objects.map((object) => [object.key, object]));
  const nodeBySpatialKey = new Map<string, IfcSpatialNode>();
  for (const node of spatialEntities) nodeBySpatialKey.set(node.key, node);

  // 大型 IFC 往往只有一个 IFCREL*SPATIAL*，但 related elements 可达数万条。
  // 不能在逐对象投影时对不断增长的数组调用 includes（会退化为 O(n²)）；
  // 这些 Set 仅在当前模型解析期间存在，最终仍按原有数组接口输出。
  const nodeObjectKeySets = new Map<string, {
    objectKeys: Set<string>;
    directObjectKeys: Set<string>;
    boundaryObjectKeys: Set<string>;
    decompositionObjectKeys: Set<string>;
    hostObjectKeys: Set<string>;
  }>();
  const nodeSets = (node: IfcSpatialNode) => {
    let sets = nodeObjectKeySets.get(node.key);
    if (!sets) {
      sets = {
        objectKeys: new Set(node.objectKeys),
        directObjectKeys: new Set(node.directObjectKeys),
        boundaryObjectKeys: new Set(node.boundaryObjectKeys),
        decompositionObjectKeys: new Set(node.decompositionObjectKeys),
        hostObjectKeys: new Set(node.hostObjectKeys),
      };
      nodeObjectKeySets.set(node.key, sets);
    }
    return sets;
  };

  /** 把 IFC 空间关系写入对象图，同时保留多容器关系和直接/继承证据。 */
  const assignObjectToSpatial = (
    object: IfcSpatialObject,
    parent: IfcSpatialNode,
    evidence: 'direct' | 'boundary' | 'inherited',
    inheritanceKind?: IfcSpatialInheritanceKind,
  ): void => {
    const parentSets = nodeSets(parent);
    // 单个对象通常只关联少量空间；保留数组 includes 可避免为数万对象各建
    // 一个 Set。真正会增长到数万项的是节点侧 objectKeys，那里使用上面的
    // nodeObjectKeySets 做 O(1) 去重。
    if (!object.spatialKeys.includes(parent.key)) {
      object.spatialKeys.push(parent.key);
    }
    if (!parentSets.objectKeys.has(object.key)) {
      parentSets.objectKeys.add(object.key);
      parent.objectKeys.push(object.key);
    }
    if (evidence === 'direct') {
      if (!parentSets.directObjectKeys.has(object.key)) {
        parentSets.directObjectKeys.add(object.key);
        parent.directObjectKeys.push(object.key);
      }
      // 同一对象可能先通过分解关系继承到一个空间，再被另一个 IFC 关系直接包含；
      // 直接关系的置信度更高，作为主空间和主证据。
      if (object.spatialContainment !== 'direct') {
        object.spatialKey = parent.key;
        object.spatialContainment = 'direct';
        object.spatialRelation = 'containment';
        delete object.spatialInheritanceKind;
      }
    } else if (evidence === 'boundary') {
      if (!parentSets.boundaryObjectKeys.has(object.key)) {
        parentSets.boundaryObjectKeys.add(object.key);
        parent.boundaryObjectKeys.push(object.key);
      }
      // 直接包含优先于边界关系；否则将边界关系作为主空间证据保留。
      if (!object.spatialKey || object.spatialContainment === 'inherited') {
        object.spatialKey = parent.key;
        object.spatialContainment = 'boundary';
        object.spatialRelation = 'space-boundary';
        delete object.spatialInheritanceKind;
      }
    } else {
      const resolvedKind = inheritanceKind ?? 'decomposition';
      const targetKeys = resolvedKind === 'host-relation'
        ? parent.hostObjectKeys
        : parent.decompositionObjectKeys;
      const targetSet = resolvedKind === 'host-relation'
        ? parentSets.hostObjectKeys
        : parentSets.decompositionObjectKeys;
      if (!targetSet.has(object.key)) {
        targetSet.add(object.key);
        targetKeys.push(object.key);
      }
      // spatialKey/spatialContainment 仅表示一个稳定的主空间兼容视图；完整
      // 的分解/宿主证据已经按空间保存在上面的数组中。若对象尚未有主空间，
      // 选择本次继承关系作为主证据；若已有直接/边界/其他空间，不覆盖它。
      if (!object.spatialKey) {
        object.spatialKey = parent.key;
        object.spatialContainment = 'inherited';
        object.spatialRelation = resolvedKind;
        object.spatialInheritanceKind = resolvedKind;
      }
    }
  };

  for (const record of relationships) {
    if (record.ifcType === 'IFCRELAGGREGATES') {
      const spatialRelation = scan.spatialRelationRefsById.get(record.expressId);
      const parentId = spatialRelation?.parentId ?? null;
      const childIds = spatialRelation?.relatedIds ?? [];
      const parent = parentId == null ? null : spatialById.get(parentId);
      if (parent) {
        for (const childId of childIds) {
          const child = spatialById.get(childId);
          if (!child || child.parentKey) continue;
          child.parentKey = parent.key;
          parent.childKeys.push(child.key);
        }
      }
    } else if (record.ifcType === 'IFCRELNESTS' || record.ifcType === 'IFCRELDECOMPOSES') {
      const spatialRelation = scan.spatialRelationRefsById.get(record.expressId);
      const parentId = spatialRelation?.parentId ?? null;
      const childIds = spatialRelation?.relatedIds ?? [];
      const parent = parentId == null ? null : spatialById.get(parentId);
      if (parent) {
        for (const childId of childIds) {
          const child = spatialById.get(childId);
          if (!child || child.parentKey) continue;
          child.parentKey = parent.key;
          parent.childKeys.push(child.key);
        }
      }
    } else if (
      record.ifcType === 'IFCRELCONTAINEDINSPATIALSTRUCTURE'
      || record.ifcType === 'IFCRELREFERENCEDINSPATIALSTRUCTURE'
    ) {
      const spatialRelation = scan.spatialRelationRefsById.get(record.expressId);
      const elementIds = spatialRelation?.relatedIds ?? [];
      const parentId = spatialRelation?.parentId ?? null;
      const parent = parentId == null ? null : spatialById.get(parentId);
      if (!parent) continue;
      for (const elementId of elementIds) {
        const childSpatial = spatialById.get(elementId);
        if (childSpatial && !childSpatial.parentKey) {
          childSpatial.parentKey = parent.key;
          parent.childKeys.push(childSpatial.key);
          continue;
        }
        const object = objectById.get(elementId);
        if (!object) continue;
        assignObjectToSpatial(object, parent, 'direct');
      }
    }
  }

  // IFCSPACE 常通过空间边界关系关联墙、门、设备等构件，而不是把它们
  // 放入 IFCREL*CONTAINEDINSPATIALSTRUCTURE。将边界关系投影到空间节点，
  // 但单独记录 boundaryObjectKeys 和空间证据，避免在统计中冒充“直接包含”。
  for (const [objectId, spaceIds] of boundarySpaceIdsByObjectId) {
    const object = objectById.get(objectId);
    if (!object) continue;
    for (const spaceId of spaceIds) {
      const parent = spatialById.get(spaceId);
      if (parent) assignObjectToSpatial(object, parent, 'boundary');
    }
  }

  const hostChildrenByParentId = new Map<number, number[]>();
  for (const [childId, parentIds] of hostObjectIdsByChildId) {
    for (const parentId of parentIds) {
      const children = hostChildrenByParentId.get(parentId) ?? [];
      if (!children.includes(childId)) children.push(childId);
      hostChildrenByParentId.set(parentId, children);
    }
  }

  // IFC 常把一个 IfcElementAssembly 直接放入楼层，再通过
  // IFCRELAGGREGATES/IFCRELNESTS/IFCRELDECOMPOSES 连接子构件。若只保留直接
  // 包含项，子构件会错误地出现在“未落入空间”分组。沿对象分解关系继承空间
  // 归属，并把证据标成 inherited，既补齐导航又不冒充 IFC 的直接包含关系。
  const propagateSpatialContainment = (object: IfcSpatialObject, active: Set<string>): void => {
    if (active.has(object.key)) return;
    active.add(object.key);
    const spatialKeys = [...object.spatialKeys];
    for (const spatialKey of spatialKeys) {
      const parent = nodeBySpatialKey.get(spatialKey);
      if (!parent) continue;
      for (const childKey of object.childObjectKeys) {
        const child = objectByKey.get(childKey);
        if (!child) continue;
        assignObjectToSpatial(child, parent, 'inherited', 'decomposition');
        propagateSpatialContainment(child, active);
      }
      for (const childId of hostChildrenByParentId.get(object.expressId) ?? []) {
        // 仅沿“子对象 → 宿主对象”的边传播空间，避免把宿主的空间反向
        // 推给所有无关对象。
        const child = objectById.get(childId);
        if (!child) continue;
        assignObjectToSpatial(child, parent, 'inherited', 'host-relation');
        propagateSpatialContainment(child, active);
      }
    }
    active.delete(object.key);
  };
  for (const object of objects) {
    if (object.spatialKeys.length > 0) propagateSpatialContainment(object, new Set<string>());
  }

  const relationshipMs = performance.now() - relationshipStarted;

  const finalizeStarted = performance.now();
  const containedObjectCount = objects.filter((object) => object.spatialKeys.length > 0).length;
  const directContainedObjectCount = objects.filter((object) => object.spatialContainment === 'direct').length;
  const finalizeMs = performance.now() - finalizeStarted;
  const profile: IfcSpatialParseProfile = {
    modelId: entry.modelId,
    entryPath: entry.path,
    sourceBytes: sourceBytes ?? text.length,
    totalMs: performance.now() - parseStarted,
    stepScanMs,
    rawEntityCount: scan.rawEntityCount,
    detailEntityCount: selectedRecords.length + relationships.length + detailById.size,
    retainedEntityCount: selectedRecords.length + relationships.length,
    placementEntityCount,
    placementCandidateCount,
    placementDetailMs,
    spatialEntityMs,
    spatialEntityCount: spatialEntities.length,
    propertyMs,
    propertyEntityCount,
    quantityEntityCount,
    propertyValueCount,
    quantityValueCount,
    materialEntityCount,
    classificationEntityCount,
    relationshipMs,
    relationshipRecordCount,
    relationshipReferenceCount,
    finalizeMs,
    objectCount: objects.length,
    containedObjectCount,
  };
  return {
    summary: {
      modelId: entry.modelId,
      entryPath: entry.path,
      spatialEntityCount: spatialEntities.length,
      objectCount: objects.length,
      directContainedObjectCount,
      spatialObjectCount: containedObjectCount,
      containedObjectCount: directContainedObjectCount,
      resourceCount: [...resourceTypeCounts.values()].reduce((sum, count) => sum + count, 0),
      resourceTypeCounts: toTopTypeCounts(resourceTypeCounts),
      lengthUnit: lengthUnit.name,
      lengthUnitScaleToMetres: lengthUnit.scaleToMetres,
      propertyValueCount,
      quantityValueCount,
      // 属性/材质等在启动 Spatial Core 延迟到 Fragments getItemsData；
      // 这里明确为 0，避免把“发现实体数量”误报成已加载属性。
      objectsWithProperties: 0,
      objectsWithMaterials: 0,
    },
    spatialEntities,
    objects,
    profile,
  };
}

/**
 * 扫描 STEP 实体边界。非目标实体只经过字符级括号/字符串扫描，
 * 不创建 body substring、args 数组或 RawIfcEntity。
 */
function scanIfcEntityBoundaries(text: string, onEntity: ScannedIfcEntityCallback): number {
  // IFC DATA records are delimited by `;` and their entity header is always
  // anchored at the beginning of a line/record.  Let V8's native regexp engine
  // find the 6M headers first; only retained entities pay the nested-parenthesis
  // scan in materializeIfcEntity().  The character scanner below remains the
  // fallback for malformed/minified input where no anchored header is found.
  const header = /(?:^|;|\r?\n)\s*#(\d+)\s*=\s*([A-Za-z0-9_]+)\s*\(/g;
  let fastCount = 0;
  let match: RegExpExecArray | null;
  while ((match = header.exec(text)) !== null) {
    fastCount++;
    onEntity(
      Number(match[1]),
      match[2].toUpperCase(),
      // The expression includes the opening parenthesis, so the body starts
      // at the match end. Avoid a second indexOf/lastIndexOf over all 6M
      // headers in large IFC files.
      match.index + match[0].length,
      // -1 means "resolve lazily".  Retained records and placement-closure
      // records calculate their end only when their arguments are needed.
      -1,
    );
  }
  if (fastCount > 0) return fastCount;

  return scanIfcEntityBoundariesCharacter(text, onEntity);
}

/** 兼容无标准行/记录分隔符的最小 STEP 文本。 */
function scanIfcEntityBoundariesCharacter(text: string, onEntity: ScannedIfcEntityCallback): number {
  let count = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const hash = text.indexOf('#', cursor);
    if (hash < 0) break;
    let i = hash + 1;
    while (i < text.length && /\d/.test(text[i])) i++;
    if (i === hash + 1) {
      cursor = hash + 1;
      continue;
    }
    const expressId = Number(text.slice(hash + 1, i));
    while (/\s/.test(text[i] || '')) i++;
    if (text[i] !== '=') {
      cursor = i + 1;
      continue;
    }
    i++;
    while (/\s/.test(text[i] || '')) i++;
    const typeStart = i;
    while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i++;
    const ifcType = text.slice(typeStart, i).toUpperCase();
    while (/\s/.test(text[i] || '')) i++;
    if (!ifcType || text[i] !== '(') {
      cursor = i + 1;
      continue;
    }
    const bodyStart = ++i;
    let depth = 1;
    let inString = false;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === "'") {
        if (inString && text[i + 1] === "'") {
          i++;
          continue;
        }
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break;
    count++;
    onEntity(expressId, ifcType, bodyStart, i);
    const semi = text.indexOf(';', i);
    cursor = semi >= 0 ? semi + 1 : i + 1;
  }
  return count;
}

function materializeIfcEntity(text: string, entity: ScannedIfcEntity): RawIfcEntity {
  const bodyEnd = entity.bodyEnd >= entity.bodyStart
    ? entity.bodyEnd
    : findIfcEntityBodyEnd(text, entity.bodyStart - 1);
  if (bodyEnd < entity.bodyStart) {
    return { expressId: entity.expressId, ifcType: entity.ifcType, args: [] };
  }
  return {
    expressId: entity.expressId,
    ifcType: entity.ifcType,
    args: splitIfcArgs(text.slice(entity.bodyStart, bodyEnd)),
  };
}

function findIfcEntityBodyEnd(text: string, openParen: number): number {
  let depth = 1;
  let inString = false;
  for (let i = openParen + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      if (inString && text[i + 1] === "'") {
        i++;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function scanIfcEntitiesSelective(
  text: string,
  shouldRetain: (ifcType: string, expressId: number) => boolean,
  onScanned?: ScannedIfcEntityCallback,
): { retained: RawIfcEntity[]; rawEntityCount: number; totalTypeCounts: Map<string, number> } {
  const retained: RawIfcEntity[] = [];
  const totalTypeCounts = new Map<string, number>();
  const rawEntityCount = scanIfcEntityBoundaries(text, (expressId, ifcType, bodyStart, bodyEnd) => {
    totalTypeCounts.set(ifcType, (totalTypeCounts.get(ifcType) ?? 0) + 1);
    // 仅 placement 候选需要回调；避免对数百万普通实体产生一次额外
    // callback/分支，再由 pass 1 统一收集其压缩位置编码。
    if (onScanned && isIfcPlacementEntityType(ifcType)) {
      onScanned(expressId, ifcType, bodyStart, bodyEnd);
    }
    if (shouldRetain(ifcType, expressId)) {
      retained.push(materializeIfcEntity(text, { expressId, ifcType, bodyStart, bodyEnd }));
    }
  });
  return { retained, rawEntityCount, totalTypeCounts };
}

function isIfcUnitEntityType(ifcType: string): boolean {
  return ifcType === 'IFCSIUNIT'
    || ifcType === 'IFCCONVERSIONBASEDUNIT'
    || ifcType === 'IFCMEASUREWITHUNIT';
}

function addRelationReference(
  map: Map<number, number[]>,
  childId: number | null,
  parentId: number | null,
  spatialRelationIds: Set<number>,
): void {
  if (childId == null || parentId == null) return;
  const values = map.get(childId) ?? [];
  if (!values.includes(parentId)) values.push(parentId);
  map.set(childId, values);
  spatialRelationIds.add(childId);
  spatialRelationIds.add(parentId);
}

/**
 * 首遍只保存空间/导航候选、关系和单位。关系引用的自定义对象可能在
 * 首遍尚未满足产品白名单，随后以 expressId 定向补齐，不会把资源实体
 * 全量带入内存。
 */
function scanIfcSemanticPass1(text: string): SelectiveIfcScanResult {
  const placementCandidates = new Map<number, number>();
  const first = scanIfcEntitiesSelective(
    text,
    (ifcType) => SPATIAL_TYPES.has(ifcType) || isIfcNavigationObjectType(ifcType) || isIfcUnitEntityType(ifcType) || ifcType.startsWith('IFCREL'),
    (expressId, ifcType, bodyStart) => {
      if (isIfcPlacementEntityType(ifcType)) {
        placementCandidates.set(expressId, encodePlacementCandidate(ifcType, bodyStart));
      }
    },
  );
  const selectedById = new Map<number, RawIfcEntity>();
  const relationships: RawIfcEntity[] = [];
  const relationshipRefsById = new Map<number, number[]>();
  const spatialRelationRefsById = new Map<number, { parentId: number | null; relatedIds: number[] }>();
  const spatialContainedIds = new Set<number>();
  const hostObjectIdsByChildId = new Map<number, number[]>();
  const boundarySpaceIdsByObjectId = new Map<number, number[]>();
  const spatialRelationIds = new Set<number>();
  const referencedIds = new Set<number>();
  for (const record of first.retained) {
    if (record.ifcType.startsWith('IFCREL')) {
      relationships.push(record);
      const relationRefs = record.args.flatMap((arg) => parseRefs(arg));
      relationshipRefsById.set(record.expressId, relationRefs);
      // 只有会影响 Spatial Core 的关系才需要定向补扫关系目标。属性、材质、
      // 分类、类型和组关系的目标在启动阶段按需读取，不要把它们的数百万
      // property/value entity 引入救援集合。
      if (isIfcSpatialSemanticRelationship(record.ifcType)) {
        for (const id of relationRefs) referencedIds.add(id);
      }
      if (record.ifcType === 'IFCRELCONTAINEDINSPATIALSTRUCTURE'
        || record.ifcType === 'IFCRELREFERENCEDINSPATIALSTRUCTURE') {
        const relatedIds = parseRefs(record.args[4]);
        spatialRelationRefsById.set(record.expressId, {
          parentId: parseRef(record.args[5]),
          relatedIds,
        });
        for (const id of relatedIds) spatialContainedIds.add(id);
      } else if (record.ifcType === 'IFCRELAGGREGATES'
        || record.ifcType === 'IFCRELNESTS'
        || record.ifcType === 'IFCRELDECOMPOSES') {
        spatialRelationRefsById.set(record.expressId, {
          parentId: parseRef(record.args[4]),
          relatedIds: parseRefs(record.args[5]),
        });
      } else if (record.ifcType === 'IFCRELVOIDSELEMENT') {
        addRelationReference(hostObjectIdsByChildId, parseRef(record.args[5]), parseRef(record.args[4]), spatialRelationIds);
      } else if (record.ifcType === 'IFCRELCONNECTSPORTTOELEMENT') {
        addRelationReference(hostObjectIdsByChildId, parseRef(record.args[4]), parseRef(record.args[5]), spatialRelationIds);
      } else if (record.ifcType.startsWith('IFCRELSPACEBOUNDARY')) {
        // IFC2x3/IFC4 均将 RelatingSpace、RelatedBuildingElement 放在第 5/6 个参数。
        addRelationReference(boundarySpaceIdsByObjectId, parseRef(record.args[5]), parseRef(record.args[4]), spatialRelationIds);
      }
      continue;
    }
    selectedById.set(record.expressId, record);
  }

  // 关系引用可能指向厂商扩展的实体类型；定向二遍只取这些 express id。
  const rescueIds = new Set<number>([...referencedIds].filter((id) => !selectedById.has(id)));
  if (rescueIds.size > 0) {
    const rescue = scanIfcEntitiesSelective(text, (_ifcType, expressId) => rescueIds.has(expressId));
    for (const record of rescue.retained) selectedById.set(record.expressId, record);
  }

  const placementRoots = new Set<number>();
  for (const record of selectedById.values()) {
    if (SPATIAL_TYPES.has(record.ifcType) || isIfcNavigationObjectType(record.ifcType)) {
      const placementRef = parseRef(record.args[5]);
      if (placementRef != null) placementRoots.add(placementRef);
    }
  }
  return {
    selectedById,
    relationships,
    relationshipRefsById,
    spatialRelationRefsById,
    placementCandidates,
    rawEntityCount: first.rawEntityCount,
    totalTypeCounts: first.totalTypeCounts,
    spatialContainedIds,
    hostObjectIdsByChildId,
    boundarySpaceIdsByObjectId,
    spatialRelationIds,
    placementRoots,
    propertyEntityCount: [...first.totalTypeCounts.entries()]
      .filter(([type]) => type.startsWith('IFCPROPERTY'))
      .reduce((sum, [, count]) => sum + count, 0),
    quantityEntityCount: [...first.totalTypeCounts.entries()]
      .filter(([type]) => type.startsWith('IFCQUANTITY') || type === 'IFCELEMENTQUANTITY')
      .reduce((sum, [, count]) => sum + count, 0),
    materialEntityCount: [...first.totalTypeCounts.entries()]
      .filter(([type]) => type.startsWith('IFCMATERIAL'))
      .reduce((sum, [, count]) => sum + count, 0),
    classificationEntityCount: [...first.totalTypeCounts.entries()]
      .filter(([type]) => type.startsWith('IFCCLASSIFICATION'))
      .reduce((sum, [, count]) => sum + count, 0),
  };
}

/**
 * 只扫描 placement 引用闭包。因 STEP 允许父 placement 出现在子记录之前，
 * 需要在新增引用后继续消费队列；每个 ID 最多 materialize 一次。使用显式
 * 队列而不是固定轮数上限，避免深层（或厂商扩展）placement 链被截断；
 * `closure` 同时也负责打断循环引用。
 */
function collectIfcPlacementClosure(
  text: string,
  roots: Set<number>,
  candidates: Map<number, number>,
): Map<number, RawIfcEntity> {
  const wanted = new Set<number>(roots);
  const closure = new Map<number, RawIfcEntity>();
  const pending = [...wanted];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const id = pending[cursor];
    if (closure.has(id)) continue;
    const encoded = candidates.get(id);
    if (encoded == null) continue;
    const candidate = decodePlacementCandidate(id, encoded);
    const record = materializeIfcEntity(text, candidate);
    closure.set(record.expressId, record);
    for (const ref of placementReferenceIds(record)) {
      if (wanted.has(ref)) continue;
      wanted.add(ref);
      pending.push(ref);
    }
  }
  return closure;
}

/**
 * placement 候选数量可能达到百万级。候选只需保存 bodyStart 和五种实体类型，
 * 用一个安全整数编码即可避免为每个候选分配 ScannedIfcEntity 对象；真正进入
 * 引用闭包的记录才在 collectIfcPlacementClosure 中物化。
 */
const PLACEMENT_TYPE_CODE: Readonly<Record<string, number>> = {
  IFCLOCALPLACEMENT: 1,
  IFCAXIS2PLACEMENT3D: 2,
  IFCAXIS2PLACEMENT2D: 3,
  IFCCARTESIANPOINT: 4,
  IFCDIRECTION: 5,
};

const PLACEMENT_TYPE_BY_CODE: Readonly<Record<number, string>> = {
  1: 'IFCLOCALPLACEMENT',
  2: 'IFCAXIS2PLACEMENT3D',
  3: 'IFCAXIS2PLACEMENT2D',
  4: 'IFCCARTESIANPOINT',
  5: 'IFCDIRECTION',
};

function encodePlacementCandidate(ifcType: string, bodyStart: number): number {
  return bodyStart * 8 + (PLACEMENT_TYPE_CODE[ifcType] ?? 0);
}

function decodePlacementCandidate(expressId: number, encoded: number): ScannedIfcEntity {
  const typeCode = encoded % 8;
  return {
    expressId,
    ifcType: PLACEMENT_TYPE_BY_CODE[typeCode] ?? 'IFCLOCALPLACEMENT',
    bodyStart: Math.floor(encoded / 8),
    // bodyEnd is deliberately resolved lazily only for closure members.
    bodyEnd: -1,
  };
}

function isIfcPlacementEntityType(ifcType: string): boolean {
  return ifcType === 'IFCLOCALPLACEMENT'
    || ifcType === 'IFCAXIS2PLACEMENT3D'
    || ifcType === 'IFCAXIS2PLACEMENT2D'
    || ifcType === 'IFCCARTESIANPOINT'
    || ifcType === 'IFCDIRECTION';
}

function isIfcSpatialSemanticRelationship(ifcType: string): boolean {
  return ifcType === 'IFCRELAGGREGATES'
    || ifcType === 'IFCRELNESTS'
    || ifcType === 'IFCRELDECOMPOSES'
    || ifcType === 'IFCRELCONTAINEDINSPATIALSTRUCTURE'
    || ifcType === 'IFCRELREFERENCEDINSPATIALSTRUCTURE'
    || ifcType === 'IFCRELVOIDSELEMENT'
    || ifcType === 'IFCRELCONNECTSPORTTOELEMENT'
    || ifcType.startsWith('IFCRELSPACEBOUNDARY');
}

function placementReferenceIds(record: RawIfcEntity): number[] {
  if (record.ifcType === 'IFCLOCALPLACEMENT'
    || record.ifcType === 'IFCAXIS2PLACEMENT3D'
    || record.ifcType === 'IFCAXIS2PLACEMENT2D') {
    return record.args.flatMap((arg) => parseRefs(arg));
  }
  return [];
}

function countPlacementCandidates(totalTypeCounts: Map<string, number>): number {
  return [
    'IFCLOCALPLACEMENT',
    'IFCAXIS2PLACEMENT3D',
    'IFCAXIS2PLACEMENT2D',
    'IFCCARTESIANPOINT',
    'IFCDIRECTION',
  ].reduce((sum, type) => sum + (totalTypeCounts.get(type) ?? 0), 0);
}

function splitIfcArgs(body: string): string[] {
  const args: string[] = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'") {
      if (inString && body[i + 1] === "'") {
        i++;
        continue;
      }
      inString = !inString;
    } else if (!inString) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) {
        args.push(body.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  args.push(body.slice(start).trim());
  return args;
}

function parseRefs(value: string | undefined): number[] {
  if (!value) return [];
  const refs: number[] = [];
  const regex = /#(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) refs.push(Number(match[1]));
  return refs;
}

function parseRef(value: string | undefined): number | null {
  const match = value?.match(/^#(\d+)$/);
  return match ? Number(match[1]) : null;
}

function parseString(value: string | undefined): string {
  if (!value || value === '$' || value === '*') return '';
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed[0] !== "'" || trimmed[trimmed.length - 1] !== "'") return '';
  return decodeIfcString(trimmed.slice(1, -1).replace(/''/g, "'"));
}

function parseIfcNumber(value: string | undefined): number | null {
  if (!value || value === '$' || value === '*') return null;
  const number = Number(value.trim());
  return Number.isFinite(number) ? number : null;
}

function displayIfcName(ifcType: string, args: string[], expressId: number): string {
  // IfcObject 的 Name 经常由导出器写成 "--"；此时优先使用
  // LongName/Tag/ObjectType/Description，避免左树出现成百上千个同名行。
  const name = parseString(args[2]);
  const candidates = SPATIAL_TYPES.has(ifcType)
    ? [name, parseString(args[7]), parseString(args[4]), parseString(args[3])]
    : [name, parseString(args[3]), parseString(args[7]), parseString(args[4])];
  const meaningful = candidates.find((value) => !isIfcPlaceholder(value));
  return meaningful ? shortenIfcLabel(meaningful) : `${ifcType} #${expressId}`;
}

function ifcSpatialMetadata(args: string[]): Pick<IfcSpatialNode, 'description' | 'objectType' | 'longName' | 'compositionType' | 'placementRef' | 'representationRef' | 'geometryStatus'> {
  const description = meaningfulIfcString(parseString(args[3]));
  const objectType = meaningfulIfcString(parseString(args[4]));
  const longName = meaningfulIfcString(parseString(args[7]));
  const compositionType = meaningfulIfcEnum(args[8]);
  const placement = parseRef(args[5]);
  const representation = parseRefs(args[6])[0];
  return {
    ...(description ? { description } : {}),
    ...(objectType ? { objectType } : {}),
    ...(longName ? { longName } : {}),
    ...(compositionType ? { compositionType } : {}),
    ...(placement != null ? { placementRef: `#${placement}` } : {}),
    ...(representation != null ? { representationRef: `#${representation}` } : {}),
    geometryStatus: representation != null ? 'represented' : 'unrepresented',
  };
}

function ifcObjectMetadata(
  args: string[],
  propertyGroups: IfcPropertyGroup[] | undefined,
  placementSummary: IfcPlacementSummary | undefined,
  extra: Pick<IfcSpatialObject, 'materials' | 'classifications' | 'typeName' | 'groupNames'>,
): Pick<IfcSpatialObject, 'description' | 'objectType' | 'tag' | 'predefinedType' | 'placementRef' | 'placement' | 'representationRef' | 'geometryStatus' | 'propertySets' | 'propertySetNames' | 'materials' | 'classifications' | 'typeName' | 'groupNames'> {
  const description = meaningfulIfcString(parseString(args[3]));
  const objectType = meaningfulIfcString(parseString(args[4]));
  const tag = meaningfulIfcString(parseString(args[7]));
  const predefinedType = meaningfulIfcEnum(args[args.length - 1]);
  const placementRef = parseRef(args[5]);
  const representationRef = parseRefs(args[6])[0];
  return {
    ...(description ? { description } : {}),
    ...(objectType ? { objectType } : {}),
    ...(tag ? { tag } : {}),
    ...(predefinedType ? { predefinedType } : {}),
    ...(placementRef != null ? { placementRef: `#${placementRef}` } : {}),
    ...(placementSummary ? { placement: placementSummary } : {}),
    ...(representationRef != null ? { representationRef: `#${representationRef}` } : {}),
    geometryStatus: representationRef != null ? 'represented' : 'unrepresented',
    ...(propertyGroups && propertyGroups.length > 0
      ? {
          propertySets: clonePropertyGroups(propertyGroups),
          propertySetNames: propertyGroups.map((group) => group.name),
        }
      : {}),
    ...(extra.materials && extra.materials.length > 0 ? { materials: [...new Set(extra.materials)] } : {}),
    ...(extra.classifications && extra.classifications.length > 0 ? { classifications: [...new Set(extra.classifications)] } : {}),
    ...(extra.typeName ? { typeName: extra.typeName } : {}),
    ...(extra.groupNames && extra.groupNames.length > 0 ? { groupNames: [...new Set(extra.groupNames)] } : {}),
  };
}

function clonePropertyGroups(groups: IfcPropertyGroup[]): IfcPropertyGroup[] {
  return groups.map((group) => ({
    ...group,
    values: group.values.map((value) => ({ ...value })),
  }));
}

function spatialElevation(ifcType: string, args: string[]): number | null {
  switch (ifcType) {
    case 'IFCBUILDINGSTOREY':
    case 'IFCSPACE':
      return parseIfcNumber(args[9]);
    case 'IFCSITE':
      return parseIfcNumber(args[11]);
    case 'IFCBUILDING':
      return parseIfcNumber(args[9]);
    default:
      return null;
  }
}

interface IfcLengthUnit {
  name?: string;
  scaleToMetres?: number;
}

function parseLengthUnit(records: RawIfcEntity[]): IfcLengthUnit {
  for (const record of records) {
    if (record.ifcType !== 'IFCSIUNIT' || meaningfulIfcEnum(record.args[0]) !== 'LENGTHUNIT') continue;
    const prefix = meaningfulIfcEnum(record.args[1]);
    const name = meaningfulIfcEnum(record.args[2]);
    const prefixScale: Record<string, number> = {
      EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6,
      KILO: 1e3, HECTO: 1e2, DECA: 1e1, DECI: 1e-1, CENTI: 1e-2,
      MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12,
    };
    const baseScale = name === 'FOOT' ? 0.3048 : name === 'INCH' ? 0.0254 : 1;
    return {
      name: [prefix, name].filter(Boolean).join(' ') || undefined,
      scaleToMetres: baseScale * (prefixScale[prefix] ?? 1),
    };
  }
  return {};
}

type Vec3 = [number, number, number];

function createIfcPlacementResolver(
  detailById: Map<number, RawIfcEntity>,
  unit: IfcLengthUnit,
): { resolve: (id: number | null) => IfcPlacementSummary | null } {
  const cache = new Map<number, IfcPlacementSummary | null>();
  const resolving = new Set<number>();
  const resolve = (id: number | null): IfcPlacementSummary | null => {
    if (id == null) return null;
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    if (resolving.has(id)) return null;
    const record = detailById.get(id);
    if (!record) {
      cache.set(id, null);
      return null;
    }
    resolving.add(id);
    let result: IfcPlacementSummary | null = null;
    if (record.ifcType === 'IFCLOCALPLACEMENT') {
      // IFC 标准字段顺序为 PlacementRelTo, RelativePlacement。
      // RelativePlacement 可以为 `$`（表示单位局部变换）；少数导出器
      // 会把 PlacementRelTo 直接写成 AXIS2PLACEMENT，下面的 fallback 兼容它。
      const parentRef = parseRef(record.args[0]);
      const relativeRef = parseRef(record.args[1]);
      const relativeSummary = relativeRef == null ? null : resolve(relativeRef);
      const relative = relativeRef == null
        ? identityMatrix()
        : relativeSummary?.matrix ?? resolveAxisPlacement(relativeRef);
      const parent = resolve(parentRef);
      const parentMatrix = parent?.matrix ?? (parentRef == null ? null : resolveAxisPlacement(parentRef));
      if (relative) {
        const matrix = parentMatrix ? multiplyMatrix(parentMatrix, relative) : relative;
        result = {
          placementRef: `#${id}`,
          matrix,
          position: [matrix[12], matrix[13], matrix[14]],
          ...(unit.name ? { unit: unit.name } : {}),
          ...(unit.scaleToMetres != null ? { unitScaleToMetres: unit.scaleToMetres } : {}),
        };
      }
    }
    resolving.delete(id);
    cache.set(id, result);
    return result;
  };

  const resolveAxisPlacement = (id: number | null): number[] | null => {
    if (id == null) return null;
    const record = detailById.get(id);
    if (!record) return null;
    if (record.ifcType === 'IFCAXIS2PLACEMENT3D') {
      const origin = parsePoint(detailById.get(parseRef(record.args[0]) ?? -1)) ?? [0, 0, 0];
      const z = normalizeVector(parseDirection(detailById.get(parseRef(record.args[1]) ?? -1)) ?? [0, 0, 1], [0, 0, 1]);
      let x = parseDirection(detailById.get(parseRef(record.args[2]) ?? -1)) ?? [1, 0, 0];
      x = normalizeVector(subtract(x, scaleVector(z, dot(z, x))), [1, 0, 0]);
      const y = cross(z, x);
      return matrixFromBasis(x, y, z, origin);
    }
    if (record.ifcType === 'IFCAXIS2PLACEMENT2D') {
      const point = parsePoint(detailById.get(parseRef(record.args[0]) ?? -1)) ?? [0, 0, 0];
      const ref = normalizeVector(parseDirection(detailById.get(parseRef(record.args[1]) ?? -1)) ?? [1, 0, 0], [1, 0, 0]);
      const y: Vec3 = [-ref[1], ref[0], 0];
      return matrixFromBasis(ref, y, [0, 0, 1], point);
    }
    return null;
  };

  return { resolve };
}

function parsePoint(record: RawIfcEntity | undefined): Vec3 | null {
  if (!record || record.ifcType !== 'IFCCARTESIANPOINT') return null;
  const values = record.args[0]?.match(/[-+]?\d*\.?\d+(?:[Ee][-+]?\d+)?/g)?.map(Number) ?? [];
  return values.length >= 3 && values.slice(0, 3).every(Number.isFinite)
    ? [values[0], values[1], values[2]]
    : null;
}

function parseDirection(record: RawIfcEntity | undefined): Vec3 | null {
  if (!record || record.ifcType !== 'IFCDIRECTION') return null;
  const values = record.args[0]?.match(/[-+]?\d*\.?\d+(?:[Ee][-+]?\d+)?/g)?.map(Number) ?? [];
  return values.length >= 3 && values.slice(0, 3).every(Number.isFinite)
    ? [values[0], values[1], values[2]]
    : values.length >= 2 && values.slice(0, 2).every(Number.isFinite)
      ? [values[0], values[1], 0]
      : null;
}

function matrixFromBasis(x: Vec3, y: Vec3, z: Vec3, origin: Vec3): number[] {
  return [
    x[0], x[1], x[2], 0,
    y[0], y[1], y[2], 0,
    z[0], z[1], z[2], 0,
    origin[0], origin[1], origin[2], 1,
  ];
}

function identityMatrix(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiplyMatrix(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
    }
  }
  return out;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scaleVector(a: Vec3, scale: number): Vec3 {
  return [a[0] * scale, a[1] * scale, a[2] * scale];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalizeVector(value: Vec3, fallback: Vec3): Vec3 {
  const length = Math.hypot(value[0], value[1], value[2]);
  return length > 1e-12 ? [value[0] / length, value[1] / length, value[2] / length] : fallback;
}

function isIfcPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === ''
    || normalized === '--'
    || normalized === '-'
    || normalized === '$'
    || normalized === '*'
    || normalized === 'n/a'
    || normalized === 'other'
    || normalized === 'others';
}

function meaningfulIfcString(value: string): string {
  return isIfcPlaceholder(value) ? '' : shortenIfcLabel(value);
}

function meaningfulIfcEnum(value: string | undefined): string {
  if (!value) return '';
  const normalized = value.trim();
  if (!normalized || normalized === '$' || normalized === '*') return '';
  return normalized.replace(/^\.|\.$/g, '');
}

function shortenIfcLabel(value: string, maxLength = 180): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

/**
 * 判断 IFC 记录是否属于可在空间导航中浏览的产品/构件。
 *
 * IFC STEP 中并非所有实体的第一个参数都是 GlobalId：属性值、几何
 * 拓扑和关系记录都可能被错误地当成对象。这里采用“产品白名单 +
 * 空间关系兜底”的策略，避免把数万条资源记录刷进左树，同时保留
 * 没有空间容器的真实产品以便在“未落入空间”分组中检查。
 */
const IFC_PRODUCT_TYPES = new Set([
  'IFCPRODUCT', 'IFCELEMENT', 'IFCELEMENTASSEMBLY', 'IFCELEMENTCOMPONENT',
  'IFCANNOTATION', 'IFCGRID', 'IFCPROXY', 'IFCDISCRETEACCESSORY',
  'IFCFASTENER', 'IFCMECHANICALFASTENER', 'IFCOPENINGELEMENT',
  'IFCOPENINGSTANDARDCASE', 'IFCFEATUREELEMENTSUBTRACTION',
  'IFCPROJECTIONELEMENT', 'IFCFEATUREELEMENTADDITION', 'IFCFEATUREELEMENT',
  'IFCBUILDINGELEMENTPART', 'IFCBUILDINGELEMENTCOMPONENT', 'IFCVIRTUALELEMENT',
  'IFCEXTERNALSPATIALELEMENT', 'IFCEXTERNALSPATIALSTRUCTUREELEMENT',
  'IFCCIVILELEMENT', 'IFCBEAM', 'IFCBEAMSTANDARDCASE', 'IFCWINDOW',
  'IFCWINDOWSTANDARDCASE', 'IFCWALL', 'IFCWALLSTANDARDCASE',
  'IFCWALLELEMENTEDCASE', 'IFCSTAIR', 'IFCSTAIRFLIGHT', 'IFCSLAB',
  'IFCSLABSTANDARDCASE', 'IFCSLABELEMENTEDCASE', 'IFCROOF', 'IFCRAMP',
  'IFCRAMPFLIGHT', 'IFCRAILING', 'IFCPLATE', 'IFCPLATESTANDARDCASE',
  'IFCPILE', 'IFCMEMBER', 'IFCMEMBERSTANDARDCASE', 'IFCFOOTING', 'IFCDOOR',
  'IFCDOORSTANDARDCASE', 'IFCCURTAINWALL', 'IFCCOVERING', 'IFCCOLUMN',
  'IFCCOLUMNSTANDARDCASE', 'IFCCHIMNEY', 'IFCFURNITURE',
  'IFCFURNISHINGELEMENT', 'IFCSYSTEMFURNITUREELEMENT', 'IFCTRANSPORTELEMENT',
  'IFCGEOGRAPHICELEMENT', 'IFCSURFACEFEATURE', 'IFCVOIDINGFEATURE',
  'IFCREINFORCINGBAR', 'IFCREINFORCINGMESH', 'IFCREINFORCINGELEMENT',
  'IFCTENDON', 'IFCTENDONANCHOR', 'IFCDISTRIBUTIONPORT', 'IFCPORT',
]);

const IFC_PRODUCT_PREFIXES = [
  'IFCBUILDINGELEMENT', 'IFCDISTRIBUTION', 'IFCFLOW', 'IFCELECTRIC',
  'IFCENERGY', 'IFCFIRE', 'IFCMECHANICAL', 'IFCSTRUCTURAL', 'IFCPIPE',
  'IFCDUCT', 'IFCCABLE', 'IFCFURNISH', 'IFCLIGHT', 'IFCSANITARY', 'IFCAIR',
  'IFCOUTLET', 'IFCSENSOR', 'IFCALARM', 'IFCACTUATOR', 'IFCCONTROLLER',
  'IFCSWITCH', 'IFCPUMP', 'IFCFAN', 'IFCTANK', 'IFCVALVE', 'IFCCHILLER',
  'IFCBOILER', 'IFCCOMPRESSOR', 'IFCMOTOR', 'IFCGENERATOR', 'IFCFILTER',
  'IFCDAMPER', 'IFCSPACEHEATER', 'IFCHEATEXCHANGER', 'IFCEVAPORATOR',
  'IFCCOIL', 'IFCENGINE', 'IFCTUBEBUNDLE', 'IFCREINFORCING', 'IFCTENDON',
  'IFCGEOGRAPHIC', 'IFCTRANSPORT', 'IFCANNOTATION',
];

function isIfcNavigationObjectType(ifcType: string): boolean {
  if (!ifcType.startsWith('IFC') || ifcType.endsWith('TYPE')) return false;
  if (IFC_PRODUCT_TYPES.has(ifcType)) return true;
  return IFC_PRODUCT_PREFIXES.some((prefix) => ifcType.startsWith(prefix));
}

function isIfcRootLikeType(ifcType: string): boolean {
  return isIfcNavigationObjectType(ifcType);
}

function toTopTypeCounts(counts: Map<string, number>): Record<string, number> | undefined {
  if (counts.size === 0) return undefined;
  return Object.fromEntries(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 24),
  );
}

function decodeIfcString(value: string): string {
  const decodedUnicode = value
    .replace(/\\X2\\([0-9a-fA-F]+)\\X0\\/g, (_match, hex: string) => {
      let output = '';
      for (let i = 0; i + 3 < hex.length; i += 4) output += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      return output;
    })
    .replace(/\\X4\\([0-9a-fA-F]+)\\X0\\/g, (_match, hex: string) => {
      let output = '';
      for (let i = 0; i + 7 < hex.length; i += 8) output += String.fromCodePoint(parseInt(hex.slice(i, i + 8), 16));
      return output;
    });
  // 部分 Bentley/BIMBase IFC 使用 STEP 的单字节 \X\HH 编码保存中文。
  // 按连续字节段解码为 GB18030；浏览器不支持该编码时保留可读的 Latin-1 回退。
  return decodedUnicode.replace(/(?:\\X\\[0-9a-fA-F]{2})+/g, (segment) => {
    const bytes: number[] = [];
    const bytePattern = /\\X\\([0-9a-fA-F]{2})/g;
    let match: RegExpExecArray | null;
    while ((match = bytePattern.exec(segment)) !== null) bytes.push(parseInt(match[1], 16));
    if (bytes.length === 0) return segment;
    try {
      return new TextDecoder('gb18030').decode(new Uint8Array(bytes));
    } catch {
      return bytes.map((byte) => String.fromCharCode(byte)).join('');
    }
  });
}

function collectCbmNodes(root: CbmNode | null): CbmNode[] {
  const result: CbmNode[] = [];
  if (!root) return result;
  const walk = (node: CbmNode): void => {
    result.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return result;
}

/**
 * 计算 CBM 节点可用于定位的有效变换矩阵。
 *
 * 这里不能对所有节点盲目做 parent × local：标准 CBM 的 F4System 矩阵在
 * 真实样本中已经是绝对/父链累积值，重复相乘会把设备移到错误位置。只有
 * `DEV_SUBDEVICE`（路径含 #dev 的虚拟节点）才明确是相对父节点的局部矩阵；
 * 没有自身矩阵的 PARTINDEX 则继承最近的有效父矩阵。这与
 * `modGeometryDiscovery.computeCbmParentTransform` 的几何加载约定一致。
 */
function buildCbmPlacementMap(root: CbmNode | null): Map<string, number[]> {
  const result = new Map<string, number[]>();
  if (!root) return result;

  const walk = (node: CbmNode, parentEffective: number[] | null): void => {
    const own = parseTransformMatrix(node.transformMatrix);
    let effective: number[] | null = null;
    if (node.entityName === 'DEV_SUBDEVICE') {
      // 虚拟子设备的矩阵来自 DEV.SUBDEVICE，仅代表相对父设备的放置。
      effective = own
        ? parentEffective ? multiplyMatrix(parentEffective, own) : own
        : parentEffective;
    } else {
      // F4/PARTINDEX 等真实 CBM 文件：有自己的矩阵时视为导出器给出的
      // 累积值；没有矩阵时（典型 PARTINDEX）沿父链继承。
      effective = own ?? parentEffective;
    }
    if (effective) result.set(node.path, effective);
    for (const child of node.children) walk(child, effective);
  };

  walk(root, null);
  return result;
}

function isAssetNode(node: CbmNode): boolean {
  return node.entityName === 'F4System' || node.entityName === 'PARTINDEX' || node.entityName === 'DEV_SUBDEVICE';
}

function parseTransformMatrix(raw: string): number[] | null {
  if (!raw) return null;
  const values = raw.split(/[,\s]+/).filter(Boolean).map(Number);
  return values.length === 16 && values.every(Number.isFinite) ? values : null;
}

function classifyPlacement(matrix: number[]): SpatialPlacementKind {
  const translated = [12, 13, 14].some((index) => Math.abs(matrix[index]) > 1e-6);
  if (translated) return 'translated';
  const identity = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ].every((value, index) => Math.abs(matrix[index] - value) <= 1e-6);
  return identity ? 'identity' : 'rotated';
}

function matrixToPosition(matrix: number[]): [number, number, number] {
  return [matrix[12], matrix[13], matrix[14]];
}

/**
 * 选择一个能保持位置可读性、又不会在左树生成数千分组的网格尺寸。
 * GIM 变换坐标在当前样本中以毫米为主；尺寸存原始单位，UI 转为米展示。
 */
function choosePlacementGridSize(links: SpatialAssetLink[]): number {
  const candidates = [5000, 10000, 20000, 50000, 100000];
  for (const gridSize of candidates) {
    const keys = new Set<string>();
    for (const link of links) {
      if (!link.position) continue;
      const [x, y, z] = link.position;
      keys.add(`${Math.floor(x / gridSize)}:${Math.floor(y / gridSize)}:${Math.floor(z / gridSize)}`);
      if (keys.size > 128) break;
    }
    if (keys.size <= 128) return gridSize;
  }
  return candidates[candidates.length - 1];
}

function buildPlacementBuckets(links: SpatialAssetLink[]): SpatialPlacementBucket[] {
  if (links.length === 0) return [];
  const gridSize = choosePlacementGridSize(links);
  const buckets = new Map<string, SpatialPlacementBucket>();
  for (const link of links) {
    if (!link.position) continue;
    const [x, y, z] = link.position;
    const xIndex = Math.floor(x / gridSize);
    const yIndex = Math.floor(y / gridSize);
    const zIndex = Math.floor(z / gridSize);
    const key = `spatial:quality:placement:${gridSize}:${xIndex}:${yIndex}:${zIndex}`;
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, {
        key,
        gridSize,
        xIndex,
        yIndex,
        zIndex,
        links: [link],
        minPosition: [x, y, z],
        maxPosition: [x, y, z],
      });
      continue;
    }
    bucket.links.push(link);
    for (let i = 0; i < 3; i++) {
      bucket.minPosition[i] = Math.min(bucket.minPosition[i], link.position[i]);
      bucket.maxPosition[i] = Math.max(bucket.maxPosition[i], link.position[i]);
    }
  }
  return [...buckets.values()].sort((a, b) =>
    a.zIndex - b.zIndex || a.yIndex - b.yIndex || a.xIndex - b.xIndex,
  );
}

interface FileDevRelationIndex {
  byPath: Map<string, FileDevEntry[]>;
  byBasename: Map<string, FileDevEntry[]>;
}

/**
 * 建立 FileDevRelation 的路径索引。
 *
 * 导出器有时写 `foo.cbm`，有时写 `CBM/foo.cbm`，也可能混用反斜杠和大小写。
 * 先按完整规范化路径命中，再按 basename 兜底；basename 冲突时保留全部条目，
 * 由 resolveSourceDesign 合并去重，避免把同名文件静默覆盖。
 */
function buildFileDevRelationIndex(entries: FileDevEntry[]): FileDevRelationIndex {
  const byPath = new Map<string, FileDevEntry[]>();
  const byBasename = new Map<string, FileDevEntry[]>();
  for (const entry of entries) {
    for (const reference of entry.deviceCbms) {
      const keys = cbmReferenceKeys(reference);
      const pathKey = keys[0];
      const baseKey = keys[keys.length - 1];
      if (pathKey) {
        const list = byPath.get(pathKey) ?? [];
        if (!list.includes(entry)) list.push(entry);
        byPath.set(pathKey, list);
      }
      if (baseKey) {
        const list = byBasename.get(baseKey) ?? [];
        if (!list.includes(entry)) list.push(entry);
        byBasename.set(baseKey, list);
      }
    }
  }
  return { byPath, byBasename };
}

function resolveSourceDesign(
  cbmPath: string,
  index: FileDevRelationIndex,
): { names: string[]; files: string[] } {
  const keys = cbmReferenceKeys(cbmPath);
  const exact = keys.flatMap((key) => index.byPath.get(key) ?? []);
  const entries = exact.length > 0
    ? exact
    : (index.byBasename.get(keys[keys.length - 1] ?? '') ?? []);
  const names = uniqueNonEmpty(entries.map((entry) => entry.ifcName));
  // 仅把真正声明为 IFC 的文件作为 sourceDesignFiles；Bentley 的 DGN 名称已经
  // 由 sourceDesignNames 保留，不能在这里伪造一个 `.ifc` 路径。
  const files = uniqueNonEmpty(entries
    .filter((entry) => /.ifc$/i.test(entry.ifcFile))
    .map((entry) => entry.ifcFile));
  return { names, files };
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function collectNodeObjectKeys(
  nodes: IfcSpatialNode[],
  field: 'directObjectKeys' | 'decompositionObjectKeys' | 'hostObjectKeys' | 'boundaryObjectKeys',
): Set<string> {
  const keys = new Set<string>();
  for (const node of nodes) {
    for (const key of node[field]) keys.add(key);
  }
  return keys;
}

/** 返回完整路径、去掉 CBM 根前缀的路径和 basename（全部小写）。 */
function cbmReferenceKeys(value: string): string[] {
  const normalized = normalizePath(value).replace(/^\/+/, '').replace(/^\.\//, '').toLowerCase();
  if (!normalized) return [];
  const withoutRoot = normalized.replace(/^cbm\//, '');
  const basename = withoutRoot.split('/').pop() || withoutRoot;
  return [...new Set([normalized, withoutRoot, basename])];
}

function normalizeGuid(value: string): string {
  return value.trim().replace(/\$+$/, '').toUpperCase();
}

function normalizeModelId(value: string): string {
  const base = normalizePath(value).split('/').pop() || value;
  return base.replace(/\.ifc$/i, '').toLowerCase();
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function spatialKey(modelId: string, expressId: number): string {
  return `ifc:${normalizeModelId(modelId)}:spatial:${expressId}`;
}

function objectKey(modelId: string, expressId: number): string {
  return `ifc:${normalizeModelId(modelId)}:object:${expressId}`;
}
