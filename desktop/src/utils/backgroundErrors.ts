import { logger } from './logger.js';
export interface BackgroundFailure {
  at: number;
  message: string;
  stack?: string;
}
const failures: BackgroundFailure[] = [];
/** Terminal sink for explicitly detached work; cancellation is an expected outcome. */
export function reportBackgroundError(error: unknown): void {
  if (
    (error instanceof Error ||
      (typeof DOMException !== 'undefined' && error instanceof DOMException)) &&
    error.name === 'AbortError'
  )
    return;
  failures.push({
    at: Date.now(),
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error ? { stack: error.stack } : {}),
  });
  if (failures.length > 32) failures.shift();
  logger.error('[Background task]', error);
}
export function backgroundErrorSnapshot(): readonly BackgroundFailure[] {
  return failures.map((row) => ({ ...row }));
}
