import proxyCategories from '../../semantic/catalog/proxyCategories.json';
import { expect, it } from 'vitest';
import { ifcSourceRecords } from '../ifcSourceRecords.js';
import { toObjectEvidence } from '../../adapters/semanticAdapter.js';
import { normalizeEngineeringModel } from '../../semantic/normalize.js';
import type { IfcSpatialObject } from '../ifcSpatialTypes.js';
import { extractEngineeringSourceGraph } from '../sourceGraph.js';
import {collectEngineeringSourceModel} from '../engineeringModel.js';
import {buildTestEngineeringSources} from './fixtures.js';

const object = (expressId: number, ifcType: string, name: string, extra: Partial<IfcSpatialObject> = {}): IfcSpatialObject => ({
  key: `model#${expressId}`, modelId: 'logical-model', expressId, ifcType, name, globalId: 'repeated-guid',
  geometryStatus: 'unrepresented', parentObjectKey: null, childObjectKeys: [], relationshipCount: 0,
  hostObjectKey: null, spatialKey: null, spatialKeys: [], spatialContainment: null, sourcePath: 'elsewhere/model.ifc', ...extra,
});

it('keeps Pset identity, raw spelling, applicability, units and object identity on source properties',()=>{
  const record=ifcSourceRecords([object(1,'IFCBUILDINGELEMENTPROXY','unknown',{propertySets:[
    {id:10,name:'Pset_Raw_Instance',kind:'property',values:[{name:'RATEDVOLTAGE',value:'1',unit:'kV',dataType:'IfcElectricVoltageMeasure'}]},
    {id:11,name:'Pset_Raw_Type',kind:'property',applicability:'type',values:[{name:'RATEDVOLTAGE',value:'2',unit:'kV'}]},
  ]})])[0];
  expect(record.properties[0]).toMatchObject({rawContainerName:'Pset_Raw_Instance',applicability:'instance',containerId:'elsewhere/model.ifc#10',sourceId:record.id,rawUnit:'kV',rawValueType:'IfcElectricVoltageMeasure'});
  expect(record.properties[1]).toMatchObject({rawContainerName:'Pset_Raw_Type',applicability:'type'});
});

it('preserves duplicate GUID instances and materialless/unrepresented outward objects', () => {
  const records = ifcSourceRecords([object(1, 'IFCBEAM', '梁'), object(2, 'IFCBEAM', '梁')]);
  expect(new Set(records.map(row => row.id)).size).toBe(2);
  expect(normalizeEngineeringModel('package', records.map(toObjectEvidence)).entities).toHaveLength(2);
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
  const model=collectEngineeringSourceModel(graph,[object(1, 'IFCBUILDINGELEMENTPROXY', '断路器')]);
  const snapshot=buildTestEngineeringSources('package',graph,[object(1, 'IFCBUILDINGELEMENTPROXY', '断路器')],[]).snapshot;
  expect(model.ifcMatches[0]).toMatchObject({ status: 'confirmed', rawGuid: 'repeated-guid$' });
  expect(model.ifcMatches[0].devSourceIds).toHaveLength(1);
  expect(model.ifcMatches[0].ifcSourceIds).toHaveLength(1);
  expect(snapshot.entities).toHaveLength(2);
});

it('retains duplicate GUID ambiguity and all IFC sources even without a unique CBM match', async () => {
  const entries: Record<string, string> = { 'project.cbm': 'IFCFILE=Elsewhere/model.ifc\nIFCGUID=repeated-guid', 'Elsewhere/model.ifc': '' };
  const graph = await extractEngineeringSourceGraph({ paths: Object.keys(entries), readText: async path => entries[path] });
  const model=collectEngineeringSourceModel(graph,[object(1, 'IFCBEAM', '梁'), object(2, 'IFCBEAM', '梁')]);
  const snapshot=buildTestEngineeringSources('package',graph,[object(1, 'IFCBEAM', '梁'), object(2, 'IFCBEAM', '梁')],[]).snapshot;
  expect(model.ifcMatches[0].status).toBe('ambiguous');
  expect(snapshot.entities).toHaveLength(2);
  expect(model.ifcMatches[0].devSourceIds).toHaveLength(0);
});
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
