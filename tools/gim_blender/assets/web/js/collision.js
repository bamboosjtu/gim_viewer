// Source-space static geometry. Queries visit nearby triangles and clip them
// to the player's body; overhead equipment never becomes a ground-level wall.
const EPS = 1e-8;

function clipHeight(points, height, above) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const ai = above ? a[2] >= height : a[2] <= height;
    const bi = above ? b[2] >= height : b[2] <= height;
    if (ai) out.push(a);
    if (ai !== bi) {
      const t = (height - a[2]) / (b[2] - a[2]);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), height]);
    }
  }
  return out;
}

function segmentDistanceSquared(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  const t = length > EPS ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length)) : 0;
  return (x - a[0] - t * dx) ** 2 + (y - a[1] - t * dy) ** 2;
}

export function circleIntersectsTriangleBody(x, y, radius, feet, triangle, height = 1.7) {
  // Keep a small sole clearance; the steppable target floor is supplied by the
  // caller, so a threshold below the feet cannot turn into an invisible wall.
  const low = feet + 0.06, high = feet + height;
  if (Math.max(...triangle.map(p => p[2])) < low || Math.min(...triangle.map(p => p[2])) > high) return false;
  const polygon = clipHeight(clipHeight(triangle, low, true), high, false);
  if (!polygon.length) return false;
  let positive = false, negative = false, area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    if (segmentDistanceSquared(x, y, a, b) < radius * radius - EPS) return true;
    const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    positive ||= cross > EPS; negative ||= cross < -EPS;
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area) > EPS && !(positive && negative);
}

export class TriangleCollision {
  constructor(positions, bounds, objects = []) {
    this.positions = positions;
    this.objects = objects;
    this.cellSize = 2;
    this.cells = new Map();
    this.stamps = new Uint32Array(positions.length / 9);
    this.epoch = 0;
    for (let i = 0; i < positions.length; i += 9) {
      const xs = [positions[i], positions[i + 3], positions[i + 6]];
      const ys = [positions[i + 1], positions[i + 4], positions[i + 7]];
      const x0 = Math.floor(Math.max(bounds.x0, Math.min(...xs)) / this.cellSize);
      const x1 = Math.floor(Math.min(bounds.x1, Math.max(...xs)) / this.cellSize);
      const y0 = Math.floor(Math.max(bounds.y0, Math.min(...ys)) / this.cellSize);
      const y1 = Math.floor(Math.min(bounds.y1, Math.max(...ys)) / this.cellSize);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const key = `${x},${y}`;
        let entries = this.cells.get(key);
        if (!entries) this.cells.set(key, entries = []);
        entries.push(i / 9);
      }
    }
  }

  hit(x, y, radius, feet) {
    this.epoch = (this.epoch + 1) >>> 0;
    if (!this.epoch) { this.stamps.fill(0); this.epoch = 1; }
    const size = this.cellSize;
    for (let cy = Math.floor((y - radius) / size); cy <= Math.floor((y + radius) / size); cy++) {
      for (let cx = Math.floor((x - radius) / size); cx <= Math.floor((x + radius) / size); cx++) {
        for (const id of this.cells.get(`${cx},${cy}`) || []) {
          if (this.stamps[id] === this.epoch) continue;
          this.stamps[id] = this.epoch;
          const off = id * 9, p = this.positions;
          if (Math.max(p[off+2], p[off+5], p[off+8]) < feet + 0.06 || Math.min(p[off+2], p[off+5], p[off+8]) > feet + 1.7) continue;
          if (Math.max(p[off], p[off+3], p[off+6]) < x-radius || Math.min(p[off], p[off+3], p[off+6]) > x+radius ||
              Math.max(p[off+1], p[off+4], p[off+7]) < y-radius || Math.min(p[off+1], p[off+4], p[off+7]) > y+radius) continue;
          const triangle = [[p[off],p[off+1],p[off+2]], [p[off+3],p[off+4],p[off+5]], [p[off+6],p[off+7],p[off+8]]];
          if (circleIntersectsTriangleBody(x, y, radius, feet, triangle)) return id;
        }
      }
    }
    return -1;
  }

  blocked(x, y, radius, feet) { return this.hit(x, y, radius, feet) >= 0; }
}

// DEV triangles use an offline BVH, avoiding a per-load index over millions of
// triangles. Positions are the exact placed source vertices used by Blender.
export class EquipmentCollision {
  constructor(buffer) {
    const h = new Uint32Array(buffer, 0, 8);
    if (h[0] !== 0x31435644 || h[1] !== 1 || buffer.byteLength !== 32+h[2]*12+h[3]*12+h[4]*32) {
      throw new Error('设备碰撞资产格式不正确');
    }
    this.positions = new Float32Array(buffer, 32, h[2]*3);
    this.indices = new Uint32Array(buffer, 32+h[2]*12, h[3]*3);
    this.bounds = new Float32Array(buffer, 32+h[2]*12+h[3]*12, h[4]*6);
    this.links = new Uint32Array(buffer, 32+h[2]*12+h[3]*12+h[4]*24, h[4]*2);
    this.nodes = h[4];
    this.stack = [];
    if ((h[3] > 0) !== (h[4] > 0)) throw new Error('设备碰撞资产不完整');
    for (const v of this.positions) if (!Number.isFinite(v)) throw new Error('设备碰撞坐标不正确');
    for (const i of this.indices) if (i >= h[2]) throw new Error('设备碰撞索引不正确');
    for (let i=0; i<this.nodes; i++) {
      const a=this.links[i*2], b=this.links[i*2+1];
      if (a & 0x80000000) {
        if ((a & 0x7fffffff)+b > h[3]) throw new Error('设备碰撞叶节点不正确');
      } else if (a <= i || b <= i || a >= this.nodes || b >= this.nodes) {
        throw new Error('设备碰撞树不正确');
      }
    }
  }

  triangle(id) {
    const p=this.positions, q=this.indices, a=q[id*3]*3, b=q[id*3+1]*3, c=q[id*3+2]*3;
    return [[p[a],p[a+1],p[a+2]], [p[b],p[b+1],p[b+2]], [p[c],p[c+1],p[c+2]]];
  }

  hit(x, y, radius, feet) {
    const stack=this.stack, bounds=this.bounds, links=this.links;
    stack.length=0; if(this.nodes)stack.push(0);
    while(stack.length) {
      const node=stack.pop(), o=node*6;
      if(bounds[o+5]<feet+.06 || bounds[o+2]>feet+1.7)continue;
      const dx=Math.max(bounds[o]-x,0,x-bounds[o+3]), dy=Math.max(bounds[o+1]-y,0,y-bounds[o+4]);
      if(dx*dx+dy*dy>=radius*radius)continue;
      const a=links[node*2], b=links[node*2+1];
      if(a & 0x80000000) {
        const first=a & 0x7fffffff;
        for(let i=first;i<first+b;i++)if(circleIntersectsTriangleBody(x,y,radius,feet,this.triangle(i)))return i;
      } else stack.push(a,b);
    }
    return -1;
  }

  blocked(x, y, radius, feet) { return this.hit(x,y,radius,feet)>=0; }

  // Actual upward-facing surfaces support the player when stepping or landing
  // on equipment. Otherwise a jump could descend through a device's top.
  floorAt(x, y, maximum) {
    const stack=this.stack, bounds=this.bounds, links=this.links;
    stack.length=0; if(this.nodes)stack.push(0);
    let best=null;
    while(stack.length) {
      const node=stack.pop(), o=node*6;
      if(x<bounds[o] || x>bounds[o+3] || y<bounds[o+1] || y>bounds[o+4] ||
          bounds[o+2]>maximum || (best!==null && bounds[o+5]<best))continue;
      const a=links[node*2], b=links[node*2+1];
      if(!(a & 0x80000000)){stack.push(a,b);continue;}
      const first=a & 0x7fffffff;
      for(let i=first;i<first+b;i++) {
        const [p,q,r]=this.triangle(i), ux=q[0]-p[0], uy=q[1]-p[1], uz=q[2]-p[2];
        const vx=r[0]-p[0], vy=r[1]-p[1], vz=r[2]-p[2], nz=ux*vy-uy*vx;
        if(nz<=EPS || nz/Math.hypot(uy*vz-uz*vy,uz*vx-ux*vz,nz)<.7)continue;
        const px=x-p[0],py=y-p[1], u=(px*vy-py*vx)/nz, v=(ux*py-uy*px)/nz;
        if(u<-.00001 || v<-.00001 || u+v>1.00001)continue;
        const z=p[2]+u*uz+v*vz;
        if(z<=maximum+.00001 && (best===null || z>best))best=z;
      }
    }
    return best;
  }
}
