/**
 * 底部状态栏（共性 UI 契约见 docs/software-spec.md）。
 *
 * 左侧：项目状态（就绪 / 加载中文本 / 错误），带状态点颜色。
 * 中部：选择状态（预留）。右侧：工程统计（预留）。
 */

let statusTextEl: HTMLElement | null = null;
let statusDotEl: HTMLElement | null = null;
let busyCount = 0;

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

/** 进入忙碌态（叠加计数，支持并发任务） */
export function pushBusy(text: string): void {
  busyCount++;
  setStatus(text, 'loading');
}

/** 退出忙碌态；全部任务结束后回到就绪 */
export function popBusy(idleText = '就绪'): void {
  busyCount = Math.max(0, busyCount - 1);
  if (busyCount === 0) setStatus(idleText, 'ok');
}

/** 更新右侧统计文本（工程统计 / 版本等） */
export function setStatusRight(text: string): void {
  const el = document.getElementById('status-right');
  if (el) el.textContent = text;
}

/** 清理工程时恢复共性状态栏，避免线路统计泄漏到下一工程。 */
export function resetStatusRight(): void {
  setStatusRight(DEFAULT_STATUS_RIGHT);
  setSelectionStatus(null);
}

/** Current semantic selection, including objects without displayable geometry. */
export function setSelectionStatus(label: string | null): void {
  const element=document.getElementById('status-selection');
  if (element) element.textContent=label ?? '未选中';
}
