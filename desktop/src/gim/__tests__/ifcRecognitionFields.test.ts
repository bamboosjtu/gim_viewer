import {it,expect} from 'vitest';
import {buildSubstationSpatialIndexFromTexts} from '../ifcSpatialParser.js';
import {ifcSourceRecords} from '../engineering/ifcSourceRecords.js';
import {toObjectEvidence,ENGINEERING_EVIDENCE_FIELDS} from '../engineering/sourceEvidence.js';
import {interpretObject} from '../../engineering/classify.js';
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
  expect(interpretObject(toObjectEvidence(ifcSourceRecords([object])[0])).category).toBe('C-C5');
});
it('exposes an inherited IFC predefined type without inventing an AC/DC or porcelain subtype',()=>{
  const text=`ISO-10303-21;HEADER;ENDSEC;DATA;
#1=IFCPROTECTIVEDEVICE('0000000000000000000001',$,'保护器',$,$,$,$,'tag');
#10=IFCPROTECTIVEDEVICETYPE('0000000000000000000010',$,'断路器型号',$,$,$,$,$,$,.CIRCUITBREAKER.);
#20=IFCRELDEFINESBYTYPE('0000000000000000000020',$,$,$,(#1),#10);
ENDSEC;END-ISO-10303-21;`;
  const index=buildSubstationSpatialIndexFromTexts([{entry,text}],null,[],undefined,ENGINEERING_EVIDENCE_FIELDS),object=index.objects.find(o=>o.expressId===1)!;
  const result=interpretObject(toObjectEvidence(ifcSourceRecords([object])[0]));expect(result.category).toBe('E06');expect(result.equipmentType).toBeUndefined();
});
