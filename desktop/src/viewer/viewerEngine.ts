import { logger } from '../utils/logger.js';
import * as OBC from '@thatopen/components';
import * as THREE from 'three';
import { freezeContainerLocalMatrix } from './staticContainer.js';
import { observeRenderer } from './renderMeasurement.js';
import { installDemandRendering } from './demandRendering.js';

/** 3D 引擎上下文，统一导出供其他模块使用 */
export interface ViewerContext {
  components: OBC.Components;
  world: OBC.World;
  ifcLoader: OBC.IfcLoader;
  fragments: OBC.FragmentsManager;
}

/** 初始化 OBC 引擎并返回上下文 */
export async function createViewerEngine(container: HTMLElement): Promise<ViewerContext> {
  const components = new OBC.Components();
  try {
    const worlds = components.get(OBC.Worlds);
    const world = worlds.create<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>();
    world.scene = new OBC.SimpleScene(components);
    world.scene.setup();
    // The scene is a fixed coordinate container. Re-composing its local identity
    // each frame otherwise forces all static DEV world matrices to be multiplied.
    freezeContainerLocalMatrix(world.scene.three);
    world.scene.three.background = new THREE.Color(0xe9eef3);
    const renderer = new OBC.SimpleRenderer(components, container);
    world.renderer = renderer;
    observeRenderer(renderer);
    // WebView2 keeps the previous line-map compositor layer behind a transparent
    // WebGL canvas. OBC's renderer defaults to alpha:true/clearAlpha:0, so after
    // switching from a line project to a substation project the old map can show
    // through the station canvas. Force an opaque clear and tag the canvas so
    // project cleanup preserves it.
    const threeRenderer = (world.renderer as unknown as { three?: THREE.WebGLRenderer }).three;
    if (threeRenderer) {
      threeRenderer.setClearColor(0xe9eef3, 1);
      threeRenderer.setClearAlpha(1);
      threeRenderer.domElement.dataset.gimRenderer = 'three';
    }
    world.camera = new OBC.OrthoPerspectiveCamera(components);
    components.init();
    const grid = components.get(OBC.Grids).create(world);
    // Treat the reference plane as a backdrop even where the engineering model lies below Y=0.
    // Three draws the opaque queue first. Explicit alpha blending keeps the grid's distance fade.
    grid.three.renderOrder = Number.MIN_SAFE_INTEGER;
    grid.material.transparent = false;
    grid.material.blending = THREE.CustomBlending;
    grid.material.blendSrc = THREE.SrcAlphaFactor;
    grid.material.blendDst = THREE.OneMinusSrcAlphaFactor;
    grid.material.blendSrcAlpha = THREE.OneFactor;
    grid.material.depthWrite = false;

    const ifcLoader = components.get(OBC.IfcLoader);
    const fragments = components.get(OBC.FragmentsManager);
    renderer.mode = OBC.RendererMode.MANUAL;
    installDemandRendering({ components, world, ifcLoader, fragments }, renderer);

    // 诊断钩子：控制台/Playwright 可读取场景与 Fragments 所有权，
    // 不参与产品流程，也不暴露到任何外部网络接口。
    Object.assign(window, { __gimWorld: world, __gimFragments: fragments });

    return { components, world, ifcLoader, fragments };
  } catch (error) {
    try {
      await Promise.resolve(components.dispose());
    } catch (cleanupError) {
      logger.warn('[Viewer initialization cleanup]', cleanupError);
    }
    throw error;
  }
}
