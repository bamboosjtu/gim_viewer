import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import type { ModelEventCallbacks } from '../viewer/ifcLoader.js';
import { ensureEngineReady, loadIfcBuffer } from '../viewer/ifcLoader.js';
import { fitCameraToScene } from '../viewer/camera.js';
import { loadingEl, emptyTipEl, fileInput, btnLoadLocal } from '../ui/dom.js';
import { isTauri } from '../desktop/runtime.js';
import { openIfcFilePaths } from '../desktop/fileDialog.js';

function showLoading(text: string) { loadingEl.textContent = text; loadingEl.style.display = 'block'; }
function hideLoading() { loadingEl.style.display = 'none'; }

/** 绑定本地 IFC 文件打开事件 */
export function setupOpenIfcService(ctx: ViewerContext, state: AppState, modelCallbacks: ModelEventCallbacks): void {
  btnLoadLocal.addEventListener('click', async () => {
    if (isTauri()) {
      const filePaths = await openIfcFilePaths();
      if (filePaths) {
        console.log('[Tauri] IFC 文件路径:', filePaths);
      }
      return;
    }
    fileInput.click();
  });
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    if (files.length === 0) return;
    btnLoadLocal.disabled = true;
    try {
      await ensureEngineReady(ctx, state, modelCallbacks);
      for (const file of files) {
        showLoading(`正在加载 ${file.name}...`);
        const buffer = new Uint8Array(await file.arrayBuffer());
        const name = file.name.replace(/\.ifc$/i, '');
        await loadIfcBuffer(ctx, name, buffer, state, (p) => showLoading(`${file.name}: ${Math.round(p * 100)}%`));
      }
      emptyTipEl.style.display = 'none';
      fitCameraToScene(ctx, state);
    } catch (err) {
      console.error(err);
      showLoading(`IFC 加载失败: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(hideLoading, 3000);
    } finally { fileInput.value = ''; btnLoadLocal.disabled = false; hideLoading(); }
  });
}
