import type { ViewerContext } from './viewerEngine.js';
import { RetryableResource } from '../shared/retryableResource.js';

/** Viewer 运行时上下文（纯 3D 引擎，不含 UI 集成） */
export interface ViewerRuntime {
  ctx: ViewerContext;
}

const runtime = new RetryableResource<ViewerRuntime>();
/** Observe an existing renderer without creating one. */
export function peekViewerRuntime(): Promise<ViewerRuntime> | null {
  return runtime.peek();
}
export function viewerRuntimePhase() {
  return runtime.phase;
}

/** 检查 Viewer runtime 是否已创建（不触发创建） */
export function isViewerRuntimeCreated(): boolean {
  return runtime.phase === 'ready';
}

/**
 * 获取 Viewer 运行时（懒加载单例）。
 *
 * 首次调用时动态 import 重模块（ThatOpen/Three/WebIFC）并创建引擎。
 * 后续调用直接返回已有实例。
 *
 * viewer 层不依赖 ui/dom.js：viewport 元素由调用方注入。
 * UI 集成（propsDrawer / modelList / selection）由 services/presentation/viewerUIBinding.ts 负责。
 *
 * @param viewportElement 3D 渲染容器元素（仅在首次创建时使用，后续调用忽略）
 */
export async function getViewerRuntime(viewportElement: HTMLElement): Promise<ViewerRuntime> {
  return runtime.get(async () => {
    // 动态 import 重模块，避免首屏加载
    const { createViewerEngine } = await import('./viewerEngine.js');
    const ctx = await createViewerEngine(viewportElement);
    return { ctx };
  });
}
