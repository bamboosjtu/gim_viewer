import * as OBC from '@thatopen/components';
import * as THREE from 'three';

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
  ((world as any).scene as any).three.background = new THREE.Color(0xeeeeee);
  world.renderer = new OBC.SimpleRenderer(components, container);
  world.camera = new OBC.OrthoPerspectiveCamera(components);
  components.init();
  components.get(OBC.Grids).create(world);

  const ifcLoader = components.get(OBC.IfcLoader);
  const fragments = components.get(OBC.FragmentsManager);

  return { components, world, ifcLoader, fragments };
}
