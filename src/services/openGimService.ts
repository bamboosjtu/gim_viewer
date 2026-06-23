import type { IfcEntry } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import type { ModelEventCallbacks } from '../viewer/ifcLoader.js';
import { extractGimFile } from '../gim/gimExtractor.js';
import { scanIfcFiles, discoverIfcFromCBM, buildIfcGuidIndex } from '../gim/gimIndexer.js';
import { buildCbmTree, buildCbmNodeIndex } from '../gim/cbmParser.js';
import { parseFileDevRelation } from '../gim/fileDevParser.js';
import { ensureEngineReady, loadIfcBuffer } from '../viewer/ifcLoader.js';
import { buildIfcNameIndex } from '../viewer/ifcNameIndex.js';
import { fitCameraToScene } from '../viewer/camera.js';
import { openIfcModal, getModalSelectedEntries, closeIfcModal } from '../ui/ifcSelectModal.js';
import { buildAndRenderCbmTree } from '../ui/cbmTreeView.js';
import { renderFileDevPanel } from '../ui/fileDevView.js';
import { loadingEl, emptyTipEl, gimFileInput, btnLoadGim } from '../ui/dom.js';

function showLoading(text: string) { loadingEl.textContent = text; loadingEl.style.display = 'block'; }
function hideLoading() { loadingEl.style.display = 'none'; }

/** GIM 文件解压后的处理流程 */
export async function onGimExtracted(ctx: ViewerContext, state: AppState, files: Map<string, File>, showMessage: (text: string) => void): Promise<IfcEntry[]> {
  state.currentFiles = files;

  // 发现 IFC 文件
  let ifcEntries = await discoverIfcFromCBM(files);
  if (ifcEntries.length === 0) ifcEntries = scanIfcFiles(files);

  state.currentIfcEntries = ifcEntries;

  // 构建 CBM 层级树
  state.currentCbmTree = await buildCbmTree(files);
  state.ifcGuidIndex = buildIfcGuidIndex(state.currentCbmTree);
  state.cbmNodeIndex = buildCbmNodeIndex(state.currentCbmTree);

  // 解析 FileDevRelation
  state.fileDevRelations = await parseFileDevRelation(files);
  state.deviceToIfcFile.clear();
  for (const entry of state.fileDevRelations) {
    for (const devCbm of entry.deviceCbms) {
      state.deviceToIfcFile.set(devCbm, entry.modelId);
    }
  }

  // 渲染层级树和文件设备面板
  buildAndRenderCbmTree(ctx, state, showMessage);
  renderFileDevPanel(ctx, state, showMessage);

  return ifcEntries;
}

/** 加载选中的 IFC 文件 */
export async function loadSelectedIfcFiles(ctx: ViewerContext, state: AppState, modelCallbacks: ModelEventCallbacks): Promise<void> {
  const selected = getModalSelectedEntries(state.currentIfcEntries);
  if (selected.length === 0) return;
  closeIfcModal();
  showLoading('正在加载 IFC 模型...');
  try {
    await ensureEngineReady(ctx, state, modelCallbacks);
    for (const entry of selected) {
      if (!state.currentFiles) break;
      const file = state.currentFiles.get(entry.path);
      if (!file) continue;
      const buffer = new Uint8Array(await file.arrayBuffer());
      showLoading(`正在加载 ${entry.name}...`);
      await loadIfcBuffer(ctx, entry.name, buffer, state, (p) => showLoading(`${entry.name}: ${Math.round(p * 100)}%`));
    }
    await buildIfcNameIndex(ctx, state);
    buildAndRenderCbmTree(ctx, state, (text) => showLoading(text));
    renderFileDevPanel(ctx, state, (text) => showLoading(text));
    emptyTipEl.style.display = 'none';
    fitCameraToScene(ctx, state);
  } catch (err) {
    console.error(err);
    showLoading(`IFC 加载失败: ${err instanceof Error ? err.message : String(err)}`);
    setTimeout(hideLoading, 3000);
    return;
  }
  hideLoading();
}

/** 绑定 GIM 文件打开事件 */
export function setupOpenGimService(ctx: ViewerContext, state: AppState, showMessage: (text: string) => void): void {
  btnLoadGim.addEventListener('click', () => gimFileInput.click());
  gimFileInput.addEventListener('change', async () => {
    const files = Array.from(gimFileInput.files || []);
    if (files.length === 0) return;
    btnLoadGim.disabled = true;
    try {
      showLoading('正在解压 GIM 文件...');
      const ab = await files[0].arrayBuffer();
      const extracted = await extractGimFile(ab);
      const entries = await onGimExtracted(ctx, state, extracted, showMessage);
      if (entries.length === 0) { showLoading('未在 GIM 文件中找到 IFC 文件'); setTimeout(hideLoading, 2000); return; }
      hideLoading();
      openIfcModal(entries);
    } catch (err) {
      console.error(err);
      showLoading(`GIM 解析失败: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(hideLoading, 3000);
    } finally { gimFileInput.value = ''; btnLoadGim.disabled = false; }
  });
}
