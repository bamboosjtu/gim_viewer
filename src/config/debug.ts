/**
 * 调试日志开关配置。
 *
 * 所有运行时 debug 日志通过 import.meta.env.DEV 控制：
 * - 开发模式（npm run dev / npm run tauri:dev）：true，输出详细日志便于定位
 * - 生产模式（npm run build / npm run tauri:build）：false，控制台无刷屏
 *
 * 例外（始终输出）：
 * - console.error（致命错误）
 * - 缓存损坏 warning（byteLength===0、文件头不符等）
 * - dispose 失败 warning
 *
 * unhandledrejection 监听器：
 * - 默认输出简化 warning（仅提示来源）
 * - DEBUG 模式输出完整错误堆栈
 */

/** 运行时详细日志总开关（开发环境开启） */
export const DEBUG_RUNTIME_LOGS = import.meta.env.DEV;

/** IFC 加载链路日志（initEngine / loadIfcEntry / post-load validation 等） */
export const DEBUG_IFC_LOAD = import.meta.env.DEV;

/** GIM 缓存读写日志（saveGimIndex / validate_gim_cache / restore 等） */
export const DEBUG_GIM_CACHE = import.meta.env.DEV;

/** 线路地图渲染日志（Canvas / 图层 / focus 等） */
export const DEBUG_LINE_MAP = import.meta.env.DEV;

/** Fragments update 异常详情日志（safeFragmentsUpdate 内部） */
export const DEBUG_FRAGMENTS = import.meta.env.DEV;
