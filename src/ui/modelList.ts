import { modelListEl } from './dom.js';
import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';

/** 添加模型到 UI 列表 */
export function addModelToUI(ctx: ViewerContext, state: AppState, modelId: string): void {
  if (document.getElementById(`model-${modelId}`)) return;
  const item = document.createElement('div');
  item.id = `model-${modelId}`;
  item.className = 'model-item';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox'; checkbox.checked = true; checkbox.className = 'model-checkbox'; checkbox.title = '显示/隐藏';
  checkbox.addEventListener('change', () => {
    const model = ctx.fragments.list.get(modelId);
    if (model) { model.object.visible = checkbox.checked; const e = state.loadedModels.get(modelId); if (e) e.visible = checkbox.checked; }
  });

  const name = document.createElement('span');
  name.className = 'name'; name.title = modelId; name.textContent = modelId;

  const actions = document.createElement('div');
  actions.className = 'actions';
  const removeBtn = document.createElement('button');
  removeBtn.className = 'icon-btn'; removeBtn.textContent = '×'; removeBtn.title = '移除模型';
  removeBtn.addEventListener('click', () => { ctx.fragments.core.disposeModel(modelId); });

  actions.appendChild(removeBtn);
  item.appendChild(checkbox); item.appendChild(name); item.appendChild(actions);
  modelListEl.appendChild(item);
}

/** 从 UI 列表移除模型 */
export function removeModelFromUI(modelId: string): void {
  document.getElementById(`model-${modelId}`)?.remove();
}
