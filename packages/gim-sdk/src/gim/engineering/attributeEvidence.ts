import type { SourceAttribute } from '../../engineering/evidence.js';
import type { SourceProperty } from './sourceEvidence.js';

const keys:Record<string,string>={'额定电压':'rated_voltage',RATEDVOLTAGE:'rated_voltage','容量':'capacity','额定容量':'capacity',RATEDCAPACITY:'capacity','额定频率':'rated_frequency',RATEDFREQUENCY:'rated_frequency'};
const units:Record<string,{symbol:string;quantityKind:string;scale:number}>={V:{symbol:'V',quantityKind:'voltage',scale:1},kV:{symbol:'V',quantityKind:'voltage',scale:1000},VA:{symbol:'VA',quantityKind:'apparent_power',scale:1},kVA:{symbol:'VA',quantityKind:'apparent_power',scale:1000},MVA:{symbol:'VA',quantityKind:'apparent_power',scale:1000000},Hz:{symbol:'Hz',quantityKind:'frequency',scale:1}};

/** Conservative observed-value conversion, never a required-property check. */
export function attributeFromProperty(p:SourceProperty,index:number):SourceAttribute{
  const path=p.path??p.source??'',rawKey=p.key??p.keys?.[p.keys.length-1]??'';
  const match=p.value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-z]+)?$/);
  const rawUnit=p.rawUnit??match?.[2],number=match?Number(match[1]):NaN;
  const value=Number.isFinite(number)?number:p.value;
  const containerId=p.containerId??p.source,applicability=p.applicability??'unknown';
  const evidence=[{documentId:path,path,line:p.line,containerId,sourceId:p.sourceId}];
  const attr:SourceAttribute={id:JSON.stringify([p.sourceId,path,containerId,p.rawContainerName,p.section,applicability,p.line??index,rawKey]),rawKey,rawValue:p.value,rawUnit,rawValueType:p.rawValueType,rawSection:p.section,containerId,rawContainerName:p.rawContainerName,applicability,sourceId:p.sourceId,evidence,
    parsedValue:{status:'parsed',value:{kind:'scalar',value},method:'observed-scalar',version:'1'}};
  const propertyId=p.keys?.map(k=>keys[k]??keys[k.toUpperCase()]).find(Boolean),unit=rawUnit?units[rawUnit]:undefined;
  const quantity=propertyId==='rated_voltage'?'voltage':propertyId==='capacity'?'apparent_power':propertyId==='rated_frequency'?'frequency':undefined;
  if(propertyId&&unit&&quantity===unit.quantityKind&&Number.isFinite(number)&&Number.isFinite(number*unit.scale))
    attr.semanticValue={propertyId,value:{kind:'scalar',value:number*unit.scale},unit:{symbol:unit.symbol,quantityKind:unit.quantityKind},method:'explicit-observed-unit',version:'1'};
  return attr;
}

/** Conflicts concern comparable observations in one document/context, not standard compliance. */
export function annotateAttributeConflicts(attributes:SourceAttribute[]):SourceAttribute[]{
  const groups=new Map<string,{ids:string[];values:Set<string>}>();
  for(const attr of attributes){if(!attr.semanticValue)continue;
    const key=JSON.stringify([attr.sourceId,attr.evidence.map(ref=>ref.path),attr.semanticValue.propertyId,attr.rawSection,attr.containerId,attr.rawContainerName,attr.applicability]);
    const group=groups.get(key)??{ids:[],values:new Set<string>()};group.ids.push(attr.id);group.values.add(JSON.stringify(attr.semanticValue.value));groups.set(key,group);
  }
  const conflicts=new Map<string,string>();for(const [key,group] of groups)if(group.values.size>1)for(const id of group.ids)conflicts.set(id,key);
  return attributes.map(attr=>conflicts.has(attr.id)?{...attr,conflict:{group:conflicts.get(attr.id)!,reason:'incompatible_observations'}}:attr);
}
