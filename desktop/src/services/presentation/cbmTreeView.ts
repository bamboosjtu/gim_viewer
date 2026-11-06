// App-injected presentation callbacks and DOM handles. No runtime UI import.
type Port = typeof import('../../ui/cbmTreeView.js');
export let buildAndRenderCbmTree: Port['buildAndRenderCbmTree'];
export function bind(port: Port):void {
  if ('buildAndRenderCbmTree' in port) buildAndRenderCbmTree=port.buildAndRenderCbmTree;
}
