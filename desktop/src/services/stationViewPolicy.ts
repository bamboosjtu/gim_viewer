import type {AppState} from '../app/state.js';

/** Display hints only; never populate engineering voltage facts from a name. */
export function stationViewPolicy(state:Pick<AppState,'projectName'|'currentStdDoc'>):{farPlane?:number;fillFraction:number}{
  const fromName=state.projectName?.match(/\b(66|110|220|330|500|750|1000)\s*(?:kV|千伏)/i)?.[1];
  const levels=state.currentStdDoc?.substation?.voltageLevels??[];
  const voltages=levels.flatMap(level=>{
    if(level.voltage===null||!Number.isFinite(level.voltage)||level.voltage<=0)return[];
    if(level.voltageUnit&&level.voltageUnit!=='V')return[];
    const factor=level.voltageMultiplier==='k'?1:level.voltageMultiplier==='M'?1000:level.voltageMultiplier===''?.001:NaN;
    return Number.isFinite(factor)?[level.voltage*factor]:[];
  });
  const voltage=Math.max(Number(fromName)||0,...voltages);
  const farPlane=voltage<=0?undefined:voltage<=220?2000:voltage<=500?4000:voltage<=750?6000:10000;
  return {farPlane,fillFraction:.8};
}
