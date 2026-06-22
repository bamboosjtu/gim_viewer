import * as OBC from '@thatopen/components';
import * as OBCF from '@thatopen/fragments';
import * as THREE from 'three';
import { Archive } from 'libarchive.js';

// ── GIM 解析工具 ──────────────────────────────────────────

Archive.init({ workerUrl: 'worker-bundle.js' });

interface IfcEntry {
  name: string;
  path: string;
  modelId: string;
}

interface CbmNode {
  path: string;
  name: string;
  entityName: string;
  children: CbmNode[];
  famPath: string;
  devPath: string;
  ifcFile: string;
  ifcGuid: string;
  classifyName: string;
  transformMatrix: string;
}

function parseKeyValue(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx > 0) result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

function parseFamSections(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let cur = '默认';
  let map = new Map<string, string>();
  sections.set(cur, map);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) { cur = m[1]; map = new Map(); sections.set(cur, map); continue; }
    const idx = line.indexOf('=');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      const eq2 = val.indexOf('=');
      if (eq2 > 0) val = val.slice(eq2 + 1).trim();
      map.set(key, val);
    }
  }
  return sections;
}

function findArchiveOffset(buffer: ArrayBuffer): number {
  const v = new Uint8Array(buffer);
  if (v.length < 8) return 0;
  if (String.fromCharCode(...v.slice(0, 7)) !== 'GIMPKGS') return 0;
  for (let i = 7; i < Math.min(v.length, 4096) - 5; i++) {
    if (v[i] === 0x37 && v[i + 1] === 0x7a && v[i + 2] === 0xbc && v[i + 3] === 0xaf && v[i + 4] === 0x27 && v[i + 5] === 0x1c) return i;
  }
  for (let i = 7; i < Math.min(v.length, 4096) - 3; i++) {
    if (v[i] === 0x50 && v[i + 1] === 0x4b && v[i + 2] === 0x03 && v[i + 3] === 0x04) return i;
  }
  return 0;
}

function flattenExtractedFiles(obj: unknown, prefix = ''): Map<string, File> {
  const result = new Map<string, File>();
  if (!obj || typeof obj !== 'object') return result;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}/${key}` : key;
    if (value instanceof File) result.set(path, value);
    else if (value && typeof value === 'object') for (const [sp, sf] of flattenExtractedFiles(value, path)) result.set(sp, sf);
  }
  return result;
}

function scanIfcFiles(files: Map<string, File>): IfcEntry[] {
  const entries: IfcEntry[] = [];
  for (const [path] of files) {
    if (path.startsWith('DEV/') && path.toLowerCase().endsWith('.ifc')) {
      const fn = path.split('/').pop()!;
      entries.push({ name: fn.replace(/\.ifc$/i, ''), path, modelId: fn.replace(/\.ifc$/i, '') });
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

async function discoverIfcFromCBM(files: Map<string, File>): Promise<IfcEntry[]> {
  const visited = new Set<string>();
  const ifcSet = new Map<string, IfcEntry>();
  async function walk(p: string) {
    if (visited.has(p)) return; visited.add(p);
    const f = files.get(p); if (!f) return;
    const kv = parseKeyValue(await f.text());
    const n = parseInt(kv['IFC.NUM'] || '0', 10);
    for (let i = 0; i < n; i++) { const r = kv[`IFC${i}`]; if (r) { const nm = r.replace(/\.ifc$/i, ''); ifcSet.set(nm, { name: nm, path: `DEV/${r}`, modelId: nm }); } }
    const sn = parseInt(kv['SUBSYSTEMS.NUM'] || '0', 10);
    for (let i = 0; i < sn; i++) { const s = kv[`SUBSYSTEM${i}`]; if (s) await walk(`CBM/${s}`); }
    const sg = kv['SUBSYSTEM']; if (sg) await walk(`CBM/${sg}`);
  }
  if (files.has('CBM/project.cbm')) await walk('CBM/project.cbm');
  return Array.from(ifcSet.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

async function buildCbmTree(files: Map<string, File>): Promise<CbmNode | null> {
  const visited = new Set<string>();
  async function build(p: string): Promise<CbmNode | null> {
    if (visited.has(p)) return null; visited.add(p);
    const f = files.get(p); if (!f) return null;
    const kv = parseKeyValue(await f.text());
    const en = kv['ENTITYNAME'] || '';
    const cn = kv['SYSCLASSIFYNAME'] || kv['PARTNAME'] || '';
    const dn = cn || en || p.split('/').pop()!;
    const children: CbmNode[] = [];
    const sg = kv['SUBSYSTEM']; if (sg) { const c = await build(`CBM/${sg}`); if (c) children.push(c); }
    const sn = parseInt(kv['SUBSYSTEMS.NUM'] || '0', 10);
    for (let i = 0; i < sn; i++) { const s = kv[`SUBSYSTEM${i}`]; if (s) { const c = await build(`CBM/${s}`); if (c) children.push(c); } }
    const dn2 = parseInt(kv['SUBDEVICES.NUM'] || '0', 10);
    for (let i = 0; i < dn2; i++) { const s = kv[`SUBDEVICE${i}`]; if (s) { const c = await build(`CBM/${s}`); if (c) children.push(c); } }
    return { path: p, name: dn, entityName: en, children, famPath: kv['BASEFAMILY'] || '', devPath: kv['OBJECTMODELPOINTER'] || '', ifcFile: kv['IFCFILE'] || '', ifcGuid: (kv['IFCGUID'] || '').replace(/\$+$/, '').trim(), classifyName: cn, transformMatrix: kv['TRANSFORMMATRIX'] || '' };
  }
  if (!files.has('CBM/project.cbm')) return null;
  return build('CBM/project.cbm');
}

/** 构建 IFCGUID → CbmNode 反向索引 */
function buildIfcGuidIndex(node: CbmNode | null): Map<string, CbmNode> {
  const index = new Map<string, CbmNode>();
  function walk(n: CbmNode) {
    if (n.ifcGuid && n.ifcFile) {
      // 以 "ifcFile:ifcGuid" 为键，支持同一 GUID 在不同 IFC 文件中出现
      index.set(`${n.ifcFile}:${n.ifcGuid}`, n);
    }
    for (const child of n.children) walk(child);
  }
  if (node) walk(node);
  return index;
}

/** 获取节点显示名称：优先 IFC 名称，其次分类名称 */
function getNodeDisplayName(node: CbmNode): string {
  if (node.ifcFile && node.ifcGuid) {
    const modelId = node.ifcFile.replace(/\.ifc$/i, '');
    const ifcName = ifcGuidToName.get(`${modelId}:${node.ifcGuid}`);
    if (ifcName) return ifcName;
  }
  return node.name;
}

/** IFC 模型加载后，构建 GUID → 名称索引 */
async function buildIfcNameIndex() {
  // 按 modelId 分组收集 GUID
  const byModel = new Map<string, { guid: string; node: CbmNode }[]>();
  for (const [, node] of ifcGuidIndex) {
    const modelId = node.ifcFile.replace(/\.ifc$/i, '');
    if (!byModel.has(modelId)) byModel.set(modelId, []);
    byModel.get(modelId)!.push({ guid: node.ifcGuid, node });
  }

  for (const [modelId, entries] of byModel) {
    const model = fragments.list.get(modelId);
    if (!model) continue;
    const guids = entries.map(e => e.guid);
    try {
      const localIds = await model.getLocalIdsByGuids(guids);
      const validEntries = entries.filter((_, i) => localIds[i] !== null);
      const validLocalIds = localIds.filter((id): id is number => id !== null);
      if (validLocalIds.length === 0) continue;
      const itemsData = await model.getItemsData(validLocalIds, { attributesDefault: true });
      for (let i = 0; i < validEntries.length; i++) {
        const data = itemsData[i] as unknown as Record<string, unknown>;
        if (!data) continue;
        // 查找 Name 属性
        let name: string | null = null;
        for (const [k, v] of Object.entries(data)) {
          if (k === 'Name' && v && typeof v === 'object' && 'value' in v) {
            const val = (v as { value: unknown }).value;
            if (val) name = String(val);
            break;
          }
        }
        if (name) {
          ifcGuidToName.set(`${modelId}:${validEntries[i].guid}`, name);
          validEntries[i].node.name = name; // 更新节点名称
        }
      }
    } catch (err) {
      console.warn(`构建名称索引失败 (${modelId}):`, err);
    }
  }
  console.log(`IFC 名称索引: ${ifcGuidToName.size} 条记录`);
}

/** 构建 CBM 文件名 → CbmNode 索引 */
function buildCbmNodeIndex(node: CbmNode | null): Map<string, CbmNode> {
  const index = new Map<string, CbmNode>();
  function walk(n: CbmNode) {
    const fileName = n.path.split('/').pop() || '';
    if (fileName) index.set(fileName, n);
    for (const child of n.children) walk(child);
  }
  if (node) walk(node);
  return index;
}

/** 收集节点及其后代的所有 IFC 引用 → Map<modelId, Set<ifcGuid>> */
function collectIfcRefs(node: CbmNode): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  function walk(n: CbmNode) {
    if (n.ifcFile && n.ifcGuid) {
      const modelId = n.ifcFile.replace(/\.ifc$/i, '');
      if (!refs.has(modelId)) refs.set(modelId, new Set());
      refs.get(modelId)!.add(n.ifcGuid);
    }
    for (const child of n.children) walk(child);
  }
  walk(node);
  return refs;
}

/** FileDevRelation 条目 */
interface FileDevEntry {
  ifcName: string;
  ifcFile: string;
  modelId: string;
  deviceCount: number;
  deviceCbms: string[];
}

/** 解析 FileDevRelation.cbm */
async function parseFileDevRelation(files: Map<string, File>): Promise<FileDevEntry[]> {
  const f = files.get('CBM/FileDevRelation.cbm');
  if (!f) return [];
  const kv = parseKeyValue(await f.text());
  const num = parseInt(kv['FILE.NUM'] || '0', 10);
  const entries: FileDevEntry[] = [];
  for (let i = 0; i < num; i += 2) {
    const ifcName = kv[`FILE${i}.NAME`] || '';
    const devNum = parseInt(kv[`FILE${i}.DEV.NUM`] || '0', 10);
    const deviceCbms: string[] = [];
    for (let j = 0; j < devNum; j++) {
      const dev = kv[`FILE${i}.DEV${j}`];
      if (dev) deviceCbms.push(dev);
    }
    // 奇数条目含实际 IFC 文件名
    const ifcFile = kv[`FILE${i + 1}.IFC`] || `${ifcName}.ifc`;
    const modelId = ifcFile.replace(/\.ifc$/i, '');
    entries.push({ ifcName, ifcFile, modelId, deviceCount: devNum, deviceCbms });
  }
  return entries;
}

async function extractGimFile(arrayBuffer: ArrayBuffer): Promise<Map<string, File>> {
  const offset = findArchiveOffset(arrayBuffer);
  const ab = offset > 0 ? arrayBuffer.slice(offset) : arrayBuffer;
  const blob = new Blob([ab]);
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
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const gimFileInput = document.getElementById('gim-file-input') as HTMLInputElement;
const btnLoadLocal = document.getElementById('btn-load-local') as HTMLButtonElement;
const btnLoadGim = document.getElementById('btn-load-gim') as HTMLButtonElement;
const btnLoadDemo = document.getElementById('btn-load-demo') as HTMLButtonElement;
const btnClear = document.getElementById('btn-clear') as HTMLButtonElement;
const cbmTreePanel = document.getElementById('cbm-tree-panel') as HTMLElement;
const fileDevPanel = document.getElementById('file-dev-panel') as HTMLElement;
const propsDrawerBody = document.getElementById('props-drawer-body') as HTMLElement;
const propsDrawer = document.getElementById('props-drawer') as HTMLElement;
const btnToggleProps = document.getElementById('btn-toggle-props') as HTMLButtonElement;
const btnCloseProps = document.getElementById('btn-close-props') as HTMLButtonElement;

// 模态框
const ifcModal = document.getElementById('ifc-modal') as HTMLElement;
const modalIfcList = document.getElementById('modal-ifc-list') as HTMLElement;
const modalInfo = document.getElementById('modal-info') as HTMLElement;
const modalClose = document.getElementById('modal-close') as HTMLButtonElement;
const modalSelectAll = document.getElementById('modal-select-all') as HTMLButtonElement;
const modalDeselectAll = document.getElementById('modal-deselect-all') as HTMLButtonElement;
const modalLoad = document.getElementById('modal-load') as HTMLButtonElement;

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
let ifcGuidIndex = new Map<string, CbmNode>(); // "ifcFile:ifcGuid" → CbmNode
let cbmNodeIndex = new Map<string, CbmNode>(); // cbmFileName → CbmNode
let ifcGuidToName = new Map<string, string>(); // "modelId:guid" → displayName
let fileDevRelations: FileDevEntry[] = [];
let deviceToIfcFile = new Map<string, string>(); // deviceCbmName → ifcModelId
const loadedModels = new Map<string, { modelId: string; visible: boolean }>();

// 高亮状态
let highlightedItems: OBC.ModelIdMap | null = null;
const HIGHLIGHT_STYLE: OBCF.MaterialDefinition = {
  color: new THREE.Color(0x00ccff),
  renderedFaces: OBCF.RenderedFaces.TWO,
  opacity: 0.6,
  transparent: true,
};

// ── 工具函数 ──────────────────────────────────────────────

function showLoading(text: string) { loadingEl.textContent = text; loadingEl.style.display = 'block'; }
function hideLoading() { loadingEl.style.display = 'none'; }

/** 显示临时消息提醒（3秒后自动消失） */
let messageTimer: ReturnType<typeof setTimeout> | null = null;
function showMessage(text: string) {
  console.log(text);
  const msgEl = document.getElementById('message-tip') || (() => {
    const el = document.createElement('div');
    el.id = 'message-tip';
    el.style.cssText = 'position:absolute;bottom:20px;left:50%;transform:translateX(-50%);padding:10px 20px;background:rgba(0,0,0,0.8);color:#fff;border-radius:8px;font-size:13px;z-index:100;max-width:80%;text-align:center;pointer-events:none;transition:opacity 0.3s';
    container.appendChild(el);
    return el;
  })();
  msgEl.textContent = text;
  msgEl.style.opacity = '1';
  msgEl.style.display = 'block';
  if (messageTimer) clearTimeout(messageTimer);
  messageTimer = setTimeout(() => { msgEl.style.opacity = '0'; }, 3000);
}

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

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 重置当前高亮 */
async function resetHighlight() {
  if (highlightedItems) {
    await fragments.resetHighlight(highlightedItems);
    highlightedItems = null;
  }
}

/** 将相机定位到指定包围盒 */
async function frameBox(box: THREE.Box3) {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const distance = maxDim * 2.5;
  await world.camera.controls.setLookAt(
    center.x + distance, center.y + distance * 0.8, center.z + distance,
    center.x, center.y, center.z,
  );
}

/** 从 CbmNode 高亮对应的 IFC 构件 */
async function highlightIfcFromNode(node: CbmNode) {
  const refs = collectIfcRefs(node);

  if (refs.size > 0) {
    // IFCGUID 精确高亮
    await resetHighlight();
    const items: OBC.ModelIdMap = {};
    let totalHighlighted = 0;
    const highlightBoxes: THREE.Box3[] = [];

    for (const [modelId, guids] of refs) {
      const model = fragments.list.get(modelId);
      if (!model) {
        console.log(`模型 ${modelId} 未加载，跳过 ${guids.size} 个 GUID`);
        continue;
      }
      try {
        const localIds = await model.getLocalIdsByGuids(Array.from(guids));
        const validIds = localIds.filter((id): id is number => id !== null);
        if (validIds.length > 0) {
          items[modelId] = new Set(validIds);
          totalHighlighted += validIds.length;
          // 获取构件包围盒用于相机定位
          try {
            const box = await model.getMergedBox(validIds);
            if (box && !box.isEmpty()) highlightBoxes.push(box);
          } catch { /* 包围盒获取失败 */ }
        } else {
          console.log(`模型 ${modelId} 中未找到匹配的 GUID (尝试了 ${guids.size} 个)`);
        }
      } catch (err) {
        console.warn(`GUID 转换失败 (${modelId}):`, err);
      }
    }

    if (Object.keys(items).length > 0) {
      await fragments.highlight(HIGHLIGHT_STYLE, items);
      highlightedItems = items;
      console.log(`已高亮 ${totalHighlighted} 个 IFC 构件`);
      // 用构件包围盒定位相机
      if (highlightBoxes.length > 0) {
        const unionBox = highlightBoxes.reduce((acc, b) => acc.union(b), highlightBoxes[0].clone());
        await frameBox(unionBox);
      }
      return;
    }
  }

  // 回退：无 IFCGUID，不飞视角（TRANSFORMMATRIX 是测量坐标系，与 IFC 模型坐标系不同）
  const cbmFileName = node.path.split('/').pop() || '';
  const ifcModelId = node.ifcFile ? node.ifcFile.replace(/\.ifc$/i, '') : deviceToIfcFile.get(cbmFileName);
  if (ifcModelId) {
    const loaded = fragments.list.has(ifcModelId);
    if (loaded) {
      showMessage(`设备 "${getNodeDisplayName(node)}" 属于 ${ifcModelId}.ifc，但无 IFCGUID 映射到具体构件`);
    } else {
      showMessage(`设备 "${getNodeDisplayName(node)}" 属于 ${ifcModelId}.ifc，该 IFC 文件未加载`);
    }
  } else {
    showMessage(`设备 "${getNodeDisplayName(node)}" 无 IFC 关联`);
  }
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

// ── 右侧属性面板折叠 ──────────────────────────────────────

function openPropsDrawer() { propsDrawer.classList.remove('collapsed'); }
function closePropsDrawer() { propsDrawer.classList.add('collapsed'); }

btnToggleProps.addEventListener('click', () => { propsDrawer.classList.toggle('collapsed'); });
btnCloseProps.addEventListener('click', closePropsDrawer);

// ── 模型列表 UI ────────────────────────────────────────────

function addModelToUI(modelId: string) {
  if (document.getElementById(`model-${modelId}`)) return;
  const item = document.createElement('div');
  item.id = `model-${modelId}`;
  item.className = 'model-item';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox'; checkbox.checked = true; checkbox.className = 'model-checkbox'; checkbox.title = '显示/隐藏';
  checkbox.addEventListener('change', () => {
    const model = fragments.list.get(modelId);
    if (model) { model.object.visible = checkbox.checked; const e = loadedModels.get(modelId); if (e) e.visible = checkbox.checked; }
  });

  const name = document.createElement('span');
  name.className = 'name'; name.title = modelId; name.textContent = modelId;

  const actions = document.createElement('div');
  actions.className = 'actions';
  const removeBtn = document.createElement('button');
  removeBtn.className = 'icon-btn'; removeBtn.textContent = '×'; removeBtn.title = '移除模型';
  removeBtn.addEventListener('click', () => { fragments.core.disposeModel(modelId); });

  actions.appendChild(removeBtn);
  item.appendChild(checkbox); item.appendChild(name); item.appendChild(actions);
  modelListEl.appendChild(item);
}

function removeModelFromUI(modelId: string) { document.getElementById(`model-${modelId}`)?.remove(); }

// ── IFC 选择模态框 ─────────────────────────────────────────

function openIfcModal(entries: IfcEntry[]) {
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

function closeIfcModal() { ifcModal.classList.remove('open'); }

function getModalSelectedEntries(): IfcEntry[] {
  const selected: IfcEntry[] = [];
  modalIfcList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
    if (cb.checked) { const e = currentIfcEntries.find(x => x.modelId === cb.value); if (e) selected.push(e); }
  });
  return selected;
}

modalClose.addEventListener('click', closeIfcModal);
ifcModal.addEventListener('click', (e) => { if (e.target === ifcModal) closeIfcModal(); });
modalSelectAll.addEventListener('click', () => { modalIfcList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => { cb.checked = true; }); });
modalDeselectAll.addEventListener('click', () => { modalIfcList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => { cb.checked = false; }); });

modalLoad.addEventListener('click', async () => {
  const selected = getModalSelectedEntries();
  if (selected.length === 0 || !currentFiles) return;
  closeIfcModal();
  modalLoad.disabled = true;
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
    // 模型加载完成后，构建 IFC 名称索引并重新渲染树
    showLoading('正在构建名称索引...');
    await buildIfcNameIndex();
    buildAndRenderCbmTree();
    renderFileDevPanel();
  } catch (err) {
    console.error(err);
    showLoading(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
    setTimeout(hideLoading, 3000);
  } finally {
    modalLoad.disabled = false;
    hideLoading();
  }
});

// ── CBM 层级树 UI ──────────────────────────────────────────

const ENTITY_ICONS: Record<string, string> = {
  F1System: '🏗️', F2System: '🏢', F3System: '⚡', F4System: '🔧', PARTINDEX: '🔩',
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
  label.textContent = getNodeDisplayName(node);
  label.title = node.path;
  row.appendChild(toggle); row.appendChild(icon); row.appendChild(label);
  nodeEl.appendChild(row);
  const childrenEl = document.createElement('div');
  childrenEl.className = 'tree-children';
  nodeEl.appendChild(childrenEl);

  let expanded = false;
  let childrenRendered = false;
  row.addEventListener('click', () => {
    document.querySelectorAll('.tree-row.selected').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
    showNodeProperties(node);
    openPropsDrawer();
    // 层级树选中 → 3D 高亮对应 IFC 构件
    highlightIfcFromNode(node);
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
  if (!currentCbmTree) { cbmTreePanel.innerHTML = '<div class="props-empty">加载 GIM 文件后显示层级树</div>'; return; }
  renderCbmTree(currentCbmTree, cbmTreePanel);
}

// ── 文件-设备面板 UI ────────────────────────────────────────

function renderFileDevPanel() {
  fileDevPanel.innerHTML = '';
  if (fileDevRelations.length === 0) {
    fileDevPanel.innerHTML = '<div class="props-empty">加载 GIM 文件后显示文件-设备关系</div>';
    return;
  }
  for (const entry of fileDevRelations) {
    const nodeEl = document.createElement('div');
    nodeEl.className = 'tree-node';
    const row = document.createElement('div');
    row.className = 'tree-row';
    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
    toggle.textContent = '▶';
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = '📄';
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = `${entry.ifcName} (${entry.deviceCount})`;
    row.appendChild(toggle); row.appendChild(icon); row.appendChild(label);
    nodeEl.appendChild(row);
    const childrenEl = document.createElement('div');
    childrenEl.className = 'tree-children';
    nodeEl.appendChild(childrenEl);

    let expanded = false;
    let childrenRendered = false;
    row.addEventListener('click', () => {
      expanded = !expanded;
      toggle.classList.toggle('expanded', expanded);
      childrenEl.classList.toggle('expanded', expanded);
      if (expanded && !childrenRendered) {
        for (const devCbm of entry.deviceCbms) {
          const devNode = cbmNodeIndex.get(devCbm);
          const devRow = document.createElement('div');
          devRow.className = 'tree-row';
          devRow.style.paddingLeft = '24px';
          const devIcon = document.createElement('span');
          devIcon.className = 'tree-icon';
          devIcon.textContent = devNode ? (ENTITY_ICONS[devNode.entityName] || '📁') : '🔩';
          const devLabel = document.createElement('span');
          devLabel.className = 'tree-label';
          devLabel.textContent = devNode ? getNodeDisplayName(devNode) : devCbm.replace(/\.cbm$/i, '');
          devRow.appendChild(devIcon); devRow.appendChild(devLabel);
          devRow.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.tree-row.selected').forEach(r => r.classList.remove('selected'));
            devRow.classList.add('selected');
            if (devNode) {
              showNodeProperties(devNode);
              highlightIfcFromNode(devNode);
            } else {
              // devNode 不在索引中，创建临时节点用于位置飞行
              const tempNode: CbmNode = {
                path: `CBM/${devCbm}`, name: devCbm.replace(/\.cbm$/i, ''),
                entityName: '', children: [], famPath: '', devPath: '',
                ifcFile: '', ifcGuid: '', classifyName: '', transformMatrix: '',
              };
              showNodeProperties(tempNode);
              highlightIfcFromNode(tempNode);
            }
            openPropsDrawer();
          });
          childrenEl.appendChild(devRow);
        }
        childrenRendered = true;
      }
    });
    fileDevPanel.appendChild(nodeEl);
  }
}

// ── 属性面板 ───────────────────────────────────────────────

async function showNodeProperties(node: CbmNode) {
  let html = `<div class="props-header">${escHtml(node.name)}</div>`;
  html += '<div class="props-section"><div class="props-section-title">基本信息</div><table class="props-table">';
  const bp: [string, string][] = [
    ['实体类型', node.entityName],
    ['分类名称', node.classifyName],
    ['CBM 文件', node.path.split('/').pop() || ''],
  ];
  if (node.ifcFile) bp.push(['IFC 文件', node.ifcFile]);
  if (node.ifcGuid) bp.push(['IFC GUID', node.ifcGuid]);
  // FileDevRelation 反向索引：显示设备所属 IFC 文件
  const cbmFileName = node.path.split('/').pop() || '';
  const ifcModelId = deviceToIfcFile.get(cbmFileName);
  if (ifcModelId && !node.ifcFile) bp.push(['所属 IFC 文件', `${ifcModelId}.ifc`]);
  if (node.children.length > 0) bp.push(['子节点数', String(node.children.length)]);
  for (const [k, v] of bp) { if (v) html += `<tr><td class="prop-key">${k}</td><td class="prop-val">${escHtml(v)}</td></tr>`; }
  html += '</table></div>';

  if (node.famPath && currentFiles) {
    const f = currentFiles.get(`CBM/${node.famPath}`);
    if (f) html += renderFamSections(parseFamSections(await f.text()));
  }

  if (node.devPath && currentFiles) {
    const f = currentFiles.get(`DEV/${node.devPath}`);
    if (f) {
      const kv = parseKeyValue(await f.text());
      html += '<div class="props-section"><div class="props-section-title">设备信息</div><table class="props-table">';
      if (kv['SYMBOLNAME']) html += `<tr><td class="prop-key">设备名称</td><td class="prop-val">${escHtml(kv['SYMBOLNAME'])}</td></tr>`;
      if (kv['TYPE']) html += `<tr><td class="prop-key">设备类型</td><td class="prop-val">${escHtml(kv['TYPE'])}</td></tr>`;
      html += '</table></div>';
      const famRef = kv['BASEFAMILY'];
      if (famRef) {
        const famFile = currentFiles.get(`DEV/${famRef}`);
        if (famFile) html += renderFamSections(parseFamSections(await famFile.text()));
      }
    }
  }

  if (node.transformMatrix && node.transformMatrix !== '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1') {
    html += '<div class="props-section"><div class="props-section-title">变换矩阵</div><table class="props-table">';
    html += `<tr><td class="prop-val" colspan="2" style="font-family:monospace;font-size:11px;color:#888;word-break:break-all">${escHtml(node.transformMatrix)}</td></tr>`;
    html += '</table></div>';
  }

  // 如果设备有 IFCGUID，读取并展示 IFC 构件原生属性
  if (node.ifcFile && node.ifcGuid) {
    const modelId = node.ifcFile.replace(/\.ifc$/i, '');
    const model = fragments.list.get(modelId);
    if (model) {
      try {
        const localIds = await model.getLocalIdsByGuids([node.ifcGuid]);
        const localId = localIds[0];
        if (localId !== null && localId !== undefined) {
          html += '<div class="props-section"><div class="props-section-title">IFC 构件属性</div><table class="props-table">';
          html += `<tr><td class="prop-key">模型</td><td class="prop-val">${escHtml(modelId)}</td></tr>`;
          html += `<tr><td class="prop-key">LocalId</td><td class="prop-val">${localId}</td></tr>`;
          html += `<tr><td class="prop-key">GUID</td><td class="prop-val">${escHtml(node.ifcGuid)}</td></tr>`;
          html += '</table></div>';
          // 读取 IFC 属性（使用 getItemsData 最简配置）
          try {
            const itemsData = await model.getItemsData([localId], { attributesDefault: true });
            if (itemsData.length > 0) {
              html += renderIfcItemData(itemsData[0] as unknown as Record<string, unknown>);
            }
          } catch (err) {
            console.warn('读取 IFC 属性失败:', err);
          }
        }
      } catch (err) {
        console.warn(`IFC GUID 查找失败 (${node.ifcGuid}):`, err);
      }
    }
  }

  propsDrawerBody.innerHTML = html;
}

/** 展示 IFC 构件属性（从 3D 点击触发） */
async function showIfcElementProperties(modelId: string, localId: number) {
  const model = fragments.list.get(modelId);
  if (!model) return;

  let html = '<div class="props-header">IFC 构件</div>';

  // 基本信息
  html += '<div class="props-section"><div class="props-section-title">基本信息</div><table class="props-table">';
  html += `<tr><td class="prop-key">模型</td><td class="prop-val">${escHtml(modelId)}</td></tr>`;
  html += `<tr><td class="prop-key">LocalId</td><td class="prop-val">${localId}</td></tr>`;

  // 获取 GUID
  try {
    const guids = await model.getGuidsByLocalIds([localId]);
    if (guids[0]) {
      html += `<tr><td class="prop-key">GUID</td><td class="prop-val">${escHtml(guids[0])}</td></tr>`;

      // 尝试通过 GUID 反向索引找到 GIM 设备
      const ifcFile = `${modelId}.ifc`;
      const gimNode = ifcGuidIndex.get(`${ifcFile}:${guids[0]}`);
      if (gimNode) {
        html += `<tr><td class="prop-key">GIM 设备</td><td class="prop-val">${escHtml(gimNode.name)}</td></tr>`;
        html += `<tr><td class="prop-key">GIM 分类</td><td class="prop-val">${escHtml(gimNode.classifyName)}</td></tr>`;
      }
    }
  } catch { /* GUID 获取失败 */ }

  html += '</table></div>';

  // 读取 IFC 属性（使用 getItemsData 最简配置）
  try {
    const itemsData = await model.getItemsData([localId], { attributesDefault: true });
    if (itemsData.length > 0) {
      html += renderIfcItemData(itemsData[0] as unknown as Record<string, unknown>);
    }
  } catch (err) {
    console.warn('读取 IFC 属性失败:', err);
  }

  // 如果关联到 GIM 设备，展示设备属性
  try {
    const guids = await model.getGuidsByLocalIds([localId]);
    if (guids[0]) {
      const ifcFile = `${modelId}.ifc`;
      const gimNode = ifcGuidIndex.get(`${ifcFile}:${guids[0]}`);
      if (gimNode) {
        html += '<div class="props-section"><div class="props-section-title">GIM 设备属性</div></div>';
        // 读取 GIM 设备属性
        if (gimNode.famPath && currentFiles) {
          const f = currentFiles.get(`CBM/${gimNode.famPath}`);
          if (f) html += renderFamSections(parseFamSections(await f.text()));
        }
        if (gimNode.devPath && currentFiles) {
          const f = currentFiles.get(`DEV/${gimNode.devPath}`);
          if (f) {
            const kv = parseKeyValue(await f.text());
            const famRef = kv['BASEFAMILY'];
            if (famRef) {
              const famFile = currentFiles.get(`DEV/${famRef}`);
              if (famFile) html += renderFamSections(parseFamSections(await famFile.text()));
            }
          }
        }
      }
    }
  } catch { /* GIM 设备属性读取失败 */ }

  propsDrawerBody.innerHTML = html;
}

/** 渲染 Item.getData() 返回的属性数据为 HTML */
function renderIfcItemData(data: Record<string, unknown>, depth = 0): string {
  if (!data || typeof data !== 'object') return '';
  let html = '';
  let tableOpen = false;

  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined || value === '') continue;
    // 跳过内部字段
    if (key.startsWith('_')) continue;

    if (typeof value === 'object' && !Array.isArray(value)) {
      // 嵌套对象 → 递归渲染为子分区
      const subHtml = renderIfcItemData(value as Record<string, unknown>, depth + 1);
      if (subHtml) {
        if (tableOpen) { html += '</table></div>'; tableOpen = false; }
        html += `<div class="props-section"><div class="props-section-title">${escHtml(key)}</div>`;
        html += subHtml;
        html += '</div>';
      }
      continue;
    }

    if (Array.isArray(value)) {
      // 数组 → 尝试渲染每个元素
      for (const elem of value) {
        if (elem && typeof elem === 'object') {
          const subHtml = renderIfcItemData(elem as Record<string, unknown>, depth + 1);
          if (subHtml) {
            if (tableOpen) { html += '</table></div>'; tableOpen = false; }
            html += `<div class="props-section"><div class="props-section-title">${escHtml(key)}</div>`;
            html += subHtml;
            html += '</div>';
          }
        }
      }
      continue;
    }

    // 基本类型值
    if (!tableOpen) {
      html += depth === 0
        ? '<div class="props-section"><div class="props-section-title">IFC 属性</div><table class="props-table">'
        : '<table class="props-table">';
      tableOpen = true;
    }
    const displayVal = String(value);
    if (displayVal === '0' && key.toLowerCase().includes('id')) continue;
    html += `<tr><td class="prop-key">${escHtml(key)}</td><td class="prop-val">${escHtml(displayVal)}</td></tr>`;
  }

  if (tableOpen) html += '</table>';
  if (depth === 0 && html) html += '</div>';
  return html;
}

function renderFamSections(sections: Map<string, Map<string, string>>): string {
  let html = '';
  for (const [secName, props] of sections) {
    if (props.size === 0) continue;
    html += `<div class="props-section"><div class="props-section-title">${escHtml(secName)}</div><table class="props-table">`;
    for (const [key, val] of props) { if (val) html += `<tr><td class="prop-key">${escHtml(key)}</td><td class="prop-val">${escHtml(val)}</td></tr>`; }
    html += '</table></div>';
  }
  return html;
}

// ── 3D 点击拾取 ────────────────────────────────────────────

container.addEventListener('click', async (e) => {
  if (!initialized || fragments.list.size === 0) return;

  // 传屏幕像素坐标，OBC 内部会自行转换为 NDC
  const mouse = new THREE.Vector2(e.clientX, e.clientY);

  try {
    const result = await fragments.raycast({
      camera: world.camera.three,
      mouse,
      dom: (container.querySelector('canvas') as HTMLCanvasElement) || container,
    });

    if (!result) {
      // 点击空白处，取消高亮
      await resetHighlight();
      return;
    }

    const { localId, fragments: hitModel } = result;
    const modelId = hitModel.modelId;

    // 高亮选中构件
    await resetHighlight();
    const items: OBC.ModelIdMap = { [modelId]: new Set([localId]) };
    await fragments.highlight(HIGHLIGHT_STYLE, items);
    highlightedItems = items;

    // 展示属性
    await showIfcElementProperties(modelId, localId);
    openPropsDrawer();
  } catch (err) {
    console.warn('射线拾取失败:', err);
  }
});

// ── 引擎初始化 ────────────────────────────────────────────

async function initEngine() {
  if (initialized) return;
  showLoading('初始化 IFC 引擎...');
  await ifcLoader.setup({ autoSetWasm: false, wasm: { path: '/', absolute: true } });
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
      material.polygonOffset = true; material.polygonOffsetUnits = 1; material.polygonOffsetFactor = Math.random();
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
  loadedModels.set(modelId, { modelId, visible: true });
}

// ── GIM 文件加载后的通用处理 ───────────────────────────────

async function onGimExtracted(extracted: Map<string, File>) {
  currentFiles = extracted;
  let entries = await discoverIfcFromCBM(extracted);
  if (entries.length === 0) entries = scanIfcFiles(extracted);
  currentIfcEntries = entries;
  currentCbmTree = await buildCbmTree(extracted);
  // 构建索引
  ifcGuidIndex = buildIfcGuidIndex(currentCbmTree);
  cbmNodeIndex = buildCbmNodeIndex(currentCbmTree);
  console.log(`IFCGUID 反向索引: ${ifcGuidIndex.size} 条记录, CBM节点索引: ${cbmNodeIndex.size} 条`);
  // 解析 FileDevRelation
  fileDevRelations = await parseFileDevRelation(extracted);
  deviceToIfcFile.clear();
  for (const entry of fileDevRelations) {
    for (const devCbm of entry.deviceCbms) {
      deviceToIfcFile.set(devCbm, entry.modelId);
    }
  }
  // 补充 FileDevRelation 引用但不在 CBM 树中的设备节点
  let supplemented = 0;
  for (const entry of fileDevRelations) {
    for (const devCbm of entry.deviceCbms) {
      if (cbmNodeIndex.has(devCbm)) continue;
      const f = extracted.get(`CBM/${devCbm}`);
      if (!f) continue;
      try {
        const kv = parseKeyValue(await f.text());
        const en = kv['ENTITYNAME'] || '';
        const cn = kv['SYSCLASSIFYNAME'] || kv['PARTNAME'] || '';
        const dn = cn || en || devCbm.replace(/\.cbm$/i, '');
        const ifcFile = kv['IFCFILE'] || '';
        const ifcGuid = (kv['IFCGUID'] || '').replace(/\$+$/, '').trim();
        const node: CbmNode = {
          path: `CBM/${devCbm}`, name: dn, entityName: en, children: [],
          famPath: kv['BASEFAMILY'] || '', devPath: kv['OBJECTMODELPOINTER'] || '',
          ifcFile, ifcGuid, classifyName: cn,
          transformMatrix: kv['TRANSFORMMATRIX'] || '',
        };
        cbmNodeIndex.set(devCbm, node);
        if (ifcFile && ifcGuid) ifcGuidIndex.set(`${ifcFile}:${ifcGuid}`, node);
        supplemented++;
      } catch { /* 读取 CBM 失败 */ }
    }
  }
  if (supplemented > 0) console.log(`补充了 ${supplemented} 个不在 CBM 树中的设备节点`);
  console.log(`FileDevRelation: ${fileDevRelations.length} 个 IFC 文件, ${deviceToIfcFile.size} 个设备映射`);
  buildAndRenderCbmTree();
  renderFileDevPanel();
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
      await loadIfcBuffer(file.name, new Uint8Array(await file.arrayBuffer()));
    }
    await buildIfcNameIndex();
    buildAndRenderCbmTree();
    renderFileDevPanel();
  } catch (err) {
    console.error(err);
    showLoading(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
    setTimeout(hideLoading, 3000);
  } finally { fileInput.value = ''; btnLoadLocal.disabled = false; hideLoading(); }
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
    hideLoading();
    openIfcModal(entries);
  } catch (err) {
    console.error(err);
    showLoading(`GIM 解析失败: ${err instanceof Error ? err.message : String(err)}`);
    setTimeout(hideLoading, 3000);
  } finally { gimFileInput.value = ''; btnLoadGim.disabled = false; }
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
        if (entries.length === 0) { showLoading('未找到 IFC 文件'); setTimeout(hideLoading, 2000); return; }
        hideLoading();
        openIfcModal(entries);
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
      await loadIfcBuffer(name, new Uint8Array(await res.arrayBuffer()));
    }
  } catch (err) {
    console.error(err);
    showLoading(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
    setTimeout(hideLoading, 3000);
  } finally { btnLoadDemo.disabled = false; hideLoading(); }
});

btnClear.addEventListener('click', async () => {
  await resetHighlight();
  for (const [modelId] of fragments.list) fragments.core.disposeModel(modelId);
  loadedModels.clear();
  currentCbmTree = null;
  ifcGuidIndex.clear();
  cbmNodeIndex.clear();
  ifcGuidToName.clear();
  fileDevRelations = [];
  deviceToIfcFile.clear();
  cbmTreePanel.innerHTML = '<div class="props-empty">加载 GIM 文件后显示层级树</div>';
  fileDevPanel.innerHTML = '<div class="props-empty">加载 GIM 文件后显示文件-设备关系</div>';
  propsDrawerBody.innerHTML = '<div class="props-empty">选择层级树节点或点击 3D 构件查看属性</div>';
});

window.addEventListener('resize', () => { world.renderer?.resize(); });
