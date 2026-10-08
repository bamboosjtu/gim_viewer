import type { PowerlineProject, ProjectIdentity, TowerPreview } from '@gim/powerline-core';
import type { ImportProgress } from '../native/bridge';
export class ParserWorker {
  private worker?: Worker;
  private reject?: (e: Error) => void;
  private job = 0;
  run<T>(message: Record<string, unknown>, progress?: (p: ImportProgress) => void): Promise<T> {
    this.cancel();
    // Vite development uses modules; the production bundle is a classic IIFE for Android 10's stock WebView.
    const worker = import.meta.env.DEV
      ? new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' })
      : new Worker(new URL('./parser.worker.ts', import.meta.url)); this.worker = worker;
    const job = ++this.job;
    return new Promise<T>((resolve, reject) => {
      this.reject = reject;
      worker.onmessage = e => { if (e.data.job !== job) return; if (e.data.progress) { progress?.(e.data.progress); return; } this.worker = undefined; this.reject = undefined; worker.terminate(); if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.result); };
      worker.onerror = () => { this.worker = undefined; this.reject = undefined; worker.terminate(); reject(new Error('解析线程异常，请重新导入')); };
      worker.postMessage({ job, ...message });
    });
  }
  project(files: { path: string; text: string }[], identity: ProjectIdentity, progress: (p: ImportProgress) => void) { return this.run<PowerlineProject>({ kind: 'project', files, identity }, progress); }
  preview(text: string, path: string) { return this.run<TowerPreview>({ kind: 'preview', text, path }); }
  cancel() { this.worker?.terminate(); this.worker = undefined; this.reject?.(new Error('操作已取消')); this.reject = undefined; }
}
