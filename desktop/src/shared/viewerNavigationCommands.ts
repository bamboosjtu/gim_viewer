export type NavigationMode =
  | 'orbit'
  | 'preparing'
  | 'ready'
  | 'walking'
  | 'paused'
  | 'inspecting'
  | 'returning'
  | 'operatingDoor'
  | 'pickingDevice'
  | 'restoringSelection'
  | 'exiting';
export type NavigationAction =
  | 'prepare'
  | 'pickStart'
  | 'start'
  | 'pause'
  | 'resume'
  | 'inspect'
  | 'measure'
  | 'door'
  | 'return'
  | 'exit';
const allowed: Record<NavigationMode, readonly NavigationAction[]> = {
  orbit: ['prepare'],
  preparing: ['pickStart', 'exit'],
  ready: ['pickStart', 'start', 'exit'],
  walking: ['pause', 'inspect', 'door', 'exit'],
  paused: ['resume', 'measure', 'return', 'exit'],
  inspecting: ['pause', 'resume', 'measure', 'return', 'exit'],
  returning: ['pause', 'exit'],
  operatingDoor: ['pause', 'exit'],
  pickingDevice: ['pause', 'exit'],
  restoringSelection: ['exit'],
  exiting: [],
};
export function acceptsNavigationAction(mode: NavigationMode, action: NavigationAction) {
  return allowed[mode].includes(action);
}

export class ViewerNavigationCommands extends EventTarget {
  mode: NavigationMode = 'orbit';
  message = '';
  gateHome = false;
  pickingStart = false;
  dragLook = false;
  estimated = false;
  limitedCoverage = false;
  measuring = false;
  doorHint = false;
  revision = 0;
  evidence?: () => Record<string, unknown>;
  execute?: (action: NavigationAction) => void;
  set(mode: NavigationMode, message = '') {
    if (mode !== this.mode) this.revision++;
    if (mode === this.mode && message === this.message) return;
    this.mode = mode;
    this.message = message;
    this.dispatchEvent(new Event('change'));
  }
  escape(): void {
    if (this.mode === 'preparing' || this.mode === 'ready') this.execute?.('exit');
    else if (acceptsNavigationAction(this.mode, 'pause')) this.execute?.('pause');
  }
}
