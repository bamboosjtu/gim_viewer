import { afterEach, describe, expect, it } from 'vitest';

describe('天地图配置', () => {
  afterEach(async () => {
    const config = await import('../tianditu.js');
    config.setTiandituKey('');
  });

  it('运行时设置 Key 后会裁剪两侧空白，并生成 MapLibre 所需占位符 URL', async () => {
    const config = await import('../tianditu.js');
    config.setTiandituKey('  unit-test-key  ');

    expect(config.isTiandituKeyAvailable()).toBe(true);
    expect(config.buildTiandituTileUrl('img_w', 2)).toBe(
      'https://t2.tianditu.gov.cn/DataServer?T=img_w&x={x}&y={y}&l={z}&tk=unit-test-key',
    );
  });

  it('清空 Key 后不可用，并对 URL 中的 Key 做编码', async () => {
    const config = await import('../tianditu.js');
    config.setTiandituKey('a b&c');
    expect(config.buildTiandituTileUrl('vec_w', 0)).toContain('tk=a%20b%26c');
    config.setTiandituKey('');
    expect(config.isTiandituKeyAvailable()).toBe(false);
  });

  it('仅使用已验证稳定的 t0–t4 子域', async () => {
    const config = await import('../tianditu.js');
    expect(config.TIANDITU_SUBDOMAINS).toEqual([0, 1, 2, 3, 4]);
  });
});
