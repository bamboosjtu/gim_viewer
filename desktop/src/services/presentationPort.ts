export interface PresentationModules {
  'cbmTreeView': typeof import('../ui/cbmTreeView.js');
  'deviceBoundsMarker': typeof import('../ui/deviceBoundsMarker.js');
  'engineeringInspector': typeof import('../ui/engineeringInspector.js');
  'engineeringTreeView': typeof import('../ui/engineeringTreeView.js');
  'fileDevView': typeof import('../ui/fileDevView.js');
  'lineProjectView': typeof import('../ui/lineProjectView.js');
  'propsDrawer': typeof import('../ui/propsDrawer.js');
  'selectionSources': typeof import('../ui/selectionSources.js');
  'sldView': typeof import('../ui/sldView.js');
}
let provider: <K extends keyof PresentationModules>(key:K)=>Promise<PresentationModules[K]>;
export function bindPresentationLoader(load: typeof provider):void { provider=load; }
export function loadPresentation<K extends keyof PresentationModules>(key:K):Promise<PresentationModules[K]> {
 if(!provider)return Promise.reject(new Error(`Presentation provider missing: ${key}`));return provider(key);
}
