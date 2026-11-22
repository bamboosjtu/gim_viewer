import {it,expect} from 'vitest';
import {stationViewPolicy} from '../stationViewPolicy.js';
it('selects fixed display depth by voltage, with an unknown-voltage fallback',()=>{
  for(const [voltage,far]of [[66,2000],[110,2000],[220,2000],[330,4000],[500,4000],[750,6000],[1000,10000]])
    expect(stationViewPolicy({projectName:`${voltage}kV standard`,currentStdDoc:null})).toEqual({farPlane:far,fillFraction:.8});
  expect(stationViewPolicy({projectName:'standard',currentStdDoc:null}).farPlane).toBeUndefined();
});
it('uses declared voltage units and the highest available display hint without mutating source facts',()=>{
  const state={projectName:'110kV standard',currentStdDoc:{substation:{voltageLevels:[{voltage:750,voltageMultiplier:'k',voltageUnit:'V'}]}}}as any;
  expect(stationViewPolicy(state).farPlane).toBe(6000);expect(state.currentStdDoc.substation.voltageLevels[0].voltage).toBe(750);
  state.currentStdDoc.substation.voltageLevels=[{voltage:500000,voltageMultiplier:'',voltageUnit:'V'}];
  expect(stationViewPolicy(state).farPlane).toBe(4000);
});
