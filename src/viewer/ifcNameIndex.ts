import type { CbmNode } from '../gim/types.js';
import type { ViewerContext } from './viewerEngine.js';
import type { AppState } from '../app/state.js';

/** IFC 模型加载后，构建 GUID → 名称索引 */
export async function buildIfcNameIndex(ctx: ViewerContext, state: AppState): Promise<void> {
  // 按 modelId 分组收集 GUID
  const byModel = new Map<string, { guid: string; node: CbmNode }[]>();
  for (const [, node] of state.ifcGuidIndex) {
    const modelId = node.ifcFile.replace(/\.ifc$/i, '');
    if (!byModel.has(modelId)) byModel.set(modelId, []);
    byModel.get(modelId)!.push({ guid: node.ifcGuid, node });
  }

  for (const [modelId, entries] of byModel) {
    const model = ctx.fragments.list.get(modelId);
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
        let name: string | null = null;
        for (const [k, v] of Object.entries(data)) {
          if (k === 'Name' && v && typeof v === 'object' && 'value' in v) {
            const val = (v as { value: unknown }).value;
            if (val) name = String(val);
            break;
          }
        }
        if (name) {
          state.ifcGuidToName.set(`${modelId}:${validEntries[i].guid}`, name);
          validEntries[i].node.name = name;
        }
      }
    } catch (err) {
      console.warn(`构建名称索引失败 (${modelId}):`, err);
    }
  }
  console.log(`IFC 名称索引: ${state.ifcGuidToName.size} 条记录`);
}
