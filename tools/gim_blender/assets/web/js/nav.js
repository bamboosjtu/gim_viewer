// Navigation grid decoded from the Blender/IFC build.
// Coordinates are Blender plan metres: x east, y north, z up.
import { TriangleCollision, EquipmentCollision } from './collision.js?v=20261116-runtime-perf-v1';

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class NavGrid {
  constructor(data) {
    this.bounds = data.bounds;
    this.res = data.bounds.res;
    this.w = data.bounds.w;
    this.h = data.bounds.h;
    this.cells = this.w * this.h;
    this.collision = new Uint8Array(this.cells);
    this.decodeCollision(data.collision);
    this.decodeFloor(data.floor);
    this.entrySteps = data.entrySteps || [];
    this.worldGround = data.worldGround || null;
    if (data.obstacles?.type === 'triangles-f32') {
      const bytes = base64ToBytes(data.obstacles.values);
      this.obstacles = new TriangleCollision(new Float32Array(bytes.buffer), this.bounds, data.obstacles.objects);
    }
  }

  decodeCollision(data) {
    const bytes = base64ToBytes(data.values);
    let p = 0, o = 0;
    while (p + 2 < bytes.length && o < this.cells) {
      const value = bytes[p++];
      const count = bytes[p] | (bytes[p + 1] << 8);
      p += 2;
      const end = Math.min(this.cells, o + count);
      if (value) this.collision.fill(value, o, end);
      o = end;
    }
    if (o !== this.cells) console.warn('collision RLE short', o, this.cells);
  }

  decodeFloor(data) {
    if (data.type === 'layers-i16') {
      const offsets = base64ToBytes(data.offsets), heights = base64ToBytes(data.values);
      this.floorOffsets = new Uint32Array(offsets.buffer);
      this.floor = new Int16Array(heights.buffer);
      return;
    }
    this.floor = new Int16Array(this.cells * 4).fill(-32768);
    const bytes = base64ToBytes(data.values);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = 0, o = 0;
    while (p + 4 <= bytes.length && o < this.floor.length) {
      const value = view.getInt16(p, true);
      const count = view.getUint16(p + 2, true);
      p += 4;
      const end = Math.min(this.floor.length, o + count);
      this.floor.fill(value, o, end);
      o = end;
    }
    if (o !== this.floor.length) console.warn('floor RLE short', o, this.floor.length);
  }

  index(x, y) {
    const ix = Math.floor((x - this.bounds.x0) / this.res);
    const iy = Math.floor((y - this.bounds.y0) / this.res);
    if (ix < 0 || iy < 0 || ix >= this.w || iy >= this.h) return -1;
    return iy * this.w + ix;
  }

  collisionAt(x, y) {
    const idx = this.index(x, y);
    return idx >= 0 ? this.collision[idx] : 0;
  }

  blocked(x, y, radius = 0.28, feet = 0) {
    for (const step of this.entrySteps) {
      if (step.base !== undefined && step.top > feet + .06 && step.base < feet + 1.7 &&
          circleIntersectsRect(x,y,radius,step.rect)) return true;
    }
    if (this.equipment?.blocked(x, y, radius, feet)) return true;
    if (this.obstacles) return this.obstacles.blocked(x, y, radius, feet);
    // Sample the player circle against the wall occupancy grid.
    if (this.collisionAt(x, y)) return true;
    const r = radius;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      if (this.collisionAt(x + Math.cos(a) * r, y + Math.sin(a) * r)) return true;
    }
    return false;
  }

  layers(x, y) {
    const idx = this.index(x, y);
    const out = [];
    const g=this.worldGround,r=g?.excludedRect,b=this.bounds;
    if(g && x>=b.x0-60 && x<=b.x1+60 && y>=b.y0-60 && y<=b.y1+60 &&
        (idx<0 || !r || x<r[0] || x>r[2] || y<r[1] || y>r[3])) out.push(g.z);
    if (idx < 0) return out;
    const base = this.floorOffsets ? this.floorOffsets[idx] : idx * 4;
    const end = this.floorOffsets ? this.floorOffsets[idx + 1] : base + 4;
    for (let k = base; k < end; k++) {
      const v = this.floor[k];
      if (v !== -32768) out.push(v / 100);
    }
    out.sort((a, b) => a - b);
    for (const s of this.entrySteps) {
      const r=s.rect;
      if(x>=r[0] && x<=r[2] && y>=r[1] && y<=r[3]) out.push(s.top);
    }
    out.sort((a,b)=>a-b);
    return out;
  }

  floorAt(x, y, current, stepUp = 0.56) {
    const ls = this.layers(x, y);
    let best = this.equipment?.floorAt(x,y,current+stepUp) ?? null;
    for (const v of ls) {
      if (v <= current + stepUp) { if(best===null || v>best)best=v; }
      else break;
    }
    return best;
  }

  setEquipment(buffer) { this.equipment = new EquipmentCollision(buffer); }

  floorAtFootprint(x, y, current, stepUp = 0.56, radius = 0.27) {
    let best = this.floorAt(x, y, current, stepUp);
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      const floor = this.floorAt(x + Math.cos(a) * radius, y + Math.sin(a) * radius, current, stepUp);
      if (floor !== null && (best === null || floor > best)) best = floor;
    }
    return best;
  }

  // Floor surface just below/at the current player height, for teleporting.
  safeFloor(x, y, current = 0) {
    const ls = this.layers(x, y);
    if (!ls.length) return current;
    let best = ls[0];
    for (const v of ls) if (v <= current + 0.6) best = v;
    return best;
  }

  isInside(x, y, pad = 0) {
    return x >= this.bounds.x0 + pad && x <= this.bounds.x1 - pad &&
           y >= this.bounds.y0 + pad && y <= this.bounds.y1 - pad;
  }
}

export function circleIntersectsRect(x, y, r, rect) {
  const [x0, y0, x1, y1] = rect;
  const nx = Math.max(x0, Math.min(x1, x));
  const ny = Math.max(y0, Math.min(y1, y));
  const dx = x - nx;
  const dy = y - ny;
  return dx * dx + dy * dy < r * r;
}
