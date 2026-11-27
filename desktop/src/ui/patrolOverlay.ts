import { acceptsNavigationAction } from '../shared/viewerNavigationCommands.js';
import { toolGlyph } from './viewerToolIcons.js';
import type {
  NavigationAction,
  ViewerNavigationCommands,
} from '../shared/viewerNavigationCommands.js';

export function mountPatrolOverlay(
  port: ViewerNavigationCommands,
  group: HTMLElement,
  viewport: HTMLElement,
) {
  const button = (parent: HTMLElement, label: string, action: NavigationAction) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = label;
    el.onclick = () => port.execute?.(action);
    parent.append(el);
    return el;
  };
  const enter = button(group, '进入巡视', 'prepare');
  toolGlyph(enter, 'patrol', '进入巡视', '进入第一人称巡视');
  enter.onclick = () => port.execute?.(port.mode === 'orbit' ? 'prepare' : 'exit');
  const hud = document.createElement('div');
  hud.className = 'patrol-hud';
  const walking = document.createElement('section');
  walking.className = 'patrol-walking';
  walking.setAttribute('aria-label', '第一人称巡视');
  const pause = button(walking, '暂停', 'pause');
  pause.className = 'patrol-pause';
  pause.title = 'Esc';
  const cross = document.createElement('div');
  cross.className = 'patrol-crosshair';
  cross.setAttribute('aria-hidden', 'true');
  const keys = document.createElement('div');
  keys.className = 'patrol-keys';
  keys.innerHTML =
    '<span><kbd>WASD</kbd> 行走</span><span><kbd>Shift</kbd> 加速</span>' +
    '<span><kbd>鼠标</kbd> <span data-patrol-look></span></span><span><kbd>F</kbd> 查看属性</span>';
  const look = keys.querySelector('[data-patrol-look]')!;
  const door = document.createElement('div');
  door.className = 'patrol-door';
  door.innerHTML = '<kbd>E</kbd> 操作门';
  walking.append(cross, keys, door);

  const backdrop = document.createElement('div');
  backdrop.className = 'patrol-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  const panel = document.createElement('section');
  panel.className = 'patrol-panel';
  const title = document.createElement('h2');
  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.className = 'patrol-actions';
  panel.append(title, status, actions);
  const start = button(actions, '开始巡视', 'start');
  const choose = button(actions, '自选起点', 'pickStart');
  const resume = button(actions, '继续巡视', 'resume');
  const measure = button(actions, '两点测量', 'measure');
  const home = button(actions, '返回巡视入口', 'return');
  const cancel = button(actions, '取消操作', 'pause');
  const exit = button(actions, '退出巡视', 'exit');
  start.className = resume.className = 'patrol-primary';
  hud.append(walking, backdrop, panel);
  viewport.append(hud);

  const drawer = viewport.closest('#main')?.querySelector('#props-drawer');
  let drawerCollapsed: boolean | undefined;
  const restoreDrawer = () => {
    if (drawerCollapsed !== undefined) drawer?.classList.toggle('collapsed', drawerCollapsed);
    drawerCollapsed = undefined;
  };
  const render = () => {
    const mode = port.mode;
    const previous = viewport.dataset.navigation;
    const active = mode !== 'orbit';
    const immersive =
      active &&
      mode !== 'preparing' &&
      mode !== 'ready' &&
      mode !== 'failed' &&
      (mode !== 'exiting' || viewport.hasAttribute('data-patrol-active'));
    const isWalking = mode === 'walking';
    if (immersive && drawer && drawerCollapsed === undefined)
      drawerCollapsed = drawer.classList.contains('collapsed');
    else if (!active) restoreDrawer();
    viewport.dataset.navigation = mode;
    viewport.toggleAttribute('data-patrol-active', immersive);
    hud.hidden = !active;
    walking.hidden = !isWalking;
    door.hidden = !port.doorHint;
    look.textContent = port.dragLook ? '按住左键拖动' : '环顾';
    backdrop.hidden = mode !== 'paused';
    const activeMessage = isWalking && port.message !== '开始巡视' ? port.message : '';
    panel.hidden = isWalking && !activeMessage && !port.estimated;
    title.textContent =
      mode === 'paused' ? '巡视暂停' : mode === 'inspecting' && !port.measuring ? '检查对象' : '';
    title.hidden = !title.textContent;
    status.textContent = isWalking
      ? activeMessage
      : port.message || (mode === 'paused' ? '继续从当前位置巡视' : '');
    if ((isWalking || mode === 'paused') && port.estimated)
      status.textContent = [status.textContent, '附近使用近似碰撞模型'].filter(Boolean).join(' · ');
    if ((mode === 'paused' || mode === 'ready') && port.unknownSourceCount)
      status.textContent = [status.textContent, `${port.unknownSourceCount} 个来源的碰撞范围未知`]
        .filter(Boolean)
        .join(' · ');
    enter.setAttribute('aria-pressed', String(active));
    enter.setAttribute('aria-label', active ? '退出巡视' : '进入巡视');
    enter.dataset.tip = active ? '退出巡视，恢复自由浏览视角' : '进入第一人称巡视';
    start.hidden = !acceptsNavigationAction(mode, 'start');
    choose.hidden =
      !acceptsNavigationAction(mode, 'pickStart') || port.pickingStart || port.compiling;
    home.textContent = port.gateHome ? '返回大门' : '返回巡视入口';
    resume.hidden = !acceptsNavigationAction(mode, 'resume');
    home.hidden = !acceptsNavigationAction(mode, 'return');
    cancel.hidden = !['returning', 'operatingDoor', 'pickingDevice'].includes(mode);
    exit.hidden = isWalking || !acceptsNavigationAction(mode, 'exit');
    enter.disabled = mode === 'exiting';
    measure.hidden = !acceptsNavigationAction(mode, 'measure') || port.measuring;
    actions.hidden = !Array.from(actions.children).some((child) => !(child as HTMLElement).hidden);
    if (mode === 'paused' && previous !== mode) resume.focus({ preventScroll: true });
  };
  let consumed = false;
  const key = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || (port.mode === 'orbit' && !consumed)) return;
    event.preventDefault();
    if (consumed || event.repeat) return;
    consumed = true;
    port.escape();
  };
  const up = (event: KeyboardEvent) => {
    if (event.key === 'Escape') consumed = false;
  };
  const blur = () => {
    consumed = false;
  };
  document.addEventListener('keydown', key, true);
  document.addEventListener('keyup', up, true);
  window.addEventListener('blur', blur);
  port.addEventListener('change', render);
  render();
  return {
    enter,
    dispose() {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
      port.removeEventListener('change', render);
      delete viewport.dataset.navigation;
      viewport.removeAttribute('data-patrol-active');
      restoreDrawer();
      enter.remove();
      hud.remove();
    },
  };
}
