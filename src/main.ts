import * as OBC from '@thatopen/components';
import * as THREE from 'three';
import { Archive } from 'libarchive.js';

// ── GIM 解析工具 ──────────────────────────────────────────

// 初始化 libarchive.js Worker
Archive.init({
  workerUrl: 'worker-bundle.js',
});

interface IfcEntry {
  name: string;       // 显示名（如 "建筑部分0317"）
  path: string;       // 在压缩包中的路径（如 "DEV/建筑部分0317.ifc"）
  modelId: string;    // 模型ID（如 "建筑部分0317"）
}

/** 解析键值对文本文件 */
function parseKeyValue(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return result;
}

/**
 * 检测 GIM 文件的自定义头部（GIMPKGS），找到实际压缩数据的偏移量。
 * .gim 文件结构：GIMPKGS 头部（变长）+ 7z 或 ZIP 压缩数据
 */
function findArchiveOffset(buffer: ArrayBuffer): number {
  const view = new Uint8Array(buffer);
  if (view.length < 8) return 0;

  // 检查 GIMPKGS 头部
  const header = String.fromCharCode(...view.slice(0, 7));
  if (header !== 'GIMPKGS') return 0;

  // 在前 4KB 中搜索 7z 签名 (37 7A BC AF 27 1C)
  for (let i = 7; i < Math.min(view.length, 4096) - 5; i++) {
    if (
      view[i] === 0x37 && view[i + 1] === 0x7a &&
      view[i + 2] === 0xbc && view[i + 3] === 0xaf &&
      view[i + 4] === 0x27 && view[i + 5] === 0x1c
    ) {
      return i;
    }
  }

  // 搜索 ZIP 签名 (PK\x03\x04)
  for (let i = 7; i < Math.min(view.length, 4096) - 3; i++) {
    if (
      view[i] === 0x50 && view[i + 1] === 0x4b &&
      view[i + 2] === 0x03 && view[i + 3] === 0x04
    ) {
      return i;
    }
  }

  return 0;
}

/** 将 libarchive.js 提取的嵌套对象展平为 Map<path, File> */
function flattenExtractedFiles(obj: unknown, prefix = ''): Map<string, File> {
  const result = new Map<string, File>();
  if (!obj || typeof obj !== 'object') return result;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}/${key}` : key;
    if (value instanceof File) {
      result.set(path, value);
    } else if (value && typeof value === 'object') {
      for (const [subPath, subFile] of flattenExtractedFiles(value, path)) {
        result.set(subPath, subFile);
      }
    }
  }
  return result;
}

/** 从 GIM 压缩包中扫描所有 IFC 文件 */
function scanIfcFiles(files: Map<string, File>): IfcEntry[] {
  const entries: IfcEntry[] = [];
  for (const [path] of files) {
    if (path.startsWith('DEV/') && path.toLowerCase().endsWith('.ifc')) {
      const fileName = path.split('/').pop()!;
      entries.push({
        name: fileName.replace(/\.ifc$/i, ''),
        path,
        modelId: fileName.replace(/\.ifc$/i, ''),
      });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return entries;
}

/** 尝试通过 CBM 层级结构发现 IFC 文件 */
async function discoverIfcFromCBM(files: Map<string, File>): Promise<IfcEntry[]> {
  const visited = new Set<string>();
  const ifcSet = new Map<string, IfcEntry>();

  async function walkCbm(cbmPath: string) {
    if (visited.has(cbmPath)) return;
    visited.add(cbmPath);
    const file = files.get(cbmPath);
    if (!file) return;
    const text = await file.text();
    const kv = parseKeyValue(text);

    // 收集 IFC 引用
    const ifcNum = parseInt(kv['IFC.NUM'] || '0', 10);
    for (let i = 0; i < ifcNum; i++) {
      const ifcRef = kv[`IFC${i}`];
      if (ifcRef) {
        const ifcPath = `DEV/${ifcRef}`;
        const name = ifcRef.replace(/\.ifc$/i, '');
        ifcSet.set(name, { name, path: ifcPath, modelId: name });
      }
    }

    // 递归子系统
    const subNum = parseInt(kv['SUBSYSTEMS.NUM'] || '0', 10);
    for (let i = 0; i < subNum; i++) {
      const sub = kv[`SUBSYSTEM${i}`];
      if (sub) {
        await walkCbm(`CBM/${sub}`);
      }
    }
    // SUBSYSTEM（单数，project.cbm 使用）
    const single = kv['SUBSYSTEM'];
    if (single) {
      await walkCbm(`CBM/${single}`);
    }
  }

  // 从入口开始
  if (files.has('CBM/project.cbm')) {
    await walkCbm('CBM/project.cbm');
  }

  return Array.from(ifcSet.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/** 解压 GIM 文件，返回所有文件的 Map */
async function extractGimFile(arrayBuffer: ArrayBuffer): Promise<Map<string, File>> {
  const offset = findArchiveOffset(arrayBuffer);
  const archiveBuffer = offset > 0 ? arrayBuffer.slice(offset) : arrayBuffer;
  const blob = new Blob([archiveBuffer]);
  const file = new File([blob], 'archive', { type: 'application/octet-stream' });
  const archive = await Archive.open(file);
  const extracted = await archive.extractFiles();
  await archive.close();
  return flattenExtractedFiles(extracted);
}

// ── UI & 状态 ─────────────────────────────────────────────

const container = document.getElementById('viewport') as HTMLElement;
const loadingEl = document.getElementById('loading') as HTMLElement;
const emptyTipEl = document.getElementById('empty-tip') as HTMLElement;
const modelListEl = document.getElementById('model-list') as HTMLElement;
const ifcPickerEl = document.getElementById('ifc-picker') as HTMLElement;
const ifcListEl = document.getElementById('ifc-list') as HTMLElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const gimFileInput = document.getElementById('gim-file-input') as HTMLInputElement;
const btnLoadLocal = document.getElementById('btn-load-local') as HTMLButtonElement;
const btnLoadGim = document.getElementById('btn-load-gim') as HTMLButtonElement;
const btnLoadDemo = document.getElementById('btn-load-demo') as HTMLButtonElement;
const btnClear = document.getElementById('btn-clear') as HTMLButtonElement;
const btnLoadSelected = document.getElementById('btn-load-selected') as HTMLButtonElement;
const btnSelectAll = document.getElementById('btn-select-all') as HTMLButtonElement;
const btnDeselectAll = document.getElementById('btn-deselect-all') as HTMLButtonElement;

// 3D 引擎
const components = new OBC.Components();
const worlds = components.get(OBC.Worlds);
const world = worlds.create<
  OBC.SimpleScene,
  OBC.OrthoPerspectiveCamera,
  OBC.SimpleRenderer
>();

world.scene = new OBC.SimpleScene(components);
world.scene.setup();
world.scene.three.background = new THREE.Color(0xeeeeee);
world.renderer = new OBC.SimpleRenderer(components, container);
world.camera = new OBC.OrthoPerspectiveCamera(components);
components.init();
components.get(OBC.Grids).create(world);

const ifcLoader = components.get(OBC.IfcLoader);
const fragments = components.get(OBC.FragmentsManager);

let initialized = false;
let hasFittedCamera = false;

// GIM 状态
let currentFiles: Map<string, File> | null = null;
let currentIfcEntries: IfcEntry[] = [];
const loadedModels = new Map<string, { modelId: string; visible: boolean }>();

// ── 工具函数 ──────────────────────────────────────────────

function showLoading(text: string) {
  loadingEl.textContent = text;
  loadingEl.style.display = 'block';
}

function hideLoading() {
  loadingEl.style.display = 'none';
}

function fitCameraToScene() {
  if (hasFittedCamera) return;
  const box = new THREE.Box3().setFromObject(world.scene.three);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim === 0 || !Number.isFinite(maxDim)) return;
  const distance = maxDim * 1.2;
  void world.camera.controls.setLookAt(
    center.x + distance,
    center.y + distance * 0.8,
    center.z + distance,
    center.x,
    center.y,
    center.z,
  );
  hasFittedCamera = true;
}

// ── 模型列表 UI ───────────────────────────────────────────

function addModelToUI(modelId: string) {
  if (document.getElementById(`model-${modelId}`)) return;
  const item = document.createElement('div');
  item.id = `model-${modelId}`;
  item.className = 'model-item';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = true;
  checkbox.className = 'model-checkbox';
  checkbox.title = '显示/隐藏';
  checkbox.addEventListener('change', () => {
    const model = fragments.list.get(modelId);
    if (model) {
      model.object.visible = checkbox.checked;
      const entry = loadedModels.get(modelId);
      if (entry) entry.visible = checkbox.checked;
    }
  });

  const name = document.createElement('span');
  name.className = 'name';
  name.title = modelId;
  name.textContent = modelId;

  const actions = document.createElement('div');
  actions.className = 'actions';

  const removeBtn = document.createElement('button');
  removeBtn.className = 'icon-btn';
  removeBtn.textContent = '×';
  removeBtn.title = '移除模型';
  removeBtn.addEventListener('click', () => {
    fragments.core.disposeModel(modelId);
  });

  actions.appendChild(removeBtn);
  item.appendChild(checkbox);
  item.appendChild(name);
  item.appendChild(actions);
  modelListEl.appendChild(item);
}

function removeModelFromUI(modelId: string) {
  const item = document.getElementById(`model-${modelId}`);
  if (item) item.remove();
}

// ── IFC 选择器 UI ─────────────────────────────────────────

function renderIfcPicker() {
  ifcListEl.innerHTML = '';
  if (currentIfcEntries.length === 0) {
    ifcPickerEl.style.display = 'none';
    return;
  }
  ifcPickerEl.style.display = 'block';

  for (const entry of currentIfcEntries) {
    const label = document.createElement('label');
    label.className = 'ifc-check-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = entry.modelId;
    checkbox.checked = false;

    const span = document.createElement('span');
    span.textContent = entry.name;

    label.appendChild(checkbox);
    label.appendChild(span);
    ifcListEl.appendChild(label);
  }
}

function getSelectedIfcEntries(): IfcEntry[] {
  const checkboxes = ifcListEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  const selected: IfcEntry[] = [];
  checkboxes.forEach((cb) => {
    if (cb.checked) {
      const entry = currentIfcEntries.find((e) => e.modelId === cb.value);
      if (entry) selected.push(entry);
    }
  });
  return selected;
}

// ── 引擎初始化 ────────────────────────────────────────────

async function initEngine() {
  if (initialized) return;

  showLoading('初始化 IFC 引擎...');
  await ifcLoader.setup({
    autoSetWasm: false,
    wasm: {
      path: 'https://unpkg.com/web-ifc@0.0.77/',
      absolute: true,
    },
  });

  const workerUrl = await OBC.FragmentsManager.getWorker();
  fragments.init(workerUrl);

  world.camera.controls.addEventListener('update', () => fragments.core.update());

  fragments.list.onItemSet.add(({ value: model }) => {
    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    fragments.core.update(true);
    addModelToUI(model.modelId);
    emptyTipEl.style.display = 'none';
    fitCameraToScene();
  });

  fragments.list.onBeforeDelete.add(({ value: model }) => {
    world.scene.three.remove(model.object);
  });

  fragments.list.onItemDeleted.add((modelId) => {
    removeModelFromUI(modelId);
    loadedModels.delete(modelId);
    if (fragments.list.size === 0) {
      emptyTipEl.style.display = 'flex';
      hasFittedCamera = false;
    }
  });

  fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
    if (!('isLodMaterial' in material && material.isLodMaterial)) {
      material.polygonOffset = true;
      material.polygonOffsetUnits = 1;
      material.polygonOffsetFactor = Math.random();
    }
  });

  initialized = true;
  hideLoading();
}

// ── IFC 加载 ──────────────────────────────────────────────

async function loadIfcBuffer(name: string, buffer: Uint8Array) {
  const modelId = name.replace(/\.ifc$/i, '');
  await ifcLoader.load(buffer, true, modelId, {
    processData: {
      progressCallback: (progress) => {
        showLoading(`正在转换 ${name} ${Math.round(progress * 100)}%`);
      },
    },
  });
  loadedModels.set(modelId, { modelId, visible: true });
}

// ── 事件绑定 ──────────────────────────────────────────────

// 选择本地 IFC 文件
btnLoadLocal.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files || []);
  if (files.length === 0) return;
  btnLoadLocal.disabled = true;
  try {
    await initEngine();
    for (const file of files) {
      showLoading(`正在读取 ${file.name}...`);
      const buffer = new Uint8Array(await file.arrayBuffer());
      await loadIfcBuffer(file.name, buffer);
    }
  } catch (err) {
    console.error(err);
    showLoading(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
    setTimeout(hideLoading, 3000);
  } finally {
    fileInput.value = '';
    btnLoadLocal.disabled = false;
    hideLoading();
  }
});

// 加载 GIM 文件
btnLoadGim.addEventListener('click', () => gimFileInput.click());

gimFileInput.addEventListener('change', async () => {
  const files = Array.from(gimFileInput.files || []);
  if (files.length === 0) return;
  btnLoadGim.disabled = true;
  try {
    showLoading('正在解压 GIM 文件...');
    const file = files[0];
    const ab = await file.arrayBuffer();
    const extracted = await extractGimFile(ab);
    currentFiles = extracted;

    // 尝试通过 CBM 层级发现 IFC，如果失败则直接扫描
    let entries = await discoverIfcFromCBM(extracted);
    if (entries.length === 0) {
      entries = scanIfcFiles(extracted);
    }
    currentIfcEntries = entries;

    if (entries.length === 0) {
      showLoading('未在 GIM 文件中找到 IFC 文件');
      setTimeout(hideLoading, 2000);
      return;
    }

    renderIfcPicker();
    hideLoading();
  } catch (err) {
    console.error(err);
    showLoading(`GIM 解析失败: ${err instanceof Error ? err.message : String(err)}`);
    setTimeout(hideLoading, 3000);
  } finally {
    gimFileInput.value = '';
    btnLoadGim.disabled = false;
  }
});

// 加载选中的 IFC
btnLoadSelected.addEventListener('click', async () => {
  const selected = getSelectedIfcEntries();
  if (selected.length === 0 || !currentFiles) return;
  btnLoadSelected.disabled = true;
  try {
    await initEngine();
    for (const entry of selected) {
      if (loadedModels.has(entry.modelId)) continue;
      showLoading(`正在读取 ${entry.name}.ifc...`);
      const file = currentFiles.get(entry.path);
      if (!file) {
        console.warn(`未找到文件: ${entry.path}`);
        continue;
      }
      const buffer = new Uint8Array(await file.arrayBuffer());
      await loadIfcBuffer(`${entry.name}.ifc`, buffer);
    }
  } catch (err) {
    console.error(err);
    showLoading(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
    setTimeout(hideLoading, 3000);
  } finally {
    btnLoadSelected.disabled = false;
    hideLoading();
  }
});

// 全选/取消全选
btnSelectAll.addEventListener('click', () => {
  ifcListEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
    cb.checked = true;
  });
});

btnDeselectAll.addEventListener('click', () => {
  ifcListEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
    cb.checked = false;
  });
});

// 加载 demo
btnLoadDemo.addEventListener('click', async () => {
  btnLoadDemo.disabled = true;
  try {
    await initEngine();
    // 先尝试从 demo 目录的 GIM 文件加载
    const demoGimPath = 'demo/demo-substation.gim';

    try {
      const res = await fetch(demoGimPath);
      if (res.ok) {
        const ab = await res.arrayBuffer();
        const extracted = await extractGimFile(ab);
        currentFiles = extracted;

        let entries = await discoverIfcFromCBM(extracted);
        if (entries.length === 0) {
          entries = scanIfcFiles(extracted);
        }
        currentIfcEntries = entries;
        renderIfcPicker();

        // 自动全选并加载
        ifcListEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
          cb.checked = true;
        });
        for (const entry of entries) {
          if (loadedModels.has(entry.modelId)) continue;
          showLoading(`正在读取 ${entry.name}.ifc...`);
          const file = extracted.get(entry.path);
          if (!file) continue;
          const buffer = new Uint8Array(await file.arrayBuffer());
          await loadIfcBuffer(`${entry.name}.ifc`, buffer);
        }
        hideLoading();
        return;
      }
    } catch {
      // GIM 文件不可用，回退到直接加载 IFC
    }

    // 回退：直接从 demo/DEV 目录加载
    const DEMO_IFC_FILES = [
      'demo/DEV/总图0317.ifc',
      'demo/DEV/一次设备0402其他.ifc',
      'demo/DEV/室内给排水0317.ifc',
      'demo/DEV/暖通布置0317.ifc',
      'demo/DEV/警卫室建筑0317.ifc',
      'demo/DEV/结构0317.ifc',
      'demo/DEV/接地0317其他.ifc',
      'demo/DEV/建筑部分0317.ifc',
      'demo/DEV/基础0317.ifc',
      'demo/DEV/给排水消防及排油添加主变水喷淋0401.ifc',
      'demo/DEV/动力照明0317.ifc',
      'demo/DEV/电气二次0317其他.ifc',
    ];
    for (const path of DEMO_IFC_FILES) {
      const name = path.split('/').pop()!;
      showLoading(`正在读取 ${name}...`);
      const res = await fetch(path);
      if (!res.ok) throw new Error(`无法获取 ${name}: ${res.status}`);
      const buffer = new Uint8Array(await res.arrayBuffer());
      await loadIfcBuffer(name, buffer);
    }
  } catch (err) {
    console.error(err);
    showLoading(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
    setTimeout(hideLoading, 3000);
  } finally {
    btnLoadDemo.disabled = false;
    hideLoading();
  }
});

// 清空场景
btnClear.addEventListener('click', () => {
  for (const [modelId] of fragments.list) {
    fragments.core.disposeModel(modelId);
  }
  loadedModels.clear();
});

window.addEventListener('resize', () => {
  world.renderer?.resize();
});
