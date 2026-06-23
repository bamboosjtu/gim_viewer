import type { CbmNode } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import { escHtml } from '../shared/html.js';
import { parseFamSections } from '../gim/famParser.js';
import { parseKeyValue } from '../gim/cbmParser.js';
import { getNodeDisplayName } from '../gim/gimIndexer.js';
import { propsDrawerBody, propsDrawer, btnToggleProps, btnCloseProps } from './dom.js';

/** 刷新视口布局（面板展开/收起后调用） */
function refreshViewportLayout(ctx: ViewerContext) {
  requestAnimationFrame(() => {
    ctx.fragments.core.update(true);
  });
}

/** 打开属性面板 */
export function openPropsDrawer(ctx: ViewerContext): void {
  propsDrawer.classList.remove('collapsed');
  btnToggleProps.style.right = '332px';
  refreshViewportLayout(ctx);
}

/** 关闭属性面板 */
export function closePropsDrawer(ctx: ViewerContext): void {
  propsDrawer.classList.add('collapsed');
  btnToggleProps.style.right = '12px';
  refreshViewportLayout(ctx);
}

/** 切换属性面板 */
export function togglePropsDrawer(ctx: ViewerContext): void {
  if (propsDrawer.classList.contains('collapsed')) {
    openPropsDrawer(ctx);
  } else {
    closePropsDrawer(ctx);
  }
}

/** 绑定属性面板按钮事件 */
export function setupPropsDrawer(ctx: ViewerContext): void {
  btnToggleProps.addEventListener('click', () => togglePropsDrawer(ctx));
  btnCloseProps.addEventListener('click', () => closePropsDrawer(ctx));
}

/** 渲染 FAM 分节属性为 HTML */
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

/** 渲染 getItemsData 返回的属性数据为 HTML */
function renderIfcItemData(data: Record<string, unknown>, depth = 0): string {
  if (!data || typeof data !== 'object') return '';
  let html = '';
  let tableOpen = false;
  let wrapperOpen = false;

  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined || value === '') continue;
    if (key.startsWith('_')) continue;

    if (typeof value === 'object' && !Array.isArray(value)) {
      const subHtml = renderIfcItemData(value as Record<string, unknown>, depth + 1);
      if (subHtml) {
        if (tableOpen) { html += '</table>'; tableOpen = false; }
        if (depth === 0 && !wrapperOpen) { html += '<div class="props-section">'; wrapperOpen = true; }
        html += `<div class="props-section-title">${escHtml(key)}</div>`;
        html += subHtml;
      }
      continue;
    }

    if (Array.isArray(value)) {
      for (const elem of value) {
        if (elem && typeof elem === 'object') {
          const subHtml = renderIfcItemData(elem as Record<string, unknown>, depth + 1);
          if (subHtml) {
            if (tableOpen) { html += '</table>'; tableOpen = false; }
            if (depth === 0 && !wrapperOpen) { html += '<div class="props-section">'; wrapperOpen = true; }
            html += `<div class="props-section-title">${escHtml(key)}</div>`;
            html += subHtml;
          }
        }
      }
      continue;
    }

    if (!tableOpen) {
      if (depth === 0 && !wrapperOpen) {
        html += '<div class="props-section"><div class="props-section-title">IFC 属性</div>';
        wrapperOpen = true;
      }
      html += '<table class="props-table">';
      tableOpen = true;
    }
    const displayVal = String(value);
    if (displayVal === '0' && key.toLowerCase().includes('id')) continue;
    html += `<tr><td class="prop-key">${escHtml(key)}</td><td class="prop-val">${escHtml(displayVal)}</td></tr>`;
  }

  if (tableOpen) html += '</table>';
  if (depth === 0 && wrapperOpen) html += '</div>';
  return html;
}

/** 显示 CbmNode 属性 */
export async function showNodeProperties(ctx: ViewerContext, state: AppState, node: CbmNode): Promise<void> {
  let html = `<div class="props-header">${escHtml(getNodeDisplayName(node, state.ifcGuidToName))}</div>`;
  html += '<div class="props-section"><div class="props-section-title">基本信息</div><table class="props-table">';
  const bp: [string, string][] = [
    ['实体类型', node.entityName],
    ['分类名称', node.classifyName],
    ['CBM 文件', node.path.split('/').pop() || ''],
  ];
  if (node.ifcFile) bp.push(['IFC 文件', node.ifcFile]);
  if (node.ifcGuid) bp.push(['IFC GUID', node.ifcGuid]);
  const cbmFileName = node.path.split('/').pop() || '';
  const ifcModelId = state.deviceToIfcFile.get(cbmFileName);
  if (ifcModelId && !node.ifcFile) bp.push(['所属 IFC 文件', `${ifcModelId}.ifc`]);
  if (node.children.length > 0) bp.push(['子节点数', String(node.children.length)]);
  for (const [k, v] of bp) { if (v) html += `<tr><td class="prop-key">${k}</td><td class="prop-val">${escHtml(v)}</td></tr>`; }
  html += '</table></div>';

  if (node.famPath && state.currentFiles) {
    const f = state.currentFiles.get(`CBM/${node.famPath}`);
    if (f) html += renderFamSections(parseFamSections(await f.text()));
  }

  if (node.devPath && state.currentFiles) {
    const f = state.currentFiles.get(`DEV/${node.devPath}`);
    if (f) {
      const kv = parseKeyValue(await f.text());
      html += '<div class="props-section"><div class="props-section-title">设备信息</div><table class="props-table">';
      if (kv['SYMBOLNAME']) html += `<tr><td class="prop-key">设备名称</td><td class="prop-val">${escHtml(kv['SYMBOLNAME'])}</td></tr>`;
      if (kv['TYPE']) html += `<tr><td class="prop-key">设备类型</td><td class="prop-val">${escHtml(kv['TYPE'])}</td></tr>`;
      html += '</table></div>';
      const famRef = kv['BASEFAMILY'];
      if (famRef) {
        const famFile = state.currentFiles.get(`DEV/${famRef}`);
        if (famFile) html += renderFamSections(parseFamSections(await famFile.text()));
      }
    }
  }

  if (node.transformMatrix && node.transformMatrix !== '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1') {
    html += '<div class="props-section"><div class="props-section-title">变换矩阵</div><table class="props-table">';
    html += `<tr><td class="prop-val" colspan="2" style="font-family:monospace;font-size:11px;color:#888;word-break:break-all">${escHtml(node.transformMatrix)}</td></tr>`;
    html += '</table></div>';
  }

  // IFC 构件原生属性
  if (node.ifcFile && node.ifcGuid) {
    const modelId = node.ifcFile.replace(/\.ifc$/i, '');
    const model = ctx.fragments.list.get(modelId);
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
export async function showIfcElementProperties(ctx: ViewerContext, state: AppState, modelId: string, localId: number): Promise<void> {
  const model = ctx.fragments.list.get(modelId);
  if (!model) return;

  let html = '<div class="props-header">IFC 构件</div>';

  let guid: string | null = null;
  let gimNode: CbmNode | null = null;
  try {
    const guids = await model.getGuidsByLocalIds([localId]);
    guid = guids[0] || null;
    if (guid) {
      const ifcFile = `${modelId}.ifc`;
      gimNode = state.ifcGuidIndex.get(`${ifcFile}:${guid}`) || null;
    }
  } catch { /* GUID 获取失败 */ }

  html += '<div class="props-section"><div class="props-section-title">基本信息</div><table class="props-table">';
  html += `<tr><td class="prop-key">模型</td><td class="prop-val">${escHtml(modelId)}</td></tr>`;
  html += `<tr><td class="prop-key">LocalId</td><td class="prop-val">${localId}</td></tr>`;
  if (guid) {
    html += `<tr><td class="prop-key">GUID</td><td class="prop-val">${escHtml(guid)}</td></tr>`;
    if (gimNode) {
      html += `<tr><td class="prop-key">GIM 设备</td><td class="prop-val">${escHtml(getNodeDisplayName(gimNode, state.ifcGuidToName))}</td></tr>`;
      html += `<tr><td class="prop-key">GIM 分类</td><td class="prop-val">${escHtml(gimNode.classifyName)}</td></tr>`;
    }
  }
  html += '</table></div>';

  try {
    const itemsData = await model.getItemsData([localId], { attributesDefault: true });
    if (itemsData.length > 0) {
      html += renderIfcItemData(itemsData[0] as unknown as Record<string, unknown>);
    }
  } catch (err) {
    console.warn('读取 IFC 属性失败:', err);
  }

  // GIM 设备属性
  if (gimNode) {
    html += '<div class="props-section"><div class="props-section-title">GIM 设备属性</div></div>';
    if (gimNode.famPath && state.currentFiles) {
      const f = state.currentFiles.get(`CBM/${gimNode.famPath}`);
      if (f) html += renderFamSections(parseFamSections(await f.text()));
    }
    if (gimNode.devPath && state.currentFiles) {
      const f = state.currentFiles.get(`DEV/${gimNode.devPath}`);
      if (f) {
        const kv = parseKeyValue(await f.text());
        const famRef = kv['BASEFAMILY'];
        if (famRef) {
          const famFile = state.currentFiles.get(`DEV/${famRef}`);
          if (famFile) html += renderFamSections(parseFamSections(await famFile.text()));
        }
      }
    }
  }

  propsDrawerBody.innerHTML = html;
}
