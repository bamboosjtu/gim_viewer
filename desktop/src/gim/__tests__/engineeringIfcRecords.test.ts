import { expect, it } from 'vitest';
import { ifcSourceRecords } from '../engineering/ifcSourceRecords.js';
import { toObjectEvidence } from '../engineering/sourceEvidence.js';
import { normalizeEngineeringModel } from '../../engineering/normalize.js';
import type { IfcSpatialObject } from '../ifcSpatialParser.js';
import { extractEngineeringSourceGraph } from '../engineering/sourceGraph.js';
import { buildEngineeringSourceModel } from '../engineering/engineeringModel.js';
import { buildSubstationSpatialIndexFromTexts } from '../ifcSpatialParser.js';

const object = (expressId: number, ifcType: string, name: string, extra: Partial<IfcSpatialObject> = {}): IfcSpatialObject => ({
  key: `model#${expressId}`, modelId: 'logical-model', expressId, ifcType, name, globalId: 'repeated-guid',
  geometryStatus: 'unrepresented', parentObjectKey: null, childObjectKeys: [], relationshipCount: 0,
  hostObjectKey: null, spatialKey: null, spatialKeys: [], spatialContainment: null, sourcePath: 'elsewhere/model.ifc', ...extra,
});

it('preserves duplicate GUID instances and materialless/unrepresented outward objects', () => {
  const records = ifcSourceRecords([object(1, 'IFCBEAM', '梁'), object(2, 'IFCBEAM', '梁')]);
  expect(new Set(records.map(row => row.id)).size).toBe(2);
  expect(normalizeEngineeringModel('package', records.map(toObjectEvidence)).entities).toHaveLength(2);
});

it('keeps the original IFC Name distinct from its meaningful display fallback', () => {
  const index = buildSubstationSpatialIndexFromTexts([{ entry: { modelId: 'm', path: 'source.ifc', name: 'source' },
    text: "ISO-10303-21;HEADER;ENDSEC;DATA;#1=IFCBUILDINGELEMENTPROXY('g',$,'--','设备支架',$,$,$,$);ENDSEC;END-ISO-10303-21;" }], null);
  expect(index.objects[0].sourceName).toBe('--');
  expect(index.objects[0].name).toBe('设备支架');
  const records = ifcSourceRecords(index.objects);
  expect(records[0].properties).toContainEqual(expect.objectContaining({ keys: ['IFC.Name'], value: '--' }));
  expect(records[0].properties).toContainEqual(expect.objectContaining({ keys: ['IFC.Description'], value: '设备支架' }));
});

it('retains openings and ports as source members instead of engineering entities', () => {
  const records = ifcSourceRecords([object(1, 'IFCWALL', '墙'), object(2, 'IFCOPENINGELEMENT', '洞口', { hostObjectKey: 'model#1' }),
    object(3, 'IFCDISTRIBUTIONPORT', '端口', { hostObjectKey: 'model#1' })]);
  const model = normalizeEngineeringModel('package', records.map(toObjectEvidence));
  expect(model.entities).toHaveLength(1);
  expect(model.entities[0].sourceIds).toHaveLength(3);
});

it('does not turn an installed door host relationship into wall component ownership', () => {
  const records = ifcSourceRecords([object(1, 'IFCWALL', '墙'), object(2, 'IFCDOOR', '门', { hostObjectKey: 'model#1' })]);
  expect(records[1].parent).toBe('');
  expect(records[1].relations?.[0].targetSourceId).toBe(records[0].id);
  expect(normalizeEngineeringModel('package', records.map(toObjectEvidence)).entities).toHaveLength(2);
});

it('does not use feature-only children to discard an unknown outward whole', () => {
  const records = ifcSourceRecords([object(1, 'IFCBUILDINGELEMENTPROXY', 'Group'),
    object(2, 'IFCDISTRIBUTIONPORT', '端口', { hostObjectKey: 'model#1' })]);
  const model = normalizeEngineeringModel('package', records.map(toObjectEvidence));
  expect(model.entities).toHaveLength(1);
  expect(model.entities[0].category).toBe('U-OBJECT');
});

it('rejects IFC internal definitions at the outward adapter boundary', () => {
  expect(() => ifcSourceRecords([object(1, 'IFCWALLTYPE', '墙类型')])).toThrow('internal');
  expect(() => ifcSourceRecords([object(1, 'IFCMATERIAL', '钢')])).toThrow('internal');
});

it('keeps a DEV/IFC declared identity link as evidence without forcing physical equivalence', async () => {
  const entries: Record<string, string> = { 'project.cbm': 'OBJECTMODELPOINTER=unit.dev\nIFCFILE=Elsewhere/model.ifc\nIFCGUID=repeated-guid$',
    'unit.dev': 'SYMBOLNAME=断路器', 'Elsewhere/model.ifc': '' };
  const graph = await extractEngineeringSourceGraph({ paths: Object.keys(entries), readText: async path => entries[path] });
  const model = buildEngineeringSourceModel('package', graph, [object(1, 'IFCBUILDINGELEMENTPROXY', '断路器')]);
  expect(model.ifcMatches[0]).toMatchObject({ status: 'confirmed', rawGuid: 'repeated-guid$' });
  expect(model.ifcMatches[0].devSourceIds).toHaveLength(1);
  expect(model.ifcMatches[0].ifcSourceIds).toHaveLength(1);
  expect(model.snapshot.entities).toHaveLength(2);
});

it('retains duplicate GUID ambiguity and all IFC sources even without a unique CBM match', async () => {
  const entries: Record<string, string> = { 'project.cbm': 'IFCFILE=Elsewhere/model.ifc\nIFCGUID=repeated-guid', 'Elsewhere/model.ifc': '' };
  const graph = await extractEngineeringSourceGraph({ paths: Object.keys(entries), readText: async path => entries[path] });
  const model = buildEngineeringSourceModel('package', graph, [object(1, 'IFCBEAM', '梁'), object(2, 'IFCBEAM', '梁')]);
  expect(model.ifcMatches[0].status).toBe('ambiguous');
  expect(model.snapshot.entities).toHaveLength(2);
  expect(model.ifcMatches[0].devSourceIds).toHaveLength(0);
});
it('classifies proxies from their own category Pset without loading unrelated properties or changing source names', () => {
  const index = buildSubstationSpatialIndexFromTexts([{entry:{modelId:'m',path:'arbitrary.ifc',name:'model'},text:`
#1=IFCBUILDINGELEMENTPROXY('a',$,'代理构件',$,$,$,$,$,$);
#2=IFCBUILDINGELEMENTPROXY('b',$,'代理构件',$,$,$,$,$,$);
#3=IFCBUILDINGELEMENTPROXY('c',$,'代理构件',$,$,$,$,$,$);
#10=IFCRELDEFINESBYPROPERTIES('r',$,$,$,(#1),#20);
#11=IFCRELDEFINESBYPROPERTIES('s',$,$,$,(#2),#21);
#20=IFCPROPERTYSET('p',$,'默认',$,(#30,#31));
#21=IFCPROPERTYSET('q',$,'默认',$,(#32));
#30=IFCPROPERTYSINGLEVALUE('类别(Category)',$,IFCLABEL('墙(Walls)'),$);
#31=IFCPROPERTYSINGLEVALUE('任意详细属性',$,IFCLABEL('不得提前加载'),$);
#32=IFCPROPERTYSINGLEVALUE('类别(Category)',$,IFCLABEL('常规模型(Generic Models)'),$);
`}],null);
  const records=ifcSourceRecords(index.objects), model=normalizeEngineeringModel('p',records.map(toObjectEvidence));
  expect(model.entities.map(e=>e.category)).toEqual(['C-A1','U-OBJECT','U-OBJECT']);
  expect(model.entities[0].name).toBe('墙体');
  expect(records[0].name).toBe('代理构件');
  expect(records[0].properties.some(p=>p.value==='不得提前加载')).toBe(false);
  expect(index.objects[0].propertyDataDeferred).toBe(true);
  expect(index.objects[0].propertySets?.[0].truncated).toBe(true);
});
import proxyCategories from '../engineering/proxyCategories.json';

it('maps explicit proxy authoring categories and leaves broad electrical/generic equipment unresolved',()=>{
 const cases=[['喷头(Sprinklers)','C-D2'],['火警设备(Fire Alarm Devices)','C-D2'],['照明设备(Lighting Fixtures)','C-D1'],['楼梯(Stairs)','C-A9'],['栏杆(Railings)','C-A9'],['管道(Pipes)','C-D6'],['线管(Conduit Fittings)','C-D6'],['机械设备(Mechanical Equipment)','E19']];
 for(const [raw,category] of cases){
  const record=ifcSourceRecords([object(1,'IFCBUILDINGELEMENTPROXY','代理构件',{propertySets:[{id:10,name:'默认',kind:'property',values:[{name:'类别(Category)',value:raw}]}]})])[0];
  expect(toObjectEvidence(record).propertyCategories?.map(p=>p.value)).toContain(category);
 }
 for(const raw of ['常规模型(Generic Models)','电气设备(Electrical Equipment)','专用设备(Specialty Equipment)']){
  const record=ifcSourceRecords([object(2,'IFCBUILDINGELEMENTPROXY','代理构件',{propertySets:[{id:11,name:'默认',kind:'property',values:[{name:'类别(Category)',value:raw}]}]})])[0];
  expect(toObjectEvidence(record).propertyCategories).toEqual([]);
 }
 expect(proxyCategories.version).toBe('ifc-proxy-category-v1');
});
