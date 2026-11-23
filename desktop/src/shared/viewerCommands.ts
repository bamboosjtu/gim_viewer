export type Tool = 'select' | 'display' | 'section' | 'distance' | 'view';
export type Vec3 = [number, number, number];
export interface SurfacePoint {
  xyz: Vec3;
  source: string;
  lod: string;
}
export interface DistanceResult {
  id: number;
  a: SurfacePoint;
  b: SurfacePoint;
  metres: number;
}
export interface Section {
  kind: 'horizontal' | 'vertical' | 'box';
  enabled: boolean;
  flipped: boolean;
  azimuth: number;
  offset: number;
  min: Vec3;
  max: Vec3;
}
export interface ToolOptions {
  models: { id: string; label: string; visible: boolean }[];
  types: string[];
  floors: { id: string; label: string }[];
}
export type CameraAction =
  'orbit' | 'pan' | 'zoomIn' | 'zoomOut' | 'home' | 'top' | 'front' | 'right' | 'iso' | 'back';
export type ViewerCommand =
  | { kind: 'camera'; action: CameraAction }
  | { kind: 'tool'; tool: Tool }
  | {
      kind:
        | 'hide'
        | 'isolate'
        | 'restore'
        | 'cancelPoint'
        | 'clearDistances'
        | 'clearSection'
        | 'refreshOptions';
    }
  | { kind: 'section'; value: Section }
  | { kind: 'startSection'; shape: Section['kind'] }
  | { kind: 'model'; id: string; visible: boolean }
  | { kind: 'type'; id: string; visible: boolean }
  | { kind: 'floor'; id: string; inferred: boolean }
  | { kind: 'removeDistance'; id: number };
export interface ToolSnapshot {
  tool: Tool;
  cameraMode: 'orbit' | 'pan';
  section?: Section;
  first?: SurfacePoint;
  distances: readonly DistanceResult[];
  options: ToolOptions;
  hiddenTypes: readonly string[];
  hasMask: boolean;
  floor: string;
  inferred: boolean;
  message: string;
}
export function initialToolState(): ToolSnapshot {
  return {
    tool: 'select',
    cameraMode: 'orbit',
    distances: [],
    options: { models: [], types: [], floors: [] },
    hiddenTypes: [],
    hasMask: false,
    floor: '',
    inferred: false,
    message: '',
  };
}
/** One command endpoint shared by the toolbar, menu and inspector. */
export type ReadonlyToolState<T> = T extends object
  ? { readonly [K in keyof T]: ReadonlyToolState<T[K]> }
  : T;
export interface ViewerCommandPort extends EventTarget {
  readonly snapshot: ReadonlyToolState<ToolSnapshot>;
  readonly available: boolean;
  dispatch(command: ViewerCommand): void;
}
export class ViewerCommands extends EventTarget implements ViewerCommandPort {
  get available() {
    return !!this.execute;
  }
  snapshot = initialToolState();
  execute?: (command: ViewerCommand) => Promise<void>;
  cleanup?: () => void;
  private epoch = 0;
  notify() {
    this.dispatchEvent(new Event('change'));
  }
  dispatch(command: ViewerCommand) {
    const epoch = ++this.epoch;
    if (!this.execute) return;
    this.execute(command).catch((error: unknown) => {
      if (epoch === this.epoch) {
        this.snapshot.message = String(error);
        this.notify();
      }
    });
  }
  reset() {
    this.epoch++;
    this.cleanup?.();
    this.snapshot = initialToolState();
    this.notify();
  }
}
