import recognitionFields from './recognitionFields.json';
import aliases from './sourceTypeAliases.json';
import type { EvidenceValue, ObjectEvidence, ObjectNameEvidence } from '../../engineering/types.js';
import { categoryFromName, ENGINEERING_RULES_VERSION } from '../../engineering/classify.js';
import { ENGINEERING_CATEGORY_LABELS } from '../../engineering/catalogLabels.js';
import proxyCategories from './proxyCategories.json';
import sourceVocabulary from './sourceVocabulary.json';
import {standardTerms,standardEquipmentId,STANDARD_CATALOG_VERSION} from '../../engineering/standardCatalog.js';
const vocabulary:Record<string,string>={...sourceVocabulary.equipment,...sourceVocabulary.equipmentAliases};
const components:Record<string,string>=sourceVocabulary.components;
export const ENGINEERING_RECOGNITION_VERSION=[ENGINEERING_RULES_VERSION,STANDARD_CATALOG_VERSION,sourceVocabulary.version,sourceVocabulary.keywordDictionary.version,aliases.version,proxyCategories.version].join('|');

/** Raw source records stay in the source domain, separate from engineering identity. */
export interface SourceProperty {
  sourceId?:string;
  applicability?:'instance'|'type'|'unknown';
  rawContainerName?:string;
  containerId?:string;
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
  /** A logical attribute reference with no physical DEV occurrence address. */
  attributeOnly?:boolean;
  attributeContextId?:string;
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
// Only classification fields enter this transient index; raw properties stay intact.
export const ENGINEERING_EVIDENCE_FIELDS:readonly string[]=recognitionFields;
const recognitionKeys=new Set(recognitionFields);
function createValueReader(record:SourceRecord):(labels:readonly string[])=>EvidenceValue[]{
  const selected:Array<{property:SourceProperty;index:number;keys:string[]}>=[];
  record.properties.forEach((property,index)=>{
    const keys=property.keys;if(!keys?.some(key=>recognitionKeys.has(key.toUpperCase()))||empty.has(property.value.trim()))return;
    selected.push({property,index,keys:keys.map(key=>key.toUpperCase())});
  });
  const evidence=new Map<number,EvidenceValue>();
  return labels=>{const wanted=new Set(labels.map(label=>label.toUpperCase()));
    return selected.flatMap(({property:p,index,keys})=>{
      if(!keys.some(key=>wanted.has(key)))return [];
      let value=evidence.get(index);
      if(!value){value={value:p.value,evidenceId:JSON.stringify([record.id,p.path??p.source,p.line??index,p.keys]),context:{section:p.section,container:p.containerId??p.source,rawContainerName:p.rawContainerName,applicability:p.applicability}};evidence.set(index,value);}
      return [value];
    });
  };
}

/** Format labels and type enums end here; the engineering core does not read them. */
export function toObjectEvidence(record: SourceRecord): ObjectEvidence {
  const values=createValueReader(record);
  const type = record.source_type;
  const devTypes: Readonly<Record<string, string>> = aliases.dev;
  const ifcTypes: Readonly<Record<string, string>> = aliases.ifc;
  const standardTypes=standardTerms(type);
  const standardCategories=[...new Set(standardTypes.map(item=>item.category))];
  const devCategory = ENGINEERING_CATEGORY_LABELS[type]?type:standardCategories.length===1?standardCategories[0]:devTypes[type.toLowerCase()];
  const subtypeTypes:Record<string,string>={postinsulator:'支柱绝缘子',acpillarinsulator:'支柱绝缘子',chaininsulation:'绝缘子串',insulatorssring:'绝缘子串',walltubeinsulator:'穿墙套管',acwallbushing:'穿墙套管',cabletray:'电缆桥架'};
  const categoryValue=(value:string,allowName:boolean):string=>{
    const direct=ENGINEERING_CATEGORY_LABELS[value]?value:undefined;
    const alias=devTypes[value.toLowerCase()]??ifcTypes[value.toUpperCase()];
    if(direct)return direct;
    const standard=standardTerms(value);if(standard.length===1)return standard[0].category;
    if(alias)return alias==='E01'?'E-T':alias;
    // Model/spec strings are free text ("220kV变压器模型04_散热器"), not a
    // category fact. Only explicit category/type fields may fall back to a name.
    return allowName?categoryFromName(value):'U-OBJECT';
  };
  const typeProperties=values(['TYPE','设备类型','设备类别','材料类型','构件类型','DEVICETYPE','EQUIPMENTTYPE','MATERIALTYPE']);
  const predefinedCategories=values(['IFC.PredefinedType']).flatMap(p=>{
    const value=(aliases.ifcPredefined as Record<string,string>)[`${type}.${p.value.trim().toUpperCase()}`];return value?[{...p,value}]:[];
  });
  const dictionary=sourceVocabulary.keywordDictionary;
  const keywordEntries=dictionary.entries as Record<string,{equipmentType?:string;componentType?:string;evidence:{sheet:string;cell:string;workbookSha256:string;verification:string;standardRef:string;originalLocation?:string}}>;
  const confidence=(entry:typeof keywordEntries[string])=>entry.evidence.verification==='verified'&&entry.evidence.originalLocation?'confirmed' as const:'candidate' as const;
  const standardDeclarations=[{value:type,evidenceId:`${record.id}:source_type:${type}`},...typeProperties,...values(['SYSCLASSIFYNAME','PARTNAME']).map(p=>({...p,confidence:keywordEntries[p.value.trim().toLowerCase()]?confidence(keywordEntries[p.value.trim().toLowerCase()]):'candidate' as const}))];
  const standardClasses=standardDeclarations.flatMap(p=>standardTerms(p.value).map(item=>({...p,id:item.id,kind:item.kind as 'equipment'|'material'|'construction',label:item.label,term:item.term,category:item.category})));
  const keywords=dictionary.fields.flatMap(field=>values([field]).map(p=>({field,property:p,entry:keywordEntries[p.value.trim().toLowerCase()]})));
  const keywordCategory:Record<string,string>={oil_immersed_transformer:'E-T',gis:'E05',hgis:'E05',ac_porcelain_circuit_breaker:'E06'};
  const keywordTypes=keywords.flatMap(({property,entry})=>entry?.equipmentType&&keywordCategory[entry.equipmentType]?[{...property,value:keywordCategory[entry.equipmentType],confidence:confidence(entry)}]:[]);
  const vocabularyObservations=keywords.map(({field,property,entry})=>{
    const terms=standardTerms(property.value),item=terms.length===1?terms[0]:undefined;
    return {field,rawValue:property.value,status:entry||item?'mapped' as const:'unresolved' as const,evidenceId:property.evidenceId,dictionaryVersion:entry?dictionary.version:STANDARD_CATALOG_VERSION,
      ...(entry?{verification:entry.evidence.verification as 'verified'|'unverified'|'ambiguous',standardRef:entry.evidence.standardRef,originalLocation:entry.evidence.originalLocation,dictionaryEvidence:JSON.stringify([entry.evidence.workbookSha256,entry.evidence.sheet,entry.evidence.cell,entry.evidence.verification,entry.evidence.standardRef,entry.evidence.originalLocation])}:item?{dictionaryEvidence:JSON.stringify([item.evidence.workbookSha256,item.evidence.sheet,item.evidence.nameCell,...item.evidence.termCells])}:{})};
  });
  const modelProperties=values(['型号','MODEL','MODELSPEC']);
  const nameTerm=keywordEntries[record.name.trim().toLowerCase()]??keywordEntries[(record.name.split(/[_－:：]/).pop()??'').trim().toLowerCase()];
  const componentNameCandidate=!components[type.toLowerCase()]&&!standardTypes.length&&!standardTerms(record.name).length&&(!devCategory||devCategory==='part')&&nameTerm?.componentType?
    [{value:nameTerm.componentType,evidenceId:record.nameEvidence?.find(n=>n.value===record.name)?.evidenceId??`name:${record.id}`,confidence:'candidate' as const}]:[];
  const propertyCategories=[
    ...predefinedCategories,
    ...keywordTypes.flatMap(p=>{const category=categoryValue(p.value,false);return category!=='U-OBJECT'&&category!=='part'?[{...p,value:category}]:[];}),
    ...typeProperties.flatMap(p=>{const category=categoryValue(p.value,true);return category!=='U-OBJECT'&&category!=='part'?[{...p,value:category}]:[];}),
    ...modelProperties.flatMap(p=>{const category=categoryValue(p.value,false);return category!=='U-OBJECT'&&category!=='part'?[{...p,value:category}]:[];}),
  ];
  // Generic IFC proxies may still carry explicit authoring categories. Keep
  // this conservative: generic models/electrical equipment are not a type.
  if (type === 'IFCBUILDINGELEMENTPROXY') for (const p of values( ['类别(Category)', '类别', 'Category'])) {
    const category = (proxyCategories.categories as Record<string,string>)[p.value.trim()];
    if (category) propertyCategories.push({...p, value:category});
  }
  const proxyCategory = new Set(propertyCategories.map(p => p.value));
  const proxyName = type === 'IFCBUILDINGELEMENTPROXY' && /^(?:代理构件|IfcBuildingElementProxy)$/i.test(record.name)
    && proxyCategory.size === 1 && !['E19','C-D6'].includes([...proxyCategory][0])
    ? ENGINEERING_CATEGORY_LABELS[[...proxyCategory][0]] : undefined;
  const observedCategories=[...new Set(propertyCategories.map(p=>p.value))];
  const typed=devCategory??ifcTypes[type]??(observedCategories.length===1?observedCategories[0]:undefined);
  for(const p of values(['用途','设备用途','PURPOSE'])){
    const category=/^(?:站用|station_service_transformer)$/i.test(p.value.trim())?'E03':/^(?:主变|main_transformer)$/i.test(p.value.trim())?'E01':categoryValue(p.value,true);
    // A service target such as “主变控制” is not this cabinet's identity.
    if((typed==='E01'||typed==='E-T')&&['E01','E03'].includes(category)||typed==='C-B4'&&['C-B2','C-B3'].includes(category)
      ||['IFCPUMP','IFCVALVE'].includes(type)&&/^(?:给排水设施|排水设施)$/.test(p.value))propertyCategories.push({...p,value:['IFCPUMP','IFCVALVE'].includes(type)?'C-D5':category});
  }
  return {
    declaredHostSourceIds:record.attributeOnly?record.relations?.filter(r=>r.kind==='host').map(r=>({value:r.targetSourceId,evidenceId:r.evidence})):[],
    standardClasses,
    hostCodes:values(['所属设备编码','宿主设备编码','HOSTEQUIPMENTID','HOSTEQUIPMENTCODE','PARENTEQUIPMENTID']),
    hostDesignations:values(['所属设备名称','所属设备工程中名称','宿主设备名称','HOSTEQUIPMENTNAME','PARENTEQUIPMENTNAME']),
    vocabularyObservations,
    equipmentTypeCandidates:[...standardDeclarations.flatMap(p=>standardTerms(p.value).filter(item=>item.kind==='equipment').map(item=>({...p,value:standardEquipmentId(item)}))),...(vocabulary[type.toLowerCase()]?[{value:vocabulary[type.toLowerCase()],evidenceId:`${record.id}:source_type:${type}`}]:[]),...typeProperties.flatMap(p=>vocabulary[p.value.trim().toLowerCase()]?[{...p,value:vocabulary[p.value.trim().toLowerCase()]}]:[]),...keywords.flatMap(({property:p,entry})=>entry?.equipmentType?[{...p,value:entry.equipmentType,confidence:confidence(entry)}]:[])],
    componentTypeCandidates:[...componentNameCandidate,...(components[type.toLowerCase()]?[{value:components[type.toLowerCase()],evidenceId:`${record.id}:source_type:${type}`}]:[]),...typeProperties.flatMap(p=>components[p.value.trim().toLowerCase()]?[{...p,value:components[p.value.trim().toLowerCase()]}]:[]),...keywords.flatMap(({property:p,entry})=>entry?.componentType?[{...p,value:entry.componentType,confidence:confidence(entry)}]:[])],
    ...(vocabulary[type.toLowerCase()]?{equipmentType:{value:vocabulary[type.toLowerCase()],evidenceId:`${record.id}:source_type:${type}`}}:{}),
    ...(components[type.toLowerCase()]?{componentType:{value:components[type.toLowerCase()],evidenceId:`${record.id}:source_type:${type}`}}:{}),
    purposes:/^stationtransformer$/i.test(type)?[{value:'station_service_transformer',evidenceId:`${record.id}:source_type:${type}`}]:['E01','E-T','E03'].includes(typed)?values(['用途','设备用途','PURPOSE']).flatMap(p=>/^(?:主变|主变压器|main_transformer)$/i.test(p.value.trim())?[{...p,value:'main_transformer'}]:/^(?:站用|站用变压器|station_service_transformer)$/i.test(p.value.trim())?[{...p,value:'station_service_transformer'}]:[]):[],
    sourceId: record.id, name: proxyName || record.name, assemblyParentId: record.parent || undefined,
    names: record.nameEvidence,
    typeCategory: /neutralpointequipment/i.test(type) ? 'neutral_set' : predefinedCategories.length===1?predefinedCategories[0].value:devCategory==='E01'&&type!=='E01'?'E-T':devCategory ?? ifcTypes[type.toUpperCase()],
    typeEvidenceId: predefinedCategories.length===1?predefinedCategories[0].evidenceId:`${record.id}:source_type:${type}`,
    propertyCategories:[...propertyCategories,...standardClasses.filter(p=>p.evidenceId!==`${record.id}:source_type:${type}`).map(p=>({...p,value:p.category}))],
    typeRefinements:['IFCPUMP','IFCVALVE'].includes(type)?['C-D5']:[],
    subtypeNames:[...values(['材料子类','设备子类','MATERIALSUBTYPE','EQUIPMENTSUBTYPE']),...(subtypeTypes[type.toLowerCase()]?[{value:subtypeTypes[type.toLowerCase()],evidenceId:`${record.id}:source_type:${type}`}]:[])],
    objectRoles:[...values(['对象角色','组件角色','OBJECTROLE','COMPONENTROLE']).flatMap(p=>/内部|组成|部件|component|part/i.test(p.value)?[{...p,value:'part'}]:/独立|independent/i.test(p.value)?[{...p,value:'independent'}]:[]),
      ...keywordTypes.flatMap(p=>devTypes[p.value.trim().toLowerCase()]==='part'?[{...p,value:'part'}]:[]),...(type==='IFCPILE'?[{value:'part',evidenceId:`${record.id}:pile_foundation_component`}]:[])],
    traits: {
      fastener: ['IFCMECHANICALFASTENER', 'IFCFASTENER'].includes(type),
      assemblyContainer: ['IFCELEMENTASSEMBLY', 'IFCBUILDINGELEMENTPROXY'].includes(type),
      materialType: !!devCategory?.startsWith('M'),
      nonphysical: isIfcFeatureSourceType(type),
    },
    designations: values( ['工程中名称', 'PROJECTNAME', 'Projectname']),
    identityCodes: values( ['电网工程标识系统编码', '设备编码', 'GRIDIDENTIFICATIONSYSTEMCODE']),
    identityNames: values( ['设备名称','DEVICENAME', '工程中名称', 'PROJECTNAME', 'Projectname']),
    phases: values( ['相数','PHASECOUNT']).map(p=>({...p,value:/^(?:1|单相)$/.test(p.value)?'单相':p.value})),
    phaseLabels:values(['相别','PHASE','PHASELABEL']),
  };
}
