import {
  IFC_DETAIL_MODE_KEY,
  isIfcNearDetailEnabled,
} from '../config/features.js';
/** Product LOD control; source identity is independent of representation. */
export function setupIfcPreviewModeControl(): void {
  const button = document.getElementById('btn-ifc-opening-policy');
  if (!button) return;
  const refresh = () => {
    const near = isIfcNearDetailEnabled();
    button.textContent = near ? 'IFC 细节：自动（近景30m）' : 'IFC 细节：远景';
    button.setAttribute('aria-pressed', String(near));
  };
  button.addEventListener('click', () => {
    try {
      localStorage.setItem(
        IFC_DETAIL_MODE_KEY,
        isIfcNearDetailEnabled() ? 'far' : 'auto'
      );
      refresh();
      window.dispatchEvent(new Event('gim-ifc-detail-mode'));
    } catch {
      button.title = '无法保存细节偏好';
    }
  });
  refresh();
}
