/**
 * 底部状态栏（共性 UI 契约见 docs/software-spec.md）。
 *
 * 左侧：项目状态（就绪 / 加载中文本 / 错误），带状态点颜色。
 * 中部：选择状态（预留）。右侧：工程统计（预留）。
 */

let statusTextEl: HTMLElement | null = null;
let statusDotEl: HTMLElement | null = null;
const busyTasks = new Map<string, string>();
let businessDeviceCount: number | null = null;
let deviceProgress = '', deviceDetail = '';

/** 空工程时右侧状态栏的稳定默认文案。 */
export const DEFAULT_STATUS_RIGHT = 'GIM BIM 浏览器';

function ensureEls(): void {
  if (statusTextEl && statusDotEl) return;
  statusTextEl = document.getElementById('status-text');
  statusDotEl = document.getElementById('status-dot');
}

export type StatusKind = 'ok' | 'loading' | 'error';

/** 设置常驻状态文本与状态点颜色 */
export function setStatus(text: string, kind: StatusKind = 'ok'): void {
  ensureEls();
  if (!statusTextEl || !statusDotEl) return;
  statusTextEl.textContent = text;
  statusDotEl.classList.toggle('loading', kind === 'loading');
  statusDotEl.classList.toggle('error', kind === 'error');
}

/** Idempotent updates to a named loading task. */
export function pushBusy(text: string, key = 'project'): void {
  busyTasks.delete(key); busyTasks.set(key,text); setStatus(text,'loading');
}
export function popBusy(idleText = '就绪', key = 'project'): void {
  busyTasks.delete(key);
  const values = [...busyTasks.values()];
  const remaining = values[values.length - 1];
  setStatus(remaining ?? idleText, remaining ? 'loading' : 'ok');
}
export function setIfcStatus(text: string): void {
  let el = document.getElementById('status-ifc');
  if (!el && text) {
    const sibling = document.getElementById('status-devices');
    if (sibling?.parentElement) { el = document.createElement('span'); el.id = 'status-ifc'; sibling.before(el); }
  }
  if (el) { el.textContent = text; el.hidden = !text; }
}

/** 更新右侧统计文本（工程统计 / 版本等） */
export function setStatusRight(text: string): void {
  const el = document.getElementById('status-right');
  if (el) el.textContent = text;
}

/** Independent device progress survives concurrent IFC/loading messages. */
export function setDeviceStatus(text: string, detail?: string): void {
  deviceProgress = text; deviceDetail = detail ?? '';
  const el = document.getElementById('status-devices');
  const display = businessDeviceCount === null ? text : `设备节点 ${businessDeviceCount}${text ? ` · ${text}` : ''}`;
  const explanation = businessDeviceCount === null ? '' : '设备节点包含装配内部的独立功能单元；几何实例统计整机装配根，两者不是一一对应。';
  if (el) { el.textContent = display; el.title = [display,explanation,detail].filter(Boolean).join('\n'); el.hidden = !display; }
}

/** Semantic equipment count is independent from renderable occurrences. */
export function setBusinessDeviceCount(count: number): void {
  businessDeviceCount = count;
  setDeviceStatus(deviceProgress,deviceDetail);
}

/** 清理工程时恢复共性状态栏，避免线路统计泄漏到下一工程。 */
export function resetStatusRight(): void {
  busyTasks.clear();
  businessDeviceCount = null;
  setIfcStatus('');
  setStatus('就绪');
  setStatusRight(DEFAULT_STATUS_RIGHT);
  setDeviceStatus('');
  setSelectionStatus(null);
}

/** Current semantic selection, including objects without displayable geometry. */
export function setSelectionStatus(label: string | null): void {
  const element=document.getElementById('status-selection');
  if (element) element.textContent=label ?? '未选中';
}
