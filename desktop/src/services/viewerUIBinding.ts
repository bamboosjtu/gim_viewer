import { projectPresentation } from './projectPresentationPort.js';
import { RetryableResource } from '../shared/retryableResource.js';
import { reportBackgroundError } from '../utils/backgroundErrors.js';
import { logger } from '../utils/logger.js';
import { prepareViewerPresentation } from './viewerPresentationPort.js';
/**
 * Viewer UI 绑定服务（编排层）。
 *
 * 职责：在 viewer 引擎首次创建后，将 3D 渲染层与 UI 层（属性抽屉 / 模型列表 / 拾取交互）
 * 进行一次性装配，并对外暴露 { ctx, modelCallbacks } 供 services 层使用。
 *
 * 分层边界（依据 AGENTS.md）：
 * - viewer 层（viewerRuntime.ts）只负责 3D 引擎创建，不依赖 ui/
 * - 本服务编排 Viewer 与显式 Presentation Port；DOM 和 UI 模块加载属于 ui/
 * - 调用方（openGimService / openIfcService / nodeInteractionService 等）只需通过
 *   getViewerRuntimeWithUI() 获取已装配好的 { ctx, modelCallbacks }，无需关心 UI 集成细节
 *
 * 成功装配后复用；失败回滚已取得资源并允许重试。
 */

import type { AppState } from '../app/state.js';
import type { ModelEventCallbacks } from '../viewer/ifcLoader.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import { container } from './presentation/dom.js';

/** Viewer 运行时 + UI 集成回调 */
export interface ViewerRuntimeWithUI {
  ctx: ViewerContext;
  modelCallbacks: ModelEventCallbacks;
}

const binding = new RetryableResource<ViewerRuntimeWithUI>();

function loadBindingModules() {
  return Promise.all([
    import('../viewer/viewerRuntime.js'),
    import('../viewer/selection.js'),
    import('./selectionVisibility.js'),
    import('../viewer/viewHistory.js'),
    import('./nodeInteractionService.js'),
    prepareViewerPresentation(),
    // Load the engine code alongside its consumers. Engine creation remains
    // the responsibility of getViewerRuntime after the presentation is ready.
    import('../viewer/viewerEngine.js'),
  ]);
}

const modules = new RetryableResource<Awaited<ReturnType<typeof loadBindingModules>>>();

/** A confirmed 3D open can overlap module loading with its source/cache reads. */
export async function prepareViewerBindingModules(): Promise<void> {
  await modules.get(loadBindingModules);
}

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
 * @param showMessage DEV 视口选择的反馈回调
 */
export async function getViewerRuntimeWithUI(
  state: AppState,
  showMessage: (text: string) => void = () => {},
): Promise<ViewerRuntimeWithUI> {
  return binding.get(async () => {
    const rollback: Array<() => void> = [];
    try {
      const [
        { getViewerRuntime },
        { setupSelection },
        { createSelectionVisibility },
        { ViewerViewHistory },
        { syncSelectionNavigation },
        presentation,
      ] = await modules.get(loadBindingModules);

      const runtime = await getViewerRuntime(container);
      const { ctx } = runtime;
      const previousVisibility = state.selection.selectionVisibility,
        previousHistory = state.viewState.viewHistory;
      state.selection.selectionVisibility ??= createSelectionVisibility(state, ctx);

      rollback.push(() => {
        if (!previousVisibility) {
          state.selection.selectionVisibility?.reset();
          state.selection.selectionVisibility = null;
        }
        if (!previousHistory) {
          state.viewState.viewHistory?.dispose();
          state.viewState.viewHistory = null;
        }
      });
      state.viewState.viewHistory ??= new ViewerViewHistory(ctx, 20, {
        getVisibility: () => (state.selection.onlySelected ? 'only-selected' : 'all'),
        setVisibility: (value) => state.selection.setOnlySelected(value === 'only-selected'),
      });

      // 装配属性抽屉按钮事件
      const disposeDrawer = presentation.bindProperties(ctx);
      rollback.push(() => disposeDrawer?.());

      // 装配 3D 点击拾取 → 显示 IFC 构件属性
      const disposeSelection = setupSelection(
        ctx,
        state,
        container,
        async (modelId, localId, request) => {
          if (state.currentProjectType === 'substation' || state.engineering.snapshot) {
            const { selectEngineeringFragmentPick } =
              await import('./engineeringViewportSelection.js');
            const model = ctx.fragments.list.get(modelId);
            if (!state.selection.isCurrentSelection(request)) return true;
            if (
              model &&
              (await selectEngineeringFragmentPick(state, modelId, localId, request, model))
            )
              return true;
          }
          void Promise.resolve(syncSelectionNavigation(state, request)).catch(
            reportBackgroundError,
          );
          void Promise.resolve(
            presentation.showElement(ctx, state, modelId, localId, request),
          ).catch(reportBackgroundError);
          return false;
        },
        (request) => {
          void Promise.resolve(syncSelectionNavigation(state, request)).catch(
            reportBackgroundError,
          );
          if (state.selection.isCurrentSelection(request)) {
            projectPresentation().clearSelection();
          }
        },
        async (regional, object, request) => {
          if (state.currentProjectType === 'substation' || state.engineering.snapshot) {
            const { selectEngineeringIfcPick } = await import('./engineeringViewportSelection.js');
            if (!state.selection.isCurrentSelection(request)) return true;
            if (await selectEngineeringIfcPick(state, regional.modelId, object.expressId, request))
              return true;
          }
          void Promise.resolve(syncSelectionNavigation(state, request)).catch(
            reportBackgroundError,
          );
          void Promise.resolve(
            presentation.showRegional(ctx, state, regional, object, request),
          ).catch(reportBackgroundError);
          return false;
        },
        (rootOccurrence, instanceKey, request, hint) => {
          void import('./devViewportSelection.js')
            .then(({ selectViewportDev }) =>
              selectViewportDev(
                ctx,
                state,
                rootOccurrence,
                instanceKey,
                request,
                showMessage,
                hint,
              ),
            )
            .catch((error) => logger.warn('[DEV selection]', error));
        },
      );

      rollback.push(() => disposeSelection?.());

      // 构造模型生命周期回调（IFC 加载/卸载时同步更新 model-list UI）
      const modelCallbacks: ModelEventCallbacks = {
        onModelAdded: (modelId, runtimeModelId) => {
          const model = ctx.fragments.list.get(runtimeModelId);
          if (model) state.selection.selectionVisibility?.registerModel(modelId, model);
          presentation.addModel(ctx, state, modelId, runtimeModelId);
          if (state.selection.engineeringSelection?.ifc.some((ref) => ref.modelId === modelId))
            state.engineeringRepresentationChanged?.();
        },
        onModelRemoved: (modelId, runtimeModelId) => {
          state.selection.selectionVisibility?.removeModel(modelId, runtimeModelId);
          presentation.removeModel(modelId);
        },
      };

      return { ctx, modelCallbacks };
    } catch (error) {
      for (const dispose of rollback.reverse()) {
        try {
          dispose();
        } catch (cleanupError) {
          logger.warn('[Viewer binding cleanup]', cleanupError);
        }
      }
      throw error;
    }
  });
}
