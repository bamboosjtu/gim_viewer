export type NavigationMode =
  'orbit' | 'preparing' | 'ready' | 'walking' | 'paused' | 'inspecting' | 'returning';
export type NavigationAction =
  'prepare' | 'start' | 'pause' | 'resume' | 'inspect' | 'measure' | 'door' | 'return' | 'exit';
export class ViewerNavigationCommands extends EventTarget {
  mode: NavigationMode = 'orbit';
  message = '';
  dragLook = false;
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
    else if (this.mode !== 'paused' && this.mode !== 'orbit') this.execute?.('pause');
  }
}
