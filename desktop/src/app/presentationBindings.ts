import { bindPublicationView } from '../services/cachePublishStatus.js';
import type { PresentationModules } from '../services/presentationPort.js';
import { bindPresentationLoader } from '../services/presentationPort.js';
import * as shell_statusBar from '../ui/shell/statusBar.js';
import { bind as bind_shell_statusBar } from '../services/presentation/shell_statusBar.js';
import * as shell_projectBar from '../ui/shell/projectBar.js';
import { bind as bind_shell_projectBar } from '../services/presentation/shell_projectBar.js';
import * as dom from '../ui/dom.js';
import { bind as bind_dom } from '../services/presentation/dom.js';
import * as cbmTreeView from '../ui/cbmTreeView.js';
import { bind as bind_cbmTreeView } from '../services/presentation/cbmTreeView.js';
import * as fileDevView from '../ui/fileDevView.js';
import { bind as bind_fileDevView } from '../services/presentation/fileDevView.js';
export function configurePresentation():void {
  if ('renderCachePublication' in shell_statusBar) bindPublicationView(shell_statusBar.renderCachePublication);
  bind_shell_statusBar(shell_statusBar);
  bind_shell_projectBar(shell_projectBar);
  bind_dom(dom);
  bind_cbmTreeView(cbmTreeView);
  bind_fileDevView(fileDevView);
  const loaders: { [K in keyof PresentationModules]: () => Promise<PresentationModules[K]> } = {
    'cbmTreeView': () => import('../ui/cbmTreeView.js'),
    'deviceBoundsMarker': () => import('../ui/deviceBoundsMarker.js'),
    'dom': () => import('../ui/dom.js'),
    'engineeringInspector': () => import('../ui/engineeringInspector.js'),
    'engineeringTreeView': () => import('../ui/engineeringTreeView.js'),
    'fileDevView': () => import('../ui/fileDevView.js'),
    'lineProjectView': () => import('../ui/lineProjectView.js'),
    'modelList': () => import('../ui/modelList.js'),
    'propsDrawer': () => import('../ui/propsDrawer.js'),
    'selectionSources': () => import('../ui/selectionSources.js'),
    'shell_projectBar': () => import('../ui/shell/projectBar.js'),
    'shell_statusBar': () => import('../ui/shell/statusBar.js'),
    'sldView': () => import('../ui/sldView.js'),
    'tabs': () => import('../ui/tabs.js'),
  };
  bindPresentationLoader(key => loaders[key]());
}
