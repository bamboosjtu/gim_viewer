import { Box3, Matrix4, Vector3, Triangle } from 'three';
import type { AppState } from '../../../app/state.js';
import type { ProjectLoadSession } from '../../../shared/projectSession.js';
import {
  readPatrolCache,
  writePatrolCache,
} from '../../../infrastructure/cache/navigation/patrolCache.js';
import { PatrolAssetBuilder } from '../../../infrastructure/workers/patrolAssetBuilder.js';
import { doorRange, doorTransform } from '../../../viewer/patrol/doorMotion.js';
import {
  bodyHits,
  triangleDistanceSquared,
  supportHeight,
  supportedInterval,
  visitTriangles,
  type PatrolAsset,
  type PlacedAsset,
} from '../../../viewer/patrol/collision/patrolGeometry.js';
import {
  patrolProfile as profile,
  type PatrolDirectory,
  type PatrolSource,
  type NavigationCoverage,
  type NavigationQueryPort,
  type StepResult,
} from '../../../viewer/patrol/navigationQueryPort.js';
import type { IfcNavigationCatalog } from '../../../viewer/patrol/ifcNavigationSource.js';
import { isUsableAffineMatrix } from '../../../gim/geometry/affineMatrix.js';
import {
  beginDevGeometryWork,
  ifcGeometryBusy,
  onGeometryWorkAvailable,
} from '../../../viewer/geometryWorkGate.js';
import { STEEL_SECTION_POLICY } from '../../../infrastructure/cache/devLodIdentity.js';
import { GEOMETRY_CACHE_VERSION } from '@desktop/contracts.js';

const size = 8;
const codec = [
  'nav-v1',
  GEOMETRY_CACHE_VERSION,
  STEEL_SECTION_POLICY,
  'z-up-m-v1',
  'roles-v1',
  'bvh-v1',
  'grid-' + size,
].join('/');
const xy = (a: number, b: number) => a + ',' + b;
const groundType = /^IFC(SLAB|STAIR(FLIGHT)?|RAMP(FLIGHT)?|ROAD|PAVEMENT|SITE|GEOGRAPHICELEMENT)$/;
const groundLabel =
  /楼板|踏步|楼梯|台阶|坡道|路面|道路|场坪|地坪|平台|\b(stair|floor|road|pavement|landing|ramp)\b/i;
const toEngineering = new Matrix4().makeRotationX(Math.PI / 2);
const abort = (signal: AbortSignal) => signal.throwIfAborted();

function reserveBuild(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => {
      unwatch();
      reject(new DOMException('巡视构建已取消', 'AbortError'));
    };
    const admit = () => {
      const release = beginDevGeometryWork(ifcGeometryBusy() ? 1 : 2);
      if (release) {
        unwatch();
        signal.removeEventListener('abort', cancel);
        resolve(release);
      }
    };
    const unwatch = onGeometryWorkAvailable(admit);
    signal.addEventListener('abort', cancel, { once: true });
    admit();
  });
}

export class PatrolNavigationRuntime implements NavigationQueryPort {
  private readonly key: string;
  private directory?: PatrolDirectory;
  private catalogOwner?: AppState['sourceGeometry']['catalog'];
  private ifcOwner?: number;
  private entryOwner?: AppState['currentIfcEntries'];
  private devOwner?: AppState['deviceLodRuntime'];
  private directoryCurrent() {
    return (
      this.catalogOwner === this.state.sourceGeometry.catalog &&
      this.devOwner === this.state.deviceLodRuntime &&
      this.ifcOwner === this.state.ifc.regionalRuntimes.revision &&
      this.entryOwner === this.state.currentIfcEntries
    );
  }
  private readonly doors = new Map<string, PatrolSource>();
  private readonly opened = new Map<string, () => void>();
  private readonly trustedDoors = new Set<string>();
  private serial: Promise<unknown> = Promise.resolve();
  private readonly sourcesById = new Map<string, PatrolSource>();
  private readonly savedAssets = new Set<string>();
  private readonly grid = new Map<string, PatrolSource[]>();
  private readonly large: PatrolSource[] = [];
  private readonly gaps = new Map<string, PatrolSource[]>();
  private readonly loaded = new Map<string, PlacedAsset[]>();
  private readonly assets = new Map<string, PatrolAsset>();
  private readonly builder = new PatrolAssetBuilder();
  readonly metrics = {
    estimatedSectionOccurrences: 0,
    assetHits: 0,
    assetBuilds: 0,
    blockHits: 0,
    blocks: 0,
    queries: 0,
    queryMs: [] as number[],
  };
  constructor(
    private state: AppState,
    private session: ProjectLoadSession,
  ) {
    this.key = [session.sourceSha256, codec].join('/');
  }
  private check(signal: AbortSignal) {
    abort(signal);
    if (!this.state.isCurrentSession(this.session)) throw Error('巡视工程已切换');
    if (this.state.geometryLoadToken !== this.session.geometryToken)
      throw Error('几何批次已改变，请重新进入巡视');
  }
  private async catalog(signal: AbortSignal) {
    if (this.directory && this.directoryCurrent()) return;
    if (this.directory) this.dispose();
    this.catalogOwner = this.state.sourceGeometry.catalog;
    this.devOwner = this.state.deviceLodRuntime;
    this.ifcOwner = this.state.ifc.regionalRuntimes.revision;
    this.entryOwner = this.state.currentIfcEntries;
    const state = this.state,
      dev = state.deviceLodRuntime;
    if (!state.sourceGeometry.catalog) throw Error('导航数据不完整：来源目录尚未就绪');
    const hasDev = state.sourceGeometry.catalog.occurrences.length > 0;
    const base = hasDev ? await dev?.patrolDirectory?.(signal) : undefined;
    if (hasDev && !base) throw Error('导航数据不完整：等待 DEV 目录');
    const sources = [...(base?.sources ?? [])],
      unknown = [...(base?.unknown ?? [])];
    for (const entry of state.currentIfcEntries) {
      const runtime = state.ifc.regionalRuntimes.get(entry.modelId);
      if (!runtime) throw Error('导航数据不完整：等待 IFC 来源 ' + entry.modelId);
      const catalogKey = this.key + '/ifc-directory/' + entry.path;
      let directory = await readPatrolCache<IfcNavigationCatalog>('coverage', catalogKey);
      this.check(signal);
      if (!directory) {
        directory = await runtime.patrolSource('patrol-catalog', signal);
        this.check(signal);
        if (this.session.sourceSha256 && !directory.unknown.length)
          await writePatrolCache('coverage', catalogKey, directory);
      }
      for (const id of directory.unknown) unknown.push(entry.path + '#' + id);
      for (const product of directory.products) {
        const b = product.bounds,
          id = entry.path + '#' + product.expressId;
        const bounds = new Box3(
          new Vector3().fromArray(b),
          new Vector3().fromArray(b, 3),
        ).applyMatrix4(toEngineering);
        sources.push({
          id,
          assetKey: 'ifc:' + id,
          bounds,
          matrix: toEngineering,
          door: product.door,
          moveLeaf: (delta, signal) =>
            runtime.movePatrolLeaf(
              product.expressId,
              delta,
              state.projectSourceToViewerMatrix!,
              signal,
            ),
          support:
            groundType.test(product.type) ||
            (product.type === 'IFCBUILDINGELEMENTPROXY' &&
              groundLabel.test(product.label) &&
              !/栏杆|扶手|墙/.test(product.label)),
          load: async (signal) => {
            const result = await runtime.patrolSource('patrol-mesh', signal, product);
            return result.parts.map((p) => {
              const positions = new Float32Array(p.vertices.length / 2);
              for (let i = 0; i < positions.length; i += 3)
                positions.set(p.vertices.subarray(i * 2, i * 2 + 3), i);
              return { positions, indices: p.indices, matrix: p.matrix };
            });
          },
        });
      }
    }
    this.check(signal);
    if (!this.directoryCurrent()) throw Error('导航来源发生变更，请重新选择入口');
    for (const row of sources) {
      this.sourcesById.set(row.id, row);
      if (!isUsableAffineMatrix(row.matrix.elements)) {
        unknown.push(row.id);
        continue;
      }
      if (row.door) {
        this.doors.set(row.id, row);
        row.bounds.union(doorRange(row.door, row.bounds));
      }
      const a = row.bounds.min,
        b = row.bounds.max;
      const x0 = Math.floor(a.x / size),
        x1 = Math.floor(b.x / size),
        y0 = Math.floor(a.y / size),
        y1 = Math.floor(b.y / size);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) {
        this.large.push(row);
        continue;
      }
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          const k = xy(x, y),
            list = this.grid.get(k);
          if (list) list.push(row);
          else this.grid.set(k, [row]);
        }
    }
    this.metrics.estimatedSectionOccurrences = sources.filter(
      (row) => row.estimatedSteelSections,
    ).length;
    this.directory = { sources, unknown };
  }
  prepare(point: Vector3, signal: AbortSignal) {
    const work = this.serial.then(() => this.prepareBlocks(point, signal));
    this.serial = work.catch(() => {});
    return work;
  }
  private async prepareBlocks(point: Vector3, signal: AbortSignal) {
    this.check(signal);
    if (!this.session.sourceSha256) throw Error('导航数据不完整：缺少来源 SHA');
    await this.catalog(signal);
    this.check(signal);
    if (this.directory!.unknown.length)
      throw Error('导航数据不完整：来源范围未知 ' + this.directory!.unknown[0]);
    const cx = Math.floor(point.x / size),
      cy = Math.floor(point.y / size);
    const keep = new Set<string>();
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let y = cy - 1; y <= cy + 1; y++) keep.add(xy(x, y));
    for (const k of this.loaded.keys())
      if (!keep.has(k)) {
        this.loaded.delete(k);
        this.gaps.delete(k);
      }
    const used = new Set([...this.loaded.values()].flat().map((a) => a.asset));
    for (const [k, a] of this.assets) if (!used.has(a)) this.assets.delete(k);
    // Only admit blocks actually intersected by the footprint and the next fixed step.
    const r = profile.radius + profile.fast / 60;
    for (let x = Math.floor((point.x - r) / size); x <= Math.floor((point.x + r) / size); x++)
      for (let y = Math.floor((point.y - r) / size); y <= Math.floor((point.y + r) / size); y++) {
        const tile = xy(x, y);
        if (this.loaded.has(tile)) continue;
        const box = new Box3(
          new Vector3(x * size, y * size, -Infinity),
          new Vector3((x + 1) * size, (y + 1) * size, Infinity),
        );

        const key = this.key + '/tile/' + tile;
        const prev = await readPatrolCache<NavigationCoverage>('coverage', key);
        this.check(signal);
        const recovered =
          prev?.complete &&
          prev.ground === 'complete' &&
          prev.obstacles === 'complete' &&
          prev.geometryRevision === this.key
            ? prev.expectedSources.map((id) => this.sourcesById.get(id))
            : undefined;
        const rows = recovered?.every((r): r is PatrolSource => !!r)
          ? recovered
          : [
              ...(this.grid.get(tile) ?? []),
              ...this.large.filter((a) => box.intersectsBox(a.bounds)),
            ];
        const coverage: NavigationCoverage = {
          tileId: tile,
          geometryRevision: this.key,
          complete: false,
          ground: 'pending',
          obstacles: 'pending',
          expectedSources: rows.map((r) => r.id),
          processedSources: [],
          failedSources: [],
        };
        const placed: PlacedAsset[] = [],
          gaps: PatrolSource[] = [];
        for (const row of rows) {
          this.check(signal);
          const assetKey = this.key + '/' + row.assetKey;
          let asset = this.assets.get(assetKey);
          if (!asset) {
            asset = await readPatrolCache<PatrolAsset>('assets', assetKey);
            this.check(signal);
            if (asset?.nodes?.length) {
              this.metrics.assetHits++;
              this.savedAssets.add(assetKey);
            } else {
              try {
                const parts = await row.load(signal);
                this.check(signal);
                const release = await reserveBuild(signal);
                try {
                  this.check(signal);
                  asset = await this.builder.build(parts);
                } finally {
                  release();
                }
                this.check(signal);
                if (await writePatrolCache('assets', assetKey, asset))
                  this.savedAssets.add(assetKey);
                this.metrics.assetBuilds++;
              } catch {
                this.check(signal);
                coverage.failedSources.push(row.id);
                gaps.push(row);
                continue;
              }
            }
            this.assets.set(assetKey, asset);
          }
          if (row.door && !this.trustedDoors.has(row.id)) {
            const hinge = new Vector3(...row.door.hingePosition),
              tip = new Vector3(...row.door.closedTip);
            const along = tip.clone().sub(hinge).setZ(0).normalize(),
              p = new Vector3();
            let min = Infinity,
              max = -Infinity,
              width = 0,
              z0 = Infinity,
              z1 = -Infinity;
            for (let i = 0; i < asset.vertices.length; i += 3) {
              p.fromArray(asset.vertices, i).applyMatrix4(row.matrix).sub(hinge);
              z0 = Math.min(z0, p.z);
              z1 = Math.max(z1, p.z);
              p.z = 0;
              const d = p.dot(along);
              min = Math.min(min, d);
              max = Math.max(max, d);
              width = Math.max(width, p.addScaledVector(along, -d).length());
            }
            if (
              Math.abs(min) < 0.1 &&
              Math.abs(max - row.door.radius) < 0.1 &&
              width < 0.14 &&
              z1 - z0 > 1.5
            )
              this.trustedDoors.add(row.id);
          }
          const matrix =
            this.opened.has(row.id) && row.door
              ? doorTransform(row.door, row.door.openAngle).multiply(row.matrix)
              : row.matrix;
          placed.push({
            id: row.id,
            matrix,
            inverse: matrix.clone().invert(),
            mirror: row.matrix.determinant() < 0,
            support: row.support,
            asset,
          });
          coverage.processedSources.push(row.id);
        }
        this.check(signal);
        coverage.ground = gaps.some((s) => s.support) ? 'partial' : 'complete';
        coverage.obstacles = gaps.length ? 'partial' : 'complete';
        coverage.complete = gaps.length === 0;
        this.gaps.set(tile, gaps);
        if (rows === recovered) this.metrics.blockHits++;
        else if (
          coverage.complete &&
          rows.every((row) => this.savedAssets.has(this.key + '/' + row.assetKey))
        )
          await writePatrolCache('coverage', key, coverage);
        this.check(signal);
        this.loaded.set(tile, placed);
        this.metrics.blocks++;
      }
  }
  step(from: Vector3, to: Vector3): StepResult {
    const start = performance.now();
    try {
      return this.query(from, to);
    } finally {
      this.metrics.queryMs[this.metrics.queries++ % 4096] = performance.now() - start;
    }
  }
  private query(from: Vector3, to: Vector3): StepResult {
    if (!this.directoryCurrent()) return { reason: '导航数据不完整：正在准备变更的来源' };
    const r = profile.radius;
    const box = new Box3().setFromPoints([from, to]).expandByScalar(r);
    box.min.z = from.z - profile.stepDown - 0.01;
    box.max.z = from.z + profile.height + profile.stepUp;
    const rows = new Map<string, PlacedAsset>();
    for (let x = Math.floor(box.min.x / size); x <= Math.floor(box.max.x / size); x++)
      for (let y = Math.floor(box.min.y / size); y <= Math.floor(box.max.y / size); y++) {
        const block = this.loaded.get(xy(x, y));
        if (!block) return { reason: '导航数据不完整：正在准备前方分块' };
        // Refine the coverage proof to the actual swept volume. A partial source
        // with a known range can only be excluded when that range is disjoint.
        const missing = this.gaps.get(xy(x, y))?.find((row) => row.bounds.intersectsBox(box));
        if (missing) return { reason: '导航数据不完整：扫掠范围内存在缺失几何 ' + missing.id };
        for (const row of block) rows.set(row.id, row);
      }
    let floor = -Infinity,
      sourceId = '';
    const intervals: [number, number][] = [];
    // Treads can be narrower than the body diameter even while standing still.
    // Allow only a verified next tread on this same support object under the foot disk.
    const footprint = Array.from({ length: 8 }, (_, i) =>
      to
        .clone()
        .add(new Vector3(r * Math.cos((i * Math.PI) / 4), r * Math.sin((i * Math.PI) / 4), 0)),
    );
    const reachableTreads = new Map<string, number>();
    for (const row of rows.values())
      if (row.support)
        visitTriangles(row, box, (t) => {
          const interval = supportedInterval(t, from, to);
          if (interval) intervals.push(interval);
          for (const sample of footprint) {
            const height = supportHeight(t, sample);
            if (height !== undefined && height > (reachableTreads.get(row.id) ?? -Infinity))
              reachableTreads.set(row.id, height);
          }
          const height = supportHeight(t, to);
          if (height !== undefined && height > floor) {
            floor = height;
            sourceId = row.id;
          }
          return false;
        });
    if (!sourceId) return { reason: '无连续落脚面' };
    intervals.sort((a, b) => a[0] - b[0]);
    let covered = 0;
    for (const [start, end] of intervals) {
      if (start > covered + 1e-8) break;
      covered = Math.max(covered, end);
    }
    if (covered < 1 - 1e-8) return { reason: '无连续落脚面' };
    const feet = to.clone().setZ(floor);
    for (const row of rows.values())
      if (
        visitTriangles(row, box, (t) => {
          const tread = reachableTreads.get(row.id);
          if (
            tread !== undefined &&
            tread >= floor &&
            Math.max(t.a.z, t.b.z, t.c.z) <= tread + 1e-5
          )
            return false;
          return bodyHits(t, from, feet);
        })
      )
        return { reason: '前方受阻或头顶净空不足' };
    return { feet, sourceId };
  }
  get hasDoors() {
    return this.trustedDoors.size > 0;
  }
  canOperate(id: string) {
    return this.trustedDoors.has(id);
  }
  async toggleDoor(id: string, feet: Vector3, signal: AbortSignal): Promise<string> {
    const row = this.doors.get(id),
      descriptor = row?.door;
    if (!row?.moveLeaf || !descriptor || !this.trustedDoors.has(id)) return '缺少门扇运动依据';
    const closing = this.opened.has(id);
    const objects = new Map<string, PlacedAsset>();
    const box = row.bounds;
    for (let x = Math.floor(box.min.x / size); x <= Math.floor(box.max.x / size); x++)
      for (let y = Math.floor(box.min.y / size); y <= Math.floor(box.max.y / size); y++) {
        await this.prepare(new Vector3((x + 0.5) * size, (y + 0.5) * size, feet.z), signal);
        const tile = this.loaded.get(xy(x, y));
        if (!tile || this.gaps.get(xy(x, y))?.some((s) => s.bounds.intersectsBox(box)))
          throw Error('门扇扫掠范围未就绪');
        for (const item of tile) objects.set(item.id, item);
      }
    const leaf = objects.get(id);
    if (!leaf) return '门扇碰撞数据不完整';
    const angle = descriptor.openAngle,
      segments = Math.max(1, Math.ceil((Math.abs(angle) * descriptor.radius) / 0.025));
    const margin = ((descriptor.radius + 0.16) * Math.abs(angle)) / (2 * segments);
    // Each intermediate triangle is expanded by a bound on its angular displacement between samples.
    for (let k = 0; k < segments; k++) {
      const delta = doorTransform(descriptor, (angle * (k + 0.5)) / segments).multiply(row.matrix);
      const sampled = { ...leaf, matrix: delta, inverse: delta.clone().invert() };
      if (
        visitTriangles(sampled, box, (t) => {
          if (bodyHits(t, feet, feet, margin)) return true;
          const region = new Box3().setFromPoints([t.a, t.b, t.c]).expandByScalar(margin);
          for (const other of objects.values()) {
            if (other.id === id) continue;
            if (
              visitTriangles(other, region, (b: Triangle) => {
                if (
                  Math.max(b.a.z, b.b.z, b.c.z) <= box.min.z + 1e-5 ||
                  Math.min(b.a.z, b.b.z, b.c.z) >= box.max.z - 1e-5
                )
                  return false;
                return triangleDistanceSquared(t, b) <= margin * margin;
              })
            )
              return true;
          }
          return false;
        })
      )
        return '门扇运动范围有人物或障碍';
    }
    this.check(signal);
    if (closing) {
      this.opened.get(id)!();
      this.opened.delete(id);
    } else {
      const undo = await row.moveLeaf(doorTransform(descriptor, angle), signal);
      if (signal.aborted) {
        undo();
        signal.throwIfAborted();
      }
      this.opened.set(id, undo);
    }
    const matrix = closing ? row.matrix : doorTransform(descriptor, angle).multiply(row.matrix);
    for (const tile of this.loaded.values())
      for (const p of tile)
        if (p.id === id) {
          p.matrix = matrix;
          p.inverse = matrix.clone().invert();
        }
    return closing ? '门已关闭' : '门已开启';
  }
  leave() {
    for (const undo of this.opened.values()) undo();
    this.opened.clear();
    this.trustedDoors.clear();
    this.builder.dispose();
    this.loaded.clear();
    this.gaps.clear();
    this.assets.clear();
    this.savedAssets.clear();
  }
  dispose() {
    this.leave();
    this.sourcesById.clear();
    this.grid.clear();
    this.large.length = 0;
    this.directory = undefined;
  }
}
