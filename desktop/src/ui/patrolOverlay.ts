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
  const panel = document.createElement('div');
  panel.className = 'patrol-panel';
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  const cross = document.createElement('div');
  cross.className = 'patrol-crosshair';
  cross.setAttribute('aria-hidden', 'true');
  cross.textContent = '+';
  panel.append(status);
  const start = button(panel, '开始巡视', 'start');
  const choose = button(panel, '自选起点', 'pickStart');
  const resume = button(panel, '继续巡视', 'resume');
  const measure = button(panel, '两点测量', 'measure');
  const home = button(panel, '返回巡视入口', 'return');
  const cancel = button(panel, '取消操作', 'pause');
  const exit = button(panel, '退出巡视', 'exit');
  viewport.append(panel, cross);
  const render = () => {
    const mode = port.mode;
    viewport.dataset.navigation = mode;
    panel.hidden = mode === 'orbit';
    cross.hidden = mode !== 'walking';
    const active = mode !== 'orbit';
    enter.setAttribute('aria-pressed', String(active));
    enter.setAttribute('aria-label', active ? '退出巡视' : '进入巡视');
    enter.dataset.tip = active ? '退出巡视，恢复自由浏览视角' : '进入第一人称巡视';
    start.hidden = mode !== 'ready';
    choose.hidden = (mode !== 'preparing' && mode !== 'ready') || port.pickingStart;
    home.textContent = port.gateHome ? '返回大门' : '返回巡视入口';
    resume.hidden = home.hidden = mode !== 'paused' && mode !== 'inspecting';
    cancel.hidden = !['returning', 'operatingDoor', 'pickingDevice'].includes(mode);
    exit.disabled = enter.disabled = mode === 'exiting';
    measure.hidden = !acceptsNavigationAction(mode, 'measure') || port.measuring;
    status.textContent =
      port.message ||
      (mode === 'walking'
        ? 'WASD 行走 · Shift 加速 · ' +
          (port.dragLook ? '按住左键拖动环顾' : '鼠标环顾') +
          ' · F 检查' +
          (port.doorHint ? ' · E 操作门' : '') +
          ' · Esc 暂停'
        : mode === 'inspecting'
          ? '检查设备'
          : '巡视已暂停');
    if (mode === 'walking' || mode === 'ready' || mode === 'paused') {
      if (port.estimated) status.textContent += ' · 附近使用近似碰撞模型';
      if (port.limitedCoverage) status.textContent += ' · 部分来源范围未知';
    }
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
      enter.remove();
      panel.remove();
      cross.remove();
    },
  };
}
