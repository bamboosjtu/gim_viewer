// Run from any directory: node desktop/scripts/engineering/scan-review-bounds.cjs [s01]
// Produces source Z-up metre bounds from actual web-ifc geometry, independent of UI.
const fs = require('fs'), path = require('path');
process.chdir(path.resolve(__dirname, '../../..'));
const { IfcAPI } = require('../../node_modules/web-ifc/web-ifc-api-node.js');
const { createHash } = require('node:crypto');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const api = new IfcAPI();
(async () => { await api.Init(); const manifest = JSON.parse(fs.readFileSync('output/refactor-baseline/manifest.json')); for (const p of manifest.packages) {
    if (process.argv[2] && p.sample !== process.argv[2])
        continue;
    if (sha(fs.readFileSync(p.source.path)) !== p.source.sha256)
        throw Error('Source SHA mismatch');
    const root = `output/entity-normalization/source-v1/${p.sample}/source`, out = [];
    function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory())
            walk(f);
        else if (/\.ifc$/i.test(f))
            out.push(f);
    } }
    walk(root);
    const models = [];
    for (const f of out) {
        const model = api.OpenModel(new Uint8Array(fs.readFileSync(f)), { COORDINATE_TO_ORIGIN: false });
        const boxes = [], cache = new Map();
        api.StreamAllMeshes(model, flat => { const entity = api.GetLine(model, flat.expressID, false); let box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; for (let i = 0; i < flat.geometries.size(); i++) {
            const g = flat.geometries.get(i);
            let b = cache.get(g.geometryExpressID);
            if (!b) {
                b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
                const geom = api.GetGeometry(model, g.geometryExpressID);
                const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
                for (let j = 0; j < v.length; j += 6)
                    for (let k = 0; k < 3; k++) {
                        b[k] = Math.min(b[k], v[j + k]);
                        b[k + 3] = Math.max(b[k + 3], v[j + k]);
                    }
                geom.delete();
                cache.set(g.geometryExpressID, b);
            }
            const m = g.flatTransformation;
            for (let n = 0; n < 8; n++) {
                const x = b[n & 1 ? 3 : 0], y = b[n & 2 ? 4 : 1], z = b[n & 4 ? 5 : 2];
                const xyz = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
                for (let k = 0; k < 3; k++) {
                    box[k] = Math.min(box[k], xyz[k]);
                    box[k + 3] = Math.max(box[k + 3], xyz[k]);
                }
            }
        } if (box.every(Number.isFinite))
            boxes.push({ expressId: flat.expressID, type: api.GetNameFromTypeCode(entity.type), name: entity.Name?.value ?? '', bounds: [box[0], -box[5], box[1], box[3], -box[2], box[4]] }); });
        api.CloseModel(model);
        models.push({ path: path.relative(root, f).replaceAll('\\', '/'), sha256: sha(fs.readFileSync(f)), objects: boxes });
        console.log(p.sample, path.basename(f), boxes.length);
    }
    fs.writeFileSync(`output/${p.sample}-ifc-bounds.json`, JSON.stringify(models));
} })().catch(e => { console.error(e); process.exitCode = 1; });
