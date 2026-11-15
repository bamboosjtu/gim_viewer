/* Probe the source-frame bounds of all IFC files.
 *
 * web-ifc output is Y-up; convert each world vertex with the same inverse
 * rotation used by export_ifc.cjs, then report a Z-up source-frame bbox.
 */
const fs = require('fs');
const path = require('path');
const { IfcAPI } = require('web-ifc');

const ROOT = path.resolve(__dirname, '..');
const EXTRACT = process.env.GIM_BLENDER_EXTRACT || path.join(ROOT, 'extracted');
const { archiveEntries } = require('./archive_entries.cjs');
const BUILD = process.env.GIM_BLENDER_BUILD || path.join(ROOT, 'build');

function toBlender(x, y, z) {
  return [x, -z, y];
}

(async () => {
  fs.mkdirSync(BUILD, { recursive: true });
  const api = new IfcAPI();
  api.SetWasmPath(path.join(__dirname, 'node_modules/web-ifc') + path.sep, true);
  await api.Init(undefined, true);
  const entries = archiveEntries(EXTRACT);
  const files = entries.filter(e => /\.ifc$/i.test(e.path));
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const perFile = [];
  for (const entry of files) {
    const file = entry.path;
    const modelID = api.OpenModel(new Uint8Array(fs.readFileSync(entry.fullPath)), { COORDINATE_TO_ORIGIN: false });
    const flo = [Infinity, Infinity, Infinity];
    const fhi = [-Infinity, -Infinity, -Infinity];
    api.StreamAllMeshes(modelID, (fm) => {
      if (!fm || !fm.geometries) return;
      for (let g = 0; g < fm.geometries.size(); g++) {
        const placed = fm.geometries.get(g);
        const geo = api.GetGeometry(modelID, placed.geometryExpressID);
        const verts = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
        const m = placed.flatTransformation;
        for (let j = 0; j < verts.length; j += 6) {
          const x = verts[j], y = verts[j + 1], z = verts[j + 2];
          const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
          const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
          const [bx, by, bz] = toBlender(wx, wy, wz);
          if (bx < lo[0]) lo[0] = bx; if (by < lo[1]) lo[1] = by; if (bz < lo[2]) lo[2] = bz;
          if (bx > hi[0]) hi[0] = bx; if (by > hi[1]) hi[1] = by; if (bz > hi[2]) hi[2] = bz;
          if (bx < flo[0]) flo[0] = bx; if (by < flo[1]) flo[1] = by; if (bz < flo[2]) flo[2] = bz;
          if (bx > fhi[0]) fhi[0] = bx; if (by > fhi[1]) fhi[1] = by; if (bz > fhi[2]) fhi[2] = bz;
        }
        geo.delete?.();
      }
    });
    perFile.push({ file, bounds: [...flo, ...fhi] });
    api.CloseModel(modelID);
    console.log(file, 'bounds', flo.map(v => +v.toFixed(2)), fhi.map(v => +v.toFixed(2)));
  }
  const hasBounds = files.length > 0 && Number.isFinite(lo[0]) && Number.isFinite(hi[0]);
  const out = { version: 1, coordinateSystem: 'source-z-up-metres-v2',
    bounds: hasBounds ? [...lo, ...hi] : null, files: perFile, discoveredIfcFiles: files.length, indexedEntries: entries.length };
  fs.writeFileSync(path.join(BUILD, 'ifc_bounds.json'), JSON.stringify(out, null, 2));
  console.log('wrote ifc_bounds.json', out.bounds);
  api.Dispose();
})().catch(e => { console.error(e); process.exit(1); });
