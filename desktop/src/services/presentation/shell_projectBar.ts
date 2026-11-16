// App-injected presentation callbacks and DOM handles. No runtime UI import.
interface Port {
  refreshNavigatorTitle():void;
  setProjectIdentity(name:string|null,kind:'substation'|'transmission_line'|'equipment'|null):void;
}
export let refreshNavigatorTitle: Port['refreshNavigatorTitle'];
export let setProjectIdentity: Port['setProjectIdentity'];
export function bind(port: Port):void {
  if ('refreshNavigatorTitle' in port) refreshNavigatorTitle=port.refreshNavigatorTitle;
  if ('setProjectIdentity' in port) setProjectIdentity=port.setProjectIdentity;
}
