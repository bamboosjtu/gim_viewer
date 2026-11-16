import policy from './compositionPolicy.json';
import type {EngineeringEntity} from './types.js';

/** Product composition policy, distinct from standard term evidence. */
export const COMPOSITION_POLICY=policy;
export type HostCompatibility='compatible'|'incompatible'|'unconfigured';
export function isEquipmentHost(host:Pick<EngineeringEntity,'category'|'recognitionCode'>):boolean {
  return (host.recognitionCode??host.category).startsWith('E');
}
export function componentHostCompatibility(_meaning:{componentType?:{id?:string}},host:Pick<EngineeringEntity,'category'|'recognitionCode'>):HostCompatibility {
  if(isEquipmentHost(host))return 'compatible';
  return !host.category||host.category==='U-OBJECT'?'unconfigured':'incompatible';
}
export const independentRole=(code:string)=>policy.independentRoles.includes(code)||code.startsWith('C-D');
export const separateInstallation=(code:string,host:string)=>policy.separateInstallations.includes(code)&&host.startsWith('E')
  ||code==='E09'&&host==='E18'||host.startsWith('C')&&(code.startsWith('C')&&code!==host||code.startsWith('E'));
