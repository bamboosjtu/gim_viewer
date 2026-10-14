// Bounded research probe. Never writes a modified IFC or production cache.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const [source, output, mode] = process.argv.slice(2);
if (!source || !output) throw new Error('Usage: node ifc-opening-cost.mjs source.ifc output.json');
if (!mode) {
  const runs = [];
  for (const variant of ['original', 'no-rel-voids']) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), resolve(source), resolve(output), variant],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const result = child.stdout.split('\n').find(line => line.startsWith('RESULT '));
    runs.push(result ? JSON.parse(result.slice(7)) : { variant, status: child.error?.code === 'ETIMEDOUT' ? 'timeout' : 'failed', error: child.error?.message ?? child.stderr.slice(-1500) });
    console.log(JSON.stringify(runs.at(-1)));
  }
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, JSON.stringify({ scope: 'Node web-ifc geometry only; no Fragments/UI; one run per variant', timeoutMs: null, runs }, null, 2));
} else {
  const W = require('web-ifc');
  const bytes = readFileSync(source);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let input = bytes, removed = 0;
  const prepare = performance.now();
  if (mode === 'no-rel-voids') {
    input = Buffer.from(bytes.toString('utf8').replace(/^\s*#\d+\s*=\s*IFCRELVOIDSELEMENT\s*\([\s\S]*?\);/gmi, () => { removed++; return ''; }));
  }
  const preparationMs = performance.now() - prepare;
  const api = new W.IfcAPI();
  await api.Init(undefined, true);
  const start = performance.now();
  const model = api.OpenModel(input, { COORDINATE_TO_ORIGIN: false });
  const openMs = performance.now() - start;
  const products = new Set(), geometries = new Set();
  let placements = 0, triangles = 0;
  const geometryStart = performance.now();
  api.StreamAllMeshes(model, mesh => {
    products.add(mesh.expressID);
    for (let i = 0; i < mesh.geometries.size(); i++) {
      const placed = mesh.geometries.get(i); placements++;
      // Count rendered occurrence triangles, and unique IDs separately.
      const geometry = api.GetGeometry(model, placed.geometryExpressID);
      triangles += geometry.GetIndexDataSize() / 3;
      geometries.add(placed.geometryExpressID);
      geometry.delete();
    }
  });
  const geometryMs = performance.now() - geometryStart;
  const result = { variant: mode, status: 'complete', sha256, sourceBytes: bytes.length, inputBytes: input.length,
    webIfcVersion: '0.0.78', removedRelations: removed, preparationMs, openMs, geometryMs,
    products: products.size, placements, uniqueGeometries: geometries.size, occurrenceTriangles: triangles,
    rssBytes: process.memoryUsage().rss };
  api.CloseModel(model); api.Dispose();
  console.log('RESULT ' + JSON.stringify(result));
}
