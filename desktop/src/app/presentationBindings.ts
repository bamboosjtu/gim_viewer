import {bindLoadingPresentation} from '../services/loadingPresentationPort.js';
import * as loadingView from '../ui/loadingView.js';
import {bindViewerPresentation} from '../services/viewerPresentationPort.js';
import {bindSourceInspectorPresentation} from '../services/sourceInspectorPresentationPort.js';
import { bindPublicationView } from '../services/cachePublishStatus.js';
import type { PresentationModules } from '../services/presentationPort.js';
import { bindPresentationLoader } from '../services/presentationPort.js';
import {bindEquipmentPresentation} from '../services/equipmentPresentationPort.js';
import {createEquipmentProjectPresentation} from '../ui/equipmentProjectView.js';
import * as shell_statusBar from '../ui/shell/statusBar.js';
import { bind as bind_shell_statusBar } from '../services/presentation/shell_statusBar.js';
import * as shell_projectBar from '../ui/shell/projectBar.js';
import { bind as bind_shell_projectBar } from '../services/presentation/shell_projectBar.js';
import * as dom from '../ui/dom.js';
import { bind as bind_dom } from '../services/presentation/dom.js';
import {bindProjectPresentation} from '../services/projectPresentationPort.js';
import {projectPresentation} from '../ui/projectPresentation.js';



export function configurePresentation():void {
  bindLoadingPresentation(loadingView);
  bindViewerPresentation(async()=>(await import('../ui/viewerPresentation.js')).viewerPresentation);
  bindSourceInspectorPresentation({
    error:async(...args)=>(await import('../ui/sourceInspectorPresentation.js')).sourceInspectorPresentation.error(...args),
    document:async(input)=>(await import('../ui/sourceInspectorPresentation.js')).sourceInspectorPresentation.document(input),
    context:async(input)=>(await import('../ui/sourceInspectorPresentation.js')).sourceInspectorPresentation.context(input),
  });
  bindEquipmentPresentation(createEquipmentProjectPresentation);
  if ('renderCachePublication' in shell_statusBar) bindPublicationView(shell_statusBar.renderCachePublication);
  bind_shell_statusBar(shell_statusBar);
  bind_shell_projectBar(shell_projectBar);
  bind_dom(dom);
  bindProjectPresentation(projectPresentation);
  const loaders: { [K in keyof PresentationModules]: () => Promise<PresentationModules[K]> } = {
    'cbmTreeView': () => import('../ui/cbmTreeView.js'),
    'deviceBoundsMarker': () => import('../ui/deviceBoundsMarker.js'),
    'engineeringInspector': () => import('../ui/engineeringInspector.js'),
    'engineeringTreeView': () => import('../ui/engineeringTreeView.js'),
    'fileDevView': () => import('../ui/fileDevView.js'),
    'lineProjectView': () => import('../ui/lineProjectView.js'),
    'propsDrawer': () => import('../ui/propsDrawer.js'),
    'selectionSources': () => import('../ui/selectionSources.js'),
    'sldView': () => import('../ui/sldView.js'),
  };
  bindPresentationLoader(key => loaders[key]());
}
