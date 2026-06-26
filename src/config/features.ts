/**
 * 功能开关配置。
 *
 * Fragments 缓存目前为实验功能，默认关闭。
 * 关闭时 loadIfcEntry 完全走 ctx.ifcLoader.load 路径，不读/写 .frag 文件。
 */
export const ENABLE_FRAGMENTS_CACHE = false;

/**
 * MapLibre 技术验证开关（M4-A1）。
 *
 * 默认 false：线路地图仍走 `src/ui/lineMapView.ts` 纯 Canvas 渲染。
 * 仅当手动改为 true 时，才会动态加载 `src/ui/lineMapBaseLayer.ts` 的 probe 模块。
 *
 * 技术验证范围（M4-A1）：
 * - 验证 maplibre-gl 能在 Tauri + Vite 中被动态 import / 创建 / 销毁
 * - 使用本地空 style（不加载在线瓦片，不访问外网）
 * - 不替换 Canvas 主流程，不改 geoToScreen()
 *
 * 后续 M4-A2 才做 Canvas overlay 对接。
 */
export const ENABLE_MAPLIBRE_EXPERIMENT = false;
