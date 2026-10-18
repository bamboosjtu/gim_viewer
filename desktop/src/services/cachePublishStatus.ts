/**
 * 状态栏“索引发布”状态。
 *
 * 两阶段发布让暖启动在核心索引提交后即可用，但用户需要知道后台属性补写
 * 是否完成：chip 显示“索引发布中 → 暖启动已就绪 · 属性补写中 → 索引已发布”，
 * 失败时保留“索引发布未完成”，悬停查看原因。所有调用都是 best-effort，
 * 缺 DOM 或测试环境不报错。
 */
export type CachePublishPhase = 'idle' | 'core' | 'rest' | 'ready' | 'failed';

let phase: CachePublishPhase = 'idle';
let startedAt: number | null = null;
let detail = '';
let timer: ReturnType<typeof setInterval> | null = null;

function element(): HTMLElement | null {
  return document.getElementById('status-publish');
}

function elapsedSeconds(): string {
  if (startedAt == null) return '';
  return `${((performance.now() - startedAt) / 1000).toFixed(0)} s`;
}

function render(): void {
  const el = element();
  if (!el) return;
  const active = phase === 'core' || phase === 'rest';
  if (phase === 'idle') {
    el.hidden = true;
    el.textContent = '';
    el.removeAttribute('title');
    el.removeAttribute('data-phase');
    return;
  }
  el.hidden = false;
  el.dataset.phase = phase;
  const seconds = active ? elapsedSeconds() : '';
  if (phase === 'core') el.textContent = `索引发布中 ${seconds}`.trim();
  else if (phase === 'rest') el.textContent = `暖启动已就绪 · 属性补写中 ${seconds}`.trim();
  else if (phase === 'ready') el.textContent = '索引已发布 · 暖启动可用';
  else el.textContent = '索引发布未完成';
  if (detail) el.title = detail;
  else el.removeAttribute('title');
}

function stopTimer(): void {
  if (timer != null) {
    clearInterval(timer);
    timer = null;
  }
}

function startTimer(): void {
  stopTimer();
  timer = setInterval(render, 1000);
}

/** 开始一次发布（core/rest 都会重置计时，便于观察该阶段耗时）。 */
export function beginCachePublish(next: 'core' | 'rest', reason?: string): void {
  phase = next;
  startedAt = performance.now();
  detail = reason ?? '';
  startTimer();
  render();
}

export function setCachePublishPhase(next: CachePublishPhase, reason?: string): void {
  phase = next;
  if (reason !== undefined) detail = reason;
  if (next === 'ready' || next === 'failed' || next === 'idle') {
    stopTimer();
  } else if (timer == null) {
    startTimer();
  }
  render();
}

export function failCachePublish(reason: string): void {
  setCachePublishPhase('failed', reason);
}

export function resetCachePublishStatus(): void {
  stopTimer();
  phase = 'idle';
  startedAt = null;
  detail = '';
  render();
}
