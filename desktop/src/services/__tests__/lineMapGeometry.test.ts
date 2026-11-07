// @vitest-environment node
import {expect,it} from 'vitest';
import {prepareLineMapGeometry} from '../lineMapGeometry.js';
import type {LineMapData} from '../../gim/lineMapData.js';

it('shares endpoint projections and preserves jumper/split/catenary semantics without a DOM',()=>{
  const point={lat:30,lng:120},wire={startLat:30,startLng:120,endLat:30.01,endLng:120.01,spanMeters:100,groupKind:'inter-point'};
  const data={bbox:{minLat:30,maxLat:30.01,minLng:120,maxLng:120.01},towers:[point],crosses:[{lat:30,lng:120},{lat:null,lng:null}],
    wires:[{...wire,nodeRef:{rawProps:{ISJUMPER:'true',SPLIT:'4'}}},{...wire,nodeRef:{rawProps:{}}}]} as unknown as LineMapData;
  const prepared=prepareLineMapGeometry(data,true);
  expect(prepared.runtimeWires[0].start).toBe(prepared.runtimeTowers[0].point);
  expect(prepared.runtimeCrosses[0].point).toBe(prepared.runtimeTowers[0].point);
  expect(prepared.runtimeCrosses[1].point).toBeNull();
  expect(prepared.runtimeWires[0]).toMatchObject({isJumper:true,split:4,useCatenary:false});
  expect(prepared.runtimeWires[1].useCatenary).toBe(true);
  expect(prepared.invMercY(prepared.mercY(30))).toBeCloseTo(30,10);
  expect(prepareLineMapGeometry(data,false).runtimeWires.every(row=>!row.useCatenary)).toBe(true);
});
