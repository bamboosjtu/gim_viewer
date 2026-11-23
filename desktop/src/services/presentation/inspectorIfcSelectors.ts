import type { AppState } from '../../app/state.js';
import type { CbmNode, IfcEntry } from '../../gim/types.js';
import type { RegionalObject } from '../../viewer/ifcRegionalData.js';
import type { IfcRegionalRuntime } from '../../viewer/ifcRegionalRuntime.js';
import {
  findIfcEntryByModelId,
  normalizeEntryPath,
  normalizedIfcBasename,
  resolveIfcModelId,
} from '../../gim/modelIdentity.js';
export type IfcRefinementRuntime = {
  refine(object: RegionalObject): Promise<unknown>;
  releaseFine(expressId: number): void;
};

export interface InspectorIfcProperties {
  attributes: Record<string, unknown>;
  propertySets: readonly unknown[];
  typeProperties?: readonly unknown[];
  materials?: readonly unknown[];
}

export async function readInspectorIfcProperties(
  runtime: Pick<IfcRegionalRuntime, 'properties'>,
  expressId: number,
): Promise<InspectorIfcProperties> {
  return await runtime.properties(expressId);
}

export function buildSpatialPath(
  index: NonNullable<AppState['substationSpatialIndex']>,
  key: string,
): string {
  const labels: string[] = [];
  const seen = new Set<string>();
  let current = index.nodeByKey.get(key);
  while (current && !seen.has(current.key)) {
    seen.add(current.key);
    labels.push(current.name);
    current = current.parentKey ? index.nodeByKey.get(current.parentKey) : undefined;
  }
  return labels.reverse().join(' / ');
}

export function ifcReferencePath(modelId: string, entries: readonly IfcEntry[] = []): string {
  const value = modelId.trim();
  if (!value) return '';
  const entry = findIfcEntryByModelId(value, entries);
  if (entry) return entry.path;

  // CBM/FileDevRelation 中的引用经常只有 basename（例如 `foo.ifc`），
  // 而 IfcEntry.path 才是 GIM 包内真实资源身份。优先通过同一套三态
  // 解析规则反查真实路径；重复 basename 时返回 null，避免来源按钮
  // 指向不确定的文件。
  const resolvedModelId = resolveIfcModelId(value, entries);
  if (resolvedModelId) {
    const resolved = findIfcEntryByModelId(resolvedModelId, entries);
    if (resolved) return resolved.path;
  }

  // `resolveIfcModelId` 返回 null 既可能表示未知引用，也可能表示重复
  // basename。后者不能回退为 `foo.ifc`，否则 UI 会制造看似确定但实际
  // 不可定位的来源。只有确实没有任何候选时才保留原始引用作为诊断文本。
  const basename = normalizedIfcBasename(value);
  const basenameCandidates = entries.filter(
    (item) => normalizedIfcBasename(item.path) === basename,
  );
  if (basenameCandidates.length > 1) return '';

  // `ifc_<hash>` 是运行时身份，不是包内文件名。若当前工程没有对应
  // IfcEntry，宁可不显示来源按钮，也不能把内部 ID 拼成虚假的路径。
  // 任意 `ifc_` 前缀都属于内部 runtime 身份；只有能在当前 entry 清单
  // 反查成功时才显示来源，避免未知/未来格式的 ID 被拼成伪造路径。
  if (/^ifc_/i.test(value)) return '';
  return /\.ifc$/i.test(value) ? value : `${value}.ifc`;
}

export function findDeviceIfcModel(
  state: Pick<AppState, 'deviceToIfcFile'>,
  cbmPath: string,
): string {
  const direct = state.deviceToIfcFile.get(cbmPath);
  if (direct) return direct;
  const normalizedPath = normalizeEntryPath(cbmPath);
  const exactMatches = Array.from(state.deviceToIfcFile)
    .filter(([key, modelId]) => modelId && normalizeEntryPath(key) === normalizedPath)
    .map(([, modelId]) => modelId);
  const exactIds = [...new Set(exactMatches)];
  if (exactIds.length === 1) return exactIds[0];
  if (exactIds.length > 1) return '';

  // FileDevRelation 既可能存完整 CBM 路径，也可能只存 basename。basename
  // 只在候选 modelId 唯一时采用，避免多个同名 CBM 被静默关联到第一个 IFC。
  const basename = normalizedPath.split('/').pop() || normalizedPath;
  const basenameMatches = Array.from(state.deviceToIfcFile)
    .filter(([key, modelId]) => {
      const keyBase = normalizeEntryPath(key).split('/').pop() || normalizeEntryPath(key);
      return Boolean(modelId) && keyBase === basename;
    })
    .map(([, modelId]) => modelId);
  const basenameIds = [...new Set(basenameMatches)];
  return basenameIds.length === 1 ? basenameIds[0] : '';
}

export function nodeIfcRefinement(
  state: Pick<AppState, 'ifc' | 'currentIfcEntries' | 'deviceToIfcFile'>,
  node: CbmNode,
): { runtime: IfcRefinementRuntime; object: RegionalObject } | undefined {
  if (!node.ifcGuid) return undefined;
  const modelId = node.ifcFile
    ? resolveIfcModelId(node.ifcFile, state.currentIfcEntries)
    : findDeviceIfcModel(state, node.path);
  if (!modelId) return undefined;
  const runtime = state.ifc.regionalRuntimes.get(modelId);
  if (!runtime) return undefined;
  const matches = runtime.index.objects.filter((object) => object.globalId === node.ifcGuid);
  return matches.length === 1 ? { runtime, object: matches[0] } : undefined;
}
