import type { AppState } from '../app/state.js';
import type {
  IfcSpatialNode,
  SpatialAssetLink,
  SpatialPlacementBucket,
  SubstationSpatialIndex,
} from '../gim/ifcSpatialParser.js';
import type { CbmNode } from '../gim/types.js';
import { getNodeDisplayName } from '../shared/displayName.js';
import type { SearchItem } from './searchBox.js';

const SPATIAL_ICONS: Record<string, string> = {
  project: '◎',
  site: '⌖',
  building: '▣',
  storey: '▤',
  space: '□',
  zone: '◫',
  container: '□',
  object: '◇',
  asset: '◆',
  quality: '!',
  model: '▧',
};

/** 单次展开最多生成的行数；其余对象通过“加载更多”继续生成，不能静默丢失。 */
const PAGE_SIZE = 200;

/** 空间视图的搜索索引：容器、IFC 构件和 CBM 资产都可搜索。 */
export function buildSpatialSearchIndex(
  state: AppState,
  index: SubstationSpatialIndex,
): SearchItem[] {
  const items: SearchItem[] = [];
  const cbmByPath = buildCbmPathMap(state.currentCbmTree);
  for (const node of index.nodes) {
    items.push({
      key: node.key,
      title: spatialNodeLabel(node),
      subtitle: `${node.ifcType} · ${node.modelId} · IFC 构件 ${node.objectKeys.length}`
        + (node.geometryStatus === 'represented' ? ' · 有空间几何' : ' · 无空间几何')
        + (node.globalId ? ` · GUID ${node.globalId}` : ''),
    });
  }
  for (const object of index.objects) {
    const cbmLinks = index.linksByIfcObjectKey.get(object.key) ?? [];
    const sourceDesign = collectSourceDesigns(cbmLinks);
    items.push({
      key: object.key,
      title: object.name,
      subtitle: [
        objectSubtitle(object),
        object.modelId,
        object.spatialKey
          ? object.spatialContainment === 'inherited'
            ? object.spatialInheritanceKind === 'host-relation' ? '空间已确认（宿主关系继承）' : '空间已确认（分解继承）'
            : object.spatialContainment === 'boundary' ? '空间边界关联' : '空间已确认'
          : '未落入空间容器',
        cbmLinks.length > 0 ? `CBM 关联 ${cbmLinks.length}` : '无 CBM 关联',
        sourceDesign.names.length > 0 ? `来源图纸 ${sourceDesign.names.slice(0, 3).join('、')}${sourceDesign.names.length > 3 ? '等' : ''}` : undefined,
        sourceDesign.files.length > 0 ? `来源 IFC ${sourceDesign.files.slice(0, 2).join('、')}${sourceDesign.files.length > 2 ? '等' : ''}` : undefined,
      ].filter(Boolean).join(' · '),
    });
  }
  const seenCbm = new Set<string>();
  for (const link of index.links) {
    if (seenCbm.has(link.cbmPath)) continue;
    const node = cbmByPath.get(link.cbmPath);
    if (!node) continue;
    seenCbm.add(link.cbmPath);
    items.push({
      key: node.path,
      title: getNodeDisplayName(node, state.ifcGuidToName),
      subtitle: [
        node.entityName,
        link.confidence === 'inferred' ? '位置推断' : link.confidence === 'unresolved' ? '未关联' : link.spatialKey ? '已确认' : '已关联但无空间容器',
        link.sourceIfcGuid ? `GUID ${link.sourceIfcGuid}` : undefined,
        sourceDesignSubtitle(link),
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }
  return items;
}

/** 将空间视图搜索键解析为 CBM 节点路径；容器本身没有 CBM 选择目标。 */
export function resolveSpatialSearchCbmPath(
  index: SubstationSpatialIndex,
  key: string,
): string | null {
  // 空间容器本身没有 CBM 选择目标；不能因为容器下有设备就误选第一台设备。
  if (index.nodeByKey.has(key)) return null;
  const object = index.objectByKey.get(key);
  if (object) {
    return index.linksByIfcObjectKey.get(object.key)?.[0]?.cbmPath ?? null;
  }
  return index.linksByCbmPath.get(key)?.cbmPath ?? null;
}

/**
 * 搜索命中后展开从空间根到目标的祖先链。
 *
 * 空间树按节点懒加载，单纯给 row 加 selected 会让用户看不到命中项；
 * 这里只展开必要的祖先，不展开同级分支，避免搜索一次生成数千行。
 */
export function revealSpatialSearchTarget(index: SubstationSpatialIndex, key: string): string | null {
  let spatialKey: string | null = null;
  let childGroup: 'objects' | 'assets' | null = null;
  let qualityGroup: string | null = null;
  let targetModelId: string | null = null;

  const spatialNode = index.nodeByKey.get(key);
  if (spatialNode) {
    spatialKey = spatialNode.key;
    targetModelId = spatialNode.modelId;
  } else {
    const object = index.objectByKey.get(key);
    if (object) {
      spatialKey = object.spatialKey;
      targetModelId = object.modelId;
      childGroup = spatialKey ? 'objects' : null;
      if (!spatialKey) {
        const linked = index.linksByIfcObjectKey.get(object.key) ?? [];
        if (linked.some((link) => link.confidence === 'confirmed' && !link.spatialKey)) {
          qualityGroup = 'spatial:quality:no-container';
        } else {
          qualityGroup = 'spatial:quality:ifc-uncontained';
        }
      }
    } else {
      const link = index.linksByCbmPath.get(key);
      if (link?.spatialKey) {
        spatialKey = link.spatialKey;
        targetModelId = index.nodeByKey.get(link.spatialKey)?.modelId ?? null;
        childGroup = 'assets';
      } else if (link?.confidence === 'inferred') {
        qualityGroup = resolvePlacementQualityGroup(index, link);
      } else if (link?.confidence === 'unresolved') {
        qualityGroup = 'spatial:quality:unresolved';
      } else if (link?.confidence === 'confirmed') {
        qualityGroup = 'spatial:quality:no-container';
      }
    }
  }

  if (spatialKey) {
    // Generic Project/Site/Building 包装层不会生成 DOM 行，祖先链只展开
    // 实际可见节点；模型分组展开后会同步把隐藏层的后代提升出来。
    const chain = visibleSpatialNodeChain(index, spatialKey).map((node) => node.key);
    chain.push('spatial:project-root');
    chain.reverse();
    // 多模型空间树在 project-root 下增加了“IFC 模型”与模型来源行；
    // 先展开这两级，懒加载目标的祖先链才真正可见。
    ensureSpatialRowExpanded('spatial:models');
    if (targetModelId) ensureSpatialRowExpanded(spatialModelGroupKey(targetModelId));
    for (const ancestorKey of chain) ensureSpatialRowExpanded(ancestorKey);
    if (childGroup) {
      const ownerKey = spatialChildGroupOwnerKey(index, spatialKey);
      ensureSpatialRowExpanded(`${ownerKey}:${childGroup}`);
    }
  }
  if (qualityGroup) {
    ensureSpatialRowExpanded('spatial:quality:status');
    ensureSpatialRowExpanded(qualityGroup);
  }
  return spatialKey
    ? childGroup ? `${spatialChildGroupOwnerKey(index, spatialKey)}:${childGroup}`
      : visibleSpatialNode(index, spatialKey)?.key ?? null
    : qualityGroup;
}

function resolvePlacementQualityGroup(index: SubstationSpatialIndex, link: SpatialAssetLink): string {
  ensureSpatialRowExpanded('spatial:quality:status');
  if (link.placementKind === 'translated') {
    const bucket = index.placementGroups.find((item) => item.links.includes(link));
    if (bucket) {
      ensureSpatialRowExpanded('spatial:quality:placement');
      ensureSpatialRowExpanded('spatial:quality:placement:grid');
      ensureSpatialRowExpanded(bucket.key);
      return bucket.key;
    }
  }
  ensureSpatialRowExpanded('spatial:quality:placement');
  return 'spatial:quality:placement:origin';
}

/** 搜索命中分页后的对象时，自动点击对应分组的“加载更多”直到目标行可见。 */
export function loadSpatialSearchTargetPage(containerKey: string | null, targetKey: string): void {
  if (!containerKey) return;
  const targetSelector = `[data-node-path="${escapeAttribute(containerKey)}"]`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (document.querySelector(`[data-node-path="${escapeAttribute(targetKey)}"]`)) return;
    const more = document.querySelector<HTMLElement>(
      `.spatial-load-more-row[data-pagination-key="${escapeAttribute(containerKey)}"]`,
    );
    if (!more) return;
    // 目标分组已展开但仍没有目标行，继续消费该分组的分页行。
    // 读取一次容器选择器，避免未来多个树实例时误点击其他分组。
    if (!document.querySelector(targetSelector)) return;
    more.click();
  }
}

/** 渲染变电空间主树。所有 IFC/CBM 事实从同一个 SubstationSpatialIndex 投影。 */
export function renderSubstationSpatialTree(
  state: AppState,
  index: SubstationSpatialIndex,
  parentEl: HTMLElement,
  onNodeClick: (node: CbmNode) => void,
  onSpatialNodeClick?: (node: IfcSpatialNode) => void,
  onSpatialObjectClick?: (object: SubstationSpatialIndex['objects'][number]) => void,
): void {
  const nodeByKey = index.nodeByKey;
  const objectByKey = index.objectByKey;
  const cbmByPath = buildCbmPathMap(state.currentCbmTree);
  const objectCountMemo = new Map<string, number>();
  const linkCountMemo = new Map<string, number>();
  const rootChildren = index.rootNodeKeys
    .map((key) => nodeByKey.get(key))
    .filter((node): node is IfcSpatialNode => !!node);
  const rootsByModel = new Map<string, IfcSpatialNode[]>();
  for (const node of rootChildren) {
    const roots = rootsByModel.get(node.modelId) ?? [];
    roots.push(node);
    rootsByModel.set(node.modelId, roots);
  }
  // 即使某个 IFC 解析失败或没有 Project/Site 根，也保留来源模型行，
  // 让首屏的“IFC 空间模型”始终是稳定的能力入口。
  for (const model of index.models) {
    if (!rootsByModel.has(model.modelId)) rootsByModel.set(model.modelId, []);
  }

  const modelCount = index.models.length;
  const containedCount = index.models.reduce((sum, model) => sum + (model.spatialObjectCount ?? model.containedObjectCount), 0);
  const uncontainedIfcObjectCount = index.coverage.uncontainedIfcObjects;
  const resourceCount = index.models.reduce((sum, model) => sum + model.resourceCount, 0);
  const summary = `IFC ${modelCount} 个模型 · 空间 ${index.nodes.length} · 构件 ${containedCount}`
    + (uncontainedIfcObjectCount > 0 ? ` · 未落位构件 ${uncontainedIfcObjectCount}` : '')
    + (resourceCount > 0 ? ` · 模型资源 ${resourceCount}` : '');
  renderSyntheticNode(
    parentEl,
    'spatial:project-root',
    state.projectName || '变电工程',
    SPATIAL_ICONS.project,
    `${summary}${index.coverage.hasSpaces ? ' · 含空间区域' : ''}`,
    true,
    (childrenEl) => {
      renderSyntheticNode(
        childrenEl,
        'spatial:models',
        `IFC 空间模型 · ${rootsByModel.size}`,
        SPATIAL_ICONS.model,
        '按来源模型分组；展开模型后查看站区 / 建筑 / 楼层，避免多个 Default 节点混在同一层级',
        rootsByModel.size > 0,
        (modelsEl) => {
          for (const [modelId, roots] of rootsByModel) renderSpatialModelGroup(modelId, roots, modelsEl);
        },
      );

      const inferred = index.links.filter((link) => link.confidence === 'inferred');
      const noContainer = index.links.filter((link) => link.confidence === 'confirmed' && !link.spatialKey);
      const unresolved = index.links.filter((link) => link.confidence === 'unresolved');
      const uncontainedObjects = index.objects.filter((object) => !object.spatialKey);
      const qualityCount = inferred.length + noContainer.length + unresolved.length + uncontainedObjects.length;
      if (qualityCount > 0) {
        renderSyntheticNode(
          childrenEl,
          'spatial:quality:status',
          `关联状态 · ${qualityCount}`,
          SPATIAL_ICONS.quality,
          '空间确认、位置推断、未关联和未落位对象统一收拢；不把质量问题伪装成空间区域',
          true,
          (statusEl) => {
            if (inferred.length > 0) renderPlacementQualityGroup(statusEl, inferred);
            if (noContainer.length > 0) {
              renderQualityGroup(
                statusEl,
                'spatial:quality:no-container',
                `已关联 IFC · 无空间容器 · ${noContainer.length}`,
                'IFC GUID 已命中，但 IFC 未提供空间包含关系',
                noContainer,
                'confirmed',
              );
            }
            if (unresolved.length > 0) {
              renderQualityGroup(
                statusEl,
                'spatial:quality:unresolved',
                `未关联 IFC 对象 · ${unresolved.length}`,
                '保留原始 CBM/DEV 路径与缺失原因',
                unresolved,
                'unresolved',
              );
            }
            if (uncontainedObjects.length > 0) {
              renderIfcObjectQualityGroup(
                statusEl,
                'spatial:quality:ifc-uncontained',
                `未落入空间的 IFC 构件 · ${uncontainedObjects.length}`,
                'IFC 产品存在，但没有 IFC 空间包含关系；保留模型、类型和 GUID',
                uncontainedObjects,
              );
            }
          },
        );
      }
      if (resourceCount > 0) renderResourceGroup(childrenEl);
      for (const model of index.models.filter((item) => item.parseError)) {
        renderLeafRow(
          childrenEl,
          `spatial:quality:parse:${model.modelId}`,
          `IFC 模型未解析 · ${model.modelId}`,
          `${model.parseError}`,
          SPATIAL_ICONS.quality,
        );
      }
    },
    undefined,
    false,
    `${modelCount} 个模型`,
  );

  function renderSpatialNode(
    node: IfcSpatialNode,
    host: HTMLElement,
    visited = new Set<string>(),
  ): void {
    if (visited.has(node.key)) return;
    // Project/Site/Building 等只是 IFC 导出的包装层时，不占用导航行；
    // 其有业务意义的后代和直接构件提升到当前模型分组下。
    if (isGenericSpatialNode(node)) {
      renderFlattenedSpatialNode(node, host, visited);
      return;
    }
    visited.add(node.key);
    renderVisibleSpatialNode(node, host, visited);
  }

  function renderVisibleSpatialNode(
    node: IfcSpatialNode,
    host: HTMLElement,
    visited: Set<string>,
  ): void {
    const links = index.linksBySpatialKey.get(node.key) ?? [];
    const directCount = node.directObjectKeys.length;
    const boundaryCount = node.boundaryObjectKeys.length;
    // 继承类别按节点级关系集合读取。对象级 spatialContainment 只保留主空间，
    // 无法表达“同一构件在另一个空间通过宿主/分解关系出现”的多空间情况。
    const decompositionInheritedCount = node.decompositionObjectKeys.length;
    const hostInheritedCount = node.hostObjectKeys.length;
    const inheritedCount = decompositionInheritedCount + hostInheritedCount;
    const objectCount = descendantObjectCount(node.key);
    const linkCount = descendantLinkCount(node.key);
    const countLabel = `IFC 构件 ${objectCount} · CBM 关联 ${linkCount}`
      + (directCount > 0 || boundaryCount > 0 || inheritedCount > 0
        ? ` · 直接 ${directCount} / 空间边界 ${boundaryCount} / 分解继承 ${decompositionInheritedCount} / 宿主继承 ${hostInheritedCount}`
        : '')
      + (node.elevation != null ? ` · 标高 ${formatNumber(node.elevation)}` : '');
    const geometryLabel = node.geometryStatus === 'represented' ? '空间几何已提供' : '空间几何未提供';
    renderSyntheticNode(
      host,
      node.key,
      spatialNodeLabel(node),
      SPATIAL_ICONS[node.kind] || SPATIAL_ICONS.container,
      `${node.ifcType} · ${node.modelId} · ${countLabel} · ${geometryLabel}`
        + (node.kind === 'space' && node.objectKeys.length === 0 ? ' · 未关联构件' : ''),
      node.childKeys.length > 0 || node.objectKeys.length > 0 || links.length > 0,
      (childrenEl) => {
        for (const childKey of node.childKeys) {
          const child = nodeByKey.get(childKey);
          if (child) renderSpatialNode(child, childrenEl, visited);
        }
        renderSpatialObjectGroup(childrenEl, node, directCount, boundaryCount, decompositionInheritedCount, hostInheritedCount);
        renderSpatialAssetGroup(childrenEl, node, links);
      },
      () => onSpatialNodeClick?.(node),
      shouldAutoExpandSpatialNode(node),
      objectCount > 0 ? `对象 ${objectCount}` : '',
    );
  }

  /**
   * 隐藏包装节点的扁平化投影。节点本身仍保留在索引和搜索父链中，
   * 这里只是不生成“项目编号 / Default / IFCBUILDING #…”这些无业务信息的行。
   */
  function renderFlattenedSpatialNode(
    node: IfcSpatialNode,
    host: HTMLElement,
    visited = new Set<string>(),
  ): void {
    if (visited.has(node.key)) return;
    visited.add(node.key);
    for (const childKey of node.childKeys) {
      const child = nodeByKey.get(childKey);
      if (!child) continue;
      renderSpatialNode(child, host, visited);
    }
    const links = index.linksBySpatialKey.get(node.key) ?? [];
    if (node.objectKeys.length > 0) {
      renderSpatialObjectGroup(
        host,
        node,
        node.directObjectKeys.length,
        node.boundaryObjectKeys.length,
        node.decompositionObjectKeys.length,
        node.hostObjectKeys.length,
      );
    }
    if (links.length > 0) {
      renderSpatialAssetGroup(host, node, links);
    }
    // 空的技术包装节点没有可供用户操作的事实，保持隐藏即可。
  }

  function renderSpatialObjectGroup(
    host: HTMLElement,
    node: IfcSpatialNode,
    directCount: number,
    boundaryCount: number,
    decompositionInheritedCount: number,
    hostInheritedCount: number,
  ): void {
    if (node.objectKeys.length === 0) return;
    renderSyntheticNode(
      host,
      `${node.key}:objects`,
      `IFC 构件 · ${node.objectKeys.length}`,
      SPATIAL_ICONS.object,
      `直接包含 ${directCount} · 空间边界 ${boundaryCount} · 分解继承 ${decompositionInheritedCount} · 宿主关系继承 ${hostInheritedCount}；未把低层资源记录伪装成构件`,
      true,
      (objectsEl) => {
        renderPagedRows(objectsEl, node.objectKeys, `${node.key}:objects`, (key, rowsEl) => {
          const object = objectByKey.get(key);
          if (!object) return;
          const link = index.linksByIfcObjectKey.get(object.key);
          const cbm = link?.length === 1 ? cbmByPath.get(link[0].cbmPath) : undefined;
          renderLeafRow(
            rowsEl,
            object.key,
            object.name,
            `${objectSubtitle(object)}`
              + (cbm ? ` · ${getNodeDisplayName(cbm, state.ifcGuidToName)}` : '')
              + (link && link.length > 1 ? ` · CBM 关联 ${link.length}` : '')
              + sourceDesignSuffixes(link ?? []),
            SPATIAL_ICONS.object,
            onSpatialObjectClick
              ? () => onSpatialObjectClick(object)
              : cbm ? () => onNodeClick(cbm) : undefined,
          );
        });
      },
    );
  }

  function renderSpatialAssetGroup(
    host: HTMLElement,
    node: IfcSpatialNode,
    links: SpatialAssetLink[],
  ): void {
    if (links.length === 0) return;
    renderSyntheticNode(
      host,
      `${node.key}:assets`,
      `关联设备 · ${links.length}`,
      SPATIAL_ICONS.asset,
      'CBM IFCGUID 命中并落入此空间',
      true,
      (assetsEl) => {
        renderPagedRows(assetsEl, links, `${node.key}:assets`, (link, rowsEl) => {
          const cbm = cbmByPath.get(link.cbmPath);
          if (!cbm) return;
          renderLeafRow(
            rowsEl,
            link.cbmPath,
            getNodeDisplayName(cbm, state.ifcGuidToName),
            `${cbm.entityName} · ${link.sourceIfcGuid || '无 GUID'} · 已确认${sourceDesignSuffix(link)}`,
            SPATIAL_ICONS.asset,
            () => onNodeClick(cbm),
          );
        });
      },
    );
  }

  /** 多 IFC 模型通常各自带一个 Default Project/Site；先按来源模型分组，
   * 让左树首屏呈现可辨认的专业/模型名称，同时保留 IFC 原始空间层级。 */
  function renderSpatialModelGroup(modelId: string, roots: IfcSpatialNode[], host: HTMLElement): void {
    const model = index.models.find((item) => item.modelId === modelId);
    const rootObjects = roots.reduce((sum, root) => sum + descendantObjectCount(root.key), 0);
    const rootLinks = roots.reduce((sum, root) => sum + descendantLinkCount(root.key), 0);
    const summary = `IFC 模型 · 空间根 ${roots.length} · 构件 ${model?.spatialObjectCount ?? model?.containedObjectCount ?? rootObjects}`
      + (rootLinks > 0 ? ` · CBM 关联 ${rootLinks}` : '')
      + (model?.propertyValueCount ? ` · 属性 ${model.propertyValueCount}` : '')
      + (model?.resourceCount ? ` · 资源 ${model.resourceCount}` : '');
    renderSyntheticNode(
      host,
      spatialModelGroupKey(modelId),
      modelId || '未命名 IFC 模型',
      SPATIAL_ICONS.model,
      summary,
      roots.length > 0,
      (childrenEl) => {
        // 一个 IFC 文件偶尔会把 Project/Site/Building 都暴露为并列根；
        // 共用去重集合，扁平化后不会重复绘制同一楼层/空间。
        const visited = new Set<string>();
        for (const root of roots) renderSpatialNode(root, childrenEl, visited);
      },
    );
  }

  function renderQualityGroup(
    host: HTMLElement,
    key: string,
    label: string,
    subtitle: string,
    links: SpatialAssetLink[],
    confidence: 'inferred' | 'unresolved' | 'confirmed',
  ): void {
    renderSyntheticNode(host, key, label, SPATIAL_ICONS.quality, subtitle, true, (childrenEl) => {
      renderPagedRows(childrenEl, links, key, (link, rowsEl) => {
        const cbm = cbmByPath.get(link.cbmPath);
        if (!cbm) return;
        const position = link.position ? ` · 坐标 ${link.position.map((value) => formatNumber(value)).join(', ')}` : '';
        const reason = link.unlocatedReason ? ` · ${unlocatedReasonLabel(link.unlocatedReason)}` : '';
        const status = confidence === 'inferred'
          ? '位置推断'
          : confidence === 'confirmed'
            ? 'IFC 已关联但无空间容器'
            : '未关联';
        renderLeafRow(
          rowsEl,
          link.cbmPath,
          getNodeDisplayName(cbm, state.ifcGuidToName),
          `${cbm.entityName} · ${status}${reason}${position}${sourceDesignSuffix(link)}`,
          SPATIAL_ICONS.asset,
          () => onNodeClick(cbm),
        );
      });
    });
  }

  /**
   * 坐标推断资产的第二级位置投影。它只使用 CBM/DEV 变换矩阵，
   * 不修改 link.spatialKey，因此不会把推断误标为 IFC 包含关系。
   */
  function renderPlacementQualityGroup(host: HTMLElement, inferred: SpatialAssetLink[]): void {
    const translated = inferred.filter((link) => link.placementKind === 'translated' && link.position);
    const noTranslation = inferred.filter((link) => link.placementKind !== 'translated');
    const gridSize = index.placementGroups[0]?.gridSize ?? 10000;
    renderSyntheticNode(
      host,
      'spatial:quality:placement',
      `坐标定位对象 · ${inferred.length}`,
      SPATIAL_ICONS.quality,
      `仅有 CBM/DEV 变换矩阵，未确认 IFC 空间；${translated.length} 个按 ${formatMeters(gridSize)} 网格分组`,
      true,
      (childrenEl) => {
        if (translated.length > 0) {
          renderSyntheticNode(
            childrenEl,
            'spatial:quality:placement:grid',
            `按坐标网格 · ${translated.length} 个 · ${formatMeters(gridSize)} 网格`,
            SPATIAL_ICONS.container,
            '网格仅用于定位检索，不代表 IFC 空间容器',
            true,
            (gridEl) => {
              for (const bucket of index.placementGroups) renderPlacementBucket(bucket, gridEl);
            },
          );
        }
        if (noTranslation.length > 0) {
          renderQualityGroup(
            childrenEl,
            'spatial:quality:placement:origin',
            `无平移坐标 · ${noTranslation.length}`,
            '矩阵为单位矩阵或仅旋转，不能从矩阵推断平面位置',
            noTranslation,
            'inferred',
          );
        }
      },
    );
  }

  function renderPlacementBucket(bucket: SpatialPlacementBucket, host: HTMLElement): void {
    const label = `坐标网格 · ${bucket.links.length}`;
    renderSyntheticNode(
      host,
      bucket.key,
      label,
      SPATIAL_ICONS.container,
      `坐标范围 ${formatPositionRange(bucket.minPosition, bucket.maxPosition)}；位置推断`,
      true,
      (bucketEl) => {
        renderPagedRows(bucketEl, bucket.links, bucket.key, (link, rowsEl) => {
          const cbm = cbmByPath.get(link.cbmPath);
          if (!cbm) return;
          const position = link.position ? ` · 坐标 ${link.position.map((value) => formatNumber(value)).join(', ')}` : '';
          renderLeafRow(
            rowsEl,
            link.cbmPath,
            getNodeDisplayName(cbm, state.ifcGuidToName),
            `${cbm.entityName} · 位置推断${position}${sourceDesignSuffix(link)}`,
            SPATIAL_ICONS.asset,
            () => onNodeClick(cbm),
          );
        });
      },
    );
  }

  function renderIfcObjectQualityGroup(
    host: HTMLElement,
    key: string,
    label: string,
    subtitle: string,
    objects: SubstationSpatialIndex['objects'],
  ): void {
    renderSyntheticNode(host, key, label, SPATIAL_ICONS.quality, subtitle, true, (childrenEl) => {
      renderPagedRows(childrenEl, objects, key, (object, rowsEl) => {
        const links = index.linksByIfcObjectKey.get(object.key) ?? [];
        const cbm = links.length === 1 ? cbmByPath.get(links[0].cbmPath) : undefined;
        const cbmLabel = cbm
          ? ` · ${getNodeDisplayName(cbm, state.ifcGuidToName)}`
          : links.length > 1 ? ` · CBM 关联 ${links.length}` : '';
        renderLeafRow(
          rowsEl,
          object.key,
          object.name,
          `${objectSubtitle(object)}${cbmLabel}${sourceDesignSuffixes(links)}`,
          SPATIAL_ICONS.object,
          onSpatialObjectClick
            ? () => onSpatialObjectClick(object)
            : cbm ? () => onNodeClick(cbm) : undefined,
        );
      });
    });
  }

  /** 模型资源不展开为对象行，但用模型/类型统计明确说明还有哪些 IFC 信息。 */
  function renderResourceGroup(host: HTMLElement): void {
    const resourceCount = index.models.reduce((sum, model) => sum + model.resourceCount, 0);
    renderSyntheticNode(
      host,
      'spatial:quality:resources',
      `模型资源 · ${resourceCount}`,
      SPATIAL_ICONS.container,
      '属性集、关系、几何拓扑等原始记录未作为构件行；选择构件后在属性面板查看关联信息',
      true,
      (childrenEl) => {
        for (const model of index.models) {
          if (model.resourceCount <= 0) continue;
          const typeSummary = Object.entries(model.resourceTypeCounts ?? {})
            .slice(0, 6)
            .map(([type, count]) => `${type} ${count}`)
            .join(' · ');
          renderLeafRow(
            childrenEl,
            `spatial:resource:${model.modelId}`,
            model.modelId,
            `资源 ${model.resourceCount}${typeSummary ? ` · ${typeSummary}` : ''}`,
            SPATIAL_ICONS.container,
          );
        }
      },
    );
  }

  function renderPagedRows<T>(
    host: HTMLElement,
    items: T[],
    key: string,
    renderItem: (item: T, rowsEl: HTMLElement) => void,
  ): void {
    let offset = 0;
    let moreRow: HTMLElement | null = null;
    const renderPage = (): void => {
      const end = Math.min(offset + PAGE_SIZE, items.length);
      for (; offset < end; offset++) renderItem(items[offset], host);
      moreRow?.remove();
      moreRow = null;
      if (offset < items.length) {
        const remaining = items.length - offset;
        moreRow = renderLeafRow(
          host,
          `${key}:more:${offset}`,
          `加载更多（剩余 ${remaining} 个）`,
          `已显示 ${offset} / ${items.length}；继续展开不会丢失对象`,
          '…',
          () => renderPage(),
        );
        moreRow.dataset.paginationKey = key;
        moreRow.classList.add('spatial-load-more-row');
      }
    };
    renderPage();
  }

  function descendantObjectCount(key: string, active = new Set<string>()): number {
    const cached = objectCountMemo.get(key);
    if (cached != null) return cached;
    if (active.has(key)) return 0;
    const node = nodeByKey.get(key);
    if (!node) return 0;
    active.add(key);
    let count = node.objectKeys.length;
    for (const childKey of node.childKeys) count += descendantObjectCount(childKey, active);
    active.delete(key);
    objectCountMemo.set(key, count);
    return count;
  }

  function descendantLinkCount(key: string, active = new Set<string>()): number {
    const cached = linkCountMemo.get(key);
    if (cached != null) return cached;
    if (active.has(key)) return 0;
    const node = nodeByKey.get(key);
    if (!node) return 0;
    active.add(key);
    let count = (index.linksBySpatialKey.get(key) ?? []).length;
    for (const childKey of node.childKeys) count += descendantLinkCount(childKey, active);
    active.delete(key);
    linkCountMemo.set(key, count);
    return count;
  }
}

function renderSyntheticNode(
  parentEl: HTMLElement,
  key: string,
  labelText: string,
  iconText: string,
  subtitle: string,
  hasChildren: boolean,
  renderChildren: (childrenEl: HTMLElement) => void,
  onSelect?: () => void,
  initiallyExpanded = false,
  badgeText = '',
): void {
  const nodeEl = document.createElement('div');
  nodeEl.className = 'tree-node spatial-tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row spatial-tree-row';
  row.dataset.nodePath = key;
  row.setAttribute('role', 'treeitem');
  row.tabIndex = 0;
  const toggle = document.createElement('span');
  toggle.className = `tree-toggle ${hasChildren ? '' : 'leaf'}`;
  toggle.textContent = '▶';
  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = iconText;
  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = labelText || '未命名空间';
  label.title = subtitle;
  row.title = [labelText, subtitle].filter(Boolean).join(' · ');
  row.append(toggle, icon, label);
  // 空间树同样只保留短计数，IFC 类型、模型 ID、坐标范围等详情通过 tooltip/属性查看。
  if (badgeText.trim()) {
    const badge = document.createElement('span');
    badge.className = 'spatial-badge';
    badge.textContent = badgeText;
    badge.title = subtitle;
    badge.setAttribute('aria-label', subtitle);
    row.appendChild(badge);
  }
  const childrenEl = document.createElement('div');
  childrenEl.className = 'tree-children';
  nodeEl.append(row, childrenEl);

  let expanded = false;
  let rendered = false;
  if (hasChildren) row.setAttribute('aria-expanded', 'false');
  const setExpanded = (next: boolean): void => {
    if (!hasChildren) return;
    expanded = next;
    toggle.classList.toggle('expanded', expanded);
    childrenEl.classList.toggle('expanded', expanded);
    row.setAttribute('aria-expanded', String(expanded));
    if (expanded && !rendered) {
      renderChildren(childrenEl);
      rendered = true;
    }
  };
  row.addEventListener('click', () => {
    document.querySelectorAll('.tree-row.selected').forEach((item) => item.classList.remove('selected'));
    row.classList.add('selected');
    onSelect?.();
    setExpanded(!expanded);
  });
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      row.click();
    } else if (event.key === 'ArrowRight' && hasChildren && !expanded) {
      event.preventDefault();
      setExpanded(true);
    } else if (event.key === 'ArrowLeft' && hasChildren && expanded) {
      event.preventDefault();
      setExpanded(false);
    }
  });
  parentEl.appendChild(nodeEl);

  // 空间总览根默认展开，用户可以立即看到站区/建筑/楼层，而不用点击一次空根节点。
  if (key === 'spatial:project-root' || initiallyExpanded) setExpanded(true);
}

function renderLeafRow(
  parentEl: HTMLElement,
  key: string,
  labelText: string,
  subtitle: string,
  iconText: string,
  onClick?: () => void,
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'tree-row spatial-tree-row spatial-leaf-row';
  row.dataset.nodePath = key;
  row.setAttribute('role', 'treeitem');
  row.tabIndex = 0;
  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle leaf';
  toggle.textContent = '▶';
  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = iconText;
  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = labelText || '未命名对象';
  label.title = subtitle;
  row.append(toggle, icon, label);
  row.addEventListener('click', () => {
    document.querySelectorAll('.tree-row.selected').forEach((item) => item.classList.remove('selected'));
    row.classList.add('selected');
    onClick?.();
  });
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      row.click();
    }
  });
  parentEl.appendChild(row);
  return row;
}

/** 空间来源模型和容器默认折叠；首屏只展开工程根，避免大型 IFC 首开生成大量行。 */
function shouldAutoExpandSpatialNode(node: IfcSpatialNode): boolean {
  void node;
  return false;
}

function buildCbmPathMap(root: CbmNode | null): Map<string, CbmNode> {
  const map = new Map<string, CbmNode>();
  if (!root) return map;
  const walk = (node: CbmNode): void => {
    map.set(node.path, node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return map;
}

function spatialNodeLabel(node: IfcSpatialNode): string {
  return node.name || '未命名空间';
}

/**
 * 判断 IFC 空间节点是否只是导出器生成的通用包装层。
 * 这些名称对用户没有定位价值（且不同模型会重复），因此从主树扁平化；
 * 原始节点仍留在索引、属性和来源证据中。
 */
function isGenericSpatialNode(node: IfcSpatialNode): boolean {
  const name = (node.name || '').trim().replace(/\s+/g, ' ');
  if (!name) return true;
  if (/^(?:项目编号|项目|工程|默认|缺省|站区|建筑|楼层)$/i.test(name)) return true;
  if (/^default(?:\s+(?:project|site|building|storey))?$/i.test(name)) return true;
  if (/^(?:project|site|building|storey)$/i.test(name)) return true;
  if (/^ifc(?:project|site|building|buildingstorey)\s*#?\d*$/i.test(name)) return true;
  // 某些导出器用 IFC 类型名直接填 Name，兼容带下划线/空格的写法。
  if (/^ifc(?:project|site|building|buildingstorey)$/i.test(name.replace(/[\s_-]+/g, ''))) return true;
  return false;
}

/** 取得从模型分组到目标的可见空间节点链，过滤通用包装层。 */
function visibleSpatialNodeChain(index: SubstationSpatialIndex, spatialKey: string): IfcSpatialNode[] {
  const result: IfcSpatialNode[] = [];
  const seen = new Set<string>();
  let current = index.nodeByKey.get(spatialKey);
  while (current && !seen.has(current.key)) {
    seen.add(current.key);
    if (!isGenericSpatialNode(current)) result.push(current);
    current = current.parentKey ? index.nodeByKey.get(current.parentKey) : undefined;
  }
  return result.reverse();
}

function visibleSpatialNode(index: SubstationSpatialIndex, spatialKey: string): IfcSpatialNode | null {
  const chain = visibleSpatialNodeChain(index, spatialKey);
  return chain.length > 0 ? chain[chain.length - 1] : null;
}

/**
 * 对象/关联设备分组属于最近的可见空间节点；若对象直接挂在隐藏包装层，
 * 则使用原始包装节点 key，因为扁平化渲染会在该 key 下生成对象组。
 */
function spatialChildGroupOwnerKey(index: SubstationSpatialIndex, spatialKey: string): string {
  const node = index.nodeByKey.get(spatialKey);
  if (!node) return spatialKey;
  if (isGenericSpatialNode(node) && node.objectKeys.length > 0) return node.key;
  return visibleSpatialNode(index, spatialKey)?.key ?? node.key;
}

function spatialModelGroupKey(modelId: string): string {
  return `spatial:model:${encodeURIComponent(modelId)}`;
}

function ensureSpatialRowExpanded(key: string): void {
  const escaped = typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(key)
    : key.replace(/"/g, '\\"');
  const row = document.querySelector<HTMLElement>(`.tree-row[data-node-path="${escaped}"]`);
  if (!row) return;
  const children = row.nextElementSibling as HTMLElement | null;
  if (children && !children.classList.contains('expanded')) row.click();
}

function escapeAttribute(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(value)
    : value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function formatMeters(value: number): string {
  const meters = value / 1000;
  return `${formatNumber(meters)}m`;
}

function formatPositionRange(min: [number, number, number], max: [number, number, number]): string {
  return `${min.map((value) => formatNumber(value)).join(', ')} ~ ${max.map((value) => formatNumber(value)).join(', ')}`;
}

function objectSubtitle(object: SubstationSpatialIndex['objects'][number]): string {
  const parts = [`${object.ifcType} · #${object.expressId}`];
  if (object.globalId) parts.push(`GUID ${object.globalId}`);
  if (object.objectType) parts.push(`对象类型 ${object.objectType}`);
  if (object.predefinedType) parts.push(object.predefinedType);
  if (object.tag) parts.push(`Tag ${object.tag}`);
  if (object.description) parts.push(object.description);
  if (object.propertySetNames && object.propertySetNames.length > 0) {
    parts.push(`属性集 ${object.propertySetNames.length}`);
  }
  const propertyCount = (object.propertySets ?? [])
    .filter((group) => group.kind === 'property')
    .reduce((sum, group) => sum + group.values.length, 0);
  const quantityCount = (object.propertySets ?? [])
    .filter((group) => group.kind === 'quantity')
    .reduce((sum, group) => sum + group.values.length, 0);
  if (propertyCount > 0) parts.push(`属性 ${propertyCount}`);
  if (quantityCount > 0) parts.push(`工程量 ${quantityCount}`);
  if (object.materials && object.materials.length > 0) parts.push(`材质 ${object.materials.length}`);
  parts.push(object.geometryStatus === 'represented' ? '有 IFC 形状' : '无 IFC 形状');
  if (object.spatialContainment === 'inherited') {
    parts.push(object.spatialInheritanceKind === 'host-relation' ? '空间归属：宿主关系继承' : '空间归属：分解继承');
  } else if (object.spatialContainment === 'boundary') {
    parts.push('空间归属：空间边界关联');
  }
  if (object.placement) {
    parts.push(`位置 ${object.placement.position.map((value) => formatNumber(value)).join(', ')}`);
  }
  return parts.join(' · ');
}

function sourceDesignSubtitle(link: SpatialAssetLink): string | undefined {
  const names = link.sourceDesignNames ?? [];
  const files = link.sourceDesignFiles ?? [];
  if (names.length === 0 && files.length === 0) return undefined;
  const parts: string[] = [];
  if (names.length > 0) parts.push(`来源图纸 ${names.slice(0, 3).join('、')}${names.length > 3 ? '等' : ''}`);
  if (files.length > 0) parts.push(`来源 IFC ${files.slice(0, 2).join('、')}${files.length > 2 ? '等' : ''}`);
  return parts.join('；');
}

function sourceDesignSuffix(link: SpatialAssetLink): string {
  const subtitle = sourceDesignSubtitle(link);
  return subtitle ? ` · ${subtitle}` : '';
}

function sourceDesignSuffixes(links: SpatialAssetLink[]): string {
  if (links.length === 0) return '';
  const sourceDesign = collectSourceDesigns(links);
  const parts: string[] = [];
  if (sourceDesign.names.length > 0) {
    parts.push(`来源图纸 ${sourceDesign.names.slice(0, 3).join('、')}${sourceDesign.names.length > 3 ? '等' : ''}`);
  }
  if (sourceDesign.files.length > 0) {
    parts.push(`来源 IFC ${sourceDesign.files.slice(0, 2).join('、')}${sourceDesign.files.length > 2 ? '等' : ''}`);
  }
  return parts.length > 0 ? ` · ${parts.join('；')}` : '';
}

function collectSourceDesigns(links: SpatialAssetLink[]): { names: string[]; files: string[] } {
  const names: string[] = [];
  const files: string[] = [];
  const add = (target: string[], values: string[] | undefined): void => {
    for (const value of values ?? []) {
      if (!value || target.some((item) => item.toLowerCase() === value.toLowerCase())) continue;
      target.push(value);
    }
  };
  for (const link of links) {
    add(names, link.sourceDesignNames);
    add(files, link.sourceDesignFiles);
  }
  return { names, files };
}

function unlocatedReasonLabel(reason: string): string {
  switch (reason) {
    case 'ifc-guid-not-found': return 'IFC GUID 未命中';
    case 'no-spatial-container': return '没有空间容器';
    case 'no-transform': return '没有有效矩阵';
    case 'no-ifc-guid': return '没有 IFC GUID';
    case 'parser-unsupported': return '解析器不支持';
    default: return reason;
  }
}
