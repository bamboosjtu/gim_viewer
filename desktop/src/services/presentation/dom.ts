// App-injected presentation callbacks and DOM handles. No runtime UI import.
type Port = typeof import('../../ui/dom.js');
export let btnLoadGim: Port['btnLoadGim'];
export let btnLoadLocal: Port['btnLoadLocal'];
export let container: Port['container'];
export let emptyTipEl: Port['emptyTipEl'];
export let fileInput: Port['fileInput'];
export let gimFileInput: Port['gimFileInput'];
export let loadingEl: Port['loadingEl'];
export function bind(port: Port):void {
  if ('btnLoadGim' in port) btnLoadGim=port.btnLoadGim;
  if ('btnLoadLocal' in port) btnLoadLocal=port.btnLoadLocal;
  if ('container' in port) container=port.container;
  if ('emptyTipEl' in port) emptyTipEl=port.emptyTipEl;
  if ('fileInput' in port) fileInput=port.fileInput;
  if ('gimFileInput' in port) gimFileInput=port.gimFileInput;
  if ('loadingEl' in port) loadingEl=port.loadingEl;
}
