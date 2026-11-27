import { compilePatrolAssets } from './patrolSceneCompiler.js';
import { usableAsset, usableManifest, type PatrolSceneManifest } from './patrolSceneCache.js';
import { Box3, Matrix4, Vector3, Triangle } from 'three';
import {
  gateApproaches,
  stationGateRank,
  type GateApproach,
  type GateBounds,
} from './patrolGate.js';
import type { AppState } from '../../../app/state.js';
import type { ProjectLoadSession } from '../../../shared/projectSession.js';
import {
  readPatrolCache,
  patrolCachePrefix,
  enterPatrolCache,
  discardPatrolEntry,
  writePatrolCache,
} from '../../../infrastructure/cache/navigation/patrolCache.js';
import { UnsupportedPatrolSourceError } from '../../../shared/patrolSpatialAsset.js';
import { PatrolAssetBuilder } from '../../../infrastructure/workers/patrolAssetBuilder.js';
import { solvePatrolStep } from '../../../viewer/patrol/collision/patrolStep.js';
import { doorRange, doorTransform } from '../../../viewer/patrol/doorMotion.js';
import {
  bodyHits,
  triangleDistanceSquared,
  supportHeight,
  visitTriangles,
  type PatrolAsset,
  type PlacedAsset,
} from '../../../viewer/patrol/collision/patrolGeometry.js';
import {
  patrolProfile as profile,
  type PatrolPose,
  type PatrolSource,
  type NavigationQueryPort,
  type StepResult,
} from '../../../viewer/patrol/navigationQueryPort.js';
import type { IfcNavigationCatalog } from '../../../viewer/patrol/ifcNavigationSource.js';
import { isUsableAffineMatrix } from '../../../gim/geometry/affineMatrix.js';

import { DEV_SHAPE_POLICY } from '../../../infrastructure/cache/devLodIdentity.js';
import { GEOMETRY_CACHE_VERSION } from '@desktop/contracts.js';

const size = 8;
const codec = [
  'nav-v1',
  GEOMETRY_CACHE_VERSION,
  DEV_SHAPE_POLICY,
  'z-up-m-v1',
  'roles-v1',
  'bvh-v1',
  'grid-' + size,
].join('/');
function sweepBounds(from: Vector3, to: Vector3) {
  const box = new Box3().setFromPoints([from, to]).expandByScalar(profile.radius);
  box.min.z = Math.min(from.z, to.z) - profile.stepDown - 0.01;
  box.max.z = Math.max(from.z, to.z) + profile.height + profile.stepUp;
  return box;
}
const xy = (a: number, b: number) => a + ',' + b;
const groundType = /^IFC(SLAB|STAIR(FLIGHT)?|RAMP(FLIGHT)?|ROAD|PAVEMENT|SITE|GEOGRAPHICELEMENT)$/;
const groundLabel =
  /楼板|踏步|楼梯|台阶|坡道|路面|道路|广场|站区地面|室外地面|场坪|地坪|平台|\b(stair|floor|road|pavement|landing|ramp)\b/i;
const toEngineering = new Matrix4().makeRotationX(Math.PI / 2);
const abort = (signal: AbortSignal) => signal.throwIfAborted();

type PreparedSource = Omit<PatrolSource, 'load'>;
type Progress = (message: string) => void;

export class PatrolNavigationRuntime implements NavigationQueryPort {
  private readonly key: string;
  private readonly cachePrefix: string;
  private hasEstimatedSources = false;
  private unknownSources: string[] = [];
  private approaches: GateApproach[] = [];
  private readonly doors = new Map<string, PreparedSource>();
  private readonly opened = new Map<string, () => void>();
  private readonly trustedDoors = new Set<string>();
  private prepared = false;
  // If storage is unavailable, keep successful template buffers for the next entrance.
  private memoryRepair?: { assets: Map<string, PatrolAsset>; unavailable: Set<string> };
  private preparation?: Promise<void>;
  private readonly sourcesById = new Map<string, PreparedSource>();
  private readonly unavailable = new Set<string>();
  private readonly grid = new Map<string, PreparedSource[]>();
  private readonly large: PreparedSource[] = [];
  private readonly placements = new Map<string, PlacedAsset>();
  private readonly builder = new PatrolAssetBuilder();
  readonly metrics = {
    estimatedSectionOccurrences: 0,
    assetHits: 0,
    assetBuilds: 0,
    blocks: 0,
    sourcesPrepared: 0,
    unavailableSources: 0,
    fromCache: false,
    persisted: false,
    queries: 0,
    residentSweepSteps: 0,
    missingSweepSteps: 0,
    queryMs: [] as number[],
  };
  constructor(
    private state: AppState,
    private session: ProjectLoadSession,
  ) {
    this.cachePrefix = patrolCachePrefix(
      session.sourceSha256 ?? '',
      session.projectId ?? null,
      DEV_SHAPE_POLICY,
    );
    this.key = this.cachePrefix + codec;
  }
  get unknownSourceCount() {
    return this.unknownSources.length;
  }
  private check(signal: AbortSignal) {
    abort(signal);
    if (!this.state.isCurrentSession(this.session)) throw Error('巡视工程已切换');
    if (this.state.geometryLoadToken !== this.session.geometryToken)
      throw Error('几何批次已改变，请重新进入巡视');
  }
  private async catalog(signal: AbortSignal) {
    const state = this.state,
      dev = state.deviceLodRuntime;
    if (!state.sourceGeometry.catalog) throw Error('导航数据不完整：来源目录尚未就绪');
    const hasDev = state.sourceGeometry.catalog.occurrences.length > 0;
    const base = hasDev ? await dev?.patrolDirectory?.(signal) : undefined;
    const sources = [...(base?.sources ?? [])],
      unknown = [...(base?.unknown ?? [])];
    if (hasDev && !base)
      unknown.push(...state.sourceGeometry.catalog.occurrences.map((row) => row.id));
    const gates: GateBounds[] = [];
    for (const entry of state.currentIfcEntries) {
      const runtime = state.ifc.regionalRuntimes.get(entry.modelId);
      if (!runtime) {
        unknown.push(entry.path);
        continue;
      }
      const catalogKey = this.key + '/ifc-directory/' + entry.path;
      let directory = await readPatrolCache<IfcNavigationCatalog>('coverage', catalogKey);
      this.check(signal);
      if (!directory) {
        try {
          directory = await runtime.patrolSource('patrol-catalog', signal);
          this.check(signal);
          await writePatrolCache('coverage', catalogKey, directory, this.cachePrefix);
        } catch {
          this.check(signal);
          unknown.push(entry.path);
          continue;
        }
      }
      for (const id of directory.unknown) unknown.push(entry.path + '#' + id);
      for (const product of directory.products) {
        const b = product.bounds,
          id = entry.path + '#' + product.expressId;
        const bounds = new Box3(
          new Vector3().fromArray(b),
          new Vector3().fromArray(b, 3),
        ).applyMatrix4(toEngineering);
        if (/^(IFCDOOR(STANDARDCASE)?|IFCGATE|IFCBUILDINGELEMENTPROXY)$/.test(product.type)) {
          const rank = stationGateRank(product.label);
          if (rank) gates.push({ rank, bounds });
        }
        sources.push({
          id,
          assetKey: 'ifc:' + id,
          bounds,
          matrix: toEngineering,
          // The descriptor comes from IFC placements in Z-up engineering metres.
          // Only web-ifc triangulations and their bounds arrive in Y-up mesh space.
          door: product.door,
          doorAddress: product.door
            ? { path: entry.path, expressId: product.expressId }
            : undefined,
          support:
            groundType.test(product.type) ||
            (product.type === 'IFCBUILDINGELEMENTPROXY' &&
              groundLabel.test(product.label) &&
              !/栏杆|扶手|墙/.test(product.label)),
          load: async (signal) => {
            const result = await runtime.patrolSource('patrol-mesh', signal, product);
            if (!result.parts.some((part) => part.indices.length))
              throw new UnsupportedPatrolSourceError(id + ': IFC source has no triangles');
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
    const usable = sources.filter((row) => {
      if (isUsableAffineMatrix(row.matrix.elements)) return true;
      unknown.push(row.id);
      return false;
    });
    const site = new Box3();
    for (const row of usable) site.union(row.bounds);
    const byId = new Map(usable.map((row) => [row.id, row]));
    for (const occurrence of state.sourceGeometry.catalog.occurrences) {
      const source = byId.get(occurrence.id);
      const rank = source && stationGateRank(occurrence.name);
      if (rank && source) gates.push({ rank, bounds: source.bounds });
    }
    return { sources: usable, unknown, approaches: gateApproaches(gates, site) };
  }

  prepareScene(signal: AbortSignal, progress: Progress = () => {}): Promise<void> {
    if (this.prepared) return Promise.resolve();
    if (this.preparation)
      return this.preparation.catch(() => {}).then(() => this.prepareScene(signal, progress));
    this.preparation = this.compileScene(signal, progress).finally(() => {
      this.preparation = undefined;
      this.builder.dispose();
    });
    return this.preparation;
  }

  private async compileScene(signal: AbortSignal, progress: Progress) {
    this.check(signal);
    if (!this.session.sourceSha256) throw Error('缺少工程来源身份，无法打开巡视场景');
    await enterPatrolCache(this.session.projectId ?? null, this.cachePrefix);
    this.check(signal);
    const key = this.key + '/scene-v1';
    const cached = await readPatrolCache<PatrolSceneManifest>('coverage', key);
    this.check(signal);
    this.metrics.fromCache = this.metrics.persisted = false;
    const assets = this.memoryRepair?.assets ?? new Map<string, PatrolAsset>();
    const unavailable = this.memoryRepair?.unavailable ?? new Set<string>();
    if (usableManifest(cached)) {
      progress('正在载入已编译的巡视场景…');
      for (const key of cached.unavailable) unavailable.add(key);
      for (const assetKey of new Set(cached.sources.map((row) => row.assetKey))) {
        if (assets.has(assetKey) || unavailable.has(assetKey)) continue;
        const asset = await readPatrolCache<PatrolAsset>('assets', this.key + '/' + assetKey);
        this.check(signal);
        if (usableAsset(asset)) {
          assets.set(assetKey, asset);
          this.metrics.assetHits++;
        }
      }
      if (
        cached.sources.some((row) => row.support && assets.has(row.assetKey)) &&
        cached.sources.every((row) => assets.has(row.assetKey) || unavailable.has(row.assetKey))
      ) {
        this.memoryRepair = undefined;
        this.publishScene(cached, assets);
        this.metrics.fromCache = this.metrics.persisted = true;
        return;
      }
    } else if (cached) {
      await discardPatrolEntry('coverage', key, this.cachePrefix);
      this.check(signal);
    }
    progress('正在准备工程来源…');
    const catalog = await this.catalog(signal);
    this.check(signal);
    const { needsRetry, stored } = await compilePatrolAssets(
      catalog.sources,
      catalog.approaches[0]?.point,
      assets,
      unavailable,
      this.key,
      this.cachePrefix,
      this.builder,
      this.metrics,
      signal,
      () => this.check(signal),
      progress,
    );
    const manifest: PatrolSceneManifest = {
      sources: catalog.sources.map((row) => ({
        id: row.id,
        assetKey: row.assetKey,
        support: row.support,
        estimatedSteelSections: row.estimatedSteelSections,
        approximate: row.approximate || !!assets.get(row.assetKey)?.previewShapes?.length,
        compiledPreviewShapes: assets.get(row.assetKey)?.previewShapes,
        estimatedGeometryCount: row.estimatedGeometryCount,
        approximationReasons: row.approximationReasons,
        matrix: row.matrix.toArray(),
        bounds: [...row.bounds.min.toArray(), ...row.bounds.max.toArray()],
        door: row.door,
        doorAddress: row.doorAddress,
      })),
      unknown: catalog.unknown,
      unavailable: [...unavailable],
      approaches: catalog.approaches.map((row) => ({ point: row.point.toArray(), yaw: row.yaw })),
    };
    this.memoryRepair = needsRetry ? { assets, unavailable } : undefined;
    if (!manifest.sources.some((row) => row.support && assets.has(row.assetKey)))
      throw Error('巡视场景缺少可用路面或楼面');
    this.metrics.persisted =
      stored && (await writePatrolCache('coverage', key, manifest, this.cachePrefix));
    this.check(signal);
    if (this.metrics.persisted) this.memoryRepair = undefined;
    this.publishScene(manifest, assets);
  }

  private publishScene(manifest: PatrolSceneManifest, assets: ReadonlyMap<string, PatrolAsset>) {
    const sources: PreparedSource[] = [];
    for (const row of manifest.sources) {
      const bounds = new Box3(
        new Vector3().fromArray(row.bounds),
        new Vector3().fromArray(row.bounds, 3),
      );
      const matrix = new Matrix4().fromArray(row.matrix);
      const source: PreparedSource = { ...row, bounds, matrix };
      sources.push(source);
      this.sourcesById.set(row.id, source);
      const asset = assets.get(row.assetKey);
      if (asset && source.door && source.doorAddress) {
        bounds.union(doorRange(source.door, bounds));
        this.doors.set(row.id, source);
        this.checkDoorShape(source, asset);
      }
      const x0 = Math.floor(bounds.min.x / size),
        x1 = Math.floor(bounds.max.x / size);
      const y0 = Math.floor(bounds.min.y / size),
        y1 = Math.floor(bounds.max.y / size);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) this.large.push(source);
      else
        for (let x = x0; x <= x1; x++)
          for (let y = y0; y <= y1; y++) {
            const tile = xy(x, y);
            const list = this.grid.get(tile);
            if (list) list.push(source);
            else this.grid.set(tile, [source]);
          }
      if (!asset) {
        this.unavailable.add(row.id);
        continue;
      }
      this.placements.set(row.id, {
        id: row.id,
        matrix,
        inverse: matrix.clone().invert(),
        mirror: matrix.determinant() < 0,
        support: row.support,
        asset,
      });
    }
    this.approaches = manifest.approaches.map((row) => ({
      point: new Vector3(...row.point),
      yaw: row.yaw,
    }));
    this.unknownSources = manifest.unknown;
    this.hasEstimatedSources = sources.some((row) => row.approximate || row.estimatedSteelSections);
    this.metrics.estimatedSectionOccurrences = sources.filter(
      (row) => row.estimatedSteelSections,
    ).length;
    this.metrics.blocks = this.grid.size;
    this.metrics.sourcesPrepared = this.placements.size;
    this.metrics.unavailableSources = this.unavailable.size;
    this.prepared = true;
  }

  private checkDoorShape(row: PreparedSource, asset: PatrolAsset) {
    const door = row.door!;
    const hinge = new Vector3(...door.hingePosition);
    const along = new Vector3(...door.closedTip).sub(hinge).setZ(0).normalize();
    const p = new Vector3();
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
    if (Math.abs(min) < 0.1 && Math.abs(max - door.radius) < 0.1 && width < 0.14 && z1 - z0 > 1.5)
      this.trustedDoors.add(row.id);
  }

  async stationEntrance(signal: AbortSignal): Promise<PatrolPose | undefined> {
    await this.prepareScene(signal);
    this.check(signal);
    for (const { point, yaw } of this.approaches) {
      const below = 6,
        above = 2;
      const column = new Box3(
        point.clone().setZ(point.z - below),
        point.clone().setZ(point.z + above),
      );
      const heights = new Set<number>();
      for (const row of this.inBounds(column).values()) {
        if (!row.support) continue;
        visitTriangles(row, column, (t) => {
          const z = supportHeight(t, point, below, above);
          if (z !== undefined) heights.add(z);
          return false;
        });
      }
      for (const z of [...heights].sort((a, b) => Math.abs(a - point.z) - Math.abs(b - point.z))) {
        const feet = point.clone().setZ(z);
        const result = this.step(feet, feet);
        if ('feet' in result) return { ...result, yaw, pitch: 0 };
      }
    }
  }

  private inBounds(box: Box3, missing?: Set<string>) {
    const rows = new Map<string, PlacedAsset>();
    const include = (row: PreparedSource) => {
      if (!row.bounds.intersectsBox(box)) return;
      const asset = this.placements.get(row.id);
      if (asset) rows.set(row.id, asset);
      else missing?.add(row.id);
    };
    for (let x = Math.floor(box.min.x / size); x <= Math.floor(box.max.x / size); x++)
      for (let y = Math.floor(box.min.y / size); y <= Math.floor(box.max.y / size); y++)
        for (const row of this.grid.get(xy(x, y)) ?? []) include(row);
    for (const row of this.large) include(row);
    return rows;
  }

  step(from: Vector3, to: Vector3): StepResult {
    const start = performance.now();
    try {
      if (!this.prepared) return { reason: '请先进入已准备的巡视场景' };
      const box = sweepBounds(from, to);
      const missing = this.unavailable.size ? new Set<string>() : undefined;
      const rows = this.inBounds(box, missing);
      if (missing?.size) {
        this.metrics.missingSweepSteps++;
        return { reason: '附近缺失碰撞几何' };
      }
      const result = solvePatrolStep(rows, box, from, to);
      if ('feet' in result) this.metrics.residentSweepSteps++;
      if (this.hasEstimatedSources) {
        for (const id of rows.keys()) {
          const source = this.sourcesById.get(id);
          if (source?.estimatedSteelSections || source?.approximate) {
            result.estimated = true;
            break;
          }
        }
      }
      return result;
    } finally {
      this.metrics.queryMs[this.metrics.queries++ % 4096] = performance.now() - start;
    }
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
    const address = row?.doorAddress;
    if (!row || !address || !descriptor || !this.trustedDoors.has(id)) return '缺少门扇运动依据';
    const entry = this.state.currentIfcEntries.find((entry) => entry.path === address.path);
    const runtime = entry && this.state.ifc.regionalRuntimes.get(entry.modelId);
    const frame = this.state.projectSourceToViewerMatrix;
    if (!runtime || !frame) return '门扇显示暂不可用';
    const closing = this.opened.has(id);
    const box = row.bounds;
    for (const sourceId of this.unavailable)
      if (this.sourcesById.get(sourceId)?.bounds.intersectsBox(box)) return '门扇附近缺少碰撞面';
    const objects = this.inBounds(box);
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
      const undo = await runtime.movePatrolLeaf(
        address.expressId,
        doorTransform(descriptor, angle),
        frame,
        signal,
      );
      if (signal.aborted) {
        undo();
        signal.throwIfAborted();
      }
      this.opened.set(id, undo);
    }
    const matrix = closing ? row.matrix : doorTransform(descriptor, angle).multiply(row.matrix);
    leaf.matrix = matrix;
    leaf.inverse = matrix.clone().invert();
    return closing ? '门已关闭' : '门已开启';
  }
  leave() {
    for (const [id, undo] of this.opened) {
      undo();
      const row = this.sourcesById.get(id);
      const placed = this.placements.get(id);
      if (row && placed) {
        placed.matrix = row.matrix;
        placed.inverse = row.matrix.clone().invert();
      }
    }
    this.opened.clear();
    if (this.metrics.persisted || this.memoryRepair) this.clearScene();
  }
  dispose() {
    try {
      this.leave();
    } finally {
      this.builder.dispose();
      this.memoryRepair = undefined;
      this.clearScene();
    }
  }
  private clearScene() {
    this.prepared = false;
    this.doors.clear();
    this.trustedDoors.clear();
    this.sourcesById.clear();
    this.unavailable.clear();
    this.placements.clear();
    this.grid.clear();
    this.large.length = 0;
    this.unknownSources = [];
    this.approaches = [];
  }
}
