import * as OBC from '@thatopen/components';
import * as THREE from 'three';
import { freezeContainerLocalMatrix } from './staticContainer.js';

/** 3D 引擎上下文，统一导出供其他模块使用 */
export interface ViewerContext {
  components: OBC.Components;
  world: OBC.World;
  ifcLoader: OBC.IfcLoader;
  fragments: OBC.FragmentsManager;
}

/** 初始化 OBC 引擎并返回上下文 */
export function createViewerEngine(container: HTMLElement): ViewerContext {
  const components = new OBC.Components();
  const worlds = components.get(OBC.Worlds);
  const world = worlds.create();
  (world as any).scene = new OBC.SimpleScene(components);
  ((world as any).scene as OBC.SimpleScene).setup();
  // The scene is a fixed coordinate container. Re-composing its local identity
  // each frame otherwise forces all static DEV world matrices to be multiplied.
  freezeContainerLocalMatrix(world.scene.three);
  ((world as any).scene as any).three.background = new THREE.Color(0xeeeeee);
  world.renderer = new OBC.SimpleRenderer(components, container);
  // WebView2 keeps the previous line-map compositor layer behind a transparent
  // WebGL canvas. OBC's renderer defaults to alpha:true/clearAlpha:0, so after
  // switching from a line project to a substation project the old map can show
  // through the station canvas. Force an opaque clear and tag the canvas so
  // project cleanup preserves it.
  const threeRenderer = (world.renderer as unknown as { three?: THREE.WebGLRenderer }).three;
  if (threeRenderer) {
    threeRenderer.setClearColor(0xeeeeee, 1);
    threeRenderer.setClearAlpha(1);
    threeRenderer.domElement.dataset.gimRenderer = 'three';
  }
  world.camera = new OBC.OrthoPerspectiveCamera(components);
  components.init();
  components.get(OBC.Grids).create(world);

  const ifcLoader = components.get(OBC.IfcLoader);
  const fragments = components.get(OBC.FragmentsManager);

  // 诊断钩子：控制台/Playwright 可读取场景与 Fragments 所有权，
  // 不参与产品流程，也不暴露到任何外部网络接口。
  (window as any).__gimWorld = world;
  (window as any).__gimFragments = fragments;

  return { components, world, ifcLoader, fragments };
}
