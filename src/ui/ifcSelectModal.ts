import type { IfcEntry } from '../gim/types.js';
import { ifcModal, modalIfcList, modalInfo, modalClose, modalSelectAll, modalDeselectAll, modalLoad } from './dom.js';

/** 打开 IFC 选择模态框 */
export function openIfcModal(entries: IfcEntry[]): void {
  modalIfcList.innerHTML = '';
  modalInfo.textContent = `共发现 ${entries.length} 个 IFC 文件`;
  for (const entry of entries) {
    const label = document.createElement('label');
    label.className = 'modal-check-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = entry.modelId; cb.checked = false;
    const span = document.createElement('span');
    span.textContent = entry.name;
    label.appendChild(cb); label.appendChild(span);
    modalIfcList.appendChild(label);
  }
  ifcModal.classList.add('open');
}

/** 关闭 IFC 选择模态框 */
export function closeIfcModal(): void {
  ifcModal.classList.remove('open');
}

/** 获取模态框中选中的 IFC 条目 */
export function getModalSelectedEntries(currentIfcEntries: IfcEntry[]): IfcEntry[] {
  const selected: IfcEntry[] = [];
  modalIfcList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
    if (cb.checked) { const e = currentIfcEntries.find(x => x.modelId === cb.value); if (e) selected.push(e); }
  });
  return selected;
}

/** 绑定模态框事件 */
export function setupIfcSelectModal(callbacks: {
  onLoadSelected: () => Promise<void>;
}): void {
  modalClose.addEventListener('click', closeIfcModal);
  ifcModal.addEventListener('click', (e) => { if (e.target === ifcModal) closeIfcModal(); });
  modalSelectAll.addEventListener('click', () => { modalIfcList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => { cb.checked = true; }); });
  modalDeselectAll.addEventListener('click', () => { modalIfcList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => { cb.checked = false; }); });
  modalLoad.addEventListener('click', async () => {
    await callbacks.onLoadSelected();
  });
}
