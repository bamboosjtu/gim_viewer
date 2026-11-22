import type { AppState } from '../../../app/state.js';
import type { LineProjectProjection } from './lineProjectProjection.js';
import type { PerfSession } from '../../../utils/perfTimings.js';
/** Minimal map surface a host probe needs; services stay free of maplibre types. */
export interface LineMapEventTarget {
  on(type: string, listener: () => void): unknown;
  off(type: string, listener: () => void): unknown;
}
export interface LineRenderOptions {
  perfSession?: PerfSession;
  enableCatenary?: boolean;
  /** Injected by the presentation binding so ui never imports measurement. */
  observeMapFrames?: (map: LineMapEventTarget) => void;
}
export interface LineProjectViewHandle {
  destroy(): void;
}
export interface LinePresentation {
  present(
    state: AppState,
    prepare: () => LineProjectProjection,
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
