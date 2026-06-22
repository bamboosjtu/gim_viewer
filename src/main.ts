import * as OBC from '@thatopen/components';
import * as THREE from 'three';
import { Archive } from 'libarchive.js';

// ── GIM 解析工具 ──────────────────────────────────────────

Archive.init({ workerUrl: 'worker-bundle.js' });

interface IfcEntry {
  name: string;
  path: string;
  modelId: string;
}

/** CBM 层级树节点 */
interface CbmNode {
  path: string;           // CBM 文件路径
  name: string;           // 显示名
  entityName: string;     // ENTITYNAME
  children: CbmNode[];
  famPath: string;        // BASEFAMILY 引用
  devPath: string;        // OBJECTMODELPOINTER 引用
  ifcFile: string;        // IFCFILE 引用
  ifcGuid: string;        // IFCGUID
  classifyName: string;   // SYSCLASSIFYNAME / PARTNAME
  transformMatrix: string;
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

/** 解析 FAM 属性文件（INI 风格，含节标题） */
function parseFamSections(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let currentSection = '默认';
  let currentMap = new Map<string, string>();
  sections.set(currentSection, currentMap);

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const secMatch = line.match(/^\[(.+)\]$/);
    if (secMatch) {
      currentSection = secMatch[1];
      currentMap = new Map<string, string>();
      sections.set(currentSection, currentMap);
      continue;
    }
    const idx = line.indexOf('=');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      // FAM 格式: 键名=键名=值，取最后一个等号后的值
      const secondEq = val.indexOf('=');
      if (secondEq > 0) {
        val = val.slice(secondEq + 1).trim();
      }
      currentMap.set(key, val);
    }
  }
  return sections;
}

/** 检测 GIMPKGS 头部，找到压缩数据偏移 */
function findArchiveOffset(buffer: ArrayBuffer): number {
  const view = new Uint8Array(buffer);
  if (view.length < 8) return 0;
  const header = String.fromCharCode(...view.slice(0, 7));
  if (header !== 'GIMPKGS') return 0;
  for (let i = 7; i < Math.min(view.length, 4096) - 5; i++) {
    if (view[i] === 0x37 && view[i + 1] === 0x7a && view[i + 2] === 0xbc &&
        view[i + 3] === 0xaf && view[i + 4] === 0x27 && view[i + 5] === 0x1c) return i;
  }
  for (let i = 7; i < Math.min(view.length, 4096) - 3; i++) {
    if (view[i] === 0x50 && view[i + 1] === 0x4b && view[i + 2] === 0x03 && view[i + 3] === 0x04) return i;
  }
  return 0;
}

/** 展平 libarchive.js 提取结果 */
function flattenExtractedFiles(obj: unknown, prefix = ''): Map<string, File> {
  const result = new Map<string, File>();
  if (!obj || typeof obj !== 'object') return result;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}/${key}` : key;
    if (value instanceof File) result.set(path, value);
    else if (value && typeof value === 'object') {
      for (const [subPath, subFile] of flattenExtractedFiles(value, path)) result.set(subPath, subFile);
    }
  }
  return result;
}

/** 扫描 DEV 目录下的 IFC 文件 */
function scanIfcFiles(files: Map<string, File>): IfcEntry[] {
  const entries: IfcEntry[] = [];
  for (const [path] of files) {
    if (path.startsWith('DEV/') && path.toLowerCase().endsWith('.ifc')) {
      const fileName = path.split('/').pop()!;
      entries.push({ name: fileName.replace(/\.ifc$/i, ''), path, modelId: fileName.replace(/\.ifc$/i, '') });
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/** 通过 CBM 层级发现 IFC 文件 */
async function discoverIfcFromCBM(files: Map<string, File>): Promise<IfcEntry[]> {
  const visited = new Set<string>();
  const ifcSet = new Map<string, IfcEntry>();

  async function walk(cbmPath: string) {
    if (visited.has(cbmPath)) return;
    visited.add(cbmPath);
    const file = files.get(cbmPath);
    if (!file) return;
    const kv = parseKeyValue(await file.text());
    const ifcNum = parseInt(kv['IFC.NUM'] || '0', 10);
    for (let i = 0; i < ifcNum; i++) {
      const ref = kv[`IFC${i}`];
      if (ref) { const name = ref.replace(/\.ifc$/i, ''); ifcSet.set(name, { name, path: `DEV/${ref}`, modelId: name }); }
    }
    const subNum = parseInt(kv['SUBSYSTEMS.NUM'] || '0', 10);
    for (let i = 0; i < subNum; i++) { const s = kv[`SUBSYSTEM${i}`]; if (s) await walk(`CBM/${s}`); }
    const single = kv['SUBSYSTEM'];
    if (single) await walk(`CBM/${single}`);
  }

  if (files.has('CBM/project.cbm')) await walk('CBM/project.cbm');
  return Array.from(ifcSet.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/** 构建 CBM 层级树 */
async function buildCbmTree(files: Map<string, File>): Promise<CbmNode | null> {
  const visited = new Set<string>();

  async function build(cbmPath: string): Promise<CbmNode | null> {
    if (visited.has(cbmPath)) return null;
    visited.add(cbmPath);
    const file = files.get(cbmPath);
    if (!file) return null;
    const kv = parseKeyValue(await file.text());

    const entityName = kv['ENTITYNAME'] || '';
    const classifyName = kv['SYSCLASSIFYNAME'] || kv['PARTNAME'] || '';
    const displayName = classifyName || entityName || cbmPath.split('/').pop()!;

    const children: CbmNode[] = [];

    // SUBSYSTEM（单数，project.cbm）
    const single = kv['SUBSYSTEM'];
    if (single) {
      const child = await build(`CBM/${single}`);
      if (child) children.push(child);
    }

    // SUBSYSTEMS（复数）
    const subNum = parseInt(kv['SUBSYSTEMS.NUM'] || '0', 10);
    for (let i = 0; i < subNum; i++) {
      const s = kv[`SUBSYSTEM${i}`];
      if (s) { const child = await build(`CBM/${s}`); if (child) children.push(child); }
    }

    // SUBDEVICES
    const devSubNum = parseInt(kv['SUBDEVICES.NUM'] || '0', 10);
    for (let i = 0; i < devSubNum; i++) {
      const s = kv[`SUBDEVICE${i}`];
      if (s) { const child = await build(`CBM/${s}`); if (child) children.push(child); }
    }

    return {
      path: cbmPath,
      name: displayName,
      entityName,
      children,
      famPath: kv['BASEFAMILY'] || '',
      devPath: kv['OBJECTMODELPOINTER'] || '',
      ifcFile: kv['IFCFILE'] || '',
      ifcGuid: kv['IFCGUID'] || '',
      classifyName,
      transformMatrix: kv['TRANSFORMMATRIX'] || '',
    };
  }

  if (!files.has('CBM/project.cbm')) return null;
  return build('CBM/project.cbm');
}

/** 解压 GIM 文件 */
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

// ── UI 元素 ───────────────────────────────────────────────

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
const cbmTreePanel = document.getElementById('cbm-tree-panel') as HTMLElement;
const propsPanel = document.getElementById('props-panel') as HTMLElement;

// ── 3D 引擎 ───────────────────────────────────────────────

const components = new OBC.Components();
const worlds = components.get(OBC.Worlds);
const world = worlds.create<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>();
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

// ── GIM 状态 ──────────────────────────────────────────────

let currentFiles: Map<string, File> | null = null;
let currentIfcEntries: IfcEntry[] = [];
let currentCbmTree: CbmNode | null = null;
// _selectedTreeNode 保留供后续 Phase 2 使用
// @ts-ignore
let _selectedTreeNode: CbmNode | null = null;
const loadedModels = new Map<string, { modelId: string; visible: boolean; ifcTypes: Map<string, number> }>();

// ── 工具函数 ──────────────────────────────────────────────

function showLoading(text: string) { loadingEl.textContent = text; loadingEl.style.display = 'block'; }
function hideLoading() { loadingEl.style.display = 'none'; }

function fitCameraToScene() {
  if (hasFittedCamera) return;
  const box = new THREE.Box3().setFromObject(world.scene.three);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim === 0 || !Number.isFinite(maxDim)) return;
  const distance = maxDim * 1.2;
  void world.camera.controls.setLookAt(center.x + distance, center.y + distance * 0.8, center.z + distance, center.x, center.y, center.z);
  hasFittedCamera = true;
}

/** 获取 IFC 模型的构件类型统计 */
function getIfcTypeStats(modelId: string): Map<string, number> {
  const stats = new Map<string, number>();
  const model = fragments.list.get(modelId);
  if (!model) return stats;
  try {
    // 尝试从 fragments model 获取构件数量
    const obj = model as unknown as { data?: { items?: Record<string, { type?: string }> } };
    if (obj.data?.items) {
      for (const item of Object.values(obj.data.items)) {
        const type = item.type;
        if (type) stats.set(type, (stats.get(type) || 0) + 1);
      }
    }
  } catch {
    // 如果 data 不可访问，跳过
  }
  return stats;
}

// ── 标签页切换 ─────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const tabId = (btn as HTMLElement).dataset.tab!;
    document.getElementById(tabId)?.classList.add('active');
  });
});

// ── 模型列表 UI ────────────────────────────────────────────

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

  // 构件数量徽章
  const badge = document.createElement('span');
  badge.className = 'count-badge';
  badge.textContent = '...';
  badge.id = `badge-${modelId}`;

  const actions = document.createElement('div');
  actions.className = 'actions';
  const removeBtn = document.createElement('button');
  removeBtn.className = 'icon-btn';
  removeBtn.textContent = '×';
  removeBtn.title = '移除模型';
  removeBtn.addEventListener('click', () => { fragments.core.disposeModel(modelId); });

  actions.appendChild(removeBtn);
  item.appendChild(checkbox);
  item.appendChild(name);
  item.appendChild(badge);
  item.appendChild(actions);
  modelListEl.appendChild(item);

  // 异步获取构件数量
  requestAnimationFrame(() => {
    const stats = getIfcTypeStats(modelId);
    const total = Array.from(stats.values()).reduce((a, b) => a + b, 0);
    badge.textContent = total > 0 ? `${total}` : '';
    const entry = loadedModels.get(modelId);
    if (entry) entry.ifcTypes = stats;
  });
}

function removeModelFromUI(modelId: string) {
  document.getElementById(`model-${modelId}`)?.remove();
}

// ── IFC 选择器 UI ─────────────────────────────────────────

function renderIfcPicker() {
  ifcListEl.innerHTML = '';
  if (currentIfcEntries.length === 0) { ifcPickerEl.style.display = 'none'; return; }
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
  const selected: IfcEntry[] = [];
  ifcListEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
    if (cb.checked) { const entry = currentIfcEntries.find((e) => e.modelId === cb.value); if (entry) selected.push(entry); }
  });
  return selected;
}

// ── CBM 层级树 UI ──────────────────────────────────────────

const ENTITY_ICONS: Record<string, string> = {
  F1System: '🏗️',
  F2System: '🏢',
  F3System: '⚡',
  F4System: '🔧',
  PARTINDEX: '🔩',
};

function renderCbmTree(node: CbmNode, parentEl: HTMLElement) {
  const nodeEl = document.createElement('div');
  nodeEl.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row';

  const toggle = document.createElement('span');
  toggle.className = `tree-toggle ${node.children.length === 0 ? 'leaf' : ''}`;
  toggle.textContent = '▶';

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = ENTITY_ICONS[node.entityName] || '📁';

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = node.name;
  label.title = node.path;

  row.appendChild(toggle);
  row.appendChild(icon);
  row.appendChild(label);
  nodeEl.appendChild(row);

  const childrenEl = document.createElement('div');
  childrenEl.className = 'tree-children';
  nodeEl.appendChild(childrenEl);

  // 展开/折叠
  let expanded = false;
  let childrenRendered = false;
  row.addEventListener('click', () => {
    // 选中节点
    document.querySelectorAll('.tree-row.selected').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
    _selectedTreeNode = node;
    showNodeProperties(node);

    // 展开/折叠子节点
    if (node.children.length > 0) {
      expanded = !expanded;
      toggle.classList.toggle('expanded', expanded);
      childrenEl.classList.toggle('expanded', expanded);
      if (expanded && !childrenRendered) {
        for (const child of node.children) renderCbmTree(child, childrenEl);
        childrenRendered = true;
      }
    }
  });

  parentEl.appendChild(nodeEl);
}

function buildAndRenderCbmTree() {
  cbmTreePanel.innerHTML = '';
  if (!currentCbmTree) {
    cbmTreePanel.innerHTML = '<div class="props-empty">加载 GIM 文件后显示层级树</div>';
    return;
  }
  renderCbmTree(currentCbmTree, cbmTreePanel);
}

// ── 属性面板 ───────────────────────────────────────────────

async function showNodeProperties(node: CbmNode) {
  // 切换到属性标签页
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector('[data-tab="tab-props"]')?.classList.add('active');
  document.getElementById('tab-props')?.classList.add('active');

  let html = `<div class="props-header">${node.name}</div>`;

  // 基本信息节
  html += '<div class="props-section"><div class="props-section-title">基本信息</div><table class="props-table">';
  const basicProps: [string, string][] = [
    ['实体类型', node.entityName],
    ['分类名称', node.classifyName],
    ['CBM 文件', node.path.split('/').pop() || ''],
  ];
  if (node.ifcFile) basicProps.push(['IFC 文件', node.ifcFile]);
  if (node.ifcGuid) basicProps.push(['IFC GUID', node.ifcGuid]);
  if (node.children.length > 0) basicProps.push(['子节点数', String(node.children.length)]);
  for (const [k, v] of basicProps) {
    if (v) html += `<tr><td class="prop-key">${k}</td><td class="prop-val">${escHtml(v)}</td></tr>`;
  }
  html += '</table></div>';

  // 读取 CBM 的 FAM 属性
  if (node.famPath && currentFiles) {
    const famFile = currentFiles.get(`CBM/${node.famPath}`);
    if (famFile) {
      const sections = parseFamSections(await famFile.text());
      html += renderFamSections(sections);
    }
  }

  // 读取 DEV → FAM 属性
  if (node.devPath && currentFiles) {
    const devFile = currentFiles.get(`DEV/${node.devPath}`);
    if (devFile) {
      const devKv = parseKeyValue(await devFile.text());
      html += '<div class="props-section"><div class="props-section-title">设备信息</div><table class="props-table">';
      if (devKv['SYMBOLNAME']) html += `<tr><td class="prop-key">设备名称</td><td class="prop-val">${escHtml(devKv['SYMBOLNAME'])}</td></tr>`;
      if (devKv['TYPE']) html += `<tr><td class="prop-key">设备类型</td><td class="prop-val">${escHtml(devKv['TYPE'])}</td></tr>`;
      html += '</table></div>';

      // DEV → FAM
      const devFamRef = devKv['BASEFAMILY'];
      if (devFamRef) {
        const devFamFile = currentFiles.get(`DEV/${devFamRef}`);
        if (devFamFile) {
          const sections = parseFamSections(await devFamFile.text());
          html += renderFamSections(sections);
        }
      }
    }
  }

  // 变换矩阵
  if (node.transformMatrix && node.transformMatrix !== '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1') {
    html += '<div class="props-section"><div class="props-section-title">变换矩阵</div><table class="props-table">';
    html += `<tr><td class="prop-val" colspan="2" style="font-family:monospace;font-size:11px;color:#888;word-break:break-all">${escHtml(node.transformMatrix)}</td></tr>`;
    html += '</table></div>';
  }

  propsPanel.innerHTML = html;
}

function renderFamSections(sections: Map<string, Map<string, string>>): string {
  let html = '';
  for (const [sectionName, props] of sections) {
    if (props.size === 0) continue;
    html += `<div class="props-section"><div class="props-section-title">${escHtml(sectionName)}</div><table class="props-table">`;
    for (const [key, val] of props) {
      if (val) html += `<tr><td class="prop-key">${escHtml(key)}</td><td class="prop-val">${escHtml(val)}</td></tr>`;
    }
    html += '</table></div>';
  }
  return html;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── 引擎初始化 ────────────────────────────────────────────

async function initEngine() {
  if (initialized) return;
  showLoading('初始化 IFC 引擎...');
  await ifcLoader.setup({
    autoSetWasm: false,
    wasm: { path: 'https://unpkg.com/web-ifc@0.0.77/', absolute: true },
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
  fragments.list.onBeforeDelete.add(({ value: model }) => { world.scene.three.remove(model.object); });
  fragments.list.onItemDeleted.add((modelId) => {
    removeModelFromUI(modelId);
    loadedModels.delete(modelId);
    if (fragments.list.size === 0) { emptyTipEl.style.display = 'flex'; hasFittedCamera = false; }
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
    processData: { progressCallback: (progress) => { showLoading(`正在转换 ${name} ${Math.round(progress * 100)}%`); } },
  });
  loadedModels.set(modelId, { modelId, visible: true, ifcTypes: new Map() });
}

// ── GIM 文件加载后的通用处理 ───────────────────────────────

async function onGimExtracted(extracted: Map<string, File>) {
  currentFiles = extracted;

  // 发现 IFC 文件
  let entries = await discoverIfcFromCBM(extracted);
  if (entries.length === 0) entries = scanIfcFiles(extracted);
  currentIfcEntries = entries;

  // 构建 CBM 层级树
  currentCbmTree = await buildCbmTree(extracted);
  buildAndRenderCbmTree();

  return entries;
}

// ── 事件绑定 ──────────────────────────────────────────────

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

btnLoadGim.addEventListener('click', () => gimFileInput.click());

gimFileInput.addEventListener('change', async () => {
  const files = Array.from(gimFileInput.files || []);
  if (files.length === 0) return;
  btnLoadGim.disabled = true;
  try {
    showLoading('正在解压 GIM 文件...');
    const ab = await files[0].arrayBuffer();
    const extracted = await extractGimFile(ab);
    const entries = await onGimExtracted(extracted);

    if (entries.length === 0) { showLoading('未在 GIM 文件中找到 IFC 文件'); setTimeout(hideLoading, 2000); return; }
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
      if (!file) { console.warn(`未找到文件: ${entry.path}`); continue; }
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

btnSelectAll.addEventListener('click', () => {
  ifcListEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => { cb.checked = true; });
});

btnDeselectAll.addEventListener('click', () => {
  ifcListEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
});

btnLoadDemo.addEventListener('click', async () => {
  btnLoadDemo.disabled = true;
  try {
    await initEngine();
    const demoGimPath = 'demo/demo-substation.gim';
    try {
      const res = await fetch(demoGimPath);
      if (res.ok) {
        const ab = await res.arrayBuffer();
        const extracted = await extractGimFile(ab);
        const entries = await onGimExtracted(extracted);
        renderIfcPicker();

        // 自动全选并加载
        ifcListEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => { cb.checked = true; });
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
    } catch { /* fallback */ }

    const DEMO_IFC_FILES = [
      'demo/DEV/总图0317.ifc', 'demo/DEV/一次设备0402其他.ifc',
      'demo/DEV/室内给排水0317.ifc', 'demo/DEV/暖通布置0317.ifc',
      'demo/DEV/警卫室建筑0317.ifc', 'demo/DEV/结构0317.ifc',
      'demo/DEV/接地0317其他.ifc', 'demo/DEV/建筑部分0317.ifc',
      'demo/DEV/基础0317.ifc', 'demo/DEV/给排水消防及排油添加主变水喷淋0401.ifc',
      'demo/DEV/动力照明0317.ifc', 'demo/DEV/电气二次0317其他.ifc',
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

btnClear.addEventListener('click', () => {
  for (const [modelId] of fragments.list) fragments.core.disposeModel(modelId);
  loadedModels.clear();
  currentCbmTree = null;
  _selectedTreeNode = null;
  cbmTreePanel.innerHTML = '<div class="props-empty">加载 GIM 文件后显示层级树</div>';
  propsPanel.innerHTML = '<div class="props-empty">选择层级树节点查看属性</div>';
});

window.addEventListener('resize', () => { world.renderer?.resize(); });
