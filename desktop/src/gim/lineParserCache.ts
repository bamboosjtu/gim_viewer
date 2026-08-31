/**
 * 线路解析阶段共享的文本/解析缓存。
 *
 * Worker 输入只包含可序列化的 `{ path, bytes }`，Worker 首次解码后把文本
 * 保存在这里。CBM 图构建与 FAM/DEV 属性解析共用同一实例，避免同一文件
 * 重复 TextDecoder、KEY=VALUE/FAM/DEV 解析。
 */

import type { LineFamProperty } from './lineFamParser.js';
import type { LineDevProperty } from './lineDevParser.js';
import { normalizeGimPath } from './linePathNormalize.js';

export interface LineParserTextFile {
  path: string;
  text: string;
}

type ParserKind = 'kv' | 'fam' | 'dev';

/** 解析器函数由调用方传入，避免 cache 层依赖具体解析器造成循环引用。 */
export class LineParserTextCache {
  private readonly filesByPath = new Map<string, LineParserTextFile>();
  private readonly filesByName = new Map<string, string[]>();
  private readonly parsed = new Map<string, Map<ParserKind, unknown>>();

  constructor(files: Iterable<LineParserTextFile>) {
    for (const file of files) {
      const normalizedPath = normalizeGimPath(file.path);
      if (!normalizedPath) continue;
      const key = normalizedPath.toLowerCase();
      // 归档内路径大小写变体视为同一文件，保留第一次出现的原始路径。
      if (!this.filesByPath.has(key)) {
        this.filesByPath.set(key, { path: file.path, text: file.text });
      }
      const name = normalizedPath.split('/').pop()?.toLowerCase() ?? '';
      if (!name) continue;
      const list = this.filesByName.get(name) ?? [];
      if (!list.includes(key)) list.push(key);
      this.filesByName.set(name, list);
    }
  }

  /** 按完整路径查找，路径分隔符和大小写均不敏感。 */
  resolvePath(path: string): string | null {
    const normalized = normalizeGimPath(path);
    if (!normalized) return null;
    const exactKey = normalized.toLowerCase();
    if (this.filesByPath.has(exactKey)) return exactKey;
    const name = normalized.split('/').pop()?.toLowerCase() ?? '';
    const matches = this.filesByName.get(name);
    return matches?.[0] ?? null;
  }

  /** 取得引用对应的实际原始路径（用于 payload/source_path）。 */
  resolveOriginalPath(path: string): string | null {
    const key = this.resolvePath(path);
    return key ? this.filesByPath.get(key)?.path ?? null : null;
  }

  getText(path: string): string | null {
    const key = this.resolvePath(path);
    return key ? this.filesByPath.get(key)?.text ?? null : null;
  }

  /** 对同一文件的同一种语义解析只执行一次。 */
  parse<T>(kind: ParserKind, path: string, parser: (text: string) => T): T | null {
    const key = this.resolvePath(path);
    if (!key) return null;
    const existing = this.parsed.get(key)?.get(kind);
    if (existing !== undefined) return existing as T;
    const source = this.filesByPath.get(key);
    if (!source) return null;
    const parsed = parser(source.text);
    const byKind = this.parsed.get(key) ?? new Map<ParserKind, unknown>();
    byKind.set(kind, parsed);
    this.parsed.set(key, byKind);
    return parsed;
  }

  get size(): number {
    return this.filesByPath.size;
  }
}

/** 仅用于让类型系统表达共享 cache 的可复用结果，运行时无额外开销。 */
export type LineParserParsedCache = LineParserTextCache;

export type { LineFamProperty, LineDevProperty };

