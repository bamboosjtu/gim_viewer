import type {
  IfcSpatialObject,
  IfcSpatialNode,
  IfcSpatialInheritanceKind,
} from '@gim/gim-sdk/source';
import type { RawIfcEntity } from '@gim/gim-sdk/parser';

interface IfcSpatialRelationFacts {
  relationships: readonly RawIfcEntity[];
  relationshipRefsById: ReadonlyMap<number, readonly number[]>;
  spatialRelationRefsById: ReadonlyMap<
    number,
    { parentId: number | null; relatedIds: readonly number[] }
  >;
  hostObjectIdsByChildId: ReadonlyMap<number, readonly number[]>;
  boundarySpaceIdsByObjectId: ReadonlyMap<number, readonly number[]>;
}

/** Consume the references indexed during the first STEP scan. */
export function indexIfcObjectRelationships(
  scan: IfcSpatialRelationFacts,
  navigationIds: ReadonlySet<number>,
) {
  const relationshipCountByObjectId = new Map<number, number>();
  const relationshipTypesByObjectId = new Map<number, Map<string, number>>();
  const childIdsByObjectId = new Map<number, number[]>();
  const parentIdByObjectId = new Map<number, number>();
  let relationshipRecordCount = 0;
  let relationshipReferenceCount = 0;
  for (const record of scan.relationships) {
    if (record.ifcType.startsWith('IFCREL')) {
      relationshipRecordCount++;
      // Pass 1 已经为每条 IFCREL 解析过引用列表。复用该列表，避免在
      // relationship 阶段再次对所有参数执行 parseRefs；这对包含数千 Related
      // Elements 的关系记录尤其重要，同时保持原有“每个对象引用计数一次”的语义。
      const relationRefs = scan.relationshipRefsById.get(record.expressId) ?? [];
      for (const objectId of relationRefs) {
        if (!navigationIds.has(objectId)) continue;
        relationshipReferenceCount++;
        relationshipCountByObjectId.set(
          objectId,
          (relationshipCountByObjectId.get(objectId) ?? 0) + 1,
        );
        const typeCounts = relationshipTypesByObjectId.get(objectId) ?? new Map<string, number>();
        typeCounts.set(record.ifcType, (typeCounts.get(record.ifcType) ?? 0) + 1);
        relationshipTypesByObjectId.set(objectId, typeCounts);
      }
    }
    if (
      record.ifcType !== 'IFCRELAGGREGATES' &&
      record.ifcType !== 'IFCRELNESTS' &&
      record.ifcType !== 'IFCRELDECOMPOSES'
    )
      continue;
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

  return {
    relationshipCountByObjectId,
    relationshipTypesByObjectId,
    childIdsByObjectId,
    parentIdByObjectId,
    relationshipRecordCount,
    relationshipReferenceCount,
  };
}

export function projectIfcSpatialRelationships(
  scan: IfcSpatialRelationFacts,
  objects: readonly IfcSpatialObject[],
  spatialEntities: readonly IfcSpatialNode[],
  spatialById: ReadonlyMap<number, IfcSpatialNode>,
): void {
  const { hostObjectIdsByChildId, boundarySpaceIdsByObjectId } = scan;
  const objectById = new Map<number, IfcSpatialObject>();
  for (const object of objects) objectById.set(object.expressId, object);
  const objectByKey = new Map(objects.map((object) => [object.key, object]));
  const nodeBySpatialKey = new Map<string, IfcSpatialNode>();
  for (const node of spatialEntities) nodeBySpatialKey.set(node.key, node);

  // 大型 IFC 往往只有一个 IFCREL*SPATIAL*，但 related elements 可达数万条。
  // 不能在逐对象投影时对不断增长的数组调用 includes（会退化为 O(n²)）；
  // 这些 Set 仅在当前模型解析期间存在，最终仍按原有数组接口输出。
  const nodeObjectKeySets = new Map<
    string,
    {
      objectKeys: Set<string>;
      directObjectKeys: Set<string>;
      boundaryObjectKeys: Set<string>;
      decompositionObjectKeys: Set<string>;
      hostObjectKeys: Set<string>;
    }
  >();
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
      const targetKeys =
        resolvedKind === 'host-relation' ? parent.hostObjectKeys : parent.decompositionObjectKeys;
      const targetSet =
        resolvedKind === 'host-relation'
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

  for (const record of scan.relationships) {
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
      record.ifcType === 'IFCRELCONTAINEDINSPATIALSTRUCTURE' ||
      record.ifcType === 'IFCRELREFERENCEDINSPATIALSTRUCTURE'
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
}
