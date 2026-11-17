import type { AppState } from '../app/state.js';
import type { GimGraph } from '@gim/powerline-core/gimGraphTypes.js';
import type { PerfSession } from '../utils/perfTimings.js';
export interface LineRenderOptions {
  perfSession?: PerfSession;
  enableCatenary?: boolean;
}
export interface LineProjectViewHandle {
  destroy(): void;
}
export interface LinePresentation {
  present(
    state: AppState,
    graph: GimGraph,
    message: (text: string) => void,
    options: LineRenderOptions,
    current: () => boolean,
  ): Promise<LineProjectViewHandle | undefined>;
}
let port: LinePresentation;
export function bindLinePresentation(value: LinePresentation): void {
  port = value;
}
export function linePresentation(): LinePresentation {
  if (!port) throw Error('Line presentation missing');
  return port;
}
