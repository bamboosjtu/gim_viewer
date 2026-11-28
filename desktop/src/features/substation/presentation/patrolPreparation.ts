import type { AppState } from '../../../app/state.js';
export async function waitForBrowseScene(state: AppState, signal: AbortSignal) {
  while (true) {
    signal.throwIfAborted();
    const physical = state.sourceGeometry;
    const dev = state.deviceLodRuntime;
    if (
      !state.ifcLoading?.pending &&
      (!physical || physical.catalog) &&
      !state.substationFineQueue?.isPreparingDevGeometry?.() &&
      (!dev || dev.diagnostics.baseRepresentationsSettled !== false)
    )
      return;
    if (physical?.ready && !(await physical.ready)) throw Error('工程模型未能打开，请重新打开工程');
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        reject(new DOMException('已取消巡视准备', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        resolve();
      }, 150);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
}
