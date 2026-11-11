import * as THREE from 'three';

interface Entry { key: string; box: THREE.Box3 }
interface Branch { box: THREE.Box3; entries?: Entry[]; left?: Branch; right?: Branch }

/** Session-local broad phase. It only chooses expensive view-metric candidates;
 * it never decides whether a source deserves a base representation. */
export class BoxViewIndex {
  private entries = new Map<string, Entry>();
  private dirty = true;
  private root: Branch | null = null;
  private changed = new Set<string>();
  private unindexed = new Set<string>();
  private lastFrustum: THREE.Frustum | null = null;
  private candidates = new Set<string>();
  readonly diagnostics = { entries: 0, rebuilds: 0, visitedNodes: 0, testedBoxes: 0, candidates: 0 };
  set(key: string, box: THREE.Box3 | null): void {
    if (!box || box.isEmpty() || ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite)) {
      if (this.entries.delete(key)) { this.dirty = true; this.changed.add(key); this.unindexed.add(key); }
      this.diagnostics.entries = this.entries.size;
      return;
    }
    if (this.entries.get(key)?.box.equals(box)) return;
    this.entries.set(key, {key, box: box.clone()}); this.dirty = true; this.changed.add(key); this.unindexed.add(key);
    this.diagnostics.entries = this.entries.size;
  }
  query(frustum: THREE.Frustum): Set<string> {
    this.diagnostics.visitedNodes = 0; this.diagnostics.testedBoxes = 0;
    if (this.lastFrustum && frustum.planes.every((plane, i) => plane.equals(this.lastFrustum!.planes[i]))) {
      // Loading adds bounds while the camera is usually stationary. Re-test
      // only changed entries against the identical frustum; defer rebuilding
      // the broad-phase tree until a different view actually needs it.
      for (const key of this.changed) {
        const entry = this.entries.get(key);
        if (entry) this.diagnostics.testedBoxes++;
        if (entry && frustum.intersectsBox(entry.box)) this.candidates.add(key);
        else this.candidates.delete(key);
      }
      this.changed.clear(); this.diagnostics.candidates = this.candidates.size;
      return new Set(this.candidates);
    }
    // While the camera moves, query unchanged tree entries plus an exact delta
    // scan. Old leaf identities are excluded below, so moved/deleted boxes can
    // never leave ghost candidates or hide a box outside its old branch.
    const rebuildThreshold = Math.max(64, Math.min(512, Math.ceil(this.entries.size / 4)));
    if (this.dirty && (!this.root || this.unindexed.size >= rebuildThreshold)) {
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
      this.root = build([...this.entries.values()]); this.dirty = false; this.unindexed.clear(); this.diagnostics.rebuilds++;
    }
    const result = new Set<string>();
    const visit = (branch: Branch | null | undefined): void => {
      if (!branch) return;
      this.diagnostics.visitedNodes++;
      if (!frustum.intersectsBox(branch.box)) return;
      if (branch.entries) for (const entry of branch.entries) {
        if (this.entries.get(entry.key) !== entry) continue;
        this.diagnostics.testedBoxes++;
        if (frustum.intersectsBox(entry.box)) result.add(entry.key);
      }
      else { visit(branch.left); visit(branch.right); }
    };
    visit(this.root);
    for (const key of this.unindexed) {
      const entry = this.entries.get(key); if (!entry) continue;
      this.diagnostics.testedBoxes++;
      if (frustum.intersectsBox(entry.box)) result.add(key);
    }
    this.diagnostics.candidates = result.size;
    this.lastFrustum = frustum.clone(); this.changed.clear(); this.candidates = result;
    return new Set(result);
  }
  clear(): void {
    this.entries.clear(); this.root = null; this.dirty = false;
    this.changed.clear(); this.unindexed.clear(); this.lastFrustum = null; this.candidates.clear();
    this.diagnostics.entries = this.diagnostics.candidates = this.diagnostics.testedBoxes = this.diagnostics.visitedNodes = 0;
  }
}
