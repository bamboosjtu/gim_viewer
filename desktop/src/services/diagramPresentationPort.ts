import type { AppState } from '../app/state.js';
export interface DiagramPresentation {
  render(state: AppState, current: () => boolean): Promise<void>;
  onSelect(
    select: (gridId: string) => void | Promise<void>,
    current: () => boolean,
  ): Promise<() => void>;
}
let port: DiagramPresentation;
export function bindDiagramPresentation(value: DiagramPresentation): void {
  port = value;
}
export function diagramPresentation(): DiagramPresentation {
  if (!port) throw Error('Diagram presentation missing');
  return port;
}
