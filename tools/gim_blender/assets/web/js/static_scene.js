// Imported geometry is immutable; only the explicitly named door roots move.
// Keep its world matrices instead of recomposing the whole model on every frame.
export function prepareStaticModel(root, nodes, movingRoots, onRootChanged = () => {}) {
  root.updateMatrixWorld(true);
  const original = root.updateMatrixWorld;
  const auto = nodes.map(node => node.matrixAutoUpdate);
  for (const node of nodes) node.matrixAutoUpdate = false;
  for (const node of movingRoots) node.matrixAutoUpdate = true;
  const local = root.matrix.clone();
  let parent = root.parent;
  const parentMatrix = parent?.matrixWorld.clone() || root.matrixWorld.clone().identity();
  const moving = movingRoots.map(node => ({node, matrix:node.matrix.clone()}));
  root.updateMatrixWorld = function () {
    root.updateMatrix();
    const changed = root.parent !== parent || !root.matrix.equals(local) ||
      (root.parent && !root.parent.matrixWorld.equals(parentMatrix));
    if (changed) {
      original.call(root, true);
      local.copy(root.matrix);
      parent = root.parent;
      if (parent) parentMatrix.copy(parent.matrixWorld); else parentMatrix.identity();
      for (const item of moving) item.matrix.copy(item.node.matrix);
      onRootChanged();
      return;
    }
    root.matrixWorldNeedsUpdate = false;
    for (const item of moving) {
      item.node.updateMatrix();
      if (!item.node.matrix.equals(item.matrix)) {
        item.node.updateMatrixWorld(true);
        item.matrix.copy(item.node.matrix);
      } else item.node.matrixWorldNeedsUpdate = false;
    }
  };
  return {
    dispose() {
      root.updateMatrixWorld = original;
      nodes.forEach((node,index) => { node.matrixAutoUpdate = auto[index]; });
    },
  };
}
