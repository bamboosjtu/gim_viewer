import type { AppState } from '../app/state.js';
import { ensureEngineReady, loadIfcBuffer } from '../viewer/ifcLoader.js';
import { fitCameraToScene } from '../viewer/camera.js';
import { loadingEl, emptyTipEl, fileInput, btnLoadLocal } from '../ui/dom.js';
import { isTauri } from '../desktop/runtime.js';
import { openIfcFilePaths } from '../desktop/fileDialog.js';

function showLoading(text: string) { loadingEl.textContent = text; loadingEl.style.display = 'block'; }
function hideLoading() { loadingEl.style.display = 'none'; }

/**
 * 打开本地 IFC 文件的动作函数（供 bootstrap 懒加载调用）。
 * - 对话框立即打开，不等待 3D 引擎
 * - 文件选中后才加载 3D 引擎并渲染
 */
export async function openIfcWithDialog(
  state: AppState,
  showMessage: (text: string) => void,
): Promise<void> {
  if (isTauri()) {
    // 1. 对话框立即打开（无 3D 依赖）
    const filePaths = await openIfcFilePaths();
    if (!filePaths || filePaths.length === 0) return;
    btnLoadLocal.disabled = true;
    try {
      // 2. 加载 3D 引擎
      showLoading('正在加载 3D 引擎...');
      const { getViewerRuntime } = await import('../viewer/viewerRuntime.js');
      const runtime = await getViewerRuntime(state, showMessage);
      const { readFileBytes } = await import('../desktop/fileReader.js');

      // 3. 逐个加载 IFC
      await ensureEngineReady(runtime.ctx, state, runtime.modelCallbacks);
      for (const fp of filePaths) {
        showLoading(`正在加载 ${fp}...`);
        const ab = await readFileBytes(fp);
        const buffer = new Uint8Array(ab);
        const name = (fp.split(/[\\/]/).pop() || 'model.ifc').replace(/\.ifc$/i, '');
        await loadIfcBuffer(runtime.ctx, name, buffer, state, (p) => showLoading(`${name}: ${Math.round(p * 100)}%`));
      }
      emptyTipEl.style.display = 'none';
      fitCameraToScene(runtime.ctx, state);
    } catch (err) {
      console.error(err);
      showLoading(`IFC 加载失败: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(hideLoading, 3000);
    } finally {
      btnLoadLocal.disabled = false;
      hideLoading();
    }
    return;
  }

  // 浏览器模式：input.click() 立即触发，change 后加载 3D
  return new Promise<void>((resolve) => {
    const handler = async () => {
      fileInput.removeEventListener('change', handler);
      const files = Array.from(fileInput.files || []);
      if (files.length === 0) { resolve(); return; }
      btnLoadLocal.disabled = true;
      try {
        showLoading('正在加载 3D 引擎...');
        const { getViewerRuntime } = await import('../viewer/viewerRuntime.js');
        const runtime = await getViewerRuntime(state, showMessage);
        await ensureEngineReady(runtime.ctx, state, runtime.modelCallbacks);
        for (const file of files) {
          showLoading(`正在加载 ${file.name}...`);
          const buffer = new Uint8Array(await file.arrayBuffer());
          const name = file.name.replace(/\.ifc$/i, '');
          await loadIfcBuffer(runtime.ctx, name, buffer, state, (p) => showLoading(`${file.name}: ${Math.round(p * 100)}%`));
        }
        emptyTipEl.style.display = 'none';
        fitCameraToScene(runtime.ctx, state);
      } catch (err) {
        console.error(err);
        showLoading(`IFC 加载失败: ${err instanceof Error ? err.message : String(err)}`);
        setTimeout(hideLoading, 3000);
      } finally {
        fileInput.value = '';
        btnLoadLocal.disabled = false;
        hideLoading();
        resolve();
      }
    };
    fileInput.addEventListener('change', handler);
    fileInput.click();
  });
}
