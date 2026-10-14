import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
const require = createRequire(import.meta.url), W = require('web-ifc');
const [source, output, policy = 'full'] = process.argv.slice(2);
if (!source || !output) throw Error('source.ifc output-directory [full|omit-rel-voids]');
const helper = readFileSync(new URL('../../src/viewer/ifcOpeningPolicy.ts', import.meta.url), 'utf8');
const { omitIfcOpeningRelations } = await import('data:text/javascript;base64,' + Buffer.from(transformSync(helper, { loader: 'ts', format: 'esm' }).code).toString('base64'));
mkdirSync(output, { recursive: true });
const bytes = readFileSync(source), sha256 = createHash('sha256').update(bytes).digest('hex');
const started = performance.now();
const removed = policy === 'omit-rel-voids' ? omitIfcOpeningRelations(bytes) : 0;
const preparationMs = performance.now() - started;
const api = new W.IfcAPI(); await api.Init(undefined, true);
const openStart = performance.now(), model = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
const openMs = performance.now() - openStart;
console.log(JSON.stringify({ policy, phase: 'opened', openMs, preparationMs, removed }));
const file = openSync(resolve(output, policy + '.bin'), 'w'), geometries = [], placements = [], seen = new Map();
let offset = 0, triangles = 0, lastProgress = performance.now();
const streamStart = performance.now();
api.StreamAllMeshes(model, mesh => {
  const entity = api.GetLine(model, mesh.expressID, false);
  for (let i = 0; i < mesh.geometries.size(); i++) {
    const placed = mesh.geometries.get(i), id = placed.geometryExpressID;
    let index = seen.get(id);
    if (index === undefined) {
      const geometry = api.GetGeometry(model, id);
      const vertices = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
      const indices = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
      index = geometries.length; seen.set(id, index);
      geometries.push({ vertexOffset: offset, vertexLength: vertices.length, indexOffset: offset + vertices.byteLength, indexLength: indices.length });
      writeSync(file, Buffer.from(vertices.buffer, vertices.byteOffset, vertices.byteLength));
      writeSync(file, Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
      offset += vertices.byteLength + indices.byteLength;
      geometry.delete();
    }
    triangles += geometries[index].indexLength / 3;
    placements.push({ expressId: mesh.expressID, globalId: entity.GlobalId?.value ?? null, type: api.GetNameFromTypeCode(entity.type), geometry: index,
      matrix: [...placed.flatTransformation], color: [placed.color.x, placed.color.y, placed.color.z, placed.color.w] });
  }
  mesh.geometries.delete?.();
  if (performance.now() - lastProgress > 30000) { console.log(JSON.stringify({ policy, phase: 'geometry', products: placements.length, elapsedMs: performance.now() - streamStart })); lastProgress = performance.now(); }
});
closeSync(file);
const result = { policy, sha256, sourceBytes: bytes.byteLength, preparationMs, openMs, streamMs: performance.now() - streamStart,
  removedRelations: removed, webIfcVersion: '0.0.78', triangles, geometries, placements, binaryBytes: offset, rss: process.memoryUsage().rss };
api.CloseModel(model); api.Dispose();
writeFileSync(resolve(output, policy + '.json'), JSON.stringify(result));
console.log(JSON.stringify({ ...result, geometries: geometries.length, placements: placements.length }));
