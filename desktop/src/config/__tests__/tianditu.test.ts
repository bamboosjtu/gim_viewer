import { afterEach, describe, expect, it, vi } from 'vitest';

describe('天地图配置', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('会裁剪 Key 两侧空白，并生成 MapLibre 所需占位符 URL', async () => {
    vi.stubEnv('VITE_TIANDITU_KEY', '  unit-test-key  ');
    vi.resetModules();
    const config = await import('../tianditu.js');

    expect(config.TIANDITU_KEY).toBe('unit-test-key');
    expect(config.isTiandituKeyAvailable()).toBe(true);
    expect(config.buildTiandituTileUrl('img_w', 2)).toBe(
      'https://t2.tianditu.gov.cn/DataServer?T=img_w&x={x}&y={y}&l={z}&tk=unit-test-key',
    );
  });

  it('仅使用已验证稳定的 t0–t4 子域', async () => {
    const config = await import('../tianditu.js');
    expect(config.TIANDITU_SUBDOMAINS).toEqual([0, 1, 2, 3, 4]);
  });
});
