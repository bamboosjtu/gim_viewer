export interface PublicationView {phase: CachePublishPhase; text:string; detail:string;}
let renderPublication:(view:PublicationView)=>void=()=>{};
export function bindPublicationView(render:typeof renderPublication):void {renderPublication=render;}
/**
 * 状态栏“索引发布”状态。
 *
 * 两阶段发布让暖启动在核心索引提交后即可用，但用户需要知道后台属性补写
 * 是否完成：chip 显示“索引发布中 → 暖启动已就绪 · 属性补写中 → 索引已发布”，
 * 失败时保留“索引发布未完成”，悬停查看原因。所有调用都是 best-effort，
 * 缺 DOM 或测试环境不报错。
 */
export type CachePublishPhase = 'idle' | 'core' | 'rest' | 'ready' | 'failed';

export function createCachePublishStatus(isCurrent: () => boolean) {
let phase: CachePublishPhase = 'idle';
let startedAt: number | null = null;
let detail = '';
let timer: ReturnType<typeof setInterval> | null = null;

function elapsedSeconds(): string {
  if (startedAt == null) return '';
  return `${((performance.now() - startedAt) / 1000).toFixed(0)} s`;
}

function render(): void {
  if (!isCurrent()) { stopTimer(); return; }
  const active = phase === 'core' || phase === 'rest';
  const seconds = active ? elapsedSeconds() : '';
  const text = phase === 'idle' ? '' : phase === 'core' ? `索引发布中 ${seconds}`.trim()
    : phase === 'rest' ? `暖启动已就绪 · 属性补写中 ${seconds}`.trim()
    : phase === 'ready' ? '索引已发布 · 暖启动可用' : '索引发布未完成';
  renderPublication({phase,text,detail});
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
function beginCachePublish(next: 'core' | 'rest', reason?: string): void {
  if (!isCurrent()) return;
  phase = next;
  startedAt = performance.now();
  detail = reason ?? '';
  startTimer();
  render();
}

function setCachePublishPhase(next: CachePublishPhase, reason?: string): void {
  if (!isCurrent()) return;
  phase = next;
  if (reason !== undefined) detail = reason;
  if (next === 'ready' || next === 'failed' || next === 'idle') {
    stopTimer();
  } else if (timer == null) {
    startTimer();
  }
  render();
}

function failCachePublish(reason: string): void {
  setCachePublishPhase('failed', reason);
}

function resetCachePublishStatus(): void {
  stopTimer();
  phase = 'idle';
  startedAt = null;
  detail = '';
  render();
}

return { beginCachePublish, setCachePublishPhase, failCachePublish, resetCachePublishStatus };
}
