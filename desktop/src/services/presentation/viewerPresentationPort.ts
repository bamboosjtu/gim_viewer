import type { AppState, SelectionRequest } from '../../app/state.js';
import type { ViewerContext } from '../../viewer/viewerEngine.js';
import type { IfcRegionalRuntime } from '../../viewer/ifcRegionalRuntime.js';
import type { RegionalObject } from '../../viewer/ifcRegionalData.js';

/** A prepared properties/model view owns its DOM listeners and can detach them. */
export interface ViewerPresentation {
  bindProperties(ctx: ViewerContext): () => void;
  showElement(
    ctx: ViewerContext,
    state: AppState,
    modelId: string,
    localId: number,
    request: SelectionRequest,
  ): Promise<void>;
  showRegional(
    ctx: ViewerContext,
    state: AppState,
    runtime: IfcRegionalRuntime,
    object: RegionalObject,
    request: SelectionRequest,
  ): Promise<void>;
  addModel(ctx: ViewerContext, state: AppState, modelId: string, runtimeModelId: string): void;
  removeModel(modelId: string): void;
}
let prepare: () => Promise<ViewerPresentation>;
export function bindViewerPresentation(factory: () => Promise<ViewerPresentation>): void {
  prepare = factory;
}
export function prepareViewerPresentation(): Promise<ViewerPresentation> {
  if (!prepare) throw Error('Viewer presentation missing');
  return prepare();
}
