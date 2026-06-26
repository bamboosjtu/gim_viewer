/**
 * M4-A2 第 2 轮：MapLibre style 工厂。
 *
 * 提供两种 style：
 * - empty：纯色背景，不加载瓦片（默认）
 * - pmtiles：本地 PMTiles vector source（实验性，默认关闭）
 *
 * 两种 style 都包含一个 background 层，确保即使 PMTiles 加载失败也有底色。
 * PMTiles style 不强制 source-layer，避免因瓦片元数据不匹配而加载失败。
 */

import type { StyleSpecification } from 'maplibre-gl';

/** 空白 style：仅一个 background 层，不引入任何 source / 瓦片 */
export function createEmptyLineMapStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: {
          'background-color': '#f8fafc',
        },
      },
    ],
  };
}

/**
 * PMTiles style：本地 vector source + background 层。
 *
 * - source URL 使用 `pmtiles://` 协议前缀，由 Protocol 管理
 * - 不添加 vector 图层（避免 source-layer 不匹配导致渲染失败）
 * - 仅保留 background 层，确保有底色
 *
 * @param url PMTiles 文件 URL（如 `/tiles/demo.pmtiles`）
 */
export function createPmtilesLineMapStyle(url: string): StyleSpecification {
  return {
    version: 8,
    sources: {
      offline: {
        type: 'vector',
        url: `pmtiles://${url}`,
      },
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: {
          'background-color': '#f8fafc',
        },
      },
    ],
  };
}
