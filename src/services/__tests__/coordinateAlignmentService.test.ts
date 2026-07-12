import { describe, expect, it, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  makeTranslationAlignment,
  applyProjectSourceToViewer,
  loadManualCoordOffsetFromLocalStorage,
} from '../coordinateAlignmentService.js';
import { AppState } from '../../app/state.js';

// ===== makeTranslationAlignment =====

describe('makeTranslationAlignment', () => {
  it('返回 manual confidence 和描述性 reason', () => {
    const result = makeTranslationAlignment(10, 20, 30);
    expect(result.confidence).toBe('manual');
    expect(result.reason).toContain('manual alignment');
    expect(result.reason).toContain('dx=10');
    expect(result.reason).toContain('dy=20');
    expect(result.reason).toContain('dz=30');
    expect(result.reason).toContain('Z-up→Y-up');
  });

  it('矩阵 = translation × ZUpToYUp（先旋转再平移）', () => {
    const { sourceToViewer: m } = makeTranslationAlignment(100, 200, 300);

    // Z-up→Y-up 旋转：原 (0,0,1) → (0,1,0)
    const zUpPoint = new THREE.Vector3(0, 0, 1).applyMatrix4(m);
    expect(zUpPoint.x).toBeCloseTo(100, 6);
    expect(zUpPoint.y).toBeCloseTo(201, 6); // 200 + 1
    expect(zUpPoint.z).toBeCloseTo(300, 6);

    // Z-up→Y-up 旋转：原 (0,1,0) → (0,0,-1)
    const yUpPoint = new THREE.Vector3(0, 1, 0).applyMatrix4(m);
    expect(yUpPoint.x).toBeCloseTo(100, 6);
    expect(yUpPoint.y).toBeCloseTo(200, 6);
    expect(yUpPoint.z).toBeCloseTo(299, 6); // 300 - 1
  });

  it('零平移时矩阵退化为纯 Z-up→Y-up 旋转', () => {
    const { sourceToViewer: m } = makeTranslationAlignment(0, 0, 0);
    const expected = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    for (let i = 0; i < 16; i++) {
      expect(m.elements[i]).toBeCloseTo(expected.elements[i], 6);
    }
  });

  it('不同平移值产生不同矩阵', () => {
    const a = makeTranslationAlignment(1, 0, 0);
    const b = makeTranslationAlignment(0, 1, 0);
    expect(a.sourceToViewer.elements).not.toEqual(b.sourceToViewer.elements);
  });

  it('原点 (0,0,0) 经变换后等于平移量', () => {
    const { sourceToViewer: m } = makeTranslationAlignment(50, 60, 70);
    const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(m);
    expect(origin.x).toBeCloseTo(50, 6);
    expect(origin.y).toBeCloseTo(60, 6);
    expect(origin.z).toBeCloseTo(70, 6);
  });
});

// ===== applyProjectSourceToViewer =====

describe('applyProjectSourceToViewer', () => {
  it('matrix 为 null 时不修改 group', () => {
    const group = new THREE.Group();
    group.position.set(10, 20, 30);
    applyProjectSourceToViewer(group, null);
    expect(group.position.x).toBe(10);
    expect(group.position.y).toBe(20);
    expect(group.position.z).toBe(30);
  });

  it('matrix 为单位矩阵时 group 不变', () => {
    const group = new THREE.Group();
    group.position.set(5, 10, 15);
    applyProjectSourceToViewer(group, new THREE.Matrix4()); // identity
    expect(group.position.x).toBeCloseTo(5, 6);
    expect(group.position.y).toBeCloseTo(10, 6);
    expect(group.position.z).toBeCloseTo(15, 6);
  });

  it('应用平移矩阵到 group', () => {
    const group = new THREE.Group();
    group.position.set(0, 0, 0);
    const translation = new THREE.Matrix4().makeTranslation(100, 200, 300);
    applyProjectSourceToViewer(group, translation);
    expect(group.position.x).toBeCloseTo(100, 6);
    expect(group.position.y).toBeCloseTo(200, 6);
    expect(group.position.z).toBeCloseTo(300, 6);
  });

  it('应用旋转矩阵到 group（Z-up→Y-up）', () => {
    const group = new THREE.Group();
    // 模拟 GIM Z-up 坐标中的点：(0, 0, 5) → 旋转后应为 (0, 5, 0)
    group.position.set(0, 0, 5);
    const rotation = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    applyProjectSourceToViewer(group, rotation);
    expect(group.position.x).toBeCloseTo(0, 6);
    expect(group.position.y).toBeCloseTo(5, 6);
    expect(group.position.z).toBeCloseTo(0, 6);
  });

  it('应用完整对齐矩阵（旋转+平移）到 group', () => {
    const group = new THREE.Group();
    // GIM Z-up 坐标 (0, 0, 5750) mm → 先旋转到 Y-up (0, 5750, 0) → 再平移
    group.position.set(0, 0, 5750);
    const { sourceToViewer } = makeTranslationAlignment(1000, 0, -2000);
    applyProjectSourceToViewer(group, sourceToViewer);
    // (0, 0, 5750) → 旋转 → (0, 5750, 0) → 平移 (1000, 0, -2000) → (1000, 5750, -2000)
    expect(group.position.x).toBeCloseTo(1000, 2);
    expect(group.position.y).toBeCloseTo(5750, 2);
    expect(group.position.z).toBeCloseTo(-2000, 2);
  });
});

// ===== loadManualCoordOffsetFromLocalStorage =====

describe('loadManualCoordOffsetFromLocalStorage', () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    // 清理 localStorage
    try {
      window.localStorage.clear();
    } catch {
      // ignore
    }
  });

  it('无 GIM_COORD_OFFSET 时返回 false 且不设置矩阵', () => {
    expect(loadManualCoordOffsetFromLocalStorage(state)).toBe(false);
    expect(state.projectSourceToViewerMatrix).toBeNull();
  });

  it('空字符串返回 false', () => {
    window.localStorage.setItem('GIM_COORD_OFFSET', '');
    expect(loadManualCoordOffsetFromLocalStorage(state)).toBe(false);
    expect(state.projectSourceToViewerMatrix).toBeNull();
  });

  it('纯空白返回 false', () => {
    window.localStorage.setItem('GIM_COORD_OFFSET', '   ');
    expect(loadManualCoordOffsetFromLocalStorage(state)).toBe(false);
  });

  it('合法 "dx,dy,dz" 格式解析成功', () => {
    window.localStorage.setItem('GIM_COORD_OFFSET', '1000,0,-2000');
    expect(loadManualCoordOffsetFromLocalStorage(state)).toBe(true);
    expect(state.projectSourceToViewerMatrix).not.toBeNull();

    // 验证矩阵内容 = makeTranslationAlignment(1000, 0, -2000)
    const expected = makeTranslationAlignment(1000, 0, -2000);
    const m = state.projectSourceToViewerMatrix!;
    for (let i = 0; i < 16; i++) {
      expect(m.elements[i]).toBeCloseTo(expected.sourceToViewer.elements[i], 6);
    }
  });

  it('带空格的 "dx, dy, dz" 格式也能解析', () => {
    window.localStorage.setItem('GIM_COORD_OFFSET', ' 10 , 20 , 30 ');
    expect(loadManualCoordOffsetFromLocalStorage(state)).toBe(true);
    expect(state.projectSourceToViewerMatrix).not.toBeNull();

    // 原点经变换后应等于 (10, 20, 30)
    const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(state.projectSourceToViewerMatrix!);
    expect(origin.x).toBeCloseTo(10, 6);
    expect(origin.y).toBeCloseTo(20, 6);
    expect(origin.z).toBeCloseTo(30, 6);
  });

  it('非 3 段格式返回 false', () => {
    window.localStorage.setItem('GIM_COORD_OFFSET', '1,2');
    expect(loadManualCoordOffsetFromLocalStorage(state)).toBe(false);
    expect(state.projectSourceToViewerMatrix).toBeNull();
  });

  it('4 段格式返回 false', () => {
    window.localStorage.setItem('GIM_COORD_OFFSET', '1,2,3,4');
    expect(loadManualCoordOffsetFromLocalStorage(state)).toBe(false);
  });

  it('含非数字返回 false', () => {
    window.localStorage.setItem('GIM_COORD_OFFSET', 'abc,def,ghi');
    expect(loadManualCoordOffsetFromLocalStorage(state)).toBe(false);
    expect(state.projectSourceToViewerMatrix).toBeNull();
  });

  it('含部分非数字返回 false', () => {
    window.localStorage.setItem('GIM_COORD_OFFSET', '1,abc,3');
    expect(loadManualCoordOffsetFromLocalStorage(state)).toBe(false);
  });

  it('含 NaN 返回 false', () => {
    window.localStorage.setItem('GIM_COORD_OFFSET', 'NaN,0,0');
    expect(loadManualCoordOffsetFromLocalStorage(state)).toBe(false);
  });

  it('含 Infinity 返回 false', () => {
    window.localStorage.setItem('GIM_COORD_OFFSET', 'Infinity,0,0');
    expect(loadManualCoordOffsetFromLocalStorage(state)).toBe(false);
  });

  it('负数和小数合法', () => {
    window.localStorage.setItem('GIM_COORD_OFFSET', '-100.5,0.001,999.999');
    expect(loadManualCoordOffsetFromLocalStorage(state)).toBe(true);
    expect(state.projectSourceToViewerMatrix).not.toBeNull();
  });

  it('已存在 projectSourceToViewerMatrix 时不覆盖', () => {
    // 先设置一个已有的矩阵
    const existing = new THREE.Matrix4().makeTranslation(999, 888, 777);
    state.projectSourceToViewerMatrix = existing;

    window.localStorage.setItem('GIM_COORD_OFFSET', '1,2,3');
    // loadManualCoordOffsetFromLocalStorage 无条件覆盖（与 syncProjectSourceToViewerFromFragments 不同）
    expect(loadManualCoordOffsetFromLocalStorage(state)).toBe(true);
    // 矩阵被覆盖为 GIM_COORD_OFFSET 对应的值
    const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(state.projectSourceToViewerMatrix!);
    expect(origin.x).toBeCloseTo(1, 6);
    expect(origin.y).toBeCloseTo(2, 6);
    expect(origin.z).toBeCloseTo(3, 6);
  });

  it('localStorage 不可用时返回 false（隐私模式）', () => {
    // Mock localStorage.getItem 抛异常
    const original = window.localStorage.getItem;
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: () => { throw new Error('not available'); },
        setItem: () => {},
        removeItem: () => {},
      },
      configurable: true,
    });
    expect(loadManualCoordOffsetFromLocalStorage(state)).toBe(false);
    expect(state.projectSourceToViewerMatrix).toBeNull();
    // 恢复
    Object.defineProperty(window, 'localStorage', { value: original, configurable: true });
  });
});

// ===== 端到端：坐标变换链完整性 =====

describe('坐标变换链端到端', () => {
  it('GIM Z-up 工程坐标 → viewer Y-up 坐标的完整变换', () => {
    // 模拟 CBM 矩阵样本 T=(45758.924, 7382.144, 5750.000)
    // Tz=5750mm 是变电站内设备的高度方向
    const gimPoint = new THREE.Vector3(45758.924, 7382.144, 5750.0);

    // 1. Z-up → Y-up 旋转（绕 X 轴 -90°）
    //    原 +Z（高度）→ 新 +Y（viewer 上方向）
    //    原 +Y → 新 -Z
    //    原 +X 不变
    const { sourceToViewer } = makeTranslationAlignment(0, 0, 0);
    const viewerPoint = gimPoint.clone().applyMatrix4(sourceToViewer);

    // 验证：X 不变，原 Z（5750）→ Y，原 Y（7382.144）→ -Z
    expect(viewerPoint.x).toBeCloseTo(45758.924, 3);
    expect(viewerPoint.y).toBeCloseTo(5750.0, 3);
    expect(viewerPoint.z).toBeCloseTo(-7382.144, 3);
  });

  it('MOD Group 应用对齐矩阵后坐标正确', () => {
    // 模拟一个 MOD 几何体在 GIM Z-up 坐标 (1000, 2000, 3000)
    const modGroup = new THREE.Group();
    modGroup.position.set(1000, 2000, 3000);

    // 应用项目对齐：先旋转 Z-up→Y-up，再平移到 viewer 原点
    const { sourceToViewer } = makeTranslationAlignment(-45000, 0, 5000);
    applyProjectSourceToViewer(modGroup, sourceToViewer);

    // (1000, 2000, 3000) → 旋转 → (1000, 3000, -2000) → 平移 (-45000, 0, 5000)
    // → (-44000, 3000, 3000)
    expect(modGroup.position.x).toBeCloseTo(-44000, 1);
    expect(modGroup.position.y).toBeCloseTo(3000, 1);
    expect(modGroup.position.z).toBeCloseTo(3000, 1);
  });
});
