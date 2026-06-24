import type { IfcEntry } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import type { ModelEventCallbacks } from '../viewer/ifcLoader.js';
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
import { isTauri } from '../desktop/runtime.js';
import { openGimFilePath } from '../desktop/fileDialog.js';

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

/** 从 ArrayBuffer 加载 GIM 文件的完整流程（浏览器和 Tauri 共用） */
async function openGimFromArrayBuffer(
  ctx: ViewerContext,
  state: AppState,
  _fileName: string,
  ab: ArrayBuffer,
  showMessage: (text: string) => void,
  options?: { projectId?: number; persistIndex?: boolean },
): Promise<void> {
  showLoading('正在加载 GIM 解压模块...');
  const { extractGimFile } = await import('../gim/gimExtractor.js');
  showLoading('正在解压 GIM 文件...');
  const extracted = await extractGimFile(ab);
  showLoading('正在解析 GIM 层级结构...');
  const entries = await onGimExtracted(ctx, state, extracted, showMessage);

  // Tauri 模式：写入 GIM 索引到 SQLite
  if (options?.persistIndex && options.projectId != null && isTauri()) {
    // 先缓存 IFC 文件到本地磁盘
    showLoading('正在缓存 IFC 文件...');
    let localCachePathMap: Map<string, string> | undefined;
    try {
      const { cacheExtractedIfcFiles } = await import('./gimExtractedCacheService.js');
      localCachePathMap = await cacheExtractedIfcFiles(options.projectId, state.currentFiles ?? new Map<string, File>());
      console.log('[Tauri] IFC 文件已缓存:', localCachePathMap.size);
    } catch (err) {
      console.error('[Tauri] IFC 文件缓存失败:', err);
    }

    showLoading('正在写入 GIM 索引...');
    try {
      const { buildGimIndexPayload } = await import('./gimIndexPersistenceService.js');
      const { saveGimIndex } = await import('../desktop/database.js');
      const payload = buildGimIndexPayload(
        options.projectId,
        state.currentFiles ?? new Map<string, File>(),
        state.currentIfcEntries,
        state.currentCbmTree,
        state.fileDevRelations,
        localCachePathMap,
      );
      await saveGimIndex(payload);
      console.log('[Tauri] GIM 索引已写入:', {
        entries: payload.entries.length,
        cbm_nodes: payload.cbm_nodes.length,
        ifc_models: payload.ifc_models.length,
        file_dev_entries: payload.file_dev_entries.length,
      });
    } catch (err) {
      console.error('[Tauri] GIM 索引写入失败:', err);
    }
  }

  if (entries.length === 0) {
    showLoading('未在 GIM 文件中找到 IFC 文件');
    setTimeout(hideLoading, 2000);
    return;
  }
  hideLoading();
  openIfcModal(entries);
}

/** 绑定 GIM 文件打开事件 */
export function setupOpenGimService(ctx: ViewerContext, state: AppState, showMessage: (text: string) => void): void {
  btnLoadGim.addEventListener('click', async () => {
    if (isTauri()) {
      const filePath = await openGimFilePath();
      if (!filePath) return;
      btnLoadGim.disabled = true;
      try {
        showLoading('正在读取 GIM 文件信息...');
        const { getFileInfo, readFileBytes } = await import('../desktop/fileReader.js');
        const info = await getFileInfo(filePath);
        console.log('[Tauri] GIM 文件信息:', info);
        showLoading('正在写入本地项目索引...');
        const { upsertGimProject, listGimProjects, getGimProjectsBySha256, getGimIndexStats } = await import('../desktop/database.js');
        const record = await upsertGimProject(info);
        console.log('[Tauri] GIM 项目记录:', record);
        console.log('[Tauri] 最近 GIM 项目:', await listGimProjects(10));
        console.log('[Tauri] 相同 sha256 项目:', await getGimProjectsBySha256(info.sha256));
        const stats = await getGimIndexStats(record.id);
        console.log('[Tauri] GIM 索引状态:', stats);
        if (stats.has_index) {
          console.log('[Tauri] 已存在 GIM 索引，但本轮仍继续走解压流程');
        }
        showLoading('正在检查本地缓存...');
        const { validateGimCache, getGimIndex } = await import('../desktop/database.js');
        const validation = await validateGimCache(record.id);
        console.log('[Tauri] GIM 缓存校验:', validation);
        if (validation.valid) {
          const index = await getGimIndex(record.id);
          console.log('[Tauri] GIM 缓存索引读取成功:', {
            entries: index.entries.length,
            cbm_nodes: index.cbm_nodes.length,
            ifc_models: index.ifc_models.length,
            file_dev_entries: index.file_dev_entries.length,
          });
          console.log('[Tauri] 缓存有效，但第 1 轮不启用短路，仍继续完整解压流程');
        } else {
          console.log('[Tauri] 缓存无效或不完整，第 1 轮继续完整解压流程:', validation);
        }
        showLoading('正在读取 GIM 文件...');
        const ab = await readFileBytes(filePath);
        const fileName = filePath.split(/[\\/]/).pop() || 'project.gim';
        await openGimFromArrayBuffer(ctx, state, fileName, ab, showMessage, {
          projectId: record.id,
          persistIndex: true,
        });
      } catch (err) {
        console.error(err);
        showLoading(`GIM 解析失败: ${err instanceof Error ? err.message : String(err)}`);
        setTimeout(hideLoading, 3000);
      } finally { btnLoadGim.disabled = false; }
      return;
    }
    gimFileInput.click();
  });
  gimFileInput.addEventListener('change', async () => {
    const files = Array.from(gimFileInput.files || []);
    if (files.length === 0) return;
    btnLoadGim.disabled = true;
    try {
      const ab = await files[0].arrayBuffer();
      await openGimFromArrayBuffer(ctx, state, files[0].name, ab, showMessage);
    } catch (err) {
      console.error(err);
      showLoading(`GIM 解析失败: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(hideLoading, 3000);
    } finally { gimFileInput.value = ''; btnLoadGim.disabled = false; }
  });
}
