import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { buildBusinessTree } from '../../gim/businessTree.js';
import type { CbmNode } from '../../gim/types.js';
import { encodeBusinessTree, decodeBusinessTree, writeBusinessTree, businessCacheEntry } from '../businessTreeCache.js';
import type { SubstationSpatialIndex } from '../../gim/ifcSpatialParser.js';
import {
  hydrateSubstationSpatialIndex,
  readSubstationSpatialSemanticCache,
  serializeSubstationSpatialIndex,
  SUBSTATION_PARSER_DOMAIN_VERSION,
  SUBSTATION_SPATIAL_SEMANTIC_VERSION,
  validateSubstationSpatialSnapshot,
  writeSubstationSpatialSemanticCache,
} from '../substationSpatialSemanticCache.js';
import { readCachedEntry, writeCacheFile } from '@desktop/database.js';

vi.mock('@desktop/database.js', () => ({
  readCachedEntry: vi.fn(),
  writeCacheFile: vi.fn(),
}));

const readCachedEntryMock = vi.mocked(readCachedEntry);
const writeCacheFileMock = vi.mocked(writeCacheFile);

describe('business projection snapshot',()=>{
  const root:CbmNode={path:'root.cbm',name:'工程',entityName:'F1System',children:[],famPath:'',devPath:'',ifcFile:'',ifcGuid:'',classifyName:'',transformMatrix:'',systemNames:[],devSymbolName:'',devType:'',devExpanded:false};
  const id={sourceSha256:'a'.repeat(64),semanticVersion:'semantic-test',modelIds:['ifc_station']};
  beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);});afterEach(()=>{vi.unstubAllGlobals();});
  it('restores all source/member indexes and original CBM references without serializing the CBM tree',async()=>{
    const p=buildBusinessTree(root,new Map(),createIndex()),bytes=await encodeBusinessTree(p,id),restored=await decodeBusinessTree(bytes,id,p.cbmByPath);
    expect(restored.objects).toEqual(p.objects);expect(restored.members).toEqual(p.members);expect(restored.objectBySource).toEqual(p.objectBySource);
    expect(restored.cbmByPath.get(root.path)).toBe(root);expect([...restored.objects.values()][0].ifcRefs?.[0].globalId).toBe('GUID-10');
  });
  it('rejects source/semantic/model changes, truncated or corrupt content and invalid graph references',async()=>{
    const p=buildBusinessTree(root,new Map(),createIndex()),bytes=await encodeBusinessTree(p,id);
    for(const changed of [{...id,sourceSha256:'b'.repeat(64)},{...id,semanticVersion:'next'},{...id,modelIds:['other']}])await expect(decodeBusinessTree(bytes,changed,p.cbmByPath)).rejects.toThrow('identity/version');
    await expect(decodeBusinessTree(bytes.subarray(0,2),id,p.cbmByPath)).rejects.toThrow('size');
    const broken=bytes.slice();broken[broken.length-1]^=1;await expect(decodeBusinessTree(broken,id,p.cbmByPath)).rejects.toThrow('checksum');
    [...p.objects.values()][0].assignment.unitKey='missing';await expect(decodeBusinessTree(await encodeBusinessTree(p,id),id,p.cbmByPath)).rejects.toThrow('object');
  });
  it('publishes one source-bound binary artifact and rejects invalid entry identities',async()=>{
    const p=buildBusinessTree(root,new Map(),createIndex());await writeBusinessTree(7,id,p);
    expect(writeCacheFileMock).toHaveBeenCalledWith(7,businessCacheEntry(id),expect.any(Uint8Array),id.sourceSha256);
    expect(()=>businessCacheEntry({...id,sourceSha256:'../bad'})).toThrow('source-sha');
  });
  it('retains lazy DEV aliases while binding the primary device to the restored CBM tree',async()=>{
    const alias={...root,path:root.path+'#dev:0:child.dev',entityName:'DEV_SUBDEVICE',devPath:'child.dev'},cold={...root,devPath:'root.dev',children:[alias]},warm={...cold,children:[]};
    const p=buildBusinessTree(cold),identity={...id,modelIds:[]},restored=await decodeBusinessTree(await encodeBusinessTree(p,identity),identity,new Map([[warm.path,warm]]));
    expect(restored.objectBySource.get(alias.path)).toBe(restored.objectBySource.get(root.path));expect(restored.cbmByPath.get(root.path)).toBe(warm);
  });
  it('compresses repeated evidence and stops expansion at the declared size',async()=>{
    const p=buildBusinessTree(root,new Map(),createIndex());[...p.objects.values()][0].context=['重复的来源与工程关系'.repeat(2000)];
    const bytes=await encodeBusinessTree(p,id),length=new DataView(bytes.buffer).getUint32(0,true),header=JSON.parse(new TextDecoder().decode(bytes.subarray(4,4+length)));
    expect(bytes.length).toBeLessThan(header.plainBytes/10);expect((await decodeBusinessTree(bytes,id,p.cbmByPath)).objects).toEqual(p.objects);
    const changed=new TextEncoder().encode(JSON.stringify({...header,plainBytes:1})),invalid=new Uint8Array(4+changed.length+bytes.length-4-length);
    new DataView(invalid.buffer).setUint32(0,changed.length,true);invalid.set(changed,4);invalid.set(bytes.subarray(4+length),4+changed.length);
    await expect(decodeBusinessTree(invalid,id,p.cbmByPath)).rejects.toThrow('expanded size');
  });
});

function createIndex(): SubstationSpatialIndex {
  const modelId = 'ifc_station';
  const nodeKey = `${modelId}#1`;
  const objectKey = `${modelId}#10`;
  const link = {
    cbmPath: 'F1/F2/F3/F4/DEVICE',
    ifcObjectKey: objectKey,
    spatialKey: nodeKey,
    evidence: 'ifc-contained' as const,
    confidence: 'confirmed' as const,
    sourceIfcFile: 'DEV/station.ifc',
    sourceIfcGuid: 'GUID-10',
  };
  const node = {
    key: nodeKey,
    modelId,
    expressId: 1,
    ifcType: 'IFCPROJECT',
    kind: 'project' as const,
    globalId: 'GUID-1',
    name: 'Station',
    parentKey: null,
    childKeys: [],
    directObjectKeys: [objectKey],
    boundaryObjectKeys: [],
    decompositionObjectKeys: [],
    hostObjectKeys: [],
    objectKeys: [objectKey],
    sourcePath: 'DEV/station.ifc',
    geometryStatus: 'unrepresented' as const,
  };
  const object = {
    key: objectKey,
    modelId,
    expressId: 10,
    ifcType: 'IFCBUILDINGELEMENTPROXY',
    globalId: 'GUID-10',
    name: 'Equipment',
    geometryStatus: 'represented' as const,
    parentObjectKey: null,
    childObjectKeys: [],
    relationshipCount: 0,
    hostObjectKey: null,
    spatialKey: nodeKey,
    spatialKeys: [nodeKey],
    spatialContainment: 'direct' as const,
    sourcePath: 'DEV/station.ifc',
  };
  const model = {
    modelId,
    entryPath: 'DEV/station.ifc',
    spatialEntityCount: 1,
    objectCount: 1,
    directContainedObjectCount: 1,
    spatialObjectCount: 1,
    containedObjectCount: 1,
    resourceCount: 0,
    propertyValueCount: 0,
    quantityValueCount: 0,
    objectsWithProperties: 0,
    objectsWithMaterials: 0,
  };
  return {
    models: [model],
    nodes: [node],
    objects: [object],
    links: [link],
    rootNodeKeys: [nodeKey],
    coverage: {
      hasSpatialEntities: false,
      hasSpatialContainment: true,
      hasSpaces: false,
      directCbmIfcLinks: 1,
      directCbmIfcLinkCoverage: 1,
      spatiallyContainedCbmLinks: 1,
      spatiallyContainedCbmCoverage: 1,
      directContainedIfcObjects: 1,
      decompositionInheritedIfcObjects: 0,
      hostInheritedIfcObjects: 0,
      boundaryContainedIfcObjects: 0,
      inheritedContainedIfcObjects: 0,
      placementOnlyAssets: 0,
      unlocatedAssets: 0,
      confirmedWithoutSpatialContainer: 0,
      uncontainedIfcObjects: 0,
      hasPlacementCoordinates: false,
      positionedAssets: 0,
      identityPlacementAssets: 0,
      placementGroups: 0,
      confidence: 'none',
    },
    nodeByKey: new Map([[nodeKey, node]]),
    objectByKey: new Map([[objectKey, object]]),
    linksBySpatialKey: new Map([[nodeKey, [link]]]),
    linksByCbmPath: new Map([[link.cbmPath, link]]),
    linksByIfcObjectKey: new Map([[objectKey, [link]]]),
    placementGroups: [],
    identityPlacementLinks: [],
  };
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe('substation spatial semantic snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serializes canonical arrays and hydrates all runtime Maps equivalently', () => {
    const snapshot = serializeSubstationSpatialIndex(createIndex(), {
      sourceSha256: 'sha-a',
    });
    expect(snapshot.cacheVersion).toBe(SUBSTATION_SPATIAL_SEMANTIC_VERSION);
    expect(snapshot.parserVersion).toBe(SUBSTATION_PARSER_DOMAIN_VERSION);
    expect(snapshot).not.toHaveProperty('nodeByKey');
    expect(validateSubstationSpatialSnapshot(snapshot, { sourceSha256: 'sha-a' })).toEqual({ valid: true });

    const restored = hydrateSubstationSpatialIndex(snapshot);
    expect(restored.nodes).toHaveLength(1);
    expect(restored.nodeByKey.get(restored.rootNodeKeys[0])?.objectKeys).toEqual(['ifc_station#10']);
    expect(restored.objectByKey.size).toBe(1);
    expect(restored.linksBySpatialKey.get('ifc_station#1')?.[0]?.cbmPath)
      .toBe('F1/F2/F3/F4/DEVICE');
    expect(restored.linksByCbmPath.size).toBe(1);
    expect(restored.linksByIfcObjectKey.size).toBe(1);
  });

  it.each([
    ['version mismatch', (snapshot: Record<string, unknown>) => { snapshot.cacheVersion = 'old'; }],
    ['source mismatch', (snapshot: Record<string, unknown>) => { snapshot.sourceSha256 = 'sha-b'; }],
    ['duplicate node', (snapshot: Record<string, unknown>) => {
      snapshot.nodes = [...(snapshot.nodes as unknown[]), ...(snapshot.nodes as unknown[])];
    }],
    ['missing parent reference', (snapshot: Record<string, unknown>) => {
      const nodes = snapshot.nodes as Array<Record<string, unknown>>;
      nodes[0].parentKey = 'missing';
    }],
    ['missing object link reference', (snapshot: Record<string, unknown>) => {
      const links = snapshot.links as Array<Record<string, unknown>>;
      links[0].ifcObjectKey = 'missing';
    }],
    ['coverage mismatch', (snapshot: Record<string, unknown>) => {
      const coverage = snapshot.coverage as Record<string, unknown>;
      coverage.uncontainedIfcObjects = 1;
    }],
    ['nested placement link mismatch', (snapshot: Record<string, unknown>) => {
      const link = {
        ...(snapshot.links as Array<Record<string, unknown>>)[0],
        ifcObjectKey: null,
      };
      snapshot.identityPlacementLinks = [link];
    }],
  ])('fails closed for %s', (_label, mutate) => {
    const snapshot = serializeSubstationSpatialIndex(createIndex(), { sourceSha256: 'sha-a' });
    mutate(snapshot as unknown as Record<string, unknown>);
    const result = validateSubstationSpatialSnapshot(snapshot, { sourceSha256: 'sha-a' });
    expect(result.valid).toBe(false);
    if (_label !== 'source mismatch') {
      expect(() => hydrateSubstationSpatialIndex(snapshot)).toThrow();
    }
  });

  it('treats corrupt/truncated/source-mismatched payloads as cache misses', async () => {
    readCachedEntryMock.mockResolvedValueOnce(new TextEncoder().encode('{')); // invalid JSON
    expect((await readSubstationSpatialSemanticCache(7, 'sha-a')).hit).toBe(false);
    readCachedEntryMock.mockRejectedValueOnce(new Error('missing')); // cache miss
    const missing = await readSubstationSpatialSemanticCache(7, 'sha-a');
    expect(missing.hit).toBe(false);
    if (!missing.hit) expect(missing.reason).toBe('not-found-or-read-failed');

    const snapshot = serializeSubstationSpatialIndex(createIndex(), { sourceSha256: 'sha-a' });
    readCachedEntryMock.mockResolvedValueOnce(encode({ ...snapshot, sourceSha256: 'sha-b' }));
    const mismatch = await readSubstationSpatialSemanticCache(7, 'sha-a');
    expect(mismatch).toMatchObject({ hit: false, reason: 'source-sha-mismatch' });
  });

  it('restores a valid cache without IFC input and writes through the atomic bridge', async () => {
    const snapshot = serializeSubstationSpatialIndex(createIndex(), { sourceSha256: 'sha-a' });
    readCachedEntryMock.mockResolvedValueOnce(encode(snapshot));
    const hit = await readSubstationSpatialSemanticCache(7, 'sha-a');
    expect(hit).toMatchObject({ hit: true, source: 'cache', models: 1, nodes: 1, objects: 1, links: 1 });

    writeCacheFileMock.mockResolvedValueOnce('cache-path');
    const written = await writeSubstationSpatialSemanticCache(7, 'sha-a', createIndex());
    expect(written.snapshotBytes).toBeGreaterThan(0);
    const call = writeCacheFileMock.mock.calls[0];
    expect(call?.[0]).toBe(7);
    expect(call?.[1]).toBe('__derived__/substation-spatial-semantic-v3.json');
    expect(call?.[2]).toBeTruthy();
    expect(call?.[3]).toBe('sha-a');
  });
});
