import type { ViewerContext } from './viewerEngine.js';

/** Viewer 运行时上下文（纯 3D 引擎，不含 UI 集成） */
export interface ViewerRuntime {
  ctx: ViewerContext;
}

let runtimePromise: Promise<ViewerRuntime> | null = null;

/** 检查 Viewer runtime 是否已创建（不触发创建） */
export function isViewerRuntimeCreated(): boolean {
  return runtimePromise !== null;
}

/**
 * 获取 Viewer 运行时（懒加载单例）。
 *
 * 首次调用时动态 import 重模块（ThatOpen/Three/WebIFC）并创建引擎。
 * 后续调用直接返回已有实例。
 *
 * viewer 层不依赖 ui/dom.js：viewport 元素由调用方注入。
 * UI 集成（propsDrawer / modelList / selection）由 services/viewerUIBinding.ts 负责。
 *
 * @param viewportElement 3D 渲染容器元素（仅在首次创建时使用，后续调用忽略）
 */
export async function getViewerRuntime(
  viewportElement: HTMLElement,
): Promise<ViewerRuntime> {
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    // 动态 import 重模块，避免首屏加载
    const { createViewerEngine } = await import('./viewerEngine.js');
    const ctx = createViewerEngine(viewportElement);
    return { ctx };
  })();

  return runtimePromise;
}
