// App-injected presentation callbacks and DOM handles. No runtime UI import.
type Port = typeof import('../../ui/shell/statusBar.js');
export let popBusy: Port['popBusy'];
export let pushBusy: Port['pushBusy'];
export let resetStatusRight: Port['resetStatusRight'];
export let setConnectionStatus: Port['setConnectionStatus'];
export let setDeviceStatus: Port['setDeviceStatus'];
export let setIfcStatus: Port['setIfcStatus'];
export let setSelectionStatus: Port['setSelectionStatus'];
export function bind(port: Port):void {
  if ('popBusy' in port) popBusy=port.popBusy;
  if ('pushBusy' in port) pushBusy=port.pushBusy;
  if ('resetStatusRight' in port) resetStatusRight=port.resetStatusRight;
  if ('setConnectionStatus' in port) setConnectionStatus=port.setConnectionStatus;
  if ('setDeviceStatus' in port) setDeviceStatus=port.setDeviceStatus;
  if ('setIfcStatus' in port) setIfcStatus=port.setIfcStatus;
  if ('setSelectionStatus' in port) setSelectionStatus=port.setSelectionStatus;
}
