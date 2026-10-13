import { isIfcPreviewEnabled, isIfcPreviewDeferredFineEnabled, setIfcQuickPreviewEnabled } from '../config/features.js';

/** Changes the next-open preference only; never mutates an active loading session. */
export function setupIfcPreviewModeControl(): void {
  const button = document.getElementById('btn-ifc-quick-preview');
  if (!button) return;
  const refresh = () => {
    const enabled = isIfcPreviewEnabled() && isIfcPreviewDeferredFineEnabled();
    button.textContent = `变电预览：${enabled ? '开启' : '关闭'}`;
    button.setAttribute('aria-pressed', String(enabled));
  };
  button.addEventListener('click', () => {
    try {
      setIfcQuickPreviewEnabled(!(isIfcPreviewEnabled() && isIfcPreviewDeferredFineEnabled()));
      refresh();
      button.title = '设置已保存，下一次打开变电 GIM 生效。预览为近似几何，精细 IFC 按需加载。';
    } catch {
      button.title = '无法保存预览设置，请检查本地存储权限。';
    }
  });
  refresh();
}
