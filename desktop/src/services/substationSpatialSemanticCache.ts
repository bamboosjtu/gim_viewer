import type {SubstationSpatialIndex} from '../gim/ifcSpatialParser.js';
import {readCachedEntry,writeCacheFile} from '@desktop/database.js';
import {SUBSTATION_PARSER_DOMAIN_VERSION,SUBSTATION_SPATIAL_SEMANTIC_VERSION,SUBSTATION_SPATIAL_SEMANTIC_CACHE_ENTRY,MAX_SUBSTATION_SPATIAL_SNAPSHOT_BYTES,
 validateSubstationSpatialSnapshot,hydrateSubstationSpatialIndex,encodeSubstationSpatialCache,spatialIndexCounts,type SubstationSpatialSemanticSnapshot,type SubstationSpatialCacheReadResult,type EncodedSpatialCache} from './substationSpatialCodec.js';

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
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
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
  prepared?:EncodedSpatialCache,
): Promise<{ writeMs: number; snapshotBytes: number }> {
  if (projectId == null) throw new Error('空间语义缓存写入缺少 projectId');
  if (!sourceSha256?.trim()) throw new Error('空间语义缓存写入缺少 source SHA-256');
  if(prepared&&(prepared.sourceSha256!==sourceSha256.trim()||prepared.parserVersion!==parserVersion||prepared.cacheVersion!==SUBSTATION_SPATIAL_SEMANTIC_VERSION))throw Error('空间语义缓存编码身份不匹配');
  if(prepared?.error)throw Error(prepared.error);
  if(prepared){const counts=spatialIndexCounts(index);if(prepared.indexCounts?.length!==counts.length||counts.some((v,i)=>v!==prepared.indexCounts![i]))throw Error('空间语义缓存索引结构不匹配');}
  const encoded=prepared??encodeSubstationSpatialCache(index,{sourceSha256,parserVersion}),bytes=encoded.bytes;
  if(!bytes?.byteLength)throw Error('空间语义缓存编码为空');
  if (bytes.byteLength > MAX_SUBSTATION_SPATIAL_SNAPSHOT_BYTES) {
    throw new Error(`空间语义缓存过大: ${bytes.byteLength}`);
  }
  const started = performance.now();
  await writeCacheFile(projectId, SUBSTATION_SPATIAL_SEMANTIC_CACHE_ENTRY, bytes, sourceSha256);
  return { writeMs: Math.max(0, performance.now() - started), snapshotBytes: bytes.byteLength };
}
