import {loadingEl,emptyTipEl} from './dom.js';
import {pushBusy,popBusy} from './shell/statusBar.js';

let loadingRevision = 0;
let loadingStartedAt: number | null = null;
let loadingTimer: ReturnType<typeof setInterval> | null = null;
let loadingProgress = 0;

function updateLoadingElapsed(): void {
  const elapsed = document.getElementById('loading-elapsed');
  if (!elapsed) return;
  if (loadingStartedAt == null) { elapsed.textContent = ''; return; }
  elapsed.textContent = `${((performance.now() - loadingStartedAt) / 1000).toFixed(1)} s`;
}

function inferLoadingProgress(text: string): number {
  const explicitIfc = text.match(/\bIFC\s+(\d+)\s*\/\s*(\d+)/i);
  if (explicitIfc) {
    const done = Number(explicitIfc[1]), total = Math.max(1, Number(explicitIfc[2]));
    return 78 + Math.min(1, done / total) * 10;
  }
  const percent = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (percent) return 88 + Math.min(1, Number(percent[1]) / 100) * 6;
  const stages: Array<[RegExp, number]> = [
    [/读取 GIM 文件信息/i, 3],
    [/登记工程记录/i, 7],
    [/检查本地缓存/i, 12],
    [/解压并校验|正在解压|解压（/i, 24],
    [/校验解压后的工程类型/i, 55],
    [/解析 GIM 层级结构/i, 65],
    [/从本地缓存恢复 GIM 索引/i, 68],
    [/加载 3D 引擎/i, 75],
    [/加载 IFC 模型/i, 78],
    [/正在加载 .*IFC|正在加载 .*\.ifc/i, 80],
    [/semantic pack 恢复|已从 .*恢复线路工程|线路工程已加载/i, 60],
  ];
  for (const [pattern, value] of stages) if (pattern.test(text)) return value;
  return 8;
}

function applyLoadingProgress(text: string): void {
  const bar = document.getElementById('loading-bar') as HTMLElement | null;
  const stage = document.getElementById('loading-stage') as HTMLElement | null;
  if (!bar) return;
  const inferred = inferLoadingProgress(text);
  // Never move backwards; extraction/IFC callbacks can arrive out of order.
  if (inferred > loadingProgress) loadingProgress = inferred;
  bar.style.width = `${Math.min(96, Math.round(loadingProgress))}%`;
  if (stage) stage.textContent = loadingProgress > 0 ? `${Math.round(loadingProgress)}%` : '准备中';
}

export function showLoading(text: string): void {
  loadingRevision += 1;
  const textEl = document.getElementById('loading-text');
  if (textEl) textEl.textContent = text;
  else loadingEl.textContent = text;
  loadingEl.style.display = 'block';
  if (loadingStartedAt == null) {
    loadingStartedAt = performance.now();
    loadingProgress = 0;
    loadingEl.classList.add('active');
  }
  if (!loadingTimer && typeof setInterval === 'function') {
    loadingTimer = setInterval(() => {
      if (loadingStartedAt == null) return;
      updateLoadingElapsed();
    }, 100);
  }
  updateLoadingElapsed();
  applyLoadingProgress(text);
  // While a project is opening, replace the empty-state copy with the
  // viewport skeleton; the bottom status bar carries IFC/DEV progress.
  emptyTipEl?.classList.add('loading');
  pushBusy(text);
}

export function hideLoading(): void {
  loadingRevision += 1;
  loadingEl.style.display = 'none';
  loadingEl.classList.remove('active');
  if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
  loadingStartedAt = null;
  loadingProgress = 0;
  emptyTipEl?.classList.remove('loading');
  popBusy('就绪');
}

/** 新工程开始时把计时和进度归零；不清除遮罩，由后续 showLoading 接管。 */
export function resetLoadingClock(): void {
  if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
  loadingStartedAt = null;
  loadingProgress = 0;
  updateLoadingElapsed();
  applyLoadingProgress('');
}

/** Delayed UI changes must retain the identity captured when scheduled. */
export function scheduleHideLoading(isCurrent: () => boolean, delay: number): ReturnType<typeof setTimeout> {
  const revision = loadingRevision;
  return setTimeout(() => { if (revision === loadingRevision && isCurrent()) hideLoading(); }, delay);
}
