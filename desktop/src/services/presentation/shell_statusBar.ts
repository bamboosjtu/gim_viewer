/** Explicit status commands; the UI owns formatting, DOM and busy arbitration. */
export interface StatusPresentation {
  popBusy:(idleText?:string,key?:string)=>void;
  pushBusy:(text:string,key?:string)=>void;
  resetStatusRight:()=>void;
  setConnectionStatus:(text:string)=>void;
  setDeviceStatus:(text:string,detail?:string)=>void;
  setIfcStatus:(text:string)=>void;
  setSelectionStatus:(label:string|null)=>void;
}
export let popBusy:StatusPresentation['popBusy'];
export let pushBusy:StatusPresentation['pushBusy'];
export let resetStatusRight:StatusPresentation['resetStatusRight'];
export let setConnectionStatus:StatusPresentation['setConnectionStatus'];
export let setDeviceStatus:StatusPresentation['setDeviceStatus'];
export let setIfcStatus:StatusPresentation['setIfcStatus'];
export let setSelectionStatus:StatusPresentation['setSelectionStatus'];
export function bind(port:StatusPresentation):void {
  if('popBusy' in port)popBusy=port.popBusy;
  if('pushBusy' in port)pushBusy=port.pushBusy;
  if('resetStatusRight' in port)resetStatusRight=port.resetStatusRight;
  if('setConnectionStatus' in port)setConnectionStatus=port.setConnectionStatus;
  if('setDeviceStatus' in port)setDeviceStatus=port.setDeviceStatus;
  if('setIfcStatus' in port)setIfcStatus=port.setIfcStatus;
  if('setSelectionStatus' in port)setSelectionStatus=port.setSelectionStatus;
}
