import * as THREE from 'three';

interface Entry { key: string; box: THREE.Box3 }
interface Branch { box: THREE.Box3; entries?: Entry[]; left?: Branch; right?: Branch }

/** Session-local broad phase. It only chooses expensive view-metric candidates;
 * it never decides whether a source deserves a base representation. */
export class BoxViewIndex {
  private entries = new Map<string, Entry>();
  private dirty = true;
  private root: Branch | null = null;
  readonly diagnostics = { entries: 0, rebuilds: 0, visitedNodes: 0, testedBoxes: 0, candidates: 0 };
  set(key: string, box: THREE.Box3 | null): void {
    if (!box || box.isEmpty() || ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite)) {
      if (this.entries.delete(key)) this.dirty = true;
      this.diagnostics.entries = this.entries.size;
      return;
    }
    if (this.entries.get(key)?.box.equals(box)) return;
    this.entries.set(key, {key, box: box.clone()}); this.dirty = true;
    this.diagnostics.entries = this.entries.size;
  }
  query(frustum: THREE.Frustum): Set<string> {
    if (this.dirty) {
      const build = (entries: Entry[]): Branch | null => {
        if (!entries.length) return null;
        const box = new THREE.Box3();
        for (const entry of entries) box.union(entry.box);
        if (entries.length <= 8) return {box, entries};
        const size = box.getSize(new THREE.Vector3());
        const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
        entries.sort((a, b) => (a.box.min[axis] + a.box.max[axis]) - (b.box.min[axis] + b.box.max[axis]));
        const middle = Math.floor(entries.length / 2);
        return {box, left: build(entries.slice(0, middle))!, right: build(entries.slice(middle))!};
      };
      this.root = build([...this.entries.values()]); this.dirty = false; this.diagnostics.rebuilds++;
    }
    const result = new Set<string>();
    this.diagnostics.visitedNodes = 0; this.diagnostics.testedBoxes = 0;
    const visit = (branch: Branch | null | undefined): void => {
      if (!branch) return;
      this.diagnostics.visitedNodes++;
      if (!frustum.intersectsBox(branch.box)) return;
      if (branch.entries) for (const entry of branch.entries) {
        this.diagnostics.testedBoxes++;
        if (frustum.intersectsBox(entry.box)) result.add(entry.key);
      }
      else { visit(branch.left); visit(branch.right); }
    };
    visit(this.root); this.diagnostics.candidates = result.size;
    return result;
  }
  clear(): void {
    this.entries.clear(); this.root = null; this.dirty = false;
    this.diagnostics.entries = this.diagnostics.candidates = this.diagnostics.testedBoxes = this.diagnostics.visitedNodes = 0;
  }
}
