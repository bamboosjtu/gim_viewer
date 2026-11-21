import type * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';
import { requestViewerRender } from './demandRendering.js';

export type GeometryTrack = 'dev' | 'ifc';

/** Observe a model draw submitted for the current viewport. No GPU fence,
 * readback, geometry compilation or wait for the whole station is involved.
 * Diagnostic tracks observe their own roots, independently of the product gate. */
export function observeModelPresentation(
  ctx: ViewerContext,
  isCurrent: () => boolean,
  onPresented: () => void,
  onTrackPresented?: (track: GeometryTrack) => void,
) {
  const renderer = ctx.world.renderer;
  const hooks = new Map<
    THREE.Object3D,
    {
      before: THREE.Object3D['onAfterRender'];
      wrapped: THREE.Object3D['onAfterRender'];
    }
  >();
  const roots = new Map<THREE.Object3D, { track?: GeometryTrack; product: boolean }>();
  const drawnTracks = new Set<GeometryTrack>(),
    completedTracks = new Set<GeometryTrack>();
  let drawn = false,
    presented = false,
    disposed = false,
    listening = false;
  const added = (event: { child: THREE.Object3D }) => hookTree(event.child);
  const removed = (event: { child: THREE.Object3D }) => event.child.traverse(detach);
  const drawnModel = (
    object: THREE.Object3D,
    ...[actual, scene, , geometry, material]: Parameters<THREE.Object3D['onAfterRender']>
  ) => {
    if (
      (!onTrackPresented && drawn) ||
      !isCurrent() ||
      actual !== renderer?.three ||
      scene !== ctx.world.scene.three ||
      !material.visible ||
      material.opacity === 0
    )
      return;
    const canvas = actual.domElement,
      rect = canvas.getBoundingClientRect();
    if (
      canvas.width <= 0 ||
      canvas.height <= 0 ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      document.visibilityState === 'hidden'
    )
      return;
    let attached = false,
      product = !onTrackPresented,
      track: GeometryTrack | undefined;
    for (let node: THREE.Object3D | null = object; node; node = node.parent) {
      if (!node.visible) return;
      if (node === scene) attached = true;
      if (onTrackPresented) {
        const root = roots.get(node);
        track ??= root?.track;
        product ||= root?.product === true;
      }
    }
    if (!attached) return;
    const count = geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0;
    if (
      count <= 0 ||
      geometry.drawRange.count <= 0 ||
      ((object as THREE.InstancedMesh).isInstancedMesh &&
        (object as THREE.InstancedMesh).count <= 0)
    )
      return;
    drawn ||= product;
    if (track && !completedTracks.has(track)) drawnTracks.add(track);
  };
  function hookTree(root: THREE.Object3D) {
    let registered = 0;
    root.traverse((object) => {
      if (hooks.has(object)) return;
      registered++;
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Wrap with the original receiver and restore the original hook on detach.
      const before = object.onAfterRender;
      const wrapped: THREE.Object3D['onAfterRender'] = function (this: THREE.Object3D, ...args) {
        before.apply(this, args);
        drawnModel(this, ...args);
      };
      hooks.set(object, { before, wrapped });
      object.onAfterRender = wrapped;
      object.addEventListener('childadded', added);
      object.addEventListener('childremoved', removed);
    });
    return registered;
  }
  function detach(object: THREE.Object3D) {
    const hook = hooks.get(object);
    if (!hook) return;
    if (object.onAfterRender === hook.wrapped) object.onAfterRender = hook.before;
    object.removeEventListener('childadded', added);
    object.removeEventListener('childremoved', removed);
    hooks.delete(object);
  }
  const before = () => {
    drawn = false;
    drawnTracks.clear();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const object of hooks.keys()) detach(object);
    roots.clear();
    stopListening();
    renderer?.onDisposed.remove(dispose);
  };
  function after() {
    if (!isCurrent()) {
      dispose();
      return;
    }
    if (!drawn && !drawnTracks.size) return;
    const first = drawn && !presented;
    if (first) presented = true;
    if (!onTrackPresented) {
      dispose();
      onPresented();
      return;
    }
    const newTracks = [...drawnTracks];
    for (const track of newTracks) completedTracks.add(track);
    if (presented && completedTracks.size === 2) dispose();
    else if (first || newTracks.length) {
      // Stop touching completed roots; retain only unfinished observations.
      for (const [root, watch] of roots) {
        if (!watch.product || presented) {
          if (!watch.track || completedTracks.has(watch.track)) roots.delete(root);
        }
      }
      for (const object of hooks.keys()) detach(object);
      for (const root of roots.keys()) hookTree(root);
      if (!roots.size) stopListening();
    }
    if (first) onPresented();
    for (const track of newTracks) if (isCurrent()) onTrackPresented(track);
  }
  function startListening() {
    if (listening) return;
    listening = true;
    renderer?.onBeforeUpdate.add(before);
    renderer?.onAfterUpdate.add(after);
  }
  function stopListening() {
    if (!listening) return;
    listening = false;
    before();
    renderer?.onBeforeUpdate.remove(before);
    renderer?.onAfterUpdate.remove(after);
  }
  renderer?.onDisposed.add(dispose);
  return {
    watch(root: THREE.Object3D, track?: GeometryTrack, product = true) {
      if (disposed || ((!product || presented) && (!track || completedTracks.has(track)))) return 0;
      const existing = roots.get(root);
      if (existing) {
        if (onTrackPresented && track) existing.track ??= track;
        if (product && !existing.product) {
          existing.product = true;
          if (!presented) requestViewerRender(ctx);
        }
        return 0;
      }
      roots.set(root, { track: onTrackPresented ? track : undefined, product });
      const registered = hookTree(root);
      startListening();
      // Measurement (early or late) must not cause an additional frame.
      if (product && !presented) requestViewerRender(ctx);
      return registered;
    },
    dispose,
  };
}
