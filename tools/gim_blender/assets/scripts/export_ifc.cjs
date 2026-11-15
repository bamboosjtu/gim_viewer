/* Export substation01 IFC civil/site/equipment geometry, doors and navigation data.
 *
 * All output coordinates are Blender Z-up metres:
 *   bx = webIfc.x, by = -webIfc.z, bz = webIfc.y
 * web-ifc already rotates IFC Z-up into Y-up: (x,y,z) -> (x,z,-y).
 * Undo that rotation to share the GIM source frame; swapping Y/Z alone
 * reflects the civil geometry relative to the equipment.
 *
 * Writes:
 *   build/ifc_scene.bin
 *   build/ifc_scene.json
 *   build/nav.json
 */
const fs = require('fs');
const path = require('path');
const { IfcAPI } = require('web-ifc');

const ROOT = path.resolve(__dirname, '..');
const EXTRACT = process.env.GIM_BLENDER_EXTRACT || path.join(ROOT, 'extracted');
const { archiveEntries } = require('./archive_entries.cjs');
const { createHash } = require('node:crypto');
const { navigationRole } = require('./ifc_navigation_roles.cjs');
const { splitCompositeDoors } = require('./ifc_composite_doors.cjs');
const BUILD = process.env.GIM_BLENDER_BUILD || path.join(ROOT, 'build');
const BIN = path.join(BUILD, 'ifc_scene.bin');

// Navigation bounds in Blender plan coordinates (metres). The pipeline can
// override this after probing the actual IFC/GIM extents.
const NAV = { x0: -40, y0: -80, x1: 100, y1: 60, res: 0.2 };
if (process.env.GIM_BLENDER_NAV_BOUNDS) {
  const p = process.env.GIM_BLENDER_NAV_BOUNDS.split(',').map(Number);
  if (p.length === 4 && p.every(Number.isFinite) && p[2] > p[0] && p[3] > p[1]) {
    NAV.x0 = p[0]; NAV.y0 = p[1]; NAV.x1 = p[2]; NAV.y1 = p[3];
  }
}
NAV.w = Math.ceil((NAV.x1 - NAV.x0) / NAV.res);
NAV.h = Math.ceil((NAV.y1 - NAV.y0) / NAV.res);

const CATEGORY = {
  '建筑部分0317.ifc': '建筑',
  '警卫室建筑0317.ifc': '建筑',
  '结构0317.ifc': '结构',
  '基础0317.ifc': '结构',
  '总图0317.ifc': '总图',
  '一次设备0402其他.ifc': '一次设备',
  '接地0317其他.ifc': '接地',
  '电气二次0317其他.ifc': '电气二次',
  '动力照明0317.ifc': '动力照明',
  '暖通布置0317.ifc': '暖通',
  '给排水消防及排油添加主变水喷淋0401.ifc': '给排水',
  '室内给排水0317.ifc': '给排水',
};

function classifyIfc(file) {
  file = path.basename(file);
  if (CATEGORY[file]) return CATEGORY[file];
  const n = file.toLowerCase();
  if (/总图|总平面|场坪|道路|site|masterplan/.test(n)) return '总图';
  if (/建筑|警卫|警传|门卫|building|architecture/.test(n)) return '建筑';
  if (/结构|基础|structure|foundation/.test(n)) return '结构';
  if (/给排水|消防|plumbing|drainage|water/.test(n)) return '给排水';
  if (/暖通|通风|空调|hvac/.test(n)) return '暖通';
  if (/接地|防雷|grounding/.test(n)) return '接地';
  if (/动力|照明|电气|二次|electrical|lighting/.test(n)) return '电气二次';
  if (/一次设备|primary/.test(n)) return '一次设备';
  return 'IFC';
}

const DEFAULT_COLOR = [180, 180, 178, 255];
const EPS = 1e-9;
// Optional exclusions, e.g. GIM_BLENDER_EXCLUDED_IDS='{"file.ifc":[123,456]}'.
const EXCLUDED_IDS = {}; // Only explicit, source-specific user exclusions.
if (process.env.GIM_BLENDER_EXCLUDED_IDS) {
  try {
    const extra = JSON.parse(process.env.GIM_BLENDER_EXCLUDED_IDS);
    for (const [file, ids] of Object.entries(extra)) {
      const set = EXCLUDED_IDS[file] || new Set();
      for (const id of ids || []) set.add(Number(id));
      EXCLUDED_IDS[file] = set;
    }
  } catch (e) {
    console.warn('invalid GIM_BLENDER_EXCLUDED_IDS', e.message);
  }
}
const GATE_NAME = process.env.GIM_BLENDER_GATE_NAME || '平开大门';

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function toBlender(x, y, z) {
  return [x, -z, y];
}

function makeMatrix(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function normalMatrix(m) {
  // Inverse-transpose of the 3x3 linear part; good enough for IFC placements.
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const D = c * h - b * i, E = a * i - c * g, F = b * g - a * h;
  const G = b * f - c * e, H = c * d - a * f, I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const invDet = 1 / det;
  // Cofactor matrix = inverse-transpose. Store it column-major, matching
  // the multiplication in the vertex loop (0/3/6, 1/4/7, 2/5/8).
  return [A * invDet, D * invDet, G * invDet, B * invDet, E * invDet, H * invDet, C * invDet, F * invDet, I * invDet];
}

function colorKey(color) {
  return color.join(',');
}

function lineColor(placed, fallback = DEFAULT_COLOR) {
  const c = placed.color;
  if (!c || c.x === undefined) return fallback.slice();
  let r = Math.max(0, Math.min(255, Math.round(c.x * 255)));
  let g = Math.max(0, Math.min(255, Math.round(c.y * 255)));
  let b = Math.max(0, Math.min(255, Math.round(c.z * 255)));
  let a = c.w === undefined ? 255 : Math.round(c.w * 255);
  if (c.max !== undefined) { /* older API */ }
  if (r === 0 && g === 0 && b === 0 && a === 0) return fallback.slice();
  if (a <= 0) a = 255;
  return [r, g, b, a];
}

class ChunkBuilder {
  constructor(meta) {
    this.meta = meta;
    this.positions = [];
    this.normals = [];
    this.indices = [];
    this.bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    this.baseVertex = 0;
  }
  add(pos, nor, idx) {
    for (let i = 0; i < pos.length; i += 3) {
      this.positions.push(pos[i], pos[i + 1], pos[i + 2]);
      this.normals.push(nor[i], nor[i + 1], nor[i + 2]);
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      if (x < this.bbox[0]) this.bbox[0] = x;
      if (y < this.bbox[1]) this.bbox[1] = y;
      if (z < this.bbox[2]) this.bbox[2] = z;
      if (x > this.bbox[3]) this.bbox[3] = x;
      if (y > this.bbox[4]) this.bbox[4] = y;
      if (z > this.bbox[5]) this.bbox[5] = z;
    }
    for (const i of idx) this.indices.push(this.baseVertex + i);
    this.baseVertex += pos.length / 3;
  }
}

class NavGrid {
  constructor() {
    this.col = new Uint8Array(NAV.w * NAV.h);
    this.floorLayers = new Array(NAV.w * NAV.h);
    this.obstaclePositions = [];
    this.obstacleObjects = [];
  }
  index(ix, iy) {
    if (ix < 0 || iy < 0 || ix >= NAV.w || iy >= NAV.h) return -1;
    return iy * NAV.w + ix;
  }
  cellOf(x, y) {
    return [Math.floor((x - NAV.x0) / NAV.res), Math.floor((y - NAV.y0) / NAV.res)];
  }
  addFloorIndex(idx, z) {
    if (idx < 0) return;
    const cm = Math.round(z * 100);
    if (cm < -32760 || cm > 32760) return;
    let layers = this.floorLayers[idx];
    if (!layers) this.floorLayers[idx] = layers = [];
    if (layers.some(v => Math.abs(v - cm) <= 1)) return;
    layers.push(cm);
    layers.sort((a, b) => a - b);
  }
  addObstacles(geoms, source) {
    const firstTriangle = this.obstaclePositions.length / 9;
    for (const g of geoms) for (const index of g.idx) {
      this.obstaclePositions.push(g.pos[index * 3], g.pos[index * 3 + 1], g.pos[index * 3 + 2]);
    }
    const triangleCount = this.obstaclePositions.length / 9 - firstTriangle;
    if (triangleCount) this.obstacleObjects.push({ ...source, firstTriangle, triangleCount });
  }
  encodeObstacles() {
    const data = new Float32Array(this.obstaclePositions);
    return { type: 'triangles-f32', values: Buffer.from(data.buffer).toString('base64'),
      triangles: data.length / 9, objects: this.obstacleObjects };
  }
  addFloorPoint(x, y, z) {
    const [ix, iy] = this.cellOf(x, y);
    this.addFloorIndex(this.index(ix, iy), z);
  }
  markCollisionPoint(x, y) {
    const [ix, iy] = this.cellOf(x, y);
    const idx = this.index(ix, iy);
    if (idx >= 0) this.col[idx] = 1;
  }
  markCollisionSegment(ax, ay, bx, by, radius = 0.08) {
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(len / (NAV.res * 0.5)));
    const cellR = Math.max(1, Math.round(radius / NAV.res));
    for (let i = 0; i <= steps; i++) {
      const x = ax + (bx - ax) * i / steps;
      const y = ay + (by - ay) * i / steps;
      const [cx, cy] = this.cellOf(x, y);
      for (let dy = -cellR; dy <= cellR; dy++) for (let dx = -cellR; dx <= cellR; dx++) {
        if (dx * dx + dy * dy > cellR * cellR + 0.25) continue;
        const idx = this.index(cx + dx, cy + dy);
        if (idx >= 0) this.col[idx] = 1;
      }
    }
  }
  addFloorTriangle(a, b, c) {
    // a,b,c are Blender [x,y,z].
    if (Math.abs(a[2] - b[2]) < 1e-5 && Math.abs(a[2] - c[2]) < 1e-5) {
      this.addFloorFlat(a, b, c);
      return;
    }
    // Sloped triangles: sample per cell using barycentric interpolation.
    const minX = Math.min(a[0], b[0], c[0]) - NAV.res, maxX = Math.max(a[0], b[0], c[0]) + NAV.res;
    const minY = Math.min(a[1], b[1], c[1]) - NAV.res, maxY = Math.max(a[1], b[1], c[1]) + NAV.res;
    const [ix0, iy0] = this.cellOf(minX, minY);
    const [ix1, iy1] = this.cellOf(maxX, maxY);
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-10) return;
    for (let iy = Math.max(0, iy0); iy <= Math.min(NAV.h - 1, iy1); iy++) {
      for (let ix = Math.max(0, ix0); ix <= Math.min(NAV.w - 1, ix1); ix++) {
        const x = NAV.x0 + (ix + 0.5) * NAV.res;
        const y = NAV.y0 + (iy + 0.5) * NAV.res;
        const w1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
        const w2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
        const w3 = 1 - w1 - w2;
        if (w1 < -0.02 || w2 < -0.02 || w3 < -0.02) continue;
        const z = a[2] * w1 + b[2] * w2 + c[2] * w3;
        if (z > -100 && z < 100) this.addFloorIndex(iy * NAV.w + ix, z);
      }
    }
  }
  addFloorFlat(a, b, c) {
    const z = a[2];
    if (z < -100 || z > 100) return;
    const minX = Math.min(a[0], b[0], c[0]) - NAV.res * 0.5;
    const maxX = Math.max(a[0], b[0], c[0]) + NAV.res * 0.5;
    const minY = Math.min(a[1], b[1], c[1]) - NAV.res * 0.5;
    const maxY = Math.max(a[1], b[1], c[1]) + NAV.res * 0.5;
    const [ix0, iy0] = this.cellOf(minX, minY);
    const [ix1, iy1] = this.cellOf(maxX, maxY);
    for (let iy = Math.max(0, iy0); iy <= Math.min(NAV.h - 1, iy1); iy++) {
      for (let ix = Math.max(0, ix0); ix <= Math.min(NAV.w - 1, ix1); ix++) {
        const x = NAV.x0 + (ix + 0.5) * NAV.res;
        const y = NAV.y0 + (iy + 0.5) * NAV.res;
        const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        if (Math.abs(d) < 1e-10) continue;
        const w1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
        const w2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
        const w3 = 1 - w1 - w2;
        if (w1 >= -0.01 && w2 >= -0.01 && w3 >= -0.01) this.addFloorIndex(iy * NAV.w + ix, z);
      }
    }
  }
  encodeCollision() {
    const runs = [];
    let value = this.col[0], count = 0;
    for (let i = 0; i < this.col.length; i++) {
      if (this.col[i] === value && count < 65535) count++;
      else { runs.push([value, count]); value = this.col[i]; count = 1; }
    }
    runs.push([value, count]);
    const buf = Buffer.alloc(runs.length * 3);
    for (let i = 0; i < runs.length; i++) {
      buf[i * 3] = runs[i][0];
      buf.writeUInt16LE(runs[i][1], i * 3 + 1);
    }
    return { type: 'u8-u16', values: buf.toString('base64'), cells: this.col.length, runs: runs.length };
  }
  encodeFloor() {
    const total = this.floorLayers.reduce((n, layers) => n + (layers?.length || 0), 0);
    const offsets = Buffer.alloc((NAV.w * NAV.h + 1) * 4), values = Buffer.alloc(total * 2);
    let off = 0;
    for (let i = 0; i < this.floorLayers.length; i++) {
      offsets.writeUInt32LE(off, i * 4);
      for (const z of this.floorLayers[i] || []) values.writeInt16LE(z, off++ * 2);
    }
    offsets.writeUInt32LE(off, this.floorLayers.length * 4);
    return { type: 'layers-i16', offsets: offsets.toString('base64'), values: values.toString('base64'),
      cells: NAV.w * NAV.h, layers: total };
  }
  addDoorThreshold(door) {
    // Floor triangles end at the wall faces. Bridge only the source door's
    // threshold, so a character can step up before its body meets the sill.
    const b = door.bbox, padding = 0.35;
    const x0 = b[0] - (door.axis === 'x' ? padding : 0);
    const x1 = b[3] + (door.axis === 'x' ? padding : 0);
    const y0 = b[1] - (door.axis === 'y' ? padding : 0);
    const y1 = b[4] + (door.axis === 'y' ? padding : 0);
    for (let x = x0; x <= x1; x += NAV.res * 0.5) {
      for (let y = y0; y <= y1; y += NAV.res * 0.5) this.addFloorPoint(x, y, door.bottom);
    }
  }
}

function encodeRLEInt16(values) {
  // values: array of int16
  const out = [];
  let value = values[0], count = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === value && count < 65534) count++;
    else { out.push(value, count); value = values[i]; count = 1; }
  }
  out.push(value, count);
  const buf = Buffer.alloc(out.length * 2);
  for (let i = 0; i < out.length; i++) buf.writeInt16LE(out[i], i * 2);
  return buf.toString('base64');
}

async function main() {
  fs.mkdirSync(BUILD, { recursive: true });
  const api = new IfcAPI();
  api.SetWasmPath(path.join(__dirname, 'node_modules/web-ifc') + path.sep, true);
  await api.Init(undefined, true);

  const entries = archiveEntries(EXTRACT);
  const files = entries.filter(e => /\.ifc$/i.test(e.path)).map(e => e.path);
  const basenameCounts = new Map();
  for (const file of files) basenameCounts.set(path.basename(file),(basenameCounts.get(path.basename(file))||0)+1);
  if (!files.length) {
    // GIM-only package: no IFC track. Emit an empty IFC scene and a flat
    // outdoor navigation grid derived from the GIM placement bounds.
    fs.writeFileSync(BIN, Buffer.alloc(0));
    const nav = new NavGrid();
    for (let y = NAV.y0 + NAV.res/2; y < NAV.y1; y += NAV.res) {
      for (let x = NAV.x0 + NAV.res/2; x < NAV.x1; x += NAV.res) {
        nav.addFloorPoint(x, y, 0);
      }
    }
    const meta = {
      version: 1,
      source: process.env.GIM_BLENDER_SOURCE_NAME || 'input.gim',
      coordinateSystem: 'source-z-up-metres-v2',
      bounds: NAV,
      files: {},
      chunks: [],
      doors: [],
      interiorAreas: [],
      gate: null,
      counts: { chunks: 0, doors: 0, triangles: 0 },
    };
    fs.writeFileSync(path.join(BUILD, 'ifc_scene.json'), JSON.stringify(meta));
    fs.writeFileSync(path.join(BUILD, 'nav.json'), JSON.stringify({
      coordinateSystem: 'source-z-up-metres-v2',
      navigationVersion: 2,
      bounds: NAV,
      collision: nav.encodeCollision(),
      obstacles: nav.encodeObstacles(),
      floor: nav.encodeFloor(),
    }));
    console.log('no IFC files; wrote empty IFC scene + flat nav');
    console.log('nav cells', NAV.w * NAV.h);
    return;
  }
  const out = fs.openSync(BIN, 'w');
  let byteOffset = 0;
  const chunks = [];
  const doors = [];
  const compositeDoors = [];
  let gateBox = null;
  const nav = new NavGrid();
  const fileBBoxes = {};
  const interiorAreas = [];
  const siteAreas = [];
  const proxyNavigation = [];
  const guardWalls = [];

  const appendBuffer = (buf) => {
    const off = byteOffset;
    fs.writeSync(out, buf, 0, buf.length);
    byteOffset += buf.length;
    return off;
  };
  function writeChunk(chunk) {
    if (!chunk.indices.length) return;
    const posArr=new Float32Array(chunk.positions),norArr=new Float32Array(chunk.normals),idxArr=new Uint32Array(chunk.indices);
    const positionOffset=appendBuffer(Buffer.from(posArr.buffer));
    const normalOffset=appendBuffer(Buffer.from(norArr.buffer));
    const indexOffset=appendBuffer(Buffer.from(idxArr.buffer));
    chunks.push({...chunk.meta,vertexCount:posArr.length/3,indexCount:idxArr.length,
      positionOffset,normalOffset,indexOffset,bbox:chunk.bbox});
  }

  for (const file of files) {
    const category = classifyIfc(file);
    const modelID = api.OpenModel(new Uint8Array(fs.readFileSync(path.join(EXTRACT, file))), { COORDINATE_TO_ORIGIN: false });
    const fileChunks = new Map();
    const fileBBox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const doorMap = new Map();
    let countMeshes = 0, countTris = 0;

    const expandFileBBox = (p) => {
      for (let k = 0; k < 3; k++) {
        if (p[k] < fileBBox[k]) fileBBox[k] = p[k];
        if (p[k] > fileBBox[k + 3]) fileBBox[k + 3] = p[k];
      }
    };

    api.StreamAllMeshes(modelID, (fm) => {
      const exclusions = EXCLUDED_IDS[file] || (basenameCounts.get(path.basename(file)) === 1 ? EXCLUDED_IDS[path.basename(file)] : null);
      if (exclusions?.has(fm.expressID)) return;
      const line = (() => { try { return api.GetLine(modelID, fm.expressID); } catch { return null; } })();
      const typeName = line?.constructor?.name || '';
      const name = line?.Name?.value || '';
      let isDoor = typeName === 'IfcDoor' || typeName === 'IfcDoorStandardCase';
      const isGate = typeName === 'IfcBuildingElementProxy' && String(name).includes(GATE_NAME);
      const isVehicle = /卡车|汽车|车辆|叉车/.test(String(name));
      const isOpening = typeName === 'IfcOpeningElement';

      // Transform all placed geometries for this object.
      let geoms = [];
      let objBox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let i = 0; i < fm.geometries.size(); i++) {
        const placed = fm.geometries.get(i);
        const geo = api.GetGeometry(modelID, placed.geometryExpressID);
        const rawVerts = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
        const rawIdx = api.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize());
        const m = placed.flatTransformation;
        const nm = normalMatrix(m);
        const vcount = rawVerts.length / 6;
        const pos = new Float32Array(vcount * 3);
        const nor = new Float32Array(vcount * 3);
        let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
        for (let j = 0, k = 0; j < rawVerts.length; j += 6, k += 3) {
          const x = rawVerts[j], y = rawVerts[j + 1], z = rawVerts[j + 2];
          const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
          const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
          const [bx, by, bz] = toBlender(wx, wy, wz);
          pos[k] = bx; pos[k + 1] = by; pos[k + 2] = bz;
          const nx0 = rawVerts[j + 3], ny0 = rawVerts[j + 4], nz0 = rawVerts[j + 5];
          let nx = nm[0] * nx0 + nm[3] * ny0 + nm[6] * nz0;
          let ny = nm[1] * nx0 + nm[4] * ny0 + nm[7] * nz0;
          let nz = nm[2] * nx0 + nm[5] * ny0 + nm[8] * nz0;
          const nl = Math.hypot(nx, ny, nz);
          if (nl < 1e-8) { nx = 0; ny = 1; nz = 0; } else { nx /= nl; ny /= nl; nz /= nl; }
          const bn = toBlender(nx, ny, nz);
          nor[k] = bn[0]; nor[k + 1] = bn[1]; nor[k + 2] = bn[2];
          if (bx < minx) minx = bx; if (by < miny) miny = by; if (bz < minz) minz = bz;
          if (bx > maxx) maxx = bx; if (by > maxy) maxy = by; if (bz > maxz) maxz = bz;
          expandFileBBox([bx, by, bz]);
        }
        // The inverse axis rotation has determinant +1: preserve winding.
        const triCount = Math.floor(rawIdx.length / 3);
        const idx = new Uint32Array(triCount * 3);
        for (let t = 0; t < triCount; t++) {
          idx[t * 3] = rawIdx[t * 3];
          idx[t * 3 + 1] = rawIdx[t * 3 + 1];
          idx[t * 3 + 2] = rawIdx[t * 3 + 2];
        }
        geoms.push({ pos, nor, idx, sourceGeometryId: String(placed.geometryExpressID)+'@'+createHash('sha256').update(JSON.stringify(Array.from(m))).digest('hex').slice(0,16) });
        if (minx < objBox[0]) objBox[0] = minx;
        if (miny < objBox[1]) objBox[1] = miny;
        if (minz < objBox[2]) objBox[2] = minz;
        if (maxx > objBox[3]) objBox[3] = maxx;
        if (maxy > objBox[4]) objBox[4] = maxy;
        if (maxz > objBox[5]) objBox[5] = maxz;
        geo.delete?.();
      }
      if (!geoms.length) return;
      const adapted = navigationRole(typeName, String(name), String(line?.ObjectType?.value || ''), objBox);
      const role = adapted.role;
      isDoor ||= role === 'door';
      if (typeName === 'IfcBuildingElementProxy' && role) proxyNavigation.push({file, id:fm.expressID, name, role, evidence:adapted.evidence, bbox:objBox});

      const compositeBarrier = role === 'wall' && /防爆墙|百叶墙|百叶围护|幕墙/.test(String(name));
      if (compositeBarrier) {
        const split = splitCompositeDoors(geoms, objBox, {id:fm.expressID,file,name:String(name),type:typeName,category,
          sourceId:`${file}#${fm.expressID}`,siteCenter:[(NAV.x0+NAV.x1)/2,(NAV.y0+NAV.y1)/2],
          color:lineColor(fm.geometries.get(0), DEFAULT_COLOR)});
        geoms = split.geoms;
        compositeDoors.push(...split.doors);
      }

      if (isDoor) {
        const rec = doorMap.get(fm.expressID) || { id: fm.expressID, sourceExpressId:fm.expressID,
          sourceFile:file, sourceId:`${file}#${fm.expressID}`, sourceType:typeName, roleEvidence:adapted.evidence, name, category, bbox: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity] };
        for (let k = 0; k < 3; k++) {
          rec.bbox[k] = Math.min(rec.bbox[k], objBox[k]);
          rec.bbox[k + 3] = Math.max(rec.bbox[k + 3], objBox[k + 3]);
        }
        doorMap.set(fm.expressID, rec);
        return;
      }
      if (isGate) {
        if (!gateBox) gateBox = objBox.slice();
        else for (let k = 0; k < 3; k++) {
          gateBox[k] = Math.min(gateBox[k], objBox[k]);
          gateBox[k + 3] = Math.max(gateBox[k + 3], objBox[k + 3]);
        }
        return;
      }
      if (isOpening) return;
      if (isVehicle) return;
      // Ground-floor room hints follow source slabs, rather than the original
      // two guessed guard-house rectangles. They do not control collisions.
      if (category === '建筑' && role === 'floor' && (objBox[3]-objBox[0])*(objBox[4]-objBox[1])>=4) {
        interiorAreas.push({ sourceId: fm.expressID, rect: [objBox[0],objBox[1],objBox[3],objBox[4]],
          floor: objBox[5], sourceFile:file, label: /警卫|警传|门卫/.test(path.basename(file)) ? '警卫室' : '室内' });
      }
      if (/警卫|警传|门卫/.test(path.basename(file)) && /IfcWall/.test(typeName) && objBox[2] < 0.5 && objBox[5] > 2) {
        guardWalls.push([objBox[0],objBox[1],objBox[3],objBox[4]]);
      }

      // Collision: walls, columns, railings, windows.
      const collisionType = ['wall','column','beam','railing','window'].includes(role);
      if (collisionType) {
        nav.addObstacles(geoms, { file, id: fm.expressID, type: typeName, role });
        for (const g of geoms) {
          // This slice is only the minimap backdrop. Movement uses the original
          // triangles at the player's height, without raster dilation.
          for (const zSlice of [1.25]) {
            for (let t = 0; t + 2 < g.idx.length; t += 3) {
              const p0 = [g.pos[g.idx[t] * 3], g.pos[g.idx[t] * 3 + 1], g.pos[g.idx[t] * 3 + 2]];
              const p1 = [g.pos[g.idx[t + 1] * 3], g.pos[g.idx[t + 1] * 3 + 1], g.pos[g.idx[t + 1] * 3 + 2]];
              const p2 = [g.pos[g.idx[t + 2] * 3], g.pos[g.idx[t + 2] * 3 + 1], g.pos[g.idx[t + 2] * 3 + 2]];
              const zs = [p0[2], p1[2], p2[2]];
              if (Math.min(...zs) > zSlice || Math.max(...zs) < zSlice) continue;
              const pts = [];
              for (const [a, b] of [[p0, p1], [p1, p2], [p2, p0]]) {
                const za = a[2] - zSlice, zb = b[2] - zSlice;
                if (Math.abs(za) < 1e-9 && Math.abs(zb) < 1e-9) { pts.push([a[0], a[1]]); pts.push([b[0], b[1]]); continue; }
                if ((za < 0 && zb > 0) || (za > 0 && zb < 0)) {
                  const u = za / (za - zb);
                  pts.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
                }
              }
              if (pts.length >= 2) nav.markCollisionSegment(pts[0][0], pts[0][1], pts[1][0], pts[1][1], 0.08);
            }
          }
        }
      }

      // Walkable surfaces.
      const floorType = ['floor','roof','stairs','ramp'].includes(role);
      const isSiteFloor = role === 'ground' || category === '总图';
      const stepSurfaceType = !compositeBarrier && ['wall','column','beam'].includes(role);
      if (isSiteFloor) siteAreas.push({file, id:fm.expressID, rect:[objBox[0],objBox[1],objBox[3],objBox[4]], top:objBox[5]});
      if (floorType || isSiteFloor || stepSurfaceType) {
        for (const g of geoms) {
          for (let t = 0; t + 2 < g.idx.length; t += 3) {
            const p0 = [g.pos[g.idx[t] * 3], g.pos[g.idx[t] * 3 + 1], g.pos[g.idx[t] * 3 + 2]];
            const p1 = [g.pos[g.idx[t + 1] * 3], g.pos[g.idx[t + 1] * 3 + 1], g.pos[g.idx[t + 1] * 3 + 2]];
            const p2 = [g.pos[g.idx[t + 2] * 3], g.pos[g.idx[t + 2] * 3 + 1], g.pos[g.idx[t + 2] * 3 + 2]];
            const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
            const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const area = 0.5 * Math.hypot(nx, ny, nz);
            if (area < 0.004) continue;
            // A curb/parapet can be stepped onto only when its actual top is
            // within the step limit; vertical faces remain body colliders.
            if (stepSurfaceType && nz / (2 * area) < 0.95) continue;
            if (isSiteFloor) {
              if (Math.abs(nz) / (2 * area) < 0.55) continue;
              if (p0[2] > 2.0 && p1[2] > 2.0 && p2[2] > 2.0) continue;
            } else {
              // Slabs and stair treads can be wound either way in IFC.
              if (Math.abs(nz) / (2 * area) < 0.45) continue;
            }
            nav.addFloorTriangle(p0, p1, p2);
          }
        }
      }

      if (isOpening) return;

      // Static render geometry, chunked by tile and colour.
      const color = lineColor(fm.geometries.get(0), DEFAULT_COLOR);
      const ckey = colorKey(color);
      const cx = (objBox[0] + objBox[3]) / 2;
      const cy = (objBox[1] + objBox[4]) / 2;
      const tile = `${Math.floor(cx / 30)}_${Math.floor(cy / 30)}`;
      const key = `${file}|${ckey}|${tile}|${typeName}`;
      let chunk = fileChunks.get(key);
      if (!chunk) {
        chunk = new ChunkBuilder({
          name: `${category}_${file.replace(/\.ifc$/i, '')}_${tile}_${ckey}`,
          file, category, color, tile, type: typeName,
        });
        fileChunks.set(key, chunk);
      }
      for (const g of geoms) {
        if (chunk.baseVertex && chunk.baseVertex+g.pos.length/3>150000) {
          writeChunk(chunk);
          chunk=new ChunkBuilder({...chunk.meta,name:chunk.meta.name+'_b'+chunks.length});
          fileChunks.set(key,chunk);
        }
        chunk.add(g.pos,g.nor,g.idx);
      }
      countMeshes++;
      for (const g of geoms) countTris += g.idx.length / 3;
    });

    for (const chunk of fileChunks.values()) {
      writeChunk(chunk);
    }

    for (const rec of doorMap.values()) {
      rec.bbox = rec.bbox.map(v => Math.round(v * 10000) / 10000);
      doors.push(rec);
    }
    fileBBoxes[file] = fileBBox;
    console.log(file, 'tris', Math.round(countTris), 'objects', countMeshes, 'doors', doorMap.size, 'chunks', fileChunks.size);
    api.CloseModel(modelID);
  }

  api.Dispose();
  fs.closeSync(out);
  // Entry assistance is derived later from this source's door/floor heights.

  // Build door leaf metadata.
  const idCounts = new Map();
  for (const d of doors) idCounts.set(d.id,(idCounts.get(d.id)||0)+1);
  const doorOut = compositeDoors.slice();
  for (const rec of doors) {
    if (idCounts.get(rec.sourceExpressId)>1) rec.id=rec.sourceId;
    const token = typeof rec.id==='number' ? rec.id : createHash('sha256').update(rec.sourceId).digest('hex').slice(0,12);
    const fb=fileBBoxes[rec.sourceFile];
    const centerMain=fb?[(fb[0]+fb[3])/2,(fb[1]+fb[4])/2]:[(NAV.x0+NAV.x1)/2,(NAV.y0+NAV.y1)/2];
    const b = rec.bbox;
    const dx = b[3] - b[0], dy = b[4] - b[1], dz = b[5] - b[2];
    const vertical = dz;
    const width = Math.max(dx, dy);
    const thickness = Math.min(dx, dy);
    const axis = dx < dy ? 'x' : 'y';
    const name = rec.name || '';
    const isRollup = name.includes('卷帘');
    const isWood = name.includes('木门') || name.includes('嵌板');
    const center = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
    const inward = axis === 'x'
      ? [Math.sign(centerMain[0] - center[0]) || 1, 0]
      : [0, Math.sign(centerMain[1] - center[1]) || 1];
    let leaves = [];
    if (isRollup) {
      const panelH = vertical * 0.95;
      leaves.push({
        name: `ROLL_${token}`,
        hinge: [center[0], center[1], b[2]],
        kind: 'rollup',
        move: [0, 0, panelH],
      });
    } else {
      const double = width > 1.15 || name.includes('双');
      const leafW = double ? width / 2 : width;
      const half = width / 2;
      const ends = double ? [-1, 1] : [1];
      for (const side of ends) {
        const hingePos = axis === 'x'
          ? [center[0], center[1] + side * half, b[2]]
          : [center[0] + side * half, center[1], b[2]];
        // Closed free-end direction points to the other end of the opening.
        const closed = axis === 'x' ? [0, -side] : [-side, 0];
        // Open toward the building interior.
        const open = inward.slice();
        // signed angle from closed to open around +Z
        const cross = closed[0] * open[1] - closed[1] * open[0];
        const dot = closed[0] * open[0] + closed[1] * open[1];
        const angle = Math.atan2(cross, dot);
        leaves.push({
          name: `DOOR_${token}_${side < 0 ? 'L' : 'R'}`,
          hinge: [hingePos[0], hingePos[1], b[2]],
          kind: 'swing',
          width: leafW,
          height: vertical,
          thickness: Math.max(0.04, Math.min(0.08, thickness)),
          closedDir: closed,
          angle,
          side,
        });
      }
    }
    doorOut.push({
      id: rec.id,
      sourceExpressId:rec.sourceExpressId, sourceFile:rec.sourceFile, sourceId:rec.sourceId, sourceType:rec.sourceType, roleEvidence:rec.roleEvidence,
      name,
      category: rec.category,
      kind: isRollup ? 'rollup' : 'swing',
      axis,
      width, height: vertical, thickness,
      bbox: b,
      center,
      bottom: b[2],
      top: b[5],
      material: isRollup ? 'metal' : isWood ? 'wood' : 'paint',
      leaves,
    });
  }

  // Sort doors by distance to the gate for a sensible list.
  doorOut.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const door of doorOut) nav.addDoorThreshold(door);
  // Connected ground-floor walls provide guard-house envelopes, including
  // lowered wet-room floors and the gaps between individual slab rectangles.
  const guardEnvelopes = [];
  for (const rect of guardWalls) {
    let merged = rect.slice(), changed = true;
    while (changed) {
      changed = false;
      for (let i = guardEnvelopes.length - 1; i >= 0; i--) {
        const b = guardEnvelopes[i];
        if (merged[0] > b[2] + .1 || merged[2] < b[0] - .1 || merged[1] > b[3] + .1 || merged[3] < b[1] - .1) continue;
        merged = [Math.min(merged[0],b[0]),Math.min(merged[1],b[1]),Math.max(merged[2],b[2]),Math.max(merged[3],b[3])];
        guardEnvelopes.splice(i,1); changed = true;
      }
    }
    guardEnvelopes.push(merged);
  }

  const gateAxis = gateBox && gateBox[3]-gateBox[0] <= gateBox[4]-gateBox[1] ? 'x' : 'y';
  const gateLeaves = gateBox ? [-1,1].map((side,i) => {
    const b=gateBox,center=[(b[0]+b[3])/2,(b[1]+b[4])/2];
    const hinge=gateAxis==='x'?[b[0]+.35,side<0?b[1]+.25:b[4]-.25,b[2]]:[side<0?b[0]+.25:b[3]-.25,b[1]+.35,b[2]];
    const closed=gateAxis==='x'?[0,-side]:[-side,0];
    const inward=gateAxis==='x'?[Math.sign((NAV.x0+NAV.x1)/2-center[0])||1,0]:[0,Math.sign((NAV.y0+NAV.y1)/2-center[1])||1];
    return {name:i?'GATE_R':'GATE_L',hinge,width:((gateAxis==='x'?b[4]-b[1]:b[3]-b[0])/2)-.25,
      height:b[5]-b[2],thickness:.08,closedDir:closed,angle:Math.atan2(closed[0]*inward[1]-closed[1]*inward[0],closed[0]*inward[0]+closed[1]*inward[1]),side};
  }) : [];
  const gateOut = {
    id: 'GATE',
    name: '平开大门',
    kind: 'swing',
    gate: true,
    bbox: gateBox,
    axis: gateAxis,
    leaves: gateBox ? [
      {
        name: 'GATE_L', hinge: [gateBox[0] + 0.35, gateBox[1] + 0.25, gateBox[2]],
        width: (gateBox[4] - gateBox[1]) / 2 - 0.25, height: gateBox[5] - gateBox[2], thickness: 0.08,
        closedDir: [0, 1], angle: Math.PI / 2, side: -1,
      },
      {
        name: 'GATE_R', hinge: [gateBox[0] + 0.35, gateBox[4] - 0.25, gateBox[2]],
        width: (gateBox[4] - gateBox[1]) / 2 - 0.25, height: gateBox[5] - gateBox[2], thickness: 0.08,
        closedDir: [0, -1], angle: -Math.PI / 2, side: 1,
      },
    ] : [],
  };
  gateOut.leaves = gateLeaves;

  const meta = {
    version: 1,
    source: process.env.GIM_BLENDER_SOURCE_NAME || 'input.gim',
    coordinateSystem: 'source-z-up-metres-v2',
    bounds: NAV,
    files: fileBBoxes,
    chunks,
    doors: doorOut,
    interiorAreas: [...guardEnvelopes.map(rect => ({rect, floor:0, label:'警卫室'})), ...interiorAreas.filter(a => a.label !== '警卫室')],
    gate: gateOut,
    siteAreas, proxyNavigation,
    counts: { ifcFiles: files.length, chunks: chunks.length, doors: doorOut.length, triangles: chunks.reduce((s, c) => s + c.indexCount / 3, 0) },
  };
  fs.writeFileSync(path.join(BUILD, 'ifc_scene.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(BUILD, 'nav.json'), JSON.stringify({
    coordinateSystem: 'source-z-up-metres-v2',
    navigationVersion: 2,
    bounds: NAV,
    collision: nav.encodeCollision(),
    obstacles: nav.encodeObstacles(),
    floor: nav.encodeFloor(),
  }));
  console.log('chunks', chunks.length, 'tris', meta.counts.triangles, 'doors', doorOut.length);
  console.log('nav cells', NAV.w * NAV.h);
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { toBlender, normalMatrix, NavGrid };
