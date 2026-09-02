import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GimGraphNode } from '../../gim/gimGraphTypes.js';
import type { LineMapData } from '../../gim/lineMapData.js';
import { renderLineMap, type LineMapRenderPhase } from '../lineMapView.js';
import { perfSnapshot } from '../../utils/perfTimings.js';

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

/** 用手动 RAF 让相机竞态测试不依赖 jsdom 的 16ms 调度。 */
function installRafQueue(): {
  pending(): number;
  runNext(): boolean;
  runAll(max?: number): number;
  restore(): void;
} {
  const originalRaf = window.requestAnimationFrame;
  const originalCancel = window.cancelAnimationFrame;
  let nextId = 1;
  const queue = new Map<number, FrameRequestCallback>();
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback): number => {
      const id = nextId++;
      queue.set(id, callback);
      return id;
    },
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: (id: number): void => { queue.delete(id); },
  });
  const runNext = (): boolean => {
    const item = queue.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!item) return false;
    queue.delete(item[0]);
    item[1](performance.now());
    return true;
  };
  return {
    pending: () => queue.size,
    runNext,
    runAll: (max = 1000) => {
      let count = 0;
      while (count < max && runNext()) count += 1;
      return count;
    },
    restore: () => {
      Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: originalRaf });
      Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: originalCancel });
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

  it('camera A→B→C 时交互帧只使用当前 revision 的投影缓存', () => {
    const stubs = installCanvasStubs();
    const raf = installRafQueue();
    const container = document.createElement('div');
    container.getBoundingClientRect = () => ({ width: 800, height: 600 } as DOMRect);
    document.body.appendChild(container);
    const requestRedraw: { current: ((phase?: LineMapRenderPhase) => void) | null } = { current: null };
    let camera = 'A';
    const projectCameras: string[] = [];
    const handle = renderLineMap(makeMapData(600), container, () => undefined, {
      onRequestRedraw: (draw) => { requestRedraw.current = draw; },
      projection: {
        project: () => {
          projectCameras.push(camera);
          const x = camera === 'A' ? 100 : camera === 'B' ? 200 : 300;
          return { x, y: 300 };
        },
      },
    });

    const redraw = requestRedraw.current;
    expect(redraw).toBeTypeOf('function');
    // 初始 progressive 尚未执行时连续切换相机；旧 RAF 必须被取消，
    // 第一个真正执行的 interaction frame 只能读取 C 的 project 结果。
    camera = 'B';
    redraw?.('interactive');
    camera = 'C';
    redraw?.('interactive');
    expect(raf.runNext()).toBe(true);
    expect(projectCameras.length).toBeGreaterThan(0);
    expect(projectCameras.every((value) => value === 'C')).toBe(true);
    expect(projectCameras).not.toContain('A');

    // 相机稳定后启动完整 settled progressive；全过程仍使用 C revision。
    redraw?.('settled');
    raf.runAll();
    expect(projectCameras.every((value) => value === 'C')).toBe(true);
    expect(stubs.calls.stroke || 0).toBeGreaterThanOrEqual(600);
    handle.destroy();
    raf.restore();
    stubs.restore();
  });

  it('连续 pan/zoom 产生交互帧，停止后 settled progressive 最终完成', () => {
    const stubs = installCanvasStubs();
    const raf = installRafQueue();
    const container = document.createElement('div');
    container.getBoundingClientRect = () => ({ width: 800, height: 600 } as DOMRect);
    document.body.appendChild(container);
    const requestRedraw: { current: ((phase?: LineMapRenderPhase) => void) | null } = { current: null };
    const handle = renderLineMap(makeMapData(600), container, () => undefined, {
      onRequestRedraw: (draw) => { requestRedraw.current = draw; },
      projection: { project: () => ({ x: 400, y: 300 }) },
    });
    const redraw = requestRedraw.current;

    // 先让一轮完整绘制开始，再模拟未完成时的连续相机变化。
    expect(raf.runNext()).toBe(true);
    const before = perfSnapshot().spans.filter((span) => span.label === '线路 Canvas 交互帧').length;
    redraw?.('settled');
    redraw?.('interactive');
    expect(raf.runNext()).toBe(true);
    redraw?.('interactive');
    expect(raf.runNext()).toBe(true);
    redraw?.('interactive');
    expect(raf.runNext()).toBe(true);
    const afterInteractive = perfSnapshot().spans.filter((span) => span.label === '线路 Canvas 交互帧').length;
    expect(afterInteractive - before).toBeGreaterThanOrEqual(3);

    // 停止操作后只启动一次 settled pass；不得重新退化为只完成塔位。
    redraw?.('settled');
    raf.runAll();
    const state = (globalThis as {
      __GIM_DEV_LINE_MAP_RENDER_STATE__?: { done?: boolean };
    }).__GIM_DEV_LINE_MAP_RENDER_STATE__;
    expect(state?.done).toBe(true);
    expect(stubs.calls.stroke || 0).toBeGreaterThanOrEqual(600);
    handle.destroy();
    raf.restore();
    stubs.restore();
  });

  it('settled 补绘期间的 hover/选中不会让 overlay 永久停在简化层', () => {
    const stubs = installCanvasStubs();
    const raf = installRafQueue();
    const container = document.createElement('div');
    container.getBoundingClientRect = () => ({ width: 800, height: 600 } as DOMRect);
    document.body.appendChild(container);
    const handle = renderLineMap(makeMapData(600), container, () => undefined, {
      projection: { project: () => ({ x: 220, y: 240 }) },
    });

    // 初始 settled pass 进入进行中状态；随后悬停会取消当前 pass 并先
    // 刷新交互层，之后必须自动排队新的 settled pass。
    expect(raf.runNext()).toBe(true);
    handle.handlePointerMove?.(220, 240);
    raf.runAll();
    const state = (globalThis as {
      __GIM_DEV_LINE_MAP_RENDER_STATE__?: { done?: boolean };
    }).__GIM_DEV_LINE_MAP_RENDER_STATE__;
    expect(state?.done).toBe(true);
    expect(stubs.calls.stroke || 0).toBeGreaterThanOrEqual(600);

    handle.destroy();
    raf.restore();
    stubs.restore();
  });

  it('相机切换后 hover/click 使用当前屏幕位置，销毁后迟到 RAF 不写 Canvas', () => {
    const stubs = installCanvasStubs();
    const raf = installRafQueue();
    const container = document.createElement('div');
    container.getBoundingClientRect = () => ({ width: 800, height: 600 } as DOMRect);
    document.body.appendChild(container);
    const requestRedraw: { current: ((phase?: LineMapRenderPhase) => void) | null } = { current: null };
    let camera = 'B';
    // 通过对象属性保存回调结果，避免 TypeScript 将闭包赋值的可变局部
    // 错误收窄为 never。
    const clicked: { current: GimGraphNode | null } = { current: null };
    const handle = renderLineMap(makeMapData(12), container, (nodeRef) => { clicked.current = nodeRef; }, {
      onRequestRedraw: (draw) => { requestRedraw.current = draw; },
      projection: {
        project: (_lng, lat) => camera === 'B'
          ? { x: 220, y: 240 }
          : lat < 30.005 ? { x: 620, y: 440 } : { x: 100, y: 100 },
      },
    });
    const redraw = requestRedraw.current;
    redraw?.('interactive');
    expect(raf.runNext()).toBe(true);
    camera = 'C';
    redraw?.('interactive');
    // 在新的 interaction RAF 执行前立即点击，也必须使用 C 相机投影，
    // 不能回退到上一帧的 towerScreen 快照。
    handle.handlePointerMove?.(620, 440);
    handle.handlePointerClick?.(620, 440);
    expect(clicked.current?.path).toBe('Cbm/N001.cbm');
    expect(raf.runNext()).toBe(true);

    const clearBeforeDestroy = stubs.calls.clearRect || 0;
    camera = 'C';
    redraw?.('interactive');
    handle.destroy();
    raf.runAll();
    expect(stubs.calls.clearRect || 0).toBe(clearBeforeDestroy);
    raf.restore();
    stubs.restore();
  });
});
