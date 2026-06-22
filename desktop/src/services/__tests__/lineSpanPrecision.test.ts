/**
 * lineWireSemanticService 档距计算单测。
 *
 * 覆盖 dev-log「档距精度」修复：BLHA 含高程时档距按斜距 sqrt(d²+h²)
 * 修正，不再仅用 Haversine 平面距离（山地塔位高程差数十米会明显低估）。
 */

import { describe, expect, it } from 'vitest';
import { buildWireSemanticInfo } from '../lineWireSemanticService.js';

describe('buildWireSemanticInfo 档距高程修正', () => {
  // 北京附近约 0.001° 纬度差 ≈ 111.19 m 平面距离
  const baseWire = {
    startLat: 39.9,
    startLng: 116.4,
    endLat: 39.901,
    endLng: 116.4,
    wireType: 'CONDUCTOR',
    nodeRef: { rawProps: {} },
  };

  it('无高程时退化为平面 Haversine 距离', () => {
    const info = buildWireSemanticInfo({ wire: baseWire });
    expect(info.spanMeters).not.toBeNull();
    expect(info.spanMeters!).toBeGreaterThan(110);
    expect(info.spanMeters!).toBeLessThan(113);
  });

  it('高程差为 0 时与平面距离一致', () => {
    const info = buildWireSemanticInfo({
      wire: { ...baseWire, startElev: 100, endElev: 100 },
    });
    const flat = buildWireSemanticInfo({ wire: baseWire });
    expect(info.spanMeters!).toBeCloseTo(flat.spanMeters!, 6);
  });

  it('有高程差时按斜距放大（sqrt(d²+h²)）', () => {
    const flat = buildWireSemanticInfo({ wire: baseWire }).spanMeters!;
    const info = buildWireSemanticInfo({
      wire: { ...baseWire, startElev: 100, endElev: 160 },
    });
    // h=60m，斜距应严格大于平面距离
    expect(info.spanMeters!).toBeGreaterThan(flat);
    // 斜距上限：平面距离 + |h|（勾股不等式）
    expect(info.spanMeters!).toBeLessThan(flat + 60.0001);
    // 精确值校验
    const expected = Math.sqrt(flat * flat + 60 * 60);
    expect(info.spanMeters!).toBeCloseTo(expected, 6);
  });

  it('仅一端有高程时退化平面距离', () => {
    const flat = buildWireSemanticInfo({ wire: baseWire });
    const p1 = buildWireSemanticInfo({
      wire: { ...baseWire, startElev: 100, endElev: null },
    });
    const p2 = buildWireSemanticInfo({
      wire: { ...baseWire, startElev: null, endElev: 160 },
    });
    expect(p1.spanMeters!).toBeCloseTo(flat.spanMeters!, 6);
    expect(p2.spanMeters!).toBeCloseTo(flat.spanMeters!, 6);
  });

  it('高程从 rawProps BLHA 解析路径不受影响（rawProps 缺失仍有 warning）', () => {
    const info = buildWireSemanticInfo({ wire: { ...baseWire, nodeRef: null } });
    expect(info.warnings.some((w) => w.includes('POINT0.BLHA'))).toBe(true);
  });
});
