import policy from './compositionPolicy.json';
import type {EngineeringEntity} from './types.js';

/** Product composition policy, distinct from standard term evidence. */
export const COMPOSITION_POLICY=policy;
export type HostCompatibility='compatible'|'incompatible'|'unconfigured';
export function componentHostCompatibility(meaning:{componentType?:{id?:string}},host:Pick<EngineeringEntity,'category'|'recognitionCode'>):HostCompatibility {
  const id=meaning.componentType?.id;
  const allowed=id?(policy.componentHosts as Record<string,string[]|null>)[id]:undefined;
  if(!allowed)return 'unconfigured';
  return allowed.includes(host.recognitionCode??host.category)?'compatible':'incompatible';
}
export const independentRole=(code:string)=>policy.independentRoles.includes(code)||code.startsWith('C-D');
export const separateInstallation=(code:string,host:string)=>policy.separateInstallations.includes(code)&&host.startsWith('E')
  ||code==='E09'&&host==='E18'||host.startsWith('C')&&(code.startsWith('C')&&code!==host||code.startsWith('E'));
