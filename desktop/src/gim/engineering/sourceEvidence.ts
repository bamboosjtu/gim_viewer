import recognitionPolicy from '../../engineering/recognitionPolicy.json';
import {ENGINEERING_EVIDENCE_FIELDS} from './recognitionFieldPolicy.js';
import aliases from './sourceCompatibilityPolicy.json';
import type { EvidenceValue, ObjectEvidence, ObjectNameEvidence } from '../../engineering/types.js';
import { ENGINEERING_RULES_VERSION } from '../../engineering/classify.js';
import { RECOGNITION_LABELS as ENGINEERING_CATEGORY_LABELS,directoryRecognitionCode,directoryDefinition } from '../../engineering/catalogLabels.js';
import proxyCategories from './proxyCategories.json';
import sourceVocabulary from './sourceVocabulary.json';
import {standardTerms,standardEquipmentId,STANDARD_CATALOG_VERSION} from '../../engineering/standardCatalog.js';
const vocabulary:Record<string,string>={...sourceVocabulary.equipment,...sourceVocabulary.equipmentAliases};
const components:Record<string,string>=sourceVocabulary.components;
type ContextRule={modelId:string;componentId:string;materialRecognitionCode?:string;defaultKind?:string};
const contextRules=recognitionPolicy.contextualTerms as Record<string,ContextRule>;
const contextRule=(value:string)=>contextRules[value.trim().toLowerCase()];
const componentWords=Object.keys(sourceVocabulary.componentDictionary.entries).filter(word=>/[\u3400-\u9fff]/.test(word)&&word.length>=3).sort((a,b)=>b.length-a.length);
const componentNameExpression=new RegExp(componentWords.map(word=>word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'));
// Data content invalidates semantic caches even while development contracts stay v1.
const vocabularyContent=(()=>{const text=JSON.stringify([sourceVocabulary,aliases,proxyCategories]);let a=2166136261,b=2246822519;
  for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b^text.charCodeAt(i),3266489917);}
  return `${(a>>>0).toString(16).padStart(8,'0')}${(b>>>0).toString(16).padStart(8,'0')}`;})();
export const ENGINEERING_RECOGNITION_VERSION=[ENGINEERING_RULES_VERSION,STANDARD_CATALOG_VERSION,sourceVocabulary.version,sourceVocabulary.keywordDictionary.version,aliases.version,proxyCategories.version,`vocabulary-content:${vocabularyContent}`].join('|');

interface KeywordSourceEvidence {sheet:string;cell:string;workbookSha256:string;verification:string;sourceLocation?:string;sourceKind?:string}
const keywordEvidenceText=new WeakMap<KeywordSourceEvidence,string>();
/** Immutable dictionary metadata is shared, not reserialized for every occurrence. */
function keywordEvidence(evidence:KeywordSourceEvidence):string {
  let text=keywordEvidenceText.get(evidence);
  if(text===undefined){text=JSON.stringify([evidence.workbookSha256,evidence.sheet,evidence.cell,evidence.verification,evidence.sourceKind,evidence.sourceLocation]);keywordEvidenceText.set(evidence,text);}
  return text;
}

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
export {ENGINEERING_EVIDENCE_FIELDS};
const recognitionKeys=new Set(ENGINEERING_EVIDENCE_FIELDS);
function createValueReader(record:SourceRecord):(labels:readonly string[])=>EvidenceValue[]{
  const byKey=new Map<string,number[]>();
  record.properties.forEach((property,index)=>{
    const keys=property.keys;if(!keys)return;
    for(const rawKey of keys){
      const key=rawKey.toUpperCase();
      if(!recognitionKeys.has(key))continue;
      if(empty.has(property.value.trim()))continue;
      const positions=byKey.get(key)??[];if(positions[positions.length-1]!==index)positions.push(index);byKey.set(key,positions);
    }
  });
  const evidence=new Map<number,EvidenceValue>();
  return labels=>{
    const matched=labels.flatMap(label=>byKey.get(label.toUpperCase())??[]);
    if(!matched.length)return [];
    const positions=labels.length===1?matched:[...new Set(matched)].sort((a,b)=>a-b);
    return positions.map(index=>{
      const p=record.properties[index];
      let value=evidence.get(index);
      if(!value){value={value:p.value,evidenceId:JSON.stringify([record.id,p.path??p.source,p.line??index,p.keys]),context:{section:p.section,container:p.containerId??p.source,rawContainerName:p.rawContainerName,applicability:p.applicability}};evidence.set(index,value);}
      return value;
    });
  };
}

/** Format labels and type enums end here; the engineering core does not read them. */
export function toObjectEvidence(record: SourceRecord): ObjectEvidence {
  const values=createValueReader(record);
  const adapt=(equipmentMember=false):ObjectEvidence=>{
  const type = record.source_type;
  const devTypes: Readonly<Record<string, string>> = aliases.dev;
  const ifcTypes: Readonly<Record<string, string>> = aliases.ifc;
  const standardTypes=standardTerms(type);
  const standardCategories=[...new Set(standardTypes.map(item=>item.recognitionCode))];
  const devCategory = standardCategories.length===1?standardCategories[0]:directoryRecognitionCode(type)??devTypes[type.toLowerCase()];
  const categoryValue=(value:string):string=>{
    const standard=standardTerms(value);if(standard.length)return standard.length===1?standard[0].recognitionCode:'U-OBJECT';
    const direct=directoryRecognitionCode(value);
    const alias=(aliases.structured as Record<string,string>)[value.trim()]??devTypes[value.toLowerCase()]??ifcTypes[value.toUpperCase()];
    if(direct)return direct;
    if(alias)return alias==='E01'?'E-T':alias;
    // Model/spec strings are free text ("220kV变压器模型04_散热器"), not a
    // category fact. Structured fields accept exact mappings only.
    return 'U-OBJECT';
  };
  const typeProperties=values(['TYPE','类型','模型分类名称','装置名称','设备类型','设备类别','材料类型','构件类型','DEVICETYPE','EQUIPMENTTYPE','MATERIALTYPE','CONSTRUCTIONTYPE','MATERIALSUBTYPE','EQUIPMENTSUBTYPE','材料子类','设备子类']);
  const predefinedCategories=values(['IFC.PredefinedType']).flatMap(p=>{
    const value=(aliases.ifcPredefined as Record<string,string>)[`${type}.${p.value.trim().toUpperCase()}`];return value?[{...p,value}]:[];
  });
  const dictionary=sourceVocabulary.keywordDictionary;
  const keywordEntries=dictionary.entries as Record<string,{equipmentType?:string;defaultCatalogId?:string;evidence:KeywordSourceEvidence}>;
  const confidence=(entry:typeof keywordEntries[string])=>('defaultCatalogId' in entry||'defaultComponentId' in entry)||entry.evidence.verification==='verified'&&entry.evidence.sourceLocation?'confirmed' as const:'candidate' as const;
  const componentEntries=sourceVocabulary.componentDictionary.entries as Record<string,{componentType?:string;componentIds:string[];defaultComponentId?:string;evidence:KeywordSourceEvidence;evidences?:KeywordSourceEvidence[]}>;
  const independent=values(['对象角色','组件角色','OBJECTROLE','COMPONENTROLE']).some(p=>/独立|independent/i.test(p.value));
  const partRole=values(['对象角色','组件角色','OBJECTROLE','COMPONENTROLE']).some(p=>/内部|组成|部件|component|part/i.test(p.value));
  const componentContext=equipmentMember||partRole||record.attributeOnly&&!!record.relations?.some(r=>r.kind==='host')||values(['COMPONENTTYPE','部件类型','所属设备编码','宿主设备编码','HOSTEQUIPMENTID','HOSTEQUIPMENTCODE','PARENTEQUIPMENTID','所属设备名称','所属设备工程中名称','宿主设备名称','HOSTEQUIPMENTNAME','PARENTEQUIPMENTNAME']).length>0;
  const namespaceAmbiguities:string[]=[];
  const rawDeclarations=[{value:type,evidenceId:`${record.id}:source_type:${type}`},...typeProperties,...values(['SYSCLASSIFYNAME','PARTNAME','COMPONENTTYPE','部件类型']).map(p=>({...p,confidence:keywordEntries[p.value.trim().toLowerCase()]?confidence(keywordEntries[p.value.trim().toLowerCase()]):componentEntries[p.value.trim().toLowerCase()]?confidence(componentEntries[p.value.trim().toLowerCase()]):'candidate' as const}))];
  const chinese=rawDeclarations.filter(p=>/[\u3400-\u9fff]/.test(p.value)&&(standardTerms(p.value).length||componentEntries[p.value.trim().toLowerCase()]));
  const declarations=chinese.length?chinese:rawDeclarations;
  const needsChineseHint=declarations.some(p=>{const entry=componentEntries[p.value.trim().toLowerCase()];return entry&&(entry.componentIds.length>1||entry.defaultComponentId||standardTerms(p.value).length);});
  const chineseName=needsChineseHint?[...values(['设备名称','DEVICENAME']).map(p=>p.value),record.name].find(name=>/[\u3400-\u9fff]/.test(name)&&componentEntries[name.trim().toLowerCase()]):undefined;
  const componentHint=chineseName?componentEntries[chineseName.trim().toLowerCase()]:undefined;
  const groundWord=(value:string)=>!!contextRule(value)?.materialRecognitionCode;
  const materialRule=declarations.map(p=>contextRule(p.value)).find(rule=>rule?.materialRecognitionCode);
  const materialDeclarations=values(['MATERIALTYPE','材料类型']).filter(p=>groundWord(p.value));
  const groundMaterial=!!materialRule&&(materialRule.defaultKind==='material'||componentContext&&!independent||materialDeclarations.length>0||!!componentHint?.componentIds.includes(materialRule.componentId));
  const groundMember=groundMaterial&&componentContext&&!independent;
  const modelTerms=(value:string)=>groundMaterial&&groundWord(value)?[]:standardTerms(value);
  const useComponent=(value:string)=>{
    const key=value.trim().toLowerCase(),entry=componentEntries[key];
    if(!entry||groundWord(value))return false;
    const items=modelTerms(value);if(!items.length)return !independent;
    if(independent)return false;
    if(componentContext)return true;
    if(contextRule(value))return !!componentHint&&componentHint.componentIds.some(id=>entry.componentIds.includes(id));
    if(recognitionPolicy.modelPreferredTerms.includes(key))return !!componentHint&&componentHint.componentIds.some(id=>entry.componentIds.includes(id));
    namespaceAmbiguities.push(value);return false;
  };
  const componentDeclarations=declarations.filter(p=>useComponent(p.value));
  const standardDeclarations=declarations.filter(p=>!componentDeclarations.includes(p)&&!namespaceAmbiguities.includes(p.value));
  const componentIds=(value:string)=>{
    const entry=componentEntries[value.trim().toLowerCase()];
    if(componentHint){const ids=entry.componentIds.filter(id=>componentHint.componentIds.includes(id));if(ids.length)return ids;}
    return entry.defaultComponentId?[entry.defaultComponentId]:entry.componentIds;
  };
  const standardClasses=standardDeclarations.flatMap(p=>{
    const items=modelTerms(p.value),family=!items.length?directoryDefinition(p.value):undefined;
    const matches=items.length?items:family?[{id:'category:'+family.code,kind:family.kind,label:family.label,term:family.code,category:family.code,recognitionCode:directoryRecognitionCode(family.code)!,catalogCategory:family.label,catalogGroup:family.groupLabel}]:[];
    return matches.map(item=>({...p,id:item.id,kind:item.kind as 'equipment'|'material'|'construction',label:item.label,term:item.term,category:item.category,recognitionCode:item.recognitionCode,catalogCategory:item.catalogCategory,catalogGroup:item.catalogGroup}));
  });
  const keywords=dictionary.fields.flatMap(field=>values([field]).map(p=>({field,property:p,entry:keywordEntries[p.value.trim().toLowerCase()]})));
  const vocabularyObservations=keywords.map(({field,property,entry})=>{
    const component=componentEntries[property.value.trim().toLowerCase()],selected=componentDeclarations.some(p=>p.evidenceId===property.evidenceId)?component:entry;
    const terms=standardTerms(property.value),ambiguous=namespaceAmbiguities.includes(property.value)||terms.length>1||selected?.evidence.verification==='ambiguous'&&!(selected&&('defaultCatalogId' in selected||'defaultComponentId' in selected));
    const evidences=selected&&'evidences' in selected?selected.evidences as KeywordSourceEvidence[]:selected?[selected.evidence]:[];
    return {field,rawValue:property.value,status:ambiguous?'ambiguous' as const:selected?'mapped' as const:'unresolved' as const,evidenceId:property.evidenceId,dictionaryVersion:dictionary.version,
      ...(selected?{verification:ambiguous?'ambiguous' as const:selected.evidence.verification as 'verified'|'unverified'|'ambiguous',sourceLocation:selected.evidence.sourceLocation,dictionaryEvidence:JSON.stringify(evidences.map(keywordEvidence))}:{})};
  });
  for(const p of declarations){
    const terms=standardTerms(p.value),alias=devTypes[p.value.trim().toLowerCase()]??ifcTypes[p.value.trim().toUpperCase()];
    if(namespaceAmbiguities.includes(p.value)||terms.length>1||componentEntries[p.value.trim().toLowerCase()]?.evidence.verification==='ambiguous'||terms.length===1&&alias&&alias!==terms[0].recognitionCode){
      vocabularyObservations.push({field:'declaration',rawValue:p.value,status:'ambiguous',evidenceId:p.evidenceId,dictionaryVersion:dictionary.version,verification:'ambiguous',dictionaryEvidence:JSON.stringify({standard:terms.map(t=>({id:t.id,evidence:t.evidence})),component:componentEntries[p.value.trim().toLowerCase()],compatibility:alias})});
    }
  }
  const modelProperties=values(['型号','MODEL','MODELSPEC']);
  const propertyCategories=[
    ...(groundMaterial?materialDeclarations.map(p=>({...p,value:materialRule!.materialRecognitionCode!})):[]),
    ...(chinese.length?[]:predefinedCategories),
    ...typeProperties.filter(p=>declarations.includes(p)&&!(groundMaterial&&groundWord(p.value))&&!standardClasses.some(c=>c.evidenceId===p.evidenceId)&&!componentDeclarations.some(c=>c.evidenceId===p.evidenceId)&&!namespaceAmbiguities.includes(p.value)).flatMap(p=>{const category=categoryValue(p.value);return category!=='U-OBJECT'&&category!=='part'?[{...p,value:category}]:[];}),
    ...modelProperties.filter(p=>!chinese.length||/[\u3400-\u9fff]/.test(p.value)).flatMap(p=>{const category=categoryValue(p.value);return category!=='U-OBJECT'&&category!=='part'?[{...p,value:category}]:[];}),
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
  const declaredCategories=[...new Set(standardClasses.map(p=>p.recognitionCode))];
  const typed=groundMaterial?materialRule!.materialRecognitionCode:declaredCategories.length===1?declaredCategories[0]:predefinedCategories.length===1?predefinedCategories[0].value:devCategory??ifcTypes[type]??(observedCategories.length===1?observedCategories[0]:undefined);
  for(const p of values(['用途','设备用途','PURPOSE'])){
    const category=/^(?:站用|station_service_transformer)$/i.test(p.value.trim())?'E03':/^(?:主变|main_transformer)$/i.test(p.value.trim())?'E01':categoryValue(p.value);
    // A service target such as “主变控制” is not this cabinet's identity.
    if((typed==='E01'||typed==='E-T')&&['E01','E03'].includes(category)||typed==='C-B4'&&['C-B2','C-B3'].includes(category)
      ||['IFCPUMP','IFCVALVE'].includes(type)&&/^(?:给排水设施|排水设施)$/.test(p.value))propertyCategories.push({...p,value:['IFCPUMP','IFCVALVE'].includes(type)?'C-D5':category});
  }
  const needsNameCandidate=!components[type.toLowerCase()]&&!standardTypes.length&&!standardClasses.length&&!componentDeclarations.length&&!groundMaterial&&!propertyCategories.length&&(!devCategory||devCategory==='part')&&!standardTerms(record.name).length;
  const nameTerm=needsNameCandidate?componentEntries[record.name.trim().toLowerCase()]??componentEntries[(record.name.split(/[_－:：]/).pop()??'').trim().toLowerCase()]:undefined;
  const namedComponent=needsNameCandidate?nameTerm??componentEntries[componentNameExpression.exec(record.name)?.[0]??'']:undefined;
  const componentNameCandidate=namedComponent?.componentType?
    [{value:namedComponent.componentType,evidenceId:record.nameEvidence?.find(n=>n.value===record.name)?.evidenceId??`name:${record.id}`,confidence:'candidate' as const}]:[];
  return {
    declaredHostSourceIds:record.attributeOnly?record.relations?.filter(r=>r.kind==='host').map(r=>({value:r.targetSourceId,evidenceId:r.evidence})):[],
    standardClasses,
    vocabularyAmbiguities:namespaceAmbiguities,
    hostCodes:values(['所属设备编码','宿主设备编码','HOSTEQUIPMENTID','HOSTEQUIPMENTCODE','PARENTEQUIPMENTID']),
    hostDesignations:values(['所属设备名称','所属设备工程中名称','宿主设备名称','HOSTEQUIPMENTNAME','PARENTEQUIPMENTNAME']),
    vocabularyObservations,
    equipmentTypeCandidates:standardDeclarations.flatMap(p=>{const items=modelTerms(p.value).filter(item=>item.kind==='equipment');return groundMaterial&&groundWord(p.value)?[]:items.length?items.map(item=>({...p,value:standardEquipmentId(item)})):vocabulary[p.value.trim().toLowerCase()]?[{...p,value:vocabulary[p.value.trim().toLowerCase()]}]:[];}),
    componentTypeCandidates:[...(groundMember?[{value:materialRule!.componentId,evidenceId:declarations.find(p=>groundWord(p.value))!.evidenceId,confidence:'confirmed' as const}]:[]),...componentNameCandidate,...componentDeclarations.flatMap(p=>{const entry=componentEntries[p.value.trim().toLowerCase()];return componentIds(p.value).map(id=>({...p,value:id,confidence:entry.defaultComponentId||componentHint?'confirmed' as const:confidence(entry)}));})],
    purposes:/^stationtransformer$/i.test(type)?[{value:'station_service_transformer',evidenceId:`${record.id}:source_type:${type}`}]:['E01','E-T','E03'].includes(typed??'')?values(['用途','设备用途','PURPOSE']).flatMap(p=>/^(?:主变|主变压器|main_transformer)$/i.test(p.value.trim())?[{...p,value:'main_transformer'}]:/^(?:站用|站用变压器|station_service_transformer)$/i.test(p.value.trim())?[{...p,value:'station_service_transformer'}]:[]):[],
    sourceId: record.id, name: proxyName || record.name, assemblyParentId: record.parent || undefined,
    names: record.nameEvidence,
    typeCategory: groundMaterial?materialRule!.materialRecognitionCode:namespaceAmbiguities.length?undefined:componentDeclarations.length&&!standardClasses.length?'part':!declarations.some(p=>p.evidenceId===record.id+':source_type:'+type)?undefined:new Set(standardClasses.map(p=>p.id)).size===1&&standardClasses.some(p=>p.evidenceId!==`${record.id}:source_type:${type}`)&&!standardTypes.length?undefined:/neutralpointequipment/i.test(type) ? 'neutral_set' : predefinedCategories.length===1?predefinedCategories[0].value:devCategory==='E01'&&type!=='E01'?'E-T':devCategory ?? ifcTypes[type.toUpperCase()],
    typeEvidenceId: groundMaterial?declarations.find(p=>groundWord(p.value))!.evidenceId:componentDeclarations.length&&!standardClasses.length?componentDeclarations[0].evidenceId:predefinedCategories.length===1?predefinedCategories[0].evidenceId:`${record.id}:source_type:${type}`,
    propertyCategories:[...propertyCategories,...standardClasses.filter(p=>p.evidenceId!==`${record.id}:source_type:${type}`).map(p=>({...p,value:p.recognitionCode!}))],
    typeRefinements:['IFCPUMP','IFCVALVE'].includes(type)?['C-D5']:['IFCBEAM','IFCBEAMSTANDARDCASE'].includes(type)?['C-A4.steel']:['IFCCOLUMN','IFCCOLUMNSTANDARDCASE'].includes(type)?['C-A3.steel']:type==='IFCMEMBER'?['C-A14','C-A3','C-A4','C-B5','C-B7']:[],
    objectRoles:[...(groundMember?[{value:'part',evidenceId:'policy:'+recognitionPolicy.version+':material_member:'+materialRule!.componentId}]:[]),...values(['对象角色','组件角色','OBJECTROLE','COMPONENTROLE']).flatMap(p=>/^(?:source_only|非物理来源)$/i.test(p.value)?[{...p,value:'source_only'}]:/^(?:detail|细部)$/i.test(p.value)?[{...p,value:'detail'}]:/^(?:container|装配容器)$/i.test(p.value)?[{...p,value:'container'}]:/内部|组成|部件|component|part/i.test(p.value)?[{...p,value:'part'}]:/独立|independent/i.test(p.value)?[{...p,value:'independent'}]:[]),
      ...(type==='IFCPILE'?[{value:'part',evidenceId:`${record.id}:pile_foundation_component`}]:[])],
    traits: {
      fastener: ['IFCMECHANICALFASTENER', 'IFCFASTENER'].includes(type),
      assemblyContainer: ['IFCELEMENTASSEMBLY', 'IFCBUILDINGELEMENTPROXY'].includes(type),
      materialType: groundMaterial||!!devCategory?.startsWith('M'),
      nonphysical: isIfcFeatureSourceType(type),
    },
    designations: values( ['工程中名称', 'PROJECTNAME', 'Projectname']),
    identityCodes: values( ['电网工程标识系统编码', '设备编码', 'GRIDIDENTIFICATIONSYSTEMCODE']),
    identityNames: values( ['设备名称','DEVICENAME', '工程中名称', 'PROJECTNAME', 'Projectname']),
    phases: values( ['相数','PHASECOUNT']).map(p=>({...p,value:/^(?:1|单相)$/.test(p.value)?'单相':p.value})),
    phaseLabels:values(['相别','PHASE','PHASELABEL']),
  };
  };
  const result=adapt();
  const role=values(['对象角色','组件角色','OBJECTROLE','COMPONENTROLE']);
  const contextual=[record.source_type,...values(['TYPE','类型','模型分类名称','装置名称','DEVICETYPE','EQUIPMENTTYPE','MATERIALTYPE','SYSCLASSIFYNAME','PARTNAME','设备类型','设备类别','材料类型','材料子类','MATERIALSUBTYPE','设备子类','EQUIPMENTSUBTYPE','COMPONENTTYPE','部件类型']).map(p=>p.value)];
  const resolvedPart=result.objectRoles?.some(p=>p.value==='part')||result.componentTypeCandidates?.some(p=>p.confidence!=='candidate');
  if(!resolvedPart&&!role.some(p=>/独立|independent/i.test(p.value))&&contextual.some(value=>contextRule(value)))result.equipmentMemberVariant=adapt(true);
  return result;
}
