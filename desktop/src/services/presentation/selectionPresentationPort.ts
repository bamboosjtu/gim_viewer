import type { AppState, SelectionRequest } from '../../app/state.js';
import type { CbmNode } from '../../gim/types.js';
import type { ViewerContext } from '../../viewer/viewerEngine.js';
import type { EngineeringInspectorInput } from '../engineering/engineeringInspectorModel.js';
export interface SourceChoice {
  label: string;
  choose(): void;
}
export interface NodeInspector {
  show(node: CbmNode, ctx?: ViewerContext): Promise<void>;
}
export interface SelectionPresentation {
  nodeInspector(state: AppState, request: SelectionRequest): Promise<NodeInspector>;
  syncNavigation(
    state: AppState,
    request: SelectionRequest,
    lookup: () => Promise<() => string | null>,
  ): Promise<void>;
  chooseSources(message: string, choices: SourceChoice[], current: () => boolean): Promise<void>;
  unlinkedDiagram(state: AppState, gridId: string, request: SelectionRequest): Promise<void>;
  sourceTree(state: AppState, current: () => boolean): Promise<void>;
  engineeringTree(state: AppState, sourceId: string | null, current: () => boolean): Promise<void>;
  refreshEngineeringTree(state: AppState, current: () => boolean): Promise<void>;
  engineeringInspector(model: EngineeringInspectorInput, current: () => boolean): Promise<void>;
  projectionChanged(message: string, current: () => boolean): Promise<void>;
}
let port: SelectionPresentation;
export function bindSelectionPresentation(value: SelectionPresentation): void {
  port = value;
}
export function selectionPresentation(): SelectionPresentation {
  if (!port) throw Error('Selection presentation missing');
  return port;
}
