import { circleIntersectsRect } from './nav.js?v=20261116-runtime-perf-v1';

// Door and gate interaction. All coordinates in this module are Blender plan metres.
export class DoorManager {
  constructor(root, sceneData) {
    this.root = root;
    this.data = sceneData;
    this.entries = [];
    this.missing = [];
    this.onToggle = null;
    this.build();
  }

  build() {
    for (const d of this.data.doors) {
      const entry = this.makeEntry(d, false);
      if (entry) this.entries.push(entry);
    }
    const g = this.data.gate;
    if (g) {
      const entry = this.makeEntry({ ...g, bottom: g.bbox[2], top: g.bbox[5], thickness: 0.1, main: false }, true);
      if (entry) this.entries.push(entry);
    }
    console.log(`doors: ${this.entries.length} interactive, ${this.missing.length} missing leaves`);
  }

  makeEntry(d, isGate) {
    const leaves = [];
    for (const l of d.leaves || []) {
      const obj = this.root.getObjectByName(l.name);
      if (!obj) { this.missing.push(l.name); continue; }
      leaves.push({
        obj,
        name: l.name,
        kind: l.kind,
        angle: l.angle || 0,
        moveZ: l.moveZ || 0,
        side: l.side || 1,
        basePos: obj.position.clone(),
        baseRotY: obj.rotation.y,
      });
    }
    if (!leaves.length) return null;
    const b = d.bbox;
    const entry = {
      id: isGate ? 'GATE' : d.id,
      isGate,
      name: d.name,
      main: !!d.main,
      kind: isGate ? 'gate' : d.kind,
      center: d.center,
      bbox: b,
      rect: [b[0], b[1], b[3], b[4]],
      bottom: d.bottom,
      top: d.top,
      leaves,
      open: false,
      t: 0,
      target: 0,
    };
    this.refreshTargets(entry);
    return entry;
  }

  refreshTargets(entry) {
    entry.targets = [entry.center];
    for (const leaf of entry.leaves) {
      const geometry = leaf.obj.geometry;
      if (!geometry) continue;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      leaf.obj.updateWorldMatrix(true, false);
      const point = leaf.obj.position.clone();
      geometry.boundingBox.getCenter(point).applyMatrix4(leaf.obj.matrixWorld);
      entry.targets.push([point.x, -point.z, point.y]);
    }
  }

  refreshAllTargets() {
    for (const entry of this.entries) this.refreshTargets(entry);
  }

  nearest(px, py, feet, fx, fy, maxDist = 3.4) {
    let best = null;
    let bestScore = Infinity;
    for (const e of this.entries) {
      if (feet+1.7 < (e.bottom??0)-.1 || feet > (e.top??3)+.1) continue;
      // Once open, the panel no longer sits at its closed doorway centre.
      // Interact with its actual pose from either side, including at the hinge.
      for (const point of e.targets) {
        const dx=point[0]-px,dy=point[1]-py,dist=Math.hypot(dx,dy);
        if(dist>maxDist)continue;
        const dot=dist<.05?1:(dx*fx+dy*fy)/dist;
        if(dot<.28)continue;
        const score=dist-dot*.4;
        if(score<bestScore){bestScore=score;best={entry:e,dist,dot};}
      }
    }
    return best;
  }

  toggle(entry) {
    if (!entry) return false;
    entry.open = !entry.open;
    entry.target = entry.open ? 1 : 0;
    if (this.onToggle) this.onToggle(entry);
    return true;
  }

  isBlocked(x, y, r = 0.28, feet = 0) {
    for (const e of this.entries) {
      if (e.t > 0.55) continue;
      if (feet + 1.9 < (e.bottom ?? 0)) continue;
      if (feet > (e.top ?? 3)) continue;
      if (circleIntersectsRect(x, y, r + 0.04, e.rect)) return true;
    }
    return false;
  }

  update(dt) {
    for (const e of this.entries) {
      if (e.t === e.target) continue;
      const speed = e.kind === 'rollup' ? 1.5 : 2.6;
      const dir = e.target > e.t ? 1 : -1;
      e.t += dir * dt * speed;
      if (dir > 0 && e.t > e.target) e.t = e.target;
      if (dir < 0 && e.t < e.target) e.t = e.target;
      const t = e.t * e.t * (3 - 2 * e.t);
      for (const l of e.leaves) {
        if (l.kind === 'rollup') {
          l.obj.position.y = l.basePos.y + l.moveZ * t;
        } else {
          l.obj.rotation.y = l.baseRotY + l.angle * t;
        }
      }
      this.refreshTargets(e);
    }
  }

  promptFor(entry) {
    if (!entry) return '';
    if (entry.isGate) return entry.open ? '关闭大门' : '开启大门';
    if (entry.kind === 'rollup') return entry.open ? '关闭卷帘门' : '升起卷帘门';
    if (entry.main) return entry.open ? '关闭主控楼大门' : '打开主控楼大门';
    return entry.open ? '关门' : '开门';
  }

  getState() {
    return this.entries.map(e => ({ id: e.id, open: e.open, t: e.t, gate: e.isGate }));
  }
}
