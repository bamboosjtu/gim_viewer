import { reportBackgroundError } from '../utils/backgroundErrors.js';
import {selectionPresentation} from './selectionPresentationPort.js';
import {diagramPresentation} from './diagramPresentationPort.js';
import { isSubstationViewerInteractive } from './substationLoadingState.js';
/** Substation navigation, selection callbacks and loading presentation. */
import { setSelectionStatus } from './presentation/shell_statusBar.js';
import type { CbmNode } from '../gim/types.js';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import {projectPresentation} from './projectPresentationPort.js';


import { perfBegin, perfMarkProductMoment, type PerfSession } from '../utils/perfTimings.js';
import { showLoading } from './gimOpenCore.js';


export function collectCbmNodeCount(root: CbmNode | null): number {
  if (!root) return 0;
  let count = 0;
  const walk = (node: CbmNode): void => {
    count += 1;
    for (const child of node.children) walk(child);
  };
  walk(root);
  return count;
}

export function createNodeClickHandler(state: AppState, showMessage: (text: string) => void): (node: CbmNode) => void {
  const session = state.captureProjectSession();
  return (node: CbmNode) => {
    if (!state.isCurrentSession(session)) return;
    if (state.currentProjectType === 'substation') {
      const request = state.beginSelection({ kind: 'engineering-source', key: `document:${node.path}` });
      if (!state.engineering.sources) {
        state.selectionMessage = '工程来源正在准备，完成后可定位该对象'; setSelectionStatus(state.selectionMessage);
        void Promise.resolve(import('./engineeringSelection.js').then(({ clearEngineeringHighlight }) => clearEngineeringHighlight(state, request))).catch(reportBackgroundError); return;
      }
      void import('./engineeringCbmSelection.js').then(async ({ selectEngineeringCbmSource }) => {
        if (state.isCurrentSelection(request) && !await selectEngineeringCbmSource(state, node.path, request) && state.isCurrentSelection(request)) {
          state.selectionMessage = '该来源尚不能唯一定位，请在来源视图核对'; setSelectionStatus(state.selectionMessage);
          void Promise.resolve(import('./engineeringSelection.js').then(({ clearEngineeringHighlight }) => clearEngineeringHighlight(state, request))).catch(reportBackgroundError);
        }
      }).catch(error => { if (state.isCurrentSelection(request)) { state.selectionMessage = `来源定位未完成：${String(error)}`; setSelectionStatus(state.selectionMessage); } });
      return;
    }
    const request = state.beginSelection({ kind: 'cbm', key: node.path });
    void import('./nodeInteractionService.js').then(({ handleNodeClick }) =>
      handleNodeClick(state, node, showMessage, request),
    ).catch((error) => console.warn('[选择] 节点交互失败:', error));
  };
}

export function setupSldGridIdInteraction(state:AppState,showMessage:(text:string)=>void,session?:ProjectLoadSession):Promise<void>{
  const scope=state.sessionScope(session??state.captureProjectSession());
  const selected=async (gridId: string) => {
      if (session && !state.isCurrentSession(session)) return;
      if (!state.currentStdSldIndex) return;
      const request = state.beginSelection({ kind: 'sld', key: gridId });
      try {
        const { getCbmNodesByGridId } = await import('../gim/stdSldIndex.js');
        if (session && !state.isCurrentSession(session)) return;
        const nodes = getCbmNodesByGridId(state.currentStdSldIndex, gridId);
        if (nodes.length === 0) {
          const {clearSelectionHighlight,syncSelectionNavigation}=await import('./nodeInteractionService.js');
          if (!state.isCurrentSelection(request)) return;
          await selectionPresentation().unlinkedDiagram(state,gridId,request);
          await Promise.all([clearSelectionHighlight(state, request, showMessage), syncSelectionNavigation(state, request)]);
          console.log('[SLD→CBM] gridId 无对应 CBM 节点:', gridId);
          return;
        }
        if (state.currentProjectType === 'substation') {
          if (!state.isCurrentSelection(request)) return;
          if (!state.engineering.sources) { state.selectionMessage = '工程来源正在准备，完成后可定位单线图对象'; setSelectionStatus(state.selectionMessage); return; }
          if (nodes.length === 1) {
            const { selectEngineeringCbmSource } = await import('./engineeringCbmSelection.js');
            if (state.isCurrentSelection(request)) await selectEngineeringCbmSource(state, nodes[0].path, request);
          } else {
            const { clearEngineeringHighlight } = await import('./engineeringSelection.js'); await clearEngineeringHighlight(state, request);
            if (state.isCurrentSelection(request)) await selectionPresentation().chooseSources('该单线图对象关联多个来源，请选择要查看的来源', nodes.map(node => ({
              label: `${node.name || '来源对象'} · ${node.path}`,
              choose: () => { if (state.isCurrentSelection(request)) createNodeClickHandler(state, showMessage)(node); },
            })), () => state.isCurrentSelection(request));
          }
          return;
        }
        const { handleNodeClick } = await import('./nodeInteractionService.js');
        if (session && !state.isCurrentSession(session)) return;
        request.target = { kind: 'cbm', key: nodes[0].path };
        await handleNodeClick(state, nodes[0], showMessage, request);
      } catch (err) {
        console.warn('[SLD→CBM] 联动失败:', err);
      }
    };
  return diagramPresentation().onSelect(async gridId=>{if(scope.isCurrent())await selected(gridId);},scope.isCurrent)
    .then(dispose=>{scope.own(dispose);}).catch(error=>{if(scope.isCurrent())console.warn('[SLD→CBM] 注册联动回调失败:',error);});
}

export function markSubstationCoreSemanticReady(
  state: AppState,
  perfSession: PerfSession,
  meta: Record<string, unknown> = {},
): void {
  const coreMeta = {
    ...meta,
    cbmNodes: collectCbmNodeCount(state.currentCbmTree),
    ifcEntries: state.currentIfcEntries.length,
    fileDevRelations: state.fileDevRelations.length,
    deviceIfcLinks: state.deviceToIfcFile.size,
  };
  perfMarkProductMoment('coreSemanticReady', coreMeta, perfSession);
  // Keep the old product moment as a compatibility alias for existing
  // diagnostics/scripts.  New consumers should use coreSemanticReady.
  perfMarkProductMoment('semanticReady', { ...coreMeta, compatibilityAlias: 'coreSemanticReady' }, perfSession);
}

export async function renderSubstationCoreUi(
  state: AppState,
  showMessage: (text: string) => void,
  session: ProjectLoadSession,
  perfSession: PerfSession,
  label: string,
): Promise<void> {
  if (!state.isCurrentSession(session)) return;
  const endUi = perfBegin(label, undefined, perfSession);
  const clickHandler = createNodeClickHandler(state, showMessage);
  await projectPresentation().renderNavigation(state,clickHandler,()=>state.isCurrentSession(session));
  if(!state.isCurrentSession(session))return;
  endUi(undefined, {
    cbmNodes: collectCbmNodeCount(state.currentCbmTree),
    ifcModels: state.currentIfcEntries.length,
    spatialIndex: state.substationSpatialIndex != null,
  });
  // DOM readiness is independent from the first usable 3D representation.
  // This does not certify paint or input latency; native acceptance verifies
  // the visible tree/search separately. Later enrichment keeps the first mark.
  if (state.isCurrentSession(session) && state.currentCbmTree) {
    perfMarkProductMoment('navigationUiReady', {
      cbmNodes: collectCbmNodeCount(state.currentCbmTree),
      ifcEntries: state.currentIfcEntries.length,
      stage: label,
      scope: 'navigation-dom',
      inputLatencyVerified: false,
    }, perfSession);
  }
}

/** Background DEV/cache progress stays in the status bar after first IFC. */
export function showLoadingBeforeInteractive(text: string): void {
  if (!isSubstationViewerInteractive()) showLoading(text);
}
