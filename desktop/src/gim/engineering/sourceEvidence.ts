import aliases from './sourceTypeAliases.json';
import type { EvidenceValue, ObjectEvidence, ObjectNameEvidence } from '../../engineering/types.js';
import { categoryFromName } from '../../engineering/classify.js';
import { ENGINEERING_CATEGORY_LABELS } from '../../engineering/catalogLabels.js';
import proxyCategories from './proxyCategories.json';
import sourceVocabulary from './sourceVocabulary.json';
const vocabulary:Record<string,string>={...sourceVocabulary.equipment,...sourceVocabulary.equipmentAliases};
const components:Record<string,string>=sourceVocabulary.components;

/** Raw source records stay in the source domain, separate from engineering identity. */
export interface SourceProperty {
  rawUnit?:string;
  rawValueType?:string;
  keys?: readonly string[];
  value: string;
  path?: string;
  /** IFC raw property spelling/value, before semantic decoding. */
  key?: string;
  source?: string;
  line?: number;
  rawLine?: string;
  section?: string;
}

export interface SourceRecord {
  id: string;
  track: 'dev' | 'ifc';
  source: string;
  name: string;
  nameEvidence?: ObjectNameEvidence[];
  source_type: string;
  /** Only a real DEV assembly or IFC object decomposition edge. */
  parent: string;
  properties: readonly SourceProperty[];
  sources: readonly string[];
  context: readonly string[];
  guid: string;
  devOccurrence?: { rootSourceId: string; cbmOccurrenceId: string; assemblyPath: string };
  ifcOccurrence?: { modelId: string; expressId: number; globalId: string };
  /** Hosting/space relations are evidence, not physical assembly membership. */
  relations?: Array<{ kind: 'host'; targetSourceId: string; evidence: string }>;
}

export const isIfcFeatureSourceType = (type: string): boolean => /^(?:IFCDISTRIBUTIONPORT|IFCPORT|IFCOPENINGELEMENT|IFCOPENINGSTANDARDCASE|IFCVOIDINGFEATURE|IFCFEATUREELEMENTSUBTRACTION|IFCFEATUREELEMENTADDITION|IFCFEATUREELEMENT|IFCPROJECTIONELEMENT|IFCANNOTATION|IFCGRID)$/.test(type);

const empty = new Set(['', '-', '/', '-100', '软件自动生成']);
function values(record: SourceRecord, labels: readonly string[]): EvidenceValue[] {
  return record.properties.flatMap((p, index) => p.keys?.some(key => labels.some(label=>label.toUpperCase()===key.toUpperCase())) && !empty.has(p.value.trim())
    ? [{ value: p.value, evidenceId: JSON.stringify([record.id, p.path ?? p.source, p.line ?? index, p.keys]),context:{section:p.section,container:p.source} }] : []);
}

/** Format labels and type enums end here; the engineering core does not read them. */
export function toObjectEvidence(record: SourceRecord): ObjectEvidence {
  const type = record.source_type;
  const devTypes: Readonly<Record<string, string>> = aliases.dev;
  const ifcTypes: Readonly<Record<string, string>> = aliases.ifc;
  const devCategory = ENGINEERING_CATEGORY_LABELS[type]?type:devTypes[type.toLowerCase()];
  const subtypeTypes:Record<string,string>={postinsulator:'支柱绝缘子',acpillarinsulator:'支柱绝缘子',chaininsulation:'绝缘子串',insulatorssring:'绝缘子串',walltubeinsulator:'穿墙套管',acwallbushing:'穿墙套管',cabletray:'电缆桥架'};
  const categoryValue=(value:string,allowName:boolean):string=>{
    const direct=ENGINEERING_CATEGORY_LABELS[value]?value:undefined;
    const alias=devTypes[value.toLowerCase()]??ifcTypes[value.toUpperCase()];
    if(direct)return direct;
    if(alias)return alias==='E01'?'E-T':alias;
    // Model/spec strings are free text ("220kV变压器模型04_散热器"), not a
    // category fact. Only explicit category/type fields may fall back to a name.
    return allowName?categoryFromName(value):'U-OBJECT';
  };
  const typeProperties=values(record,['TYPE','设备类型','设备类别','材料类型','构件类型','DEVICETYPE','EQUIPMENTTYPE','MATERIALTYPE']);
  const modelProperties=values(record,['型号','MODEL','MODELSPEC']);
  const propertyCategories=[
    ...typeProperties.flatMap(p=>{const category=categoryValue(p.value,true);return category!=='U-OBJECT'&&category!=='part'?[{...p,value:category}]:[];}),
    ...modelProperties.flatMap(p=>{const category=categoryValue(p.value,false);return category!=='U-OBJECT'&&category!=='part'?[{...p,value:category}]:[];}),
  ];
  // Generic IFC proxies may still carry explicit authoring categories. Keep
  // this conservative: generic models/electrical equipment are not a type.
  if (type === 'IFCBUILDINGELEMENTPROXY') for (const p of values(record, ['类别(Category)', '类别', 'Category'])) {
    const category = (proxyCategories.categories as Record<string,string>)[p.value.trim()];
    if (category) propertyCategories.push({...p, value:category});
  }
  const proxyCategory = new Set(propertyCategories.map(p => p.value));
  const proxyName = type === 'IFCBUILDINGELEMENTPROXY' && /^(?:代理构件|IfcBuildingElementProxy)$/i.test(record.name)
    && proxyCategory.size === 1 && !['E19','C-D6'].includes([...proxyCategory][0])
    ? ENGINEERING_CATEGORY_LABELS[[...proxyCategory][0]] : undefined;
  const typed=devCategory??ifcTypes[type];
  for(const p of values(record,['用途','设备用途','PURPOSE'])){
    const category=/^(?:站用|station_service_transformer)$/i.test(p.value.trim())?'E03':/^(?:主变|main_transformer)$/i.test(p.value.trim())?'E01':categoryValue(p.value,true);
    // A service target such as “主变控制” is not this cabinet's identity.
    if((typed==='E01'||typed==='E-T')&&['E01','E03'].includes(category)||typed==='C-B4'&&['C-B2','C-B3'].includes(category)
      ||['IFCPUMP','IFCVALVE'].includes(type)&&/^(?:给排水设施|排水设施)$/.test(p.value))propertyCategories.push({...p,value:['IFCPUMP','IFCVALVE'].includes(type)?'C-D5':category});
  }
  return {
    equipmentTypeCandidates:[...(vocabulary[type.toLowerCase()]?[{value:vocabulary[type.toLowerCase()],evidenceId:`${record.id}:source_type:${type}`}]:[]),...typeProperties.flatMap(p=>vocabulary[p.value.toLowerCase()]?[{...p,value:vocabulary[p.value.toLowerCase()]}]:[])],
    componentTypeCandidates:[...(components[type.toLowerCase()]?[{value:components[type.toLowerCase()],evidenceId:`${record.id}:source_type:${type}`}]:[]),...typeProperties.flatMap(p=>components[p.value.toLowerCase()]?[{...p,value:components[p.value.toLowerCase()]}]:[])],
    ...(vocabulary[type.toLowerCase()]?{equipmentType:{value:vocabulary[type.toLowerCase()],evidenceId:`${record.id}:source_type:${type}`}}:{}),
    ...(components[type.toLowerCase()]?{componentType:{value:components[type.toLowerCase()],evidenceId:`${record.id}:source_type:${type}`}}:{}),
    purposes:/^stationtransformer$/i.test(type)?[{value:'station_service_transformer',evidenceId:`${record.id}:source_type:${type}`}]:['E01','E-T','E03'].includes(typed)?values(record,['用途','设备用途','PURPOSE']).flatMap(p=>/^(?:主变|主变压器|main_transformer)$/i.test(p.value.trim())?[{...p,value:'main_transformer'}]:/^(?:站用|站用变压器|station_service_transformer)$/i.test(p.value.trim())?[{...p,value:'station_service_transformer'}]:[]):[],
    sourceId: record.id, name: proxyName || record.name, assemblyParentId: record.parent || undefined,
    names: record.nameEvidence,
    typeCategory: /neutralpointequipment/i.test(type) ? 'neutral_set' : devCategory==='E01'&&type!=='E01'?'E-T':devCategory ?? ifcTypes[type.toUpperCase()],
    typeEvidenceId: `${record.id}:source_type:${type}`,
    propertyCategories,
    typeRefinements:['IFCPUMP','IFCVALVE'].includes(type)?['C-D5']:[],
    subtypeNames:[...values(record,['材料子类','设备子类','MATERIALSUBTYPE','EQUIPMENTSUBTYPE']),...(subtypeTypes[type.toLowerCase()]?[{value:subtypeTypes[type.toLowerCase()],evidenceId:`${record.id}:source_type:${type}`}]:[])],
    objectRoles:[...values(record,['对象角色','组件角色','OBJECTROLE','COMPONENTROLE']).flatMap(p=>/内部|组成|部件|component|part/i.test(p.value)?[{...p,value:'part'}]:/独立|independent/i.test(p.value)?[{...p,value:'independent'}]:[]),...(type==='IFCPILE'?[{value:'part',evidenceId:`${record.id}:pile_foundation_component`}]:[])],
    traits: {
      fastener: ['IFCMECHANICALFASTENER', 'IFCFASTENER'].includes(type),
      assemblyContainer: ['IFCELEMENTASSEMBLY', 'IFCBUILDINGELEMENTPROXY'].includes(type),
      materialType: !!devCategory?.startsWith('M'),
      nonphysical: isIfcFeatureSourceType(type),
    },
    designations: values(record, ['工程中名称', 'PROJECTNAME', 'Projectname']),
    identityCodes: values(record, ['电网工程标识系统编码', '设备编码', 'GRIDIDENTIFICATIONSYSTEMCODE']),
    identityNames: values(record, ['设备名称','DEVICENAME', '工程中名称', 'PROJECTNAME', 'Projectname']),
    phases: values(record, ['相数','PHASECOUNT']).map(p=>({...p,value:/^(?:1|单相)$/.test(p.value)?'单相':p.value})),
    phaseLabels:values(record,['相别','PHASE','PHASELABEL']),
  };
}
