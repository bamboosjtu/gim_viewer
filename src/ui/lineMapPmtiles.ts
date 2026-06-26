/**
 * M4-A2 第 2 轮：PMTiles protocol 管理。
 *
 * 仅在 `ENABLE_PMTILES_EXPERIMENT=true` 时由 `lineMapBaseLayer.ts` 动态 import 使用。
 *
 * 职责：
 * - 动态 import `pmtiles` 包（默认关闭时不进入主 bundle）
 * - 向 MapLibre 注册 `pmtiles://` 协议（防重复注册）
 * - 提供 cleanup 接口（removeProtocol）
 *
 * 不做的事：
 * - 不下载瓦片（瓦片由 MapLibre source 按需请求）
 * - 不做坐标偏移
 * - 不访问外网
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** PMTiles protocol 清理句柄 */
export interface PmtilesProtocolHandle {
  /** 注销 pmtiles:// 协议（removeProtocol），幂等 */
  destroy(): void;
}

/** MapLibre 模块的最小类型约束（addProtocol / removeProtocol） */
export interface MapLibreProtocolCapable {
  addProtocol(name: string, fn: (req: RequestParameters) => Promise<unknown>): void;
  removeProtocol(name: string): void;
}

/** MapLibre RequestParameters 最小类型 */
interface RequestParameters {
  url: string;
  type?: string;
}

// ---------------------------------------------------------------------------
// 防重复注册
// ---------------------------------------------------------------------------

/** 是否已注册 pmtiles 协议（模块级单例，防止多次 probe 创建时重复注册） */
let protocolRegistered = false;

/** 当前注册的引用计数（多个 probe 共享时，最后一个 destroy 才真正 removeProtocol） */
let protocolRefCount = 0;

/** pmtiles Protocol 实例（用于 cleanup 时解除引用） */
let pmtilesProtocol: { tile: (req: RequestParameters) => Promise<unknown> } | null = null;

// ---------------------------------------------------------------------------
// protocol 工厂
// ---------------------------------------------------------------------------

/**
 * 注册 PMTiles 协议到 MapLibre。
 *
 * 行为：
 * - 动态 import `pmtiles` 包
 * - 如果尚未注册，创建 Protocol 实例并调用 `maplibre.addProtocol('pmtiles', protocol.tile)`
 * - 引用计数 +1
 * - 返回 handle，destroy 时引用计数 -1，归零时 removeProtocol
 *
 * @param maplibre 动态 import 的 maplibre-gl 模块
 * @throws 如果 pmtiles 包加载失败
 */
export async function setupPmtilesProtocol(
  maplibre: MapLibreProtocolCapable,
): Promise<PmtilesProtocolHandle> {
  // 动态 import：默认关闭时 pmtiles 包不会进入主 bundle
  const pmtiles = await import('pmtiles');

  // 首次注册
  if (!protocolRegistered) {
    const protocol = new pmtiles.Protocol();
    pmtilesProtocol = protocol as unknown as { tile: (req: RequestParameters) => Promise<unknown> };
    maplibre.addProtocol('pmtiles', pmtilesProtocol.tile);
    protocolRegistered = true;
    console.log('[PMTiles] protocol registered');
  }

  protocolRefCount++;

  let destroyed = false;

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      protocolRefCount = Math.max(0, protocolRefCount - 1);
      // 引用计数归零时才真正 removeProtocol（避免多 probe 场景下误删）
      if (protocolRefCount === 0 && protocolRegistered) {
        try {
          maplibre.removeProtocol('pmtiles');
          protocolRegistered = false;
          pmtilesProtocol = null;
          console.log('[PMTiles] protocol removed');
        } catch (err) {
          console.warn('[PMTiles] protocol remove 失败:', err);
        }
      }
    },
  };
}
