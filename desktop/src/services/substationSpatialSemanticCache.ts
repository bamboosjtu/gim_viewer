import type {
  IfcSpatialNode,
  IfcSpatialObject,
  SpatialAssetLink,
  SpatialCoverage,
  SpatialModelSummary,
  SpatialPlacementBucket,
  SubstationSpatialIndex,
} from '../gim/ifcSpatialParser.js';
import { readCachedEntry, writeCacheFile } from '@desktop/database.js';

/**
 * Persistence version for the substation IFC spatial projection.
 *
 * This is intentionally independent from both the shared parser version and
 * the geometry/Fragments cache versions.  A change to the line parser or to
 * DEV GLB output must not invalidate this derived semantic projection.
 */
export const SUBSTATION_SPATIAL_SEMANTIC_VERSION = 'substation-spatial-semantic-v1';
export const SUBSTATION_SPATIAL_SEMANTIC_CACHE_ENTRY =
  '__derived__/substation-spatial-semantic-v1.json';

/** Must match desktop/src-tauri/src/db.rs::SUBSTATION_PARSER_VERSION. */
export const SUBSTATION_PARSER_DOMAIN_VERSION = 'gim-substation-parser-v23';

/** Refuse to parse an unbounded/corrupt derived payload in the WebView. */
export const MAX_SUBSTATION_SPATIAL_SNAPSHOT_BYTES = 128 * 1024 * 1024;

export interface SubstationSpatialSemanticSnapshot {
  cacheVersion: string;
  sourceSha256: string;
  parserVersion: string;
  models: SpatialModelSummary[];
  nodes: IfcSpatialNode[];
  objects: IfcSpatialObject[];
  links: SpatialAssetLink[];
  rootNodeKeys: string[];
  coverage: SpatialCoverage;
  placementGroups: SpatialPlacementBucket[];
  identityPlacementLinks: SpatialAssetLink[];
}

export interface SubstationSpatialSnapshotValidation {
  valid: boolean;
  reason?: string;
}

export interface SubstationSpatialSnapshotMetadata {
  sourceSha256: string;
  parserVersion?: string;
}

export interface SubstationSpatialCacheHit {
  hit: true;
  index: SubstationSpatialIndex;
  source: 'cache';
  readMs: number;
  deserializeMs: number;
  hydrateMs: number;
  snapshotBytes: number;
  models: number;
  nodes: number;
  objects: number;
  links: number;
}

export interface SubstationSpatialCacheMiss {
  hit: false;
  source: 'cache';
  reason: string;
  readMs: number;
  deserializeMs: number;
  hydrateMs: number;
  snapshotBytes: number;
}

export type SubstationSpatialCacheReadResult =
  | SubstationSpatialCacheHit
  | SubstationSpatialCacheMiss;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isFiniteNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => isFiniteNumber(item));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function hasRequiredModelShape(value: unknown): value is SpatialModelSummary {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.modelId)
    && typeof value.entryPath === 'string'
    && isNonNegativeNumber(value.spatialEntityCount)
    && isNonNegativeNumber(value.objectCount)
    && isNonNegativeNumber(value.containedObjectCount)
    && isNonNegativeNumber(value.resourceCount)
    && isNonNegativeNumber(value.propertyValueCount)
    && isNonNegativeNumber(value.quantityValueCount)
    && isNonNegativeNumber(value.objectsWithProperties)
    && isNonNegativeNumber(value.objectsWithMaterials);
}

function hasRequiredNodeShape(value: unknown): value is IfcSpatialNode {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.key)
    && isNonEmptyString(value.modelId)
    && isNonEmptyString(value.ifcType)
    && isNonEmptyString(value.kind)
    && isNullableString(value.parentKey)
    && isStringArray(value.childKeys)
    && isStringArray(value.directObjectKeys)
    && isStringArray(value.boundaryObjectKeys)
    && isStringArray(value.decompositionObjectKeys)
    && isStringArray(value.hostObjectKeys)
    && isStringArray(value.objectKeys)
    && typeof value.sourcePath === 'string';
}

function hasRequiredObjectShape(value: unknown): value is IfcSpatialObject {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.key)
    && isNonEmptyString(value.modelId)
    && Number.isSafeInteger(value.expressId)
    && isNonEmptyString(value.ifcType)
    && typeof value.globalId === 'string'
    && typeof value.name === 'string'
    && (value.geometryStatus === 'represented' || value.geometryStatus === 'unrepresented')
    && isNullableString(value.parentObjectKey)
    && isStringArray(value.childObjectKeys)
    && isNullableString(value.hostObjectKey)
    && isNullableString(value.spatialKey)
    && isStringArray(value.spatialKeys)
    && typeof value.sourcePath === 'string';
}

function hasRequiredLinkShape(value: unknown): value is SpatialAssetLink {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.cbmPath)
    && isNullableString(value.ifcObjectKey)
    && isNullableString(value.spatialKey)
    && (value.evidence === 'ifc-contained'
      || value.evidence === 'ifc-boundary'
      || value.evidence === 'ifc-guid'
      || value.evidence === 'cbm-transform'
      || value.evidence === 'unresolved')
    && (value.confidence === 'confirmed'
      || value.confidence === 'inferred'
      || value.confidence === 'unresolved')
    && (value.transformMatrix === undefined || isFiniteNumberArray(value.transformMatrix))
    && (value.position === undefined
      || (Array.isArray(value.position)
        && value.position.length === 3
        && value.position.every((item) => isFiniteNumber(item))));
}

function hasRequiredCoverageShape(value: unknown): value is SpatialCoverage {
  if (!isRecord(value)) return false;
  const booleans = [
    'hasSpatialEntities',
    'hasSpatialContainment',
    'hasSpaces',
    'hasPlacementCoordinates',
  ];
  const counters = [
    'directCbmIfcLinks',
    'directCbmIfcLinkCoverage',
    'spatiallyContainedCbmLinks',
    'spatiallyContainedCbmCoverage',
    'directContainedIfcObjects',
    'decompositionInheritedIfcObjects',
    'hostInheritedIfcObjects',
    'boundaryContainedIfcObjects',
    'inheritedContainedIfcObjects',
    'placementOnlyAssets',
    'unlocatedAssets',
    'confirmedWithoutSpatialContainer',
    'uncontainedIfcObjects',
    'positionedAssets',
    'identityPlacementAssets',
    'placementGroups',
  ];
  const directCoverage = value.directCbmIfcLinkCoverage;
  const spatialCoverage = value.spatiallyContainedCbmCoverage;
  return booleans.every((key) => typeof value[key] === 'boolean')
    && counters.every((key) => isNonNegativeNumber(value[key]))
    && (value.confidence === 'confirmed'
      || value.confidence === 'partial'
      || value.confidence === 'inferred'
      || value.confidence === 'none')
    && isFiniteNumber(directCoverage)
    && isFiniteNumber(spatialCoverage)
    && directCoverage <= 1
    && spatialCoverage <= 1;
}

function hasRequiredPlacementBucketShape(value: unknown): value is SpatialPlacementBucket {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.key)
    && isNonNegativeNumber(value.gridSize)
    && Number.isSafeInteger(value.xIndex)
    && Number.isSafeInteger(value.yIndex)
    && Number.isSafeInteger(value.zIndex)
    && Array.isArray(value.links)
    && value.links.every((link) => hasRequiredLinkShape(link))
    && Array.isArray(value.minPosition)
    && value.minPosition.length === 3
    && value.minPosition.every((item) => isFiniteNumber(item))
    && Array.isArray(value.maxPosition)
    && value.maxPosition.length === 3
    && value.maxPosition.every((item) => isFiniteNumber(item));
}

function fail(reason: string): SubstationSpatialSnapshotValidation {
  return { valid: false, reason };
}

function linkFingerprint(link: SpatialAssetLink): string {
  // Placement groups and identity links repeat the canonical link payload in
  // JSON because they are persistence arrays, not object references.  Keep a
  // small explicit fingerprint so a partial/tampered nested copy cannot be
  // hydrated with different CBM/IFC evidence than `links`.
  return JSON.stringify([
    link.cbmPath,
    link.ifcObjectKey,
    link.spatialKey,
    link.evidence,
    link.confidence,
    link.sourceIfcFile ?? null,
    link.sourceIfcGuid ?? null,
    link.sourceDesignNames ?? null,
    link.sourceDesignFiles ?? null,
    link.transformMatrix ?? null,
    link.position ?? null,
    link.placementKind ?? null,
    link.unlocatedReason ?? null,
  ]);
}

/**
 * Validate the persistence boundary before any derived Map is rebuilt.
 *
 * The checks deliberately cover references and count invariants, not merely
 * JSON shape.  A structurally valid but partial snapshot must be treated as a
 * miss so the caller can rebuild the complete spatial projection.
 */
export function validateSubstationSpatialSnapshot(
  value: unknown,
  expected: {
    sourceSha256?: string;
    parserVersion?: string;
    cacheVersion?: string;
  } = {},
): SubstationSpatialSnapshotValidation {
  if (!isRecord(value)) return fail('snapshot-not-object');
  if (value.cacheVersion !== (expected.cacheVersion ?? SUBSTATION_SPATIAL_SEMANTIC_VERSION)) {
    return fail('cache-version-mismatch');
  }
  if (!isNonEmptyString(value.sourceSha256)) return fail('source-sha-missing');
  if (expected.sourceSha256 && value.sourceSha256 !== expected.sourceSha256) {
    return fail('source-sha-mismatch');
  }
  if (!isNonEmptyString(value.parserVersion)) return fail('parser-version-missing');
  if (expected.parserVersion && value.parserVersion !== expected.parserVersion) {
    return fail('parser-version-mismatch');
  }
  if (!Array.isArray(value.models) || !value.models.every(hasRequiredModelShape)) {
    return fail('models-invalid');
  }
  if (!Array.isArray(value.nodes) || !value.nodes.every(hasRequiredNodeShape)) {
    return fail('nodes-invalid');
  }
  if (!Array.isArray(value.objects) || !value.objects.every(hasRequiredObjectShape)) {
    return fail('objects-invalid');
  }
  if (!Array.isArray(value.links) || !value.links.every(hasRequiredLinkShape)) {
    return fail('links-invalid');
  }
  if (!isStringArray(value.rootNodeKeys)) return fail('root-keys-invalid');
  if (!hasRequiredCoverageShape(value.coverage)) return fail('coverage-invalid');
  if (!Array.isArray(value.placementGroups)
    || !value.placementGroups.every(hasRequiredPlacementBucketShape)) {
    return fail('placement-groups-invalid');
  }
  if (!Array.isArray(value.identityPlacementLinks)
    || !value.identityPlacementLinks.every(hasRequiredLinkShape)) {
    return fail('identity-placement-links-invalid');
  }

  const models = value.models as SpatialModelSummary[];
  const modelKeys = new Set<string>();
  for (const model of models) {
    if (modelKeys.has(model.modelId)) return fail(`duplicate-model:${model.modelId}`);
    modelKeys.add(model.modelId);
  }
  const nodeByKey = new Map<string, IfcSpatialNode>();
  for (const node of value.nodes as IfcSpatialNode[]) {
    if (nodeByKey.has(node.key)) return fail(`duplicate-node:${node.key}`);
    if (!modelKeys.has(node.modelId)) return fail(`node-model-missing:${node.key}`);
    nodeByKey.set(node.key, node);
  }
  const objectByKey = new Map<string, IfcSpatialObject>();
  for (const object of value.objects as IfcSpatialObject[]) {
    if (objectByKey.has(object.key)) return fail(`duplicate-object:${object.key}`);
    if (!modelKeys.has(object.modelId)) return fail(`object-model-missing:${object.key}`);
    objectByKey.set(object.key, object);
  }

  const hasRef = (map: Map<string, unknown>, key: string, label: string): string | null => {
    if (!map.has(key)) return `${label}-missing:${key}`;
    return null;
  };
  const checkReciprocal = (parent: IfcSpatialNode, childKey: string): string | null => {
    const child = nodeByKey.get(childKey);
    if (!child) return `child-node-missing:${childKey}`;
    if (child.parentKey !== parent.key) return `child-parent-mismatch:${childKey}`;
    return null;
  };
  for (const node of nodeByKey.values()) {
    if (node.parentKey != null) {
      const error = hasRef(nodeByKey, node.parentKey, 'parent-node');
      if (error) return fail(error);
      const parent = nodeByKey.get(node.parentKey)!;
      if (!parent.childKeys.includes(node.key)) return fail(`parent-child-mismatch:${node.key}`);
    }
    if (new Set(node.childKeys).size !== node.childKeys.length) {
      return fail(`duplicate-child:${node.key}`);
    }
    for (const childKey of node.childKeys) {
      const error = checkReciprocal(node, childKey);
      if (error) return fail(error);
    }
    for (const objectKey of [
      ...node.directObjectKeys,
      ...node.boundaryObjectKeys,
      ...node.decompositionObjectKeys,
      ...node.hostObjectKeys,
      ...node.objectKeys,
    ]) {
      const error = hasRef(objectByKey, objectKey, 'node-object');
      if (error) return fail(error);
    }
  }

  const roots = value.rootNodeKeys as string[];
  if (new Set(roots).size !== roots.length) return fail('duplicate-root-key');
  for (const rootKey of roots) {
    const root = nodeByKey.get(rootKey);
    if (!root) return fail(`root-node-missing:${rootKey}`);
    if (root.parentKey !== null) return fail(`root-parent-not-null:${rootKey}`);
  }
  for (const object of objectByKey.values()) {
    if (object.parentObjectKey != null) {
      const parent = objectByKey.get(object.parentObjectKey);
      if (!parent) return fail(`object-parent-missing:${object.key}`);
      if (!parent.childObjectKeys.includes(object.key)) return fail(`object-parent-mismatch:${object.key}`);
    }
    for (const childKey of object.childObjectKeys) {
      const child = objectByKey.get(childKey);
      if (!child) return fail(`object-child-missing:${childKey}`);
      if (child.parentObjectKey !== object.key) return fail(`object-child-mismatch:${childKey}`);
    }
    if (object.hostObjectKey != null && !objectByKey.has(object.hostObjectKey)) {
      return fail(`object-host-missing:${object.key}`);
    }
    for (const spatialKey of object.spatialKeys) {
      const error = hasRef(nodeByKey, spatialKey, 'object-spatial');
      if (error) return fail(error);
    }
    if (object.spatialKey != null && !object.spatialKeys.includes(object.spatialKey)) {
      return fail(`object-primary-spatial-mismatch:${object.key}`);
    }
  }

  const linkByCbmPath = new Map<string, SpatialAssetLink>();
  for (const link of value.links as SpatialAssetLink[]) {
    if (linkByCbmPath.has(link.cbmPath)) return fail(`duplicate-link:${link.cbmPath}`);
    if (link.spatialKey != null && !nodeByKey.has(link.spatialKey)) {
      return fail(`link-spatial-missing:${link.cbmPath}`);
    }
    if (link.ifcObjectKey != null && !objectByKey.has(link.ifcObjectKey)) {
      return fail(`link-object-missing:${link.cbmPath}`);
    }
    linkByCbmPath.set(link.cbmPath, link);
  }
  const checkPlacementLinks = (links: SpatialAssetLink[], label: string): string | null => {
    for (const link of links) {
      const canonical = linkByCbmPath.get(link.cbmPath);
      if (!canonical) return `${label}-link-missing:${link.cbmPath}`;
      if (linkFingerprint(link) !== linkFingerprint(canonical)) {
        return `${label}-link-mismatch:${link.cbmPath}`;
      }
    }
    return null;
  };
  const identityError = checkPlacementLinks(value.identityPlacementLinks as SpatialAssetLink[], 'identity');
  if (identityError) return fail(identityError);
  const identityLinkKeys = new Set<string>();
  for (const link of value.identityPlacementLinks as SpatialAssetLink[]) {
    if (identityLinkKeys.has(link.cbmPath)) return fail(`duplicate-identity-link:${link.cbmPath}`);
    identityLinkKeys.add(link.cbmPath);
  }
  const placementGroupKeys = new Set<string>();
  const placementLinkKeys = new Set<string>();
  for (const bucket of value.placementGroups as SpatialPlacementBucket[]) {
    if (placementGroupKeys.has(bucket.key)) return fail(`duplicate-placement-group:${bucket.key}`);
    placementGroupKeys.add(bucket.key);
    const error = checkPlacementLinks(bucket.links, `placement:${bucket.key}`);
    if (error) return fail(error);
    for (const link of bucket.links) {
      if (placementLinkKeys.has(link.cbmPath)) return fail(`duplicate-placement-link:${link.cbmPath}`);
      placementLinkKeys.add(link.cbmPath);
    }
  }

  // Basic count consistency catches truncated arrays without imposing a new
  // domain model or recomputing every diagnostic coverage ratio.
  const objectCountByModel = new Map<string, number>();
  const nodeCountByModel = new Map<string, number>();
  for (const object of objectByKey.values()) {
    objectCountByModel.set(object.modelId, (objectCountByModel.get(object.modelId) ?? 0) + 1);
  }
  for (const node of nodeByKey.values()) {
    nodeCountByModel.set(node.modelId, (nodeCountByModel.get(node.modelId) ?? 0) + 1);
  }
  for (const model of models) {
    if (model.objectCount !== (objectCountByModel.get(model.modelId) ?? 0)) {
      return fail(`model-object-count-mismatch:${model.modelId}`);
    }
    if (model.spatialEntityCount !== (nodeCountByModel.get(model.modelId) ?? 0)) {
      return fail(`model-node-count-mismatch:${model.modelId}`);
    }
  }
  const uncontained = Array.from(objectByKey.values()).filter((object) => object.spatialKeys.length === 0).length;
  const positioned = (value.links as SpatialAssetLink[]).filter(
    (link) => link.confidence === 'inferred' && link.placementKind === 'translated' && link.position,
  ).length;
  const identity = (value.links as SpatialAssetLink[]).filter(
    (link) => link.confidence === 'inferred' && link.placementKind !== 'translated',
  ).length;
  const unresolved = (value.links as SpatialAssetLink[]).filter((link) => link.confidence === 'unresolved').length;
  if (value.coverage.uncontainedIfcObjects !== uncontained) return fail('coverage-uncontained-mismatch');
  if (value.coverage.positionedAssets !== positioned) return fail('coverage-positioned-mismatch');
  if (value.coverage.identityPlacementAssets !== identity) return fail('coverage-identity-mismatch');
  if (value.coverage.unlocatedAssets !== unresolved) return fail('coverage-unlocated-mismatch');
  if (value.coverage.placementGroups !== value.placementGroups.length) return fail('coverage-placement-group-mismatch');

  return { valid: true };
}

/** Create the canonical, Map-free persistence representation. */
export function serializeSubstationSpatialIndex(
  index: SubstationSpatialIndex,
  metadata: SubstationSpatialSnapshotMetadata,
): SubstationSpatialSemanticSnapshot {
  const sourceSha256 = metadata.sourceSha256.trim();
  if (!sourceSha256) throw new Error('空间语义缓存缺少 source SHA-256');
  const snapshot: SubstationSpatialSemanticSnapshot = {
    cacheVersion: SUBSTATION_SPATIAL_SEMANTIC_VERSION,
    sourceSha256,
    parserVersion: metadata.parserVersion ?? SUBSTATION_PARSER_DOMAIN_VERSION,
    models: index.models.map((model) => ({
      ...model,
      ...(model.resourceTypeCounts ? { resourceTypeCounts: { ...model.resourceTypeCounts } } : {}),
    })),
    nodes: index.nodes.map((node) => ({
      ...node,
      childKeys: node.childKeys.slice(),
      directObjectKeys: node.directObjectKeys.slice(),
      boundaryObjectKeys: node.boundaryObjectKeys.slice(),
      decompositionObjectKeys: node.decompositionObjectKeys.slice(),
      hostObjectKeys: node.hostObjectKeys.slice(),
      objectKeys: node.objectKeys.slice(),
    })),
    objects: index.objects.map((object) => ({
      ...object,
      ...(object.placement ? { placement: { ...object.placement, matrix: object.placement.matrix.slice() } } : {}),
      childObjectKeys: object.childObjectKeys.slice(),
      spatialKeys: object.spatialKeys.slice(),
      ...(object.propertySets ? {
        propertySets: object.propertySets.map((group) => ({
          ...group,
          values: group.values.map((value) => ({ ...value })),
        })),
      } : {}),
      ...(object.propertySetNames ? { propertySetNames: object.propertySetNames.slice() } : {}),
      ...(object.materials ? { materials: object.materials.slice() } : {}),
      ...(object.classifications ? { classifications: object.classifications.slice() } : {}),
      ...(object.groupNames ? { groupNames: object.groupNames.slice() } : {}),
    })),
    links: index.links.map((link) => ({
      ...link,
      ...(link.transformMatrix ? { transformMatrix: link.transformMatrix.slice() } : {}),
      ...(link.position ? { position: [...link.position] as [number, number, number] } : {}),
      ...(link.sourceDesignNames ? { sourceDesignNames: link.sourceDesignNames.slice() } : {}),
      ...(link.sourceDesignFiles ? { sourceDesignFiles: link.sourceDesignFiles.slice() } : {}),
    })),
    rootNodeKeys: index.rootNodeKeys.slice(),
    coverage: { ...index.coverage },
    placementGroups: index.placementGroups.map((group) => ({
      ...group,
      links: group.links.map((link) => ({
        ...link,
        ...(link.transformMatrix ? { transformMatrix: link.transformMatrix.slice() } : {}),
        ...(link.position ? { position: [...link.position] as [number, number, number] } : {}),
        ...(link.sourceDesignNames ? { sourceDesignNames: link.sourceDesignNames.slice() } : {}),
        ...(link.sourceDesignFiles ? { sourceDesignFiles: link.sourceDesignFiles.slice() } : {}),
      })),
      minPosition: [...group.minPosition] as [number, number, number],
      maxPosition: [...group.maxPosition] as [number, number, number],
    })),
    identityPlacementLinks: index.identityPlacementLinks.map((link) => ({
      ...link,
      ...(link.transformMatrix ? { transformMatrix: link.transformMatrix.slice() } : {}),
      ...(link.position ? { position: [...link.position] as [number, number, number] } : {}),
      ...(link.sourceDesignNames ? { sourceDesignNames: link.sourceDesignNames.slice() } : {}),
      ...(link.sourceDesignFiles ? { sourceDesignFiles: link.sourceDesignFiles.slice() } : {}),
    })),
  };
  const validation = validateSubstationSpatialSnapshot(snapshot, {
    sourceSha256,
    parserVersion: snapshot.parserVersion,
  });
  if (!validation.valid) throw new Error(`空间语义缓存序列化前校验失败: ${validation.reason}`);
  return snapshot;
}

/** Rebuild all runtime Maps from a validated persistence snapshot. */
export function hydrateSubstationSpatialIndex(
  snapshot: SubstationSpatialSemanticSnapshot,
): SubstationSpatialIndex {
  const validation = validateSubstationSpatialSnapshot(snapshot);
  if (!validation.valid) throw new Error(`空间语义缓存 hydrate 失败: ${validation.reason}`);
  const nodes = snapshot.nodes.slice();
  const objects = snapshot.objects.slice();
  const links = snapshot.links.slice();
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const objectByKey = new Map(objects.map((object) => [object.key, object]));
  const linksBySpatialKey = new Map<string, SpatialAssetLink[]>();
  const linksByCbmPath = new Map<string, SpatialAssetLink>();
  const linksByIfcObjectKey = new Map<string, SpatialAssetLink[]>();
  for (const link of links) {
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
  return {
    models: snapshot.models.slice(),
    nodes,
    objects,
    links,
    rootNodeKeys: snapshot.rootNodeKeys.slice(),
    coverage: { ...snapshot.coverage },
    nodeByKey,
    objectByKey,
    linksBySpatialKey,
    linksByCbmPath,
    linksByIfcObjectKey,
    placementGroups: snapshot.placementGroups.map((group) => ({
      ...group,
      links: group.links.map((link) => linksByCbmPath.get(link.cbmPath)!),
      minPosition: [...group.minPosition] as [number, number, number],
      maxPosition: [...group.maxPosition] as [number, number, number],
    })),
    identityPlacementLinks: snapshot.identityPlacementLinks.map((link) => linksByCbmPath.get(link.cbmPath)!),
  };
}

function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/** Try a derived cache without touching IFC files. All failures are misses. */
export async function readSubstationSpatialSemanticCache(
  projectId: number | null | undefined,
  sourceSha256: string | null | undefined,
  parserVersion = SUBSTATION_PARSER_DOMAIN_VERSION,
): Promise<SubstationSpatialCacheReadResult> {
  const started = performance.now();
  if (projectId == null) {
    return {
      hit: false,
      source: 'cache',
      reason: 'cache-unavailable',
      readMs: 0,
      deserializeMs: 0,
      hydrateMs: 0,
      snapshotBytes: 0,
    };
  }
  if (!sourceSha256?.trim()) {
    return {
      hit: false,
      source: 'cache',
      reason: 'source-sha-missing',
      readMs: 0,
      deserializeMs: 0,
      hydrateMs: 0,
      snapshotBytes: 0,
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = await readCachedEntry(projectId, SUBSTATION_SPATIAL_SEMANTIC_CACHE_ENTRY);
  } catch {
    return {
      hit: false,
      source: 'cache',
      reason: 'not-found-or-read-failed',
      readMs: Math.max(0, performance.now() - started),
      deserializeMs: 0,
      hydrateMs: 0,
      snapshotBytes: 0,
    };
  }
  const readMs = Math.max(0, performance.now() - started);
  const snapshotBytes = bytes.byteLength;
  if (snapshotBytes <= 0 || snapshotBytes > MAX_SUBSTATION_SPATIAL_SNAPSHOT_BYTES) {
    return { hit: false, source: 'cache', reason: 'size-invalid', readMs, deserializeMs: 0, hydrateMs: 0, snapshotBytes };
  }
  const deserializeStarted = performance.now();
  let parsed: unknown;
  try {
    parsed = decodeJson(bytes);
  } catch {
    return {
      hit: false,
      source: 'cache',
      reason: 'deserialize-failed',
      readMs,
      deserializeMs: Math.max(0, performance.now() - deserializeStarted),
      hydrateMs: 0,
      snapshotBytes,
    };
  }
  const deserializeMs = Math.max(0, performance.now() - deserializeStarted);
  const validation = validateSubstationSpatialSnapshot(parsed, {
    sourceSha256: sourceSha256.trim(),
    parserVersion,
  });
  if (!validation.valid) {
    return { hit: false, source: 'cache', reason: validation.reason ?? 'snapshot-invalid', readMs, deserializeMs, hydrateMs: 0, snapshotBytes };
  }
  const hydrateStarted = performance.now();
  try {
    const index = hydrateSubstationSpatialIndex(parsed as SubstationSpatialSemanticSnapshot);
    const hydrateMs = Math.max(0, performance.now() - hydrateStarted);
    return {
      hit: true,
      index,
      source: 'cache',
      readMs,
      deserializeMs,
      hydrateMs,
      snapshotBytes,
      models: index.models.length,
      nodes: index.nodes.length,
      objects: index.objects.length,
      links: index.links.length,
    };
  } catch {
    return {
      hit: false,
      source: 'cache',
      reason: 'hydrate-failed',
      readMs,
      deserializeMs,
      hydrateMs: Math.max(0, performance.now() - hydrateStarted),
      snapshotBytes,
    };
  }
}

/** Serialize and atomically publish a complete snapshot. */
export async function writeSubstationSpatialSemanticCache(
  projectId: number | null | undefined,
  sourceSha256: string | null | undefined,
  index: SubstationSpatialIndex,
  parserVersion = SUBSTATION_PARSER_DOMAIN_VERSION,
): Promise<{ writeMs: number; snapshotBytes: number }> {
  if (projectId == null) throw new Error('空间语义缓存写入缺少 projectId');
  if (!sourceSha256?.trim()) throw new Error('空间语义缓存写入缺少 source SHA-256');
  const snapshot = serializeSubstationSpatialIndex(index, { sourceSha256, parserVersion });
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  if (bytes.byteLength > MAX_SUBSTATION_SPATIAL_SNAPSHOT_BYTES) {
    throw new Error(`空间语义缓存过大: ${bytes.byteLength}`);
  }
  const started = performance.now();
  await writeCacheFile(projectId, SUBSTATION_SPATIAL_SEMANTIC_CACHE_ENTRY, bytes, sourceSha256);
  return { writeMs: Math.max(0, performance.now() - started), snapshotBytes: bytes.byteLength };
}
