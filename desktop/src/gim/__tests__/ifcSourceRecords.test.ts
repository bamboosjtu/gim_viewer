import {expect,it} from 'vitest';
import {ifcSourceRecords} from '@gim/gim-sdk/source';
import {toObjectEvidence} from '@gim/gim-sdk/source-adapter';
import {normalizeEngineeringModel} from '@gim/gim-sdk/semantic';
import {buildSubstationSpatialIndexFromTexts} from '../ifcSpatialParser.js';

it('keeps the original IFC Name distinct from its meaningful display fallback', () => {
  const index = buildSubstationSpatialIndexFromTexts([{ entry: { modelId: 'm', path: 'source.ifc', name: 'source' },
    text: "ISO-10303-21;HEADER;ENDSEC;DATA;#1=IFCBUILDINGELEMENTPROXY('g',$,'--','设备支架',$,$,$,$);ENDSEC;END-ISO-10303-21;" }], null);
  expect(index.objects[0].sourceName).toBe('--');
  expect(index.objects[0].name).toBe('设备支架');
  const records = ifcSourceRecords(index.objects);
  expect(records[0].properties).toContainEqual(expect.objectContaining({ keys: ['IFC.Name'], value: '--' }));
  expect(records[0].properties).toContainEqual(expect.objectContaining({ keys: ['IFC.Description'], value: '设备支架' }));
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
  expect(model.entities.map(e=>e.category)).toEqual(['C02','U-OBJECT','U-OBJECT']);
  expect(model.entities[0].name).toBe('墙体');
  expect(records[0].name).toBe('代理构件');
  expect(records[0].properties.some(p=>p.value==='不得提前加载')).toBe(false);
  expect(index.objects[0].propertyDataDeferred).toBe(true);
  expect(index.objects[0].propertySets?.[0].truncated).toBe(true);
});
