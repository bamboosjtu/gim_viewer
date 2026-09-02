import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GimGraphNode } from '../../gim/gimGraphTypes.js';
import type { LineMapData } from '../../gim/lineMapData.js';
import { renderLineMap } from '../lineMapView.js';

function node(path: string): GimGraphNode {
  return {
    path,
    name: path,
    entityName: 'TOWER',
    classifyName: 'TOWER',
    rawProps: {},
    children: [],
    refs: {
      cbmFiles: [], devFiles: [], famFiles: [], phmFiles: [], modFiles: [],
      stlFiles: [], wireFiles: [], ifcFiles: [], rawRefs: {},
    },
  };
}

function makeMapData(wireCount = 12): LineMapData {
  const towerA = node('Cbm/N001.cbm');
  const towerB = node('Cbm/N002.cbm');
  const towerAData = {
    cbmPath: towerA.path,
    lat: 30,
    lng: 120,
    elev: 0,
    azimuth: null,
    towerNumber: 'N001',
    towerType: '直线塔',
    dataQuality: 'full' as const,
    nodeRef: towerA,
  };
  const towerBData = {
    ...towerAData,
    cbmPath: towerB.path,
    lat: 30.01,
    lng: 120.01,
    towerNumber: 'N002',
    nodeRef: towerB,
  };
  return {
    towers: [towerAData, towerBData],
    wires: Array.from({ length: wireCount }, (_, index) => ({
      startLat: 30,
      startLng: 120,
      endLat: 30.01,
      endLng: 120.01,
      wireType: index % 2 ? 'GROUNDWIRE' : 'CONDUCTOR',
      nodeRef: node(`Cbm/W${index}.cbm`),
      startElev: 0,
      endElev: 0,
      spanMeters: 1200,
      groupKind: 'inter-point' as const,
    })),
    crosses: [],
    bbox: { minLat: 30, maxLat: 30.01, minLng: 120, maxLng: 120.01 },
    warnings: [],
    stats: {
      towerTotal: 2,
      towerWithBlha: 2,
      towerWithFam: 2,
      wireTotal: wireCount,
      wireWithEndpoints: wireCount,
      crossTotal: 0,
      crossWithCoord: 0,
    },
    unresolved: { towers: [], wires: [], crosses: [], famSources: [], devSources: [] },
  };
}

function installCanvasStubs(): { calls: Record<string, number>; restore: () => void } {
  const calls: Record<string, number> = {};
  const count = (name: string) => { calls[name] = (calls[name] || 0) + 1; };
  const context = new Proxy({}, {
    get(_target, property: string) {
      if (property === 'setTransform' || property === 'clearRect' || property === 'fillRect'
        || property === 'strokeRect' || property === 'beginPath' || property === 'moveTo'
        || property === 'lineTo' || property === 'stroke' || property === 'fill'
        || property === 'arc' || property === 'closePath' || property === 'fillText'
        || property === 'setLineDash') {
        return () => count(property);
      }
      return undefined;
    },
  }) as unknown as CanvasRenderingContext2D;
  const canvasProto = HTMLCanvasElement.prototype as unknown as {
    getContext: HTMLCanvasElement['getContext'];
  };
  const originalGetContext = canvasProto.getContext;
  canvasProto.getContext = (() => context) as unknown as HTMLCanvasElement['getContext'];
  const originalResizeObserver = globalThis.ResizeObserver;
  class FakeResizeObserver {
    observe(): void { /* no-op */ }
    disconnect(): void { /* no-op */ }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  return {
    calls,
    restore: () => {
      canvasProto.getContext = originalGetContext;
      if (originalResizeObserver) vi.stubGlobal('ResizeObserver', originalResizeObserver);
      else vi.unstubAllGlobals();
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('线路 Canvas 渐进绘制与运行时投影索引', () => {
  it('先提交首帧，再分帧补齐导线，并复用共享端点投影', async () => {
    const stubs = installCanvasStubs();
    const container = document.createElement('div');
    container.getBoundingClientRect = () => ({
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    document.body.appendChild(container);
    let projectCalls = 0;
    const handle = renderLineMap(makeMapData(120), container, () => undefined, {
      projection: {
        project: () => {
          projectCalls += 1;
          return { x: 400, y: 300 };
        },
      },
    });

    // resize() 内的首帧同步完成，业务对象在后续 timer/RAF 批次绘制。
    expect(stubs.calls.clearRect).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(stubs.calls.stroke).toBeGreaterThan(0);
    // 120 条导线共用两个端点；同一帧内不应产生 240 次 project 调用。
    expect(projectCalls).toBeLessThan(40);
    handle.destroy();
    stubs.restore();
  });

  it('销毁地图后，迟到的渐进绘制不会继续写 Canvas', async () => {
    const stubs = installCanvasStubs();
    const container = document.createElement('div');
    container.getBoundingClientRect = () => ({ width: 800, height: 600 } as DOMRect);
    document.body.appendChild(container);
    const handle = renderLineMap(makeMapData(300), container, () => undefined);
    const strokesBeforeDestroy = stubs.calls.stroke || 0;
    handle.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stubs.calls.stroke || 0).toBe(strokesBeforeDestroy);
    stubs.restore();
  });

  it('MapLibre 连续视图变化时合并重绘，不会取消当前补绘流水线', async () => {
    const stubs = installCanvasStubs();
    const container = document.createElement('div');
    container.getBoundingClientRect = () => ({ width: 800, height: 600 } as DOMRect);
    document.body.appendChild(container);
    // 通过对象属性保存回调；TypeScript 不会把闭包稍后赋值的可变局部
    // 变量错误收窄成 never。
    const requestRedraw: { current: (() => void) | null } = { current: null };
    const handle = renderLineMap(makeMapData(600), container, () => undefined, {
      onRequestRedraw: (draw) => { requestRedraw.current = draw; },
    });

    // 模拟 MapLibre 在 fitBounds/拖拽过程中连续发出的 move/zoom/resize。
    // 旧实现会在每次回调里取消当前 pass，导致大线路一直停在塔位阶段；
    // 新实现应让当前 pass 完成，再合并成一次重绘。
    let completed = false;
    const deadline = Date.now() + 800;
    while (Date.now() < deadline) {
      const state = (globalThis as {
        __GIM_DEV_LINE_MAP_RENDER_STATE__?: { done?: boolean };
      }).__GIM_DEV_LINE_MAP_RENDER_STATE__;
      if (state?.done) {
        completed = true;
        break;
      }
      // 先捕获局部引用，避免 tsc 在闭包赋值的可变变量上把可选调用
      // 错误收窄为 never（运行时仍允许尚未注册回调）。
      const redraw = requestRedraw.current;
      if (redraw) redraw();
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
    expect(completed).toBe(true);
    // 每条导线至少产生一次 stroke；这个断言同时覆盖非 DEV 环境下的
    // 回退行为，并确保不是只完成了塔位首阶段。
    expect(stubs.calls.stroke || 0).toBeGreaterThanOrEqual(600);
    handle.destroy();
    stubs.restore();
  });
});
