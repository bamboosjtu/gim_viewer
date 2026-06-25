import type { IfcEntry } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import type { ModelEventCallbacks } from '../viewer/ifcLoader.js';
import type { CbmNode } from '../gim/types.js';
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

/** 创建统一的节点点击回调 */
function createNodeClickHandler(state: AppState, showMessage: (text: string) => void): (node: CbmNode) => void {
  return (node: CbmNode) => {
    import('./nodeInteractionService.js').then(({ handleNodeClick }) => {
      handleNodeClick(state, node, showMessage);
    });
  };
}

/** GIM 文件解压后的处理流程 */
export async function onGimExtracted(state: AppState, files: Map<string, File>, showMessage: (text: string) => void): Promise<IfcEntry[]> {
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

  // 渲染层级树和文件设备面板（统一使用 handleNodeClick）
  const clickHandler = createNodeClickHandler(state, showMessage);
  buildAndRenderCbmTree(state, clickHandler);
  renderFileDevPanel(state, clickHandler);

  return ifcEntries;
}

/**
 * 获取 IFC 文件内容。
 * 1. 优先从完整解压流程的 currentFiles 读取
 * 2. 缓存命中时从 cachedIfcPaths + readCachedIfc 读取
 * 3. 找不到返回 null（调用方跳过）
 */
async function getIfcBufferForEntry(entry: IfcEntry, state: AppState): Promise<Uint8Array | null> {
  // 1. 完整解压流程
  if (state.currentFiles) {
    const file = state.currentFiles.get(entry.path);
    if (file) {
      console.log('[IFC Buffer] 使用 GIM 解压内存文件:', {
        name: entry.name,
        path: entry.path,
      });
      return new Uint8Array(await file.arrayBuffer());
    }
  }

  // 2. Tauri 缓存命中
  if (isTauri() && state.cachedIfcPaths.has(entry.path)) {
    const projectId = state.currentProjectId;
    if (projectId != null) {
      const cachePath = state.cachedIfcPaths.get(entry.path)!;
      console.log('[IFC Buffer] 使用本地 IFC 缓存:', {
        name: entry.name,
        path: entry.path,
        cachePath,
      });
      const { readCachedIfc } = await import('../desktop/database.js');
      return await readCachedIfc(projectId, entry.path);
    }
  }

  // 3. 找不到
  console.warn('[IFC Buffer] 找不到 IFC 文件内容或缓存:', entry);
  return null;
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
      const buffer = await getIfcBufferForEntry(entry, state);
      if (!buffer) continue;
      showLoading(`正在加载 ${entry.name}...`);
      await loadIfcBuffer(ctx, entry.name, buffer, state, (p) => showLoading(`${entry.name}: ${Math.round(p * 100)}%`));
    }
    await buildIfcNameIndex(ctx, state);
    // 统一使用 handleNodeClick 作为点击回调
    const clickHandler = createNodeClickHandler(state, (text) => showLoading(text));
    buildAndRenderCbmTree(state, clickHandler);
    renderFileDevPanel(state, clickHandler);
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

/** 从 ArrayBuffer 加载 GIM 文件的完整流程（浏览器和 Tauri 共用，不创建 Viewer） */
async function openGimFromArrayBuffer(
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
  const entries = await onGimExtracted(state, extracted, showMessage);

  // Tauri 模式：写入 GIM 索引到 SQLite
  if (options?.persistIndex && options.projectId != null && isTauri()) {
    // 缓存 IFC 文件到本地磁盘（以 ifcEntries 为准，逐个 try/catch）
    showLoading('正在缓存 IFC 文件...');
    let localCachePathMap = new Map<string, string>();
    try {
      const { cacheIfcEntries } = await import('./gimExtractedCacheService.js');
      const cacheResult = await cacheIfcEntries(
        options.projectId,
        state.currentFiles ?? new Map<string, File>(),
        state.currentIfcEntries,
      );
      localCachePathMap = cacheResult.pathMap;
      console.log('[Tauri] IFC 缓存结果:', {
        expected: state.currentIfcEntries.length,
        cached: localCachePathMap.size,
        errors: cacheResult.errors,
      });
      if (cacheResult.errors.length > 0) {
        console.warn('[Tauri] 部分 IFC 缓存失败:', cacheResult.errors);
      }
    } catch (err) {
      console.error('[Tauri] IFC 文件缓存失败:', err);
    }

    showLoading('正在写入 GIM 索引...');
    try {
      const { buildGimIndexPayload } = await import('./gimIndexPersistenceService.js');
      const { saveGimIndex } = await import('../desktop/database.js');
      const payload = await buildGimIndexPayload(
        options.projectId,
        state.currentFiles ?? new Map<string, File>(),
        state.currentIfcEntries,
        state.currentCbmTree,
        state.fileDevRelations,
        localCachePathMap,
      );

      // 校验：即将写入的 IFC local_cache_path 数量
      const payloadIfcEntries = payload.entries.filter((e) => e.entry_type === 'IFC');
      console.log('[Tauri] 即将写入 SQLite 的 IFC local_cache_path:', {
        ifc_entries: payloadIfcEntries.length,
        with_cache_path: payloadIfcEntries.filter((e) => !!e.local_cache_path).length,
      });

      await saveGimIndex(payload);
      console.log('[Tauri] GIM 索引已写入:', {
        entries: payload.entries.length,
        cbm_nodes: payload.cbm_nodes.length,
        ifc_models: payload.ifc_models.length,
        file_dev_entries: payload.file_dev_entries.length,
        fam_properties: payload.fam_properties.length,
        dev_properties: payload.dev_properties.length,
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

/**
 * 打开 GIM 文件的动作函数（供 bootstrap 懒加载调用）。
 * - 对话框立即打开，不等待 3D 引擎
 * - FileInfo / 缓存校验不需要 3D
 * - 完整解压路径也不创建 Viewer，只做读取+解压+索引+渲染树
 * - Viewer 仅在节点点击 / IFC 弹窗加载 / 本地 IFC 打开时按需创建
 */
export async function openGimWithDialog(
  state: AppState,
  showMessage: (text: string) => void,
): Promise<void> {
  if (isTauri()) {
    // 1. 对话框立即打开（无 3D 依赖）
    const filePath = await openGimFilePath();
    if (!filePath) return;
    btnLoadGim.disabled = true;
    try {
      // 2. FileInfo + 缓存校验（无 3D 依赖）
      showLoading('正在读取 GIM 文件信息...');
      const { getFileInfo, readFileBytes } = await import('../desktop/fileReader.js');
      const info = await getFileInfo(filePath);
      console.log('[Tauri] GIM 文件信息:', info);
      showLoading('正在写入本地项目索引...');
      const { upsertGimProject, validateGimCache, getGimIndex } = await import('../desktop/database.js');
      const record = await upsertGimProject(info);
      console.log('[Tauri] GIM 项目记录:', record);

      showLoading('正在检查本地缓存...');
      const validation = await validateGimCache(record.id);
      console.log('[Tauri] GIM 缓存校验:', validation);

      // 3. 缓存命中短路：不 readFileBytes、不 extractGimFile、不创建 Viewer
      if (validation.valid) {
        try {
          showLoading('正在从本地缓存恢复 GIM 索引...');
          const { restoreGimIndexToState } = await import('./gimIndexRestoreService.js');

          const index = await getGimIndex(record.id);
          restoreGimIndexToState(state, index);
          state.currentProjectId = record.id;

          console.log('[Tauri] 已从缓存恢复 GIM:', {
            project_id: record.id,
            ifc_entries: state.currentIfcEntries.length,
            cbm_root: state.currentCbmTree?.path || null,
            cached_ifc_paths: state.cachedIfcPaths.size,
            file_dev_relations: state.fileDevRelations.length,
          });

          if (state.currentIfcEntries.length === 0) {
            throw new Error('缓存索引中没有 IFC 文件');
          }

          // 立即渲染 CBM 层级树和文件设备面板（无 Viewer）
          // 点击节点时由 nodeInteractionService 懒加载 Viewer + IFC
          const clickHandler = createNodeClickHandler(state, showMessage);
          buildAndRenderCbmTree(state, clickHandler);
          renderFileDevPanel(state, clickHandler);
          emptyTipEl.style.display = 'none';

          hideLoading();
          // 轻量状态提示
          showLoading('已从本地缓存恢复，可点击节点按需加载 IFC');
          setTimeout(hideLoading, 3000);
          console.log('[Tauri] 缓存短路生效：未读取原始 GIM，未执行解压');
          return; // 缓存命中，短路完成
        } catch (err) {
          console.warn('[Tauri] 缓存恢复失败，回退完整解压流程:', err);
        }
      } else {
        console.log('[Tauri] 缓存无效或不完整，继续完整解压流程:', validation);
      }

      // 4. 回退：完整解压流程（不创建 Viewer，只读取+解压+索引+渲染树）
      console.log('[Tauri] 缓存短路未生效：进入完整解压流程');
      showLoading('正在读取 GIM 文件...');
      const ab = await readFileBytes(filePath);

      const fileName = filePath.split(/[\\/]/).pop() || 'project.gim';
      await openGimFromArrayBuffer(state, fileName, ab, showMessage, {
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

  // 浏览器模式：input.click() 立即触发，change 后读取+解压（不创建 Viewer）
  return new Promise<void>((resolve) => {
    const handler = async () => {
      gimFileInput.removeEventListener('change', handler);
      const files = Array.from(gimFileInput.files || []);
      if (files.length === 0) { resolve(); return; }
      btnLoadGim.disabled = true;
      try {
        const ab = await files[0].arrayBuffer();
        await openGimFromArrayBuffer(state, files[0].name, ab, showMessage);
      } catch (err) {
        console.error(err);
        showLoading(`GIM 解析失败: ${err instanceof Error ? err.message : String(err)}`);
        setTimeout(hideLoading, 3000);
      } finally {
        gimFileInput.value = '';
        btnLoadGim.disabled = false;
        resolve();
      }
    };
    gimFileInput.addEventListener('change', handler);
    gimFileInput.click();
  });
}
