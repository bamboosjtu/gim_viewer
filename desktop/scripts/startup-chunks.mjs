const heavyPackage = /(?:^|\/)node_modules\/(three|web-ifc|maplibre-gl)(?:\/|$)/;

/** Check the emitted static graph, including dependencies hoisted by manualChunks. */
export function startupChunkViolations(bundle) {
  const violations = [];
  const visited = new Set();

  function visit(chunk, parents) {
    if (visited.has(chunk.fileName)) return;
    visited.add(chunk.fileName);
    const path = [...parents, chunk.fileName];
    const packages = new Set(chunk.moduleIds.flatMap((id) => {
      const match = heavyPackage.exec(id.replaceAll('\\', '/'));
      return match ? [match[1]] : [];
    }));
    if (packages.size) violations.push(`${path.join(' → ')} (${[...packages].join(', ')})`);

    for (const name of chunk.imports) {
      const dependency = bundle[name];
      if (dependency?.type === 'chunk') visit(dependency, path);
    }
  }

  for (const output of Object.values(bundle)) {
    if (output.type === 'chunk' && output.isEntry) visit(output, []);
  }
  return violations;
}
