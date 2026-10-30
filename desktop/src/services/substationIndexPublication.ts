import type { CbmNode, FileDevEntry, IfcEntry } from '../gim/types.js';
import type { GimIndexPayload, GeometryRefsPayload } from '@desktop/database.js';
import {
  buildGimIndexPayload,
  buildSubstationRestPayload,
  type SubstationRestPayload,
} from './gimIndexPersistenceService.js';

export interface SubstationPublicationInput {
  projectId: number;
  sourceSha256: string;
  files: Map<string, File>;
  cachePaths: Map<string, string>;
  /** 变电源 pack 成员：没有独立缓存路径，但索引可证明其已落盘。 */
  packedPaths?: Set<string>;
  tree: CbmNode | null;
  ifcs: IfcEntry[];
  relations: FileDevEntry[];
}

export interface CoreDependencies {
  isCurrent(): boolean;
  saveIndex(payload: GimIndexPayload): Promise<void>;
  saveRefs(payload: GeometryRefsPayload): Promise<void>;
  validate(): Promise<{ substation_semantic_cache_valid: boolean }>;
  onPhase?(phase: string, counts?: Record<string, number>): void;
}

export interface RestDependencies {
  isCurrent(): boolean;
  saveRest(payload: SubstationRestPayload): Promise<void>;
  onPhase?(phase: string, counts?: Record<string, number>): void;
  onPublished?(payload: SubstationRestPayload): void;
}

/**
 * 第一阶段只依赖内存中的树/关系/IFC 清单，不读取任何源文件字节。
 * 这样交互后 1–3 s 就能提交 entries + 树 + IFC + 关系 + receipt，
 * 让暖启动立即可用；FAM/DEV 属性与几何引用留给第二阶段。
 */
export async function publishSubstationCore(
  input: SubstationPublicationInput,
  deps: CoreDependencies,
): Promise<boolean> {
  const current = (): boolean => deps.isCurrent();
  if (!current()) return false;
  if (!input.sourceSha256 || input.projectId <= 0 || !input.tree || !input.ifcs.length) {
    throw new Error('变电索引缺少完整源身份或语义入口');
  }
  assertSemanticSourcesCached(input, deps.onPhase);
  let index: GimIndexPayload;
  try {
    index = await buildGimIndexPayload(
      input.projectId,
      input.files,
      input.ifcs,
      input.tree,
      input.relations,
      input.cachePaths,
      input.sourceSha256,
      current,
      { coreOnly: true },
    );
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return false;
    throw error;
  }
  if (!current()) return false;
  deps.onPhase?.('saveIndexStart');
  await deps.saveIndex(index);
  if (!current()) return false;
  deps.onPhase?.('saveIndexReady', {
    entries: index.entries.length,
    cbm: index.cbm_nodes.length,
    relations: index.file_dev_entries.length,
    ifc: index.ifc_models.length,
  });
  const emptyRefs: GeometryRefsPayload = {
    project_id: input.projectId,
    source_sha256: input.sourceSha256,
    dev_solid_models: [],
    dev_sub_devices: [],
    phm_solid_models: [],
  };
  await deps.saveRefs(emptyRefs); // 提交 parser_version + receipt（属性计数为 0）
  if (!current()) return false;
  const validation = await deps.validate();
  if (!current()) return false;
  if (!validation.substation_semantic_cache_valid) {
    throw new Error('变电语义索引发布后有效性校验失败');
  }
  deps.onPhase?.('coreValid');
  return true;
}

/** 第二阶段：几何引用 + FAM/DEV 属性，由单独的原子事务补写并重算 receipt。 */
export async function publishSubstationRest(
  input: SubstationPublicationInput,
  deps: RestDependencies,
): Promise<boolean> {
  const current = (): boolean => deps.isCurrent();
  if (!current()) return false;
  if (!input.sourceSha256 || input.projectId <= 0 || !input.tree) {
    throw new Error('变电索引补写缺少完整源身份或语义入口');
  }
  const prepared = await prepareSourceTexts(input, current, deps.onPhase);
  if (!prepared) return false;
  let payload: SubstationRestPayload;
  try {
    payload = await buildSubstationRestPayload(
      input.projectId,
      prepared,
      input.tree,
      input.sourceSha256,
      current,
    );
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return false;
    throw error;
  }
  if (!current()) return false;
  deps.onPhase?.('saveRestStart', {
    fam: payload.fam_properties.length,
    dev: payload.dev_properties.length,
    refs: payload.refs.dev_solid_models.length + payload.refs.phm_solid_models.length,
  });
  await deps.saveRest(payload);
  if (!current()) return false;
  deps.onPublished?.(payload);
  deps.onPhase?.('saveRestReady', {
    fam: payload.fam_properties.length,
    dev: payload.dev_properties.length,
  });
  return true;
}

function assertSemanticSourcesCached(
  input: SubstationPublicationInput,
  onPhase?: (phase: string, counts?: Record<string, number>) => void,
): void {
  const paths = new Map(
    [...input.cachePaths].map(([path, value]) => [path.replace(/\\/g, '/').toLowerCase(), value]),
  );
  const packed = new Set(
    [...(input.packedPaths ?? [])].map((path) => path.replace(/\\/g, '/').toLowerCase()),
  );
  const missingPaths: string[] = [];
  const missingSemanticPaths: string[] = [];
  for (const [path] of input.files) {
    if (!/\.(ifc|cbm|fam|dev|phm|mod|gl|stl|sch|std|sld)$/i.test(path)) continue;
    const key = path.replace(/\\/g, '/').toLowerCase();
    if (paths.get(key) || packed.has(key)) continue;
    missingPaths.push(path);
    // 语义发布只要求 CBM/FAM/DEV/PHM 文本；缺 MOD/STL/IFC 由逐条目几何读取修复。
    if (/\.(cbm|fam|dev|phm)$/i.test(path)) missingSemanticPaths.push(path);
  }
  if (missingSemanticPaths.length) {
    throw new Error(
      `语义源文件尚未完成缓存，拒绝发布索引: ${missingSemanticPaths.slice(0, 5).join('、')}` +
      `${missingSemanticPaths.length > 5 ? ` 等 ${missingSemanticPaths.length} 个` : ''}`,
    );
  }
  if (missingPaths.length) onPhase?.('sourceCacheIncomplete', { count: missingPaths.length });
}

/**
 * 属性与几何引用解析需要小文本源。
 *
 * 冷路径中 CBM/DEV/FAM 已在 hydration 时驻留内存；PHM 等仍是磁盘惰性
 * File，逐条 text() 会产生数千次主线程 IPC（实测单条 30–90 ms），所以
 * 惰性条目统一走批量读取再包装成内存 File。读取失败直接中止，防止不完整
 * 属性入库。
 */
async function prepareSourceTexts(
  input: SubstationPublicationInput,
  current: () => boolean,
  onPhase?: (phase: string, counts?: Record<string, number>) => void,
): Promise<Map<string, File> | null> {
  onPhase?.('sourceTextStart');
  const { isDiskBackedFile } = await import('@desktop/gimExtract.js');
  const { batchReadCachedFiles } = await import('@desktop/database.js');
  const prepared = new Map(input.files);
  // 只预读 DEV/FAM/PHM：DEV 属性与几何引用各解析一次，FAM 只解析一次；
  // CBM 已从树上 rawProperties 读取。FAM 若留到解析时再逐个 File.text()，
  // 会与 DEV 编译争用主线程（单次读取可达数十毫秒），所以一并预取。
  const candidates = [...input.files].filter(([path]) => /\.(dev|fam|phm)$/i.test(path));
  const eager = candidates.filter(([, file]) => !isDiskBackedFile(file));
  const lazyPaths = candidates.filter(([, file]) => isDiskBackedFile(file)).map(([path]) => path);

  for (let offset = 0; offset < eager.length; offset += 32) {
    if (!current()) return null;
    const chunk = eager.slice(offset, offset + 32);
    const texts = await Promise.all(chunk.map(([, file]) => file.text()));
    if (!current()) return null;
    chunk.forEach(([path, file], i) => prepared.set(path, new Proxy(file, {
      get(target, key) {
        if (key === 'text') return async () => texts[i];
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })));
  }

  const BATCH_FILES = 2048;
  for (let offset = 0; offset < lazyPaths.length; offset += BATCH_FILES) {
    if (!current()) return null;
    const chunk = lazyPaths.slice(offset, offset + BATCH_FILES);
    let result: Map<string, Uint8Array | null>;
    try {
      result = await batchReadCachedFiles(input.projectId, chunk);
    } catch (error) {
      throw new Error(`读取语义源失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!current()) return null;
    for (const path of chunk) {
      const bytes = result.get(path);
      if (!bytes) throw new Error(`语义源缓存不可读: ${path}`);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      prepared.set(path, new File([copy.buffer], path.split('/').pop() || path));
    }
  }
  onPhase?.('sourceTextReady', { files: candidates.length, lazy: lazyPaths.length });
  return prepared;
}
