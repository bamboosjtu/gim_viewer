/**
 * M4-A2 第 2/3 轮：MapLibre style 工厂。
 *
 * 提供三种 style：
 * - empty：纯色背景，不加载瓦片（生产默认）
 * - osm-online：OpenStreetMap 在线 raster 底图（仅开发调试，DEV 模式）
 * - pmtiles：本地 PMTiles vector source（实验性，默认关闭）
 *
 * empty / pmtiles 都包含一个 background 层，确保即使 PMTiles 加载失败也有底色。
 * PMTiles style 不强制 source-layer，避免因瓦片元数据不匹配而加载失败。
 *
 * osm-online 仅在开发阶段用于调试 overlay 与底图对齐：
 * - 不批量下载瓦片
 * - 不预取大范围瓦片
 * - 不缓存为离线包
 * - 必须显示 attribution
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
 * OpenStreetMap 在线 raster style（仅开发调试用）。
 *
 * - 使用官方 tile.openstreetmap.org（HTTPS），不使用 a/b/c 子域
 * - tileSize: 256（OSM 标准）
 * - attribution 必须显示（ODbL 许可要求）
 *
 * 限制（M4-A2 第 3 轮 spec）：
 * - 不批量下载瓦片
 * - 不预取大范围瓦片
 * - 不缓存为离线包
 * - 不做 GCJ-02 坐标偏移
 * - 生产环境不使用此 style
 */
export function createOsmOnlineRasterStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: [
          'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [
      {
        id: 'osm-raster',
        type: 'raster',
        source: 'osm',
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
