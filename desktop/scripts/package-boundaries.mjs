export function packageBoundaryError(specifier,dependencies) {
  if(specifier.startsWith('.')&&/(?:^|\/)packages\//.test(specifier))return 'shared packages must use declared package exports';
  if(!specifier.startsWith('@gim/'))return null;
  const name=specifier.split('/').slice(0,2).join('/');
  if(!Object.hasOwn(dependencies,name))return `undeclared shared package ${name}`;
  if(specifier.split('/').some(part=>['..','src','__tests__'].includes(part)))return 'shared package private path bypasses its public exports';
  return null;
}

export function dependencyCycles(graph) {
  const active = new Set(), visited = new Set(), cycles = [];
  function visit(path) {
    if (active.has(path)) {
      const trail = [...active];
      cycles.push([...trail.slice(trail.indexOf(path)), path]);
      return;
    }
    if (visited.has(path)) return;
    visited.add(path);
    active.add(path);
    for (const target of graph.get(path)) visit(target);
    active.delete(path);
  }
  for (const path of graph.keys()) visit(path);
  return cycles;
}
