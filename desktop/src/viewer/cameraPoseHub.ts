import { Quaternion, Vector3 } from 'three';
import type { ViewerContext } from './viewerEngine.js';
import type { Vec3 } from '../shared/viewerCommands.js';

type Owner = Readonly<{ source: 'orbit' | 'patrol'; session: number; generation: number }>;
export interface CameraPoseChange {
  owner: Owner;
  revision: number;
  projectionRevision: number;
  position: Vec3;
  direction: Vec3;
  up: Vec3;
}

const hubs = new WeakMap<object, CameraPoseHub>();
export function cameraPoseHub(ctx: ViewerContext): CameraPoseHub {
  const camera = ctx.world.camera;
  let hub = hubs.get(camera);
  if (!hub) {
    hub = new CameraPoseHub(camera);
    hubs.set(camera, hub);
  }
  return hub;
}

/** One adapter per active camera, independently of the number of LOD consumers. */
export class CameraPoseHub {
  private owner: Owner = { source: 'orbit', session: 0, generation: 0 };
  private listeners = new Set<(view: CameraPoseChange) => void>();
  private revision = 0;
  private session?: () => number;
  private lastChangeAt = 0;
  private samples?: { dev: number[]; ifc: number[]; seen: Record<'dev' | 'ifc', number> };
  startAdmissionTrace() {
    return (this.samples = { dev: [], ifc: [], seen: { dev: -1, ifc: -1 } });
  }
  stopAdmissionTrace() {
    this.samples = undefined;
  }
  admitted(channel: 'dev' | 'ifc') {
    const s = this.samples;
    if (!s || this.owner.source !== 'patrol' || s.seen[channel] === this.revision) return;
    s.seen[channel] = this.revision;
    if (s[channel].length < 4096) s[channel].push(performance.now() - this.lastChangeAt);
  }
  private projectionRevision = 0;
  private last?: number[];
  private lastProjection?: number[];
  private rotation = new Quaternion();
  private position = new Vector3();
  private readonly orbitUpdate = () => {
    const owner = this.current;
    if (owner.source === 'orbit') this.publish(owner);
  };
  constructor(private camera: ViewerContext['world']['camera']) {}
  bindSession(session: () => number) {
    this.session = session;
    return () => {
      if (this.session === session) this.session = undefined;
    };
  }
  get current() {
    const generation = this.session?.();
    if (generation !== undefined && generation !== this.owner.session) {
      this.last = undefined;
      this.claim('orbit', generation);
    }
    return this.owner;
  }
  claim(source: Owner['source'], session: number): Owner {
    this.owner = { source, session, generation: this.owner.generation + 1 };
    return this.owner;
  }
  subscribe(listener: (event: CameraPoseChange) => void): () => void {
    if (!this.listeners.size) this.camera.controls?.addEventListener?.('update', this.orbitUpdate);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size)
        this.camera.controls?.removeEventListener?.('update', this.orbitUpdate);
    };
  }
  write(owner: Owner, mutation: () => void): boolean {
    if (owner !== this.current) return false;
    mutation();
    this.publish(owner);
    return true;
  }
  publish(owner: Owner): void {
    if (owner !== this.current) return;
    const active = this.camera.three;
    const position =
      active?.getWorldPosition?.(this.position) ??
      this.camera.controls?.getPosition?.(this.position, false);
    if (!position) return;
    const rotation = active?.getWorldQuaternion?.(this.rotation) ?? this.rotation.identity();
    const signature = [
      position.x,
      position.y,
      position.z,
      rotation.x,
      rotation.y,
      rotation.z,
      rotation.w,
    ];
    const projection = active?.projectionMatrix?.elements ?? [];
    const projectionChanged =
      !this.lastProjection || projection.some((v, i) => this.lastProjection![i] !== v);
    if (!projectionChanged && this.last && signature.every((v, i) => this.last![i] === v)) return;
    if (projectionChanged) {
      this.lastProjection = [...projection];
      this.projectionRevision++;
    }
    this.last = signature;
    this.lastChangeAt = performance.now();
    const view = {
      owner,
      revision: ++this.revision,
      projectionRevision: this.projectionRevision,
      position: position.toArray(),
      direction: new Vector3(0, 0, -1).applyQuaternion(rotation).toArray(),
      up: new Vector3(0, 1, 0).applyQuaternion(rotation).toArray(),
    };
    for (const listener of this.listeners) listener(view);
  }
}
