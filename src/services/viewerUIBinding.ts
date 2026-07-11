/**
 * Viewer UI 绑定服务（编排层）。
 *
 * 职责：在 viewer 引擎首次创建后，将 3D 渲染层与 UI 层（属性抽屉 / 模型列表 / 拾取交互）
 * 进行一次性装配，并对外暴露 { ctx, modelCallbacks } 供 services 层使用。
 *
 * 分层边界（依据 AGENTS.md）：
 * - viewer 层（viewerRuntime.ts）只负责 3D 引擎创建，不依赖 ui/
 * - 本服务位于 services/，可同时 dynamic import viewer/ 与 ui/，承担装配职责
 * - 调用方（openGimService / openIfcService / nodeInteractionService 等）只需通过
 *   getViewerRuntimeWithUI() 获取已装配好的 { ctx, modelCallbacks }，无需关心 UI 集成细节
 *
 * 单例语义：UI 装配只执行一次，后续调用直接返回缓存的 Promise。
 */

import type { AppState } from '../app/state.js';
import type { ModelEventCallbacks } from '../viewer/ifcLoader.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import { container } from '../ui/dom.js';

/** Viewer 运行时 + UI 集成回调 */
export interface ViewerRuntimeWithUI {
  ctx: ViewerContext;
  modelCallbacks: ModelEventCallbacks;
}

let uiBindingPromise: Promise<ViewerRuntimeWithUI> | null = null;

/**
 * 获取已装配 UI 集成的 Viewer 运行时（懒加载单例）。
 *
 * 首次调用：
 *   1. 通过 viewerRuntime.getViewerRuntime(container) 创建 3D 引擎
 *   2. 装配 propsDrawer 按钮事件
 *   3. 装配 selection 点击拾取 → showIfcElementProperties
 *   4. 构造 ModelEventCallbacks（onModelAdded/onModelRemoved → modelList UI）
 *
 * 后续调用：直接返回缓存的 Promise。
 *
 * @param state 全局 AppState（首次装配时用于 selection 回调绑定）
 * @param _showMessage 预留的消息回调（当前未使用，保持签名稳定性）
 */
export async function getViewerRuntimeWithUI(
  state: AppState,
  _showMessage: (text: string) => void = () => {},
): Promise<ViewerRuntimeWithUI> {
  if (uiBindingPromise) return uiBindingPromise;

  uiBindingPromise = (async () => {
    const { getViewerRuntime } = await import('../viewer/viewerRuntime.js');
    const { setupSelection } = await import('../viewer/selection.js');
    const { setupPropsDrawer, showIfcElementProperties } = await import('../ui/propsDrawer.js');
    const { addModelToUI, removeModelFromUI } = await import('../ui/modelList.js');

    const runtime = await getViewerRuntime(container);
    const { ctx } = runtime;

    // 装配属性抽屉按钮事件
    setupPropsDrawer(ctx);

    // 装配 3D 点击拾取 → 显示 IFC 构件属性
    setupSelection(ctx, state, container, (modelId, localId) => {
      void showIfcElementProperties(ctx, state, modelId, localId);
    });

    // 构造模型生命周期回调（IFC 加载/卸载时同步更新 model-list UI）
    const modelCallbacks: ModelEventCallbacks = {
      onModelAdded: (modelId) => addModelToUI(ctx, state, modelId),
      onModelRemoved: (modelId) => removeModelFromUI(modelId),
    };

    return { ctx, modelCallbacks };
  })();

  return uiBindingPromise;
}

/**
 * 释放 UI 绑定单例（用于项目切换 / 场景清空后的下一次装配）。
 *
 * 注意：此函数仅清空 UI 装配缓存，不销毁底层 ViewerRuntime（由 projectCleanupService 负责）。
 * 下次调用 getViewerRuntimeWithUI 时会复用已存在的 ViewerRuntime，但重新装配 UI。
 */
export function resetViewerUIBinding(): void {
  uiBindingPromise = null;
}
