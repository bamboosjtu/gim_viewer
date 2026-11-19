import {it,expect} from 'vitest';
import {buildSubstationSpatialIndexFromTexts} from '../ifcSpatialParser.js';
import {ifcSourceRecords} from '@gim/gim-sdk/source';
import {toObjectEvidence,ENGINEERING_EVIDENCE_FIELDS} from '@gim/gim-sdk/source-adapter';
import {normalizeEngineeringModel} from '@gim/gim-sdk/semantic';
const entry={path:'model.ifc',name:'model.ifc',modelId:'ifc-test'};
it('retains requested object-linked recognition fields while unrelated property values stay deferred',()=>{
  const text=`ISO-10303-21;HEADER;ENDSEC;DATA;
#1=IFCBUILDINGELEMENTPROXY('0000000000000000000001',$,'道路_直角弯头',$,$,$,$,$,.NOTDEFINED.);
#20=IFCPROPERTYSET('0000000000000000000020',$,'设计',$,(#21,#22));
#21=IFCPROPERTYSINGLEVALUE('设备类型',$,IFCLABEL('道路'),$);
#22=IFCPROPERTYSINGLEVALUE('无关详情',$,IFCTEXT('${'detail'.repeat(500)}'),$);
#30=IFCRELDEFINESBYPROPERTIES('0000000000000000000030',$,$,$,(#1),#20);
ENDSEC;END-ISO-10303-21;`;
  const index=buildSubstationSpatialIndexFromTexts([{entry,text}],null,[],undefined,ENGINEERING_EVIDENCE_FIELDS),object=index.objects.find(o=>o.expressId===1)!;
  expect(object.propertyDataDeferred).toBe(true);expect(object.propertySets?.[0]).toMatchObject({name:'设计',applicability:'instance',truncated:true});
  expect(object.propertySets?.flatMap(p=>p.values.map(v=>v.name))).toEqual(['设备类型']);
  expect(normalizeEngineeringModel('ifc-test',[toObjectEvidence(ifcSourceRecords([object])[0])]).memberships[0].interpretation.category).toBe('C01');
});
it('exposes an inherited IFC predefined type without inventing an AC/DC or porcelain subtype',()=>{
  const text=`ISO-10303-21;HEADER;ENDSEC;DATA;
#1=IFCPROTECTIVEDEVICE('0000000000000000000001',$,'保护器',$,$,$,$,'tag');
#10=IFCPROTECTIVEDEVICETYPE('0000000000000000000010',$,'断路器型号',$,$,$,$,$,$,.CIRCUITBREAKER.);
#20=IFCRELDEFINESBYTYPE('0000000000000000000020',$,$,$,(#1),#10);
ENDSEC;END-ISO-10303-21;`;
  const index=buildSubstationSpatialIndexFromTexts([{entry,text}],null,[],undefined,ENGINEERING_EVIDENCE_FIELDS),object=index.objects.find(o=>o.expressId===1)!;
  const result=normalizeEngineeringModel('ifc-test',[toObjectEvidence(ifcSourceRecords([object])[0])]).memberships[0].interpretation;expect(result.category).toBe('E06');expect(result.equipmentType).toBeUndefined();
});

it('resolves mixed forward and backward Pset links without pulling in unrelated properties',()=>{
  const text=String.raw`ISO-10303-21;HEADER;ENDSEC;DATA;
#1=IFCBUILDINGELEMENTPROXY('0000000000000000000001',$,'保护器',$,$,$,$,$,.NOTDEFINED.);
#31=IFCPROPERTYSINGLEVALUE('Category',$,IFCLABEL('Type'),$);
#40=IFCPROPERTYSET('0000000000000000000040',$,'Inherited',$,(#31));
#12=IFCRELDEFINESBYPROPERTIES('0000000000000000000012',$,$,$,(#1),#41);
#11=IFCRELDEFINESBYTYPE('0000000000000000000011',$,$,$,(#1),#10);
#10=IFCBUILDINGELEMENTPROXYTYPE('0000000000000000000010',$,'保护器型号',$,$,(#40),$,$,$,.NOTDEFINED.);
#41=IFCPROPERTYSET('0000000000000000000041',$,'Instance',$,(#32,#33));
#32=IFCPROPERTYSINGLEVALUE('\X2\7C7B522B\X0\',$,IFCLABEL('Instance'),$);
#33=IFCPROPERTYSINGLEVALUE('Unrelated',$,IFCLABEL('Ignored'),$);
#34=IFCPROPERTYSINGLEVALUE('Category',$,IFCLABEL('Unlinked'),$);
ENDSEC;END-ISO-10303-21;`;
  const index=buildSubstationSpatialIndexFromTexts([{entry,text}],null,[],undefined,ENGINEERING_EVIDENCE_FIELDS);
  expect(index.objects.find(o=>o.expressId===1)?.propertySets).toMatchObject([
    {name:'Inherited',applicability:'type',values:[{name:'Category',value:'Type'}]},
    {name:'Instance',applicability:'instance',values:[{name:'类别',value:'Instance'}]},
  ]);
});
