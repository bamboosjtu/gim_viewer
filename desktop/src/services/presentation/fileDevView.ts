// App-injected presentation callbacks and DOM handles. No runtime UI import.
type Port = typeof import('../../ui/fileDevView.js');
export let renderFileDevPanel: Port['renderFileDevPanel'];
export function bind(port: Port):void {
  if ('renderFileDevPanel' in port) renderFileDevPanel=port.renderFileDevPanel;
}
