import data from './geometryRequirements.json';
import attributes from './attributeDefinitions.json';

export interface RequirementEvidence {standardRef:string;pdfPage:number;printedPage:number;field:string;documentDigest:string;verification:string;reviewRecordId:string|null}
export interface RequirementField {value:string;rawText:string;evidence:RequirementEvidence}
export interface GeometryRequirement {id:string;equipmentType:string;table:string;fields:Record<string,RequirementField>}
export const REQUIREMENTS_VERSION=data.version;
export function attributeDefinitionContext(context:{standardVersion?:string;equipmentType?:string}){
  const definitions=context.standardVersion==='Q/GDW 11810.1—2023'&&context.equipmentType?attributes.records.filter(r=>r.equipmentType===context.equipmentType):[];
  return structuredClone({context,resourceVersion:attributes.version,coverage:'selected-observed-attribute-definitions',definitions});
}
const records=data.records as GeometryRequirement[];
const byType=new Map<string,GeometryRequirement[]>();
for(const record of records){const rows=byType.get(record.equipmentType)??[];rows.push(record);byType.set(record.equipmentType,rows);}

/** Metadata lookup only. No model, mesh, identity or compliance result as input. */
export function requirementContext(context:{standardVersion?:string;equipmentType?:string;modelType?:'generic'|'product'}){
  const candidates=context.standardVersion==='Q/GDW 11810.1—2023'&&context.equipmentType?byType.get(context.equipmentType)??[]:[];
  const applicableRequirements:Array<{id:string;componentName?:string;modelRequirement?:string;fields:Record<string,RequirementField>}> = [];
  let partial=false;
  for(const row of candidates){
    const fields:Record<string,RequirementField>={};
    for(const [key,field] of Object.entries(row.fields))if(field.evidence.verification==='verified')fields[key]=field;else partial=true;
    const model=context.modelType==='generic'?'genericModel':'productModel';
    applicableRequirements.push({id:row.id,componentName:fields.componentName?.value,modelRequirement:context.modelType?fields[model]?.value:undefined,fields});
  }
  return structuredClone({context:{...context},resourceVersion:REQUIREMENTS_VERSION,status:!candidates.length||!context.modelType?'unknown' as const:partial?'partial' as const:'resolved' as const,applicableRequirements});
}
