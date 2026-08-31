import { modelListEl } from './dom.js';
import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';

/** 添加模型到 UI 列表 */
export function addModelToUI(ctx: ViewerContext, state: AppState, modelId: string, runtimeModelId = modelId): void {
  if (document.getElementById(`model-${modelId}`)) return;
  const item = document.createElement('div');
  item.id = `model-${modelId}`;
  item.className = 'model-item';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox'; checkbox.checked = true; checkbox.className = 'model-checkbox'; checkbox.title = '显示/隐藏';
  checkbox.addEventListener('change', () => {
    const model = ctx.fragments.list.get(runtimeModelId);
    if (model) { model.object.visible = checkbox.checked; const e = state.loadedModels.get(modelId); if (e) e.visible = checkbox.checked; }
  });

  const name = document.createElement('span');
  const entry = state.currentIfcEntries.find((item) => item.modelId === modelId);
  name.className = 'name';
  // runtime modelId 只用于内部寻址（例如 ifc_<hash>），不应泄漏到
  // 模型列表作为用户可读名称；缓存/异常恢复缺少 entry 时也使用通用
  // 占位文本，而不是把内部 hash 展示出来。
  name.title = entry?.path || 'IFC 模型';
  name.textContent = entry?.name || '未命名 IFC 模型';

  const actions = document.createElement('div');
  actions.className = 'actions';
  const removeBtn = document.createElement('button');
  removeBtn.className = 'icon-btn'; removeBtn.textContent = '×'; removeBtn.title = '移除模型';
  removeBtn.addEventListener('click', () => { ctx.fragments.core.disposeModel(runtimeModelId); });

  actions.appendChild(removeBtn);
  item.appendChild(checkbox); item.appendChild(name); item.appendChild(actions);
  modelListEl.appendChild(item);
}

/** 从 UI 列表移除模型 */
export function removeModelFromUI(modelId: string, runtimeModelId = modelId): void {
  document.getElementById(`model-${modelId}`)?.remove();
  // 兼容旧版本曾以 runtime ID 直接作为 DOM key 的残留行。
  if (runtimeModelId !== modelId) document.getElementById(`model-${runtimeModelId}`)?.remove();
}
