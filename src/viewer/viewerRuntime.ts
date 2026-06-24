import type { AppState } from '../app/state.js';
import type { ViewerContext } from './viewerEngine.js';
import type { ModelEventCallbacks } from './ifcLoader.js';
import { container } from '../ui/dom.js';

/** Viewer 运行时上下文 */
export interface ViewerRuntime {
  ctx: ViewerContext;
  modelCallbacks: ModelEventCallbacks;
}

let runtimePromise: Promise<ViewerRuntime> | null = null;

/** 检查 Viewer runtime 是否已创建（不触发创建） */
export function isViewerRuntimeCreated(): boolean {
  return runtimePromise !== null;
}

/**
 * 获取 Viewer 运行时（懒加载单例）。
 * 首次调用时动态 import 重模块（ThatOpen/Three/WebIFC）并创建引擎。
 * 后续调用直接返回已有实例。
 */
export async function getViewerRuntime(
  state: AppState,
  _showMessage: (text: string) => void,
): Promise<ViewerRuntime> {
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    // 动态 import 重模块，避免首屏加载
    const { createViewerEngine } = await import('./viewerEngine.js');
    const { setupSelection } = await import('./selection.js');
    const { setupPropsDrawer, showIfcElementProperties } = await import('../ui/propsDrawer.js');
    const { addModelToUI, removeModelFromUI } = await import('../ui/modelList.js');

    const ctx = createViewerEngine(container);

    const modelCallbacks: ModelEventCallbacks = {
      onModelAdded: (modelId) => addModelToUI(ctx, state, modelId),
      onModelRemoved: (modelId) => removeModelFromUI(modelId),
    };

    setupPropsDrawer(ctx);
    setupSelection(ctx, state, container, (modelId, localId) => {
      showIfcElementProperties(ctx, state, modelId, localId);
    });

    return { ctx, modelCallbacks };
  })();

  return runtimePromise;
}
