import { AppState } from './state.js';
import { createViewerEngine } from '../viewer/viewerEngine.js';
import { registerModelEvents } from '../viewer/ifcLoader.js';
import { setupSelection } from '../viewer/selection.js';
import { setupTabs } from '../ui/tabs.js';
import { setupPropsDrawer, showIfcElementProperties } from '../ui/propsDrawer.js';
import { addModelToUI, removeModelFromUI } from '../ui/modelList.js';
import { setupIfcSelectModal } from '../ui/ifcSelectModal.js';
import { setupOpenGimService, loadSelectedIfcFiles } from '../services/openGimService.js';
import { setupOpenIfcService } from '../services/openIfcService.js';
import { resetHighlight } from '../viewer/highlight.js';
import { container, btnClear, loadingEl } from '../ui/dom.js';

function showLoading(text: string) { loadingEl.textContent = text; loadingEl.style.display = 'block'; }

/** 应用启动入口 */
export function bootstrap(): void {
  // 创建状态
  const state = new AppState();

  // 初始化 3D 引擎
  const ctx = createViewerEngine(container);

  // 注册模型事件
  registerModelEvents(ctx, state, {
    onModelAdded: (modelId) => addModelToUI(ctx, state, modelId),
    onModelRemoved: (modelId) => removeModelFromUI(modelId),
  });

  // 设置 3D 点击拾取
  setupSelection(ctx, state, container, (modelId, localId) => {
    showIfcElementProperties(ctx, state, modelId, localId);
  });

  // 设置 UI
  setupTabs();
  setupPropsDrawer(ctx);
  setupIfcSelectModal({
    onLoadSelected: () => loadSelectedIfcFiles(ctx, state),
  });

  // 设置文件打开服务
  setupOpenGimService(ctx, state, (text) => showLoading(text));
  setupOpenIfcService(ctx, state);

  // 清空场景
  btnClear.addEventListener('click', async () => {
    for (const [modelId] of state.loadedModels) {
      ctx.fragments.core.disposeModel(modelId);
    }
    state.reset();
    document.getElementById('model-list')!.innerHTML = '';
    document.getElementById('cbm-tree-panel')!.innerHTML = '';
    document.getElementById('file-dev-panel')!.innerHTML = '';
    document.getElementById('props-drawer-body')!.innerHTML = '<div class="props-empty">选择层级树节点查看属性</div>';
    document.getElementById('empty-tip')!.style.display = '';
    await resetHighlight(ctx, state);
  });
}
