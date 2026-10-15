/** Selection stays first; waiting background work eventually outranks ordinary
 * visible work so camera changes cannot starve all-station base coverage. */
export function agedWorkPriority(priority: number, queuedAt: number, now = performance.now()): number {
  return priority === 0 ? 0 : Math.max(0.5, priority - Math.max(0, now - queuedAt) / 15000);
}
