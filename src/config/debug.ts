/**
 * 调试日志开关配置。
 *
 * 默认行为：
 * - 开发模式（import.meta.env.DEV=true）：所有 debug 日志开启
 * - 生产模式（import.meta.env.DEV=false）：所有 debug 日志关闭
 *
 * localStorage override（生产排障用）：
 * - localStorage.setItem('GIM_DEBUG', '1') 开启 override
 * - localStorage.setItem('GIM_DEBUG_CATEGORIES', 'ifc,fragments') 指定分类
 * - GIM_DEBUG=1 且 GIM_DEBUG_CATEGORIES 为空 → 开启全部
 * - GIM_DEBUG=1 且 GIM_DEBUG_CATEGORIES 非空 → 仅开启指定分类
 * - 开发模式忽略 override，始终全部开启
 *
 * 例外（始终输出，不受 debug 开关控制）：
 * - console.error（致命错误）
 * - 缓存损坏 warning（byteLength===0、文件头不符等）
 * - dispose 失败 warning
 *
 * unhandledrejection 监听器（bootstrap.ts）：
 * - Fragments 异常被 preventDefault() 捕获，避免红屏
 * - 开发模式输出完整 warning 堆栈
 * - 生产模式静默处理
 * - 真实错误仍通过 safeFragmentsUpdate 局部 catch / console.error 处理
 */

/** debug 分类标识 */
export type DebugCategory = 'runtime' | 'ifc' | 'gim-cache' | 'line-map' | 'fragments';

/** 所有合法分类（用于校验和快照） */
const ALL_CATEGORIES: DebugCategory[] = ['runtime', 'ifc', 'gim-cache', 'line-map', 'fragments'];

/** localStorage 安全读取（兼容非浏览器环境 / 隐私模式） */
function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** GIM_DEBUG 是否开启 */
function isGimDebugEnabled(): boolean {
  return readLocalStorage('GIM_DEBUG') === '1';
}

/**
 * 解析 GIM_DEBUG_CATEGORIES。
 * @returns null 表示未指定（应开启全部）；空数组表示指定了但全部非法；非空数组表示有效分类列表
 */
function parseDebugCategories(): DebugCategory[] | null {
  const raw = readLocalStorage('GIM_DEBUG_CATEGORIES');
  if (!raw || !raw.trim()) return null; // 未指定 → 开启全部
  const cats = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is DebugCategory =>
      (ALL_CATEGORIES as string[]).includes(s),
    );
  return cats;
}

/**
 * 判断指定 debug 分类是否通过 localStorage override 开启。
 *
 * 规则：
 * - GIM_DEBUG≠'1' → false（override 未激活）
 * - GIM_DEBUG='1' 且 GIM_DEBUG_CATEGORIES 为空 → true（开启全部）
 * - GIM_DEBUG='1' 且 GIM_DEBUG_CATEGORIES 非空 → 仅指定分类为 true
 *
 * 注意：开发模式（import.meta.env.DEV=true）不调用此函数，
 * 由 isDebugOn 统一处理 DEV || override。
 */
export function isDebugOverrideEnabled(category: DebugCategory): boolean {
  if (!isGimDebugEnabled()) return false;
  const cats = parseDebugCategories();
  if (cats === null) return true; // 未指定分类 → 开启全部
  return cats.includes(category);
}

/** DEV 模式或 localStorage override → 该分类 debug 开启 */
function isDebugOn(category: DebugCategory): boolean {
  return import.meta.env.DEV || isDebugOverrideEnabled(category);
}

/** 运行时详细日志总开关（工程类型识别 / cleanup 统计等） */
export const DEBUG_RUNTIME_LOGS = isDebugOn('runtime');

/** IFC 加载链路日志（initEngine / loadIfcEntry / post-load validation / WASM / 高亮等） */
export const DEBUG_IFC_LOAD = isDebugOn('ifc');

/** GIM 缓存读写日志（saveGimIndex / validate_gim_cache / restore / 线路图缓存等） */
export const DEBUG_GIM_CACHE = isDebugOn('gim-cache');

/** 线路地图渲染日志（Canvas / 图层 / focus / LineMapData 提取等） */
export const DEBUG_LINE_MAP = isDebugOn('line-map');

/** Fragments update 异常详情日志（safeFragmentsUpdate / unhandledrejection） */
export const DEBUG_FRAGMENTS = isDebugOn('fragments');

/**
 * 返回当前 debug 配置快照（供 Ctrl+Shift+D 诊断使用）。
 *
 * 快照包含：
 * - dev: import.meta.env.DEV 值
 * - gimDebug: localStorage GIM_DEBUG 原始值
 * - categoriesRaw: localStorage GIM_DEBUG_CATEGORIES 原始值
 * - categories: 解析后的分类列表或 'ALL'
 * - runtime / ifc / gimCache / lineMap / fragments: 各分类最终生效状态
 */
export function getDebugConfigSnapshot(): Record<string, unknown> {
  const gimDebug = readLocalStorage('GIM_DEBUG');
  const catsRaw = readLocalStorage('GIM_DEBUG_CATEGORIES');
  const cats = parseDebugCategories();
  return {
    dev: import.meta.env.DEV,
    gimDebug,
    categoriesRaw: catsRaw,
    categories: cats ?? 'ALL',
    runtime: DEBUG_RUNTIME_LOGS,
    ifc: DEBUG_IFC_LOAD,
    gimCache: DEBUG_GIM_CACHE,
    lineMap: DEBUG_LINE_MAP,
    fragments: DEBUG_FRAGMENTS,
  };
}
