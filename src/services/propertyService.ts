import type { CbmNode } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import { parseFamSections } from '../gim/famParser.js';
import { parseKeyValue } from '../gim/cbmParser.js';
import { getNodeDisplayName } from '../gim/gimIndexer.js';

/** 属性面板中的属性节 */
export interface PropertySection {
  title: string;
  properties: { key: string; value: string }[];
  source: 'cbm' | 'fam' | 'ifc';
}

/** 节点属性数据 */
export interface NodePropertyData {
  title: string;
  sections: PropertySection[];
}

/** 获取 CbmNode 的结构化属性数据 */
export async function getNodePropertyData(state: AppState, node: CbmNode): Promise<NodePropertyData> {
  const sections: PropertySection[] = [];

  // 基本信息
  const basicProps: { key: string; value: string }[] = [
    { key: '实体类型', value: node.entityName },
    { key: '分类名称', value: node.classifyName },
    { key: 'CBM 文件', value: node.path.split('/').pop() || '' },
  ];
  if (node.ifcFile) basicProps.push({ key: 'IFC 文件', value: node.ifcFile });
  if (node.ifcGuid) basicProps.push({ key: 'IFC GUID', value: node.ifcGuid });
  const cbmFileName = node.path.split('/').pop() || '';
  const ifcModelId = state.deviceToIfcFile.get(cbmFileName);
  if (ifcModelId && !node.ifcFile) basicProps.push({ key: '所属 IFC 文件', value: `${ifcModelId}.ifc` });
  if (node.children.length > 0) basicProps.push({ key: '子节点数', value: String(node.children.length) });
  sections.push({ title: '基本信息', properties: basicProps.filter(p => p.value), source: 'cbm' });

  // FAM 属性
  if (node.famPath && state.currentFiles) {
    const f = state.currentFiles.get(`CBM/${node.famPath}`);
    if (f) {
      const famSections = parseFamSections(await f.text());
      for (const [secName, props] of famSections) {
        if (props.size === 0) continue;
        sections.push({
          title: secName,
          properties: Array.from(props.entries()).filter(([, v]) => v).map(([k, v]) => ({ key: k, value: v })),
          source: 'fam',
        });
      }
    }
  }

  // 设备信息
  if (node.devPath && state.currentFiles) {
    const f = state.currentFiles.get(`DEV/${node.devPath}`);
    if (f) {
      const kv = parseKeyValue(await f.text());
      const devProps: { key: string; value: string }[] = [];
      if (kv['SYMBOLNAME']) devProps.push({ key: '设备名称', value: kv['SYMBOLNAME'] });
      if (kv['TYPE']) devProps.push({ key: '设备类型', value: kv['TYPE'] });
      if (devProps.length > 0) sections.push({ title: '设备信息', properties: devProps, source: 'cbm' });

      const famRef = kv['BASEFAMILY'];
      if (famRef) {
        const famFile = state.currentFiles.get(`DEV/${famRef}`);
        if (famFile) {
          const famSections = parseFamSections(await famFile.text());
          for (const [secName, props] of famSections) {
            if (props.size === 0) continue;
            sections.push({
              title: secName,
              properties: Array.from(props.entries()).filter(([, v]) => v).map(([k, v]) => ({ key: k, value: v })),
              source: 'fam',
            });
          }
        }
      }
    }
  }

  // 变换矩阵
  if (node.transformMatrix && node.transformMatrix !== '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1') {
    sections.push({ title: '变换矩阵', properties: [{ key: '矩阵', value: node.transformMatrix }], source: 'cbm' });
  }

  return { title: getNodeDisplayName(node, state.ifcGuidToName), sections };
}

/** 获取 IFC 构件的结构化属性数据 */
export async function getIfcElementPropertyData(
  ctx: ViewerContext,
  state: AppState,
  modelId: string,
  localId: number,
): Promise<NodePropertyData> {
  const model = ctx.fragments.list.get(modelId);
  const sections: PropertySection[] = [];

  if (!model) return { title: 'IFC 构件', sections };

  // 基本信息
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

  const basicProps: { key: string; value: string }[] = [
    { key: '模型', value: modelId },
    { key: 'LocalId', value: String(localId) },
  ];
  if (guid) {
    basicProps.push({ key: 'GUID', value: guid });
    if (gimNode) {
      basicProps.push({ key: 'GIM 设备', value: getNodeDisplayName(gimNode, state.ifcGuidToName) });
      basicProps.push({ key: 'GIM 分类', value: gimNode.classifyName });
    }
  }
  sections.push({ title: '基本信息', properties: basicProps, source: 'ifc' });

  // GIM 设备属性
  if (gimNode) {
    if (gimNode.famPath && state.currentFiles) {
      const f = state.currentFiles.get(`CBM/${gimNode.famPath}`);
      if (f) {
        const famSections = parseFamSections(await f.text());
        for (const [secName, props] of famSections) {
          if (props.size === 0) continue;
          sections.push({
            title: secName,
            properties: Array.from(props.entries()).filter(([, v]) => v).map(([k, v]) => ({ key: k, value: v })),
            source: 'fam',
          });
        }
      }
    }
    if (gimNode.devPath && state.currentFiles) {
      const f = state.currentFiles.get(`DEV/${gimNode.devPath}`);
      if (f) {
        const kv = parseKeyValue(await f.text());
        const famRef = kv['BASEFAMILY'];
        if (famRef) {
          const famFile = state.currentFiles.get(`DEV/${famRef}`);
          if (famFile) {
            const famSections = parseFamSections(await famFile.text());
            for (const [secName, props] of famSections) {
              if (props.size === 0) continue;
              sections.push({
                title: secName,
                properties: Array.from(props.entries()).filter(([, v]) => v).map(([k, v]) => ({ key: k, value: v })),
                source: 'fam',
              });
            }
          }
        }
      }
    }
  }

  return { title: 'IFC 构件', sections };
}
