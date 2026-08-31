import type { IfcEntry } from './types.js';

/**
 * 规范化 GIM 包内路径，作为 IFC 资源身份的唯一输入。
 *
 * GIM 导出器可能混用反斜杠、大小写和 `./` 前缀；模型运行时 ID 必须在
 * Windows/Linux 以及同一个工程的二次打开之间保持一致。
 */
export function normalizeEntryPath(path: string): string {
  let normalized = path.trim().replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized.replace(/^\/+/, '').toLowerCase();
}

/** 去掉 IFC 后缀但保留可读名称。 */
export function stripIfcExtension(value: string): string {
  return value.replace(/\.ifc$/i, '');
}

/**
 * 生成稳定且与文件名无关的 IFC logical modelId。
 *
 * FNV-1a 64 位无需异步 WebCrypto，适合在解析索引阶段同步生成；规范化
 * 路径仍保存在 entry_path 中，因此 hash 只承担短 ID 作用，不替代资源身份。
 */
export function createIfcModelId(entryPath: string): string {
  const input = normalizeEntryPath(entryPath);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return `ifc_${hash.toString(16).padStart(16, '0')}`;
}

/**
 * 生成当前 Viewer 生命周期内使用的 IFC 模型 ID。
 *
 * `createIfcModelId` 是包内稳定的 logical ID，数据库和 CBM 关联必须继续
 * 使用它；Fragments 则需要把源 GIM 身份带入运行时 ID，避免工程 A 的迟到
 * 异步加载与工程 B 共用同一个长生命周期 key。sourceIdentity 通常为 GIM
 * SHA-256，缺失时由调用方提供 project/generation 作用域字符串。可选的
 * generation 用于区分“同一 GIM 关闭后再次打开”的两个 Viewer 会话；它不
 * 参与数据库/业务索引，只是运行时生命周期盐。
 */
export function createIfcRuntimeModelId(
  sourceIdentity: string,
  logicalModelId: string,
  generation?: number,
): string {
  const generationSalt = generation == null ? '' : `\u0000generation:${generation}`;
  const input = `${sourceIdentity.trim().toLowerCase()}\u0000${logicalModelId.trim().toLowerCase()}${generationSalt}`;
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return `ifc_rt_${hash.toString(16).padStart(16, '0')}`;
}

/** 返回路径的 basename（小写、去 IFC 后缀）。 */
export function normalizedIfcBasename(value: string): string {
  const normalized = normalizeEntryPath(value);
  const basename = normalized.split('/').pop() || normalized;
  return stripIfcExtension(basename).toLowerCase();
}

/**
 * 将 CBM/FileDevRelation 中的 IFC 引用解析为当前工程的 runtime modelId。
 *
 * 目录完整匹配优先；只有 basename 唯一时才允许 basename 匹配。重复 basename
 * 返回 null，调用方不得静默选择第一个模型，从而避免 GUID/高亮串模。
 */
export function resolveIfcModelId(reference: string, entries: readonly IfcEntry[]): string | null {
  const ref = normalizeEntryPath(reference);
  if (!ref) return null;

  const exact = entries.filter((entry) => normalizeEntryPath(entry.path) === ref);
  if (exact.length === 1) return exact[0].modelId;
  if (exact.length > 1) return null;

  const basename = normalizedIfcBasename(reference);
  const matches = entries.filter((entry) => normalizedIfcBasename(entry.path) === basename);
  return matches.length === 1 ? matches[0].modelId : null;
}

/** 根据稳定 modelId 找到 entry，供 UI/缓存恢复路径使用。 */
export function findIfcEntryByModelId(
  modelId: string,
  entries: readonly IfcEntry[],
): IfcEntry | undefined {
  return entries.find((entry) => entry.modelId === modelId);
}
