import { doorSweepObstruction } from '../../../viewer/patrol/collision/doorSweep.js';
import { compilePatrolAssets } from './patrolSceneCompiler.js';
import { usableAsset, usableManifest, type PatrolSceneManifest } from './patrolSceneCache.js';
import { Box3, Matrix4, Vector3 } from 'three';
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
import { appendPatrolProduct } from './patrolIfcSources.js';
import { PatrolAssetBuilder } from '../../../infrastructure/workers/patrolAssetBuilder.js';
import { solvePatrolStep } from '../../../viewer/patrol/collision/patrolStep.js';
import { doorRange, doorTransform } from '../../../viewer/patrol/doorMotion.js';
import {
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
  'mapped-panels-v1',
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
const toEngineering = new Matrix4().makeRotationX(Math.PI / 2);
const abort = (signal: AbortSignal) => signal.throwIfAborted();

type PreparedSource = Omit<PatrolSource, 'load'>;
type Progress = (message: string, done?: number, total?: number) => void;

export class PatrolNavigationRuntime implements NavigationQueryPort {
  private readonly key: string;
  private readonly cachePrefix: string;
  private hasEstimatedSources = false;
  private unknownSources: string[] = [];
  private approaches: GateApproach[] = [];
  private siteCenter?: Vector3;
  inwardYaw(feet: Vector3) {
    if (!this.siteCenter) return;
    const d = this.siteCenter.clone().sub(feet);
    if (Math.hypot(d.x, d.y) > 1e-6) return Math.atan2(d.x, d.y);
  }
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
  lastDoorCheck?: { id: string; obstacle?: string; person: boolean };
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
    const perimeter = new Box3();
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
        if (/围墙|周界围栏|\bfence\b/i.test(product.label)) perimeter.union(bounds);
        if (/^(IFCDOOR(STANDARDCASE)?|IFCGATE|IFCBUILDINGELEMENTPROXY)$/.test(product.type)) {
          const rank = stationGateRank(product.label);
          if (rank) gates.push({ rank, bounds });
        }
        appendPatrolProduct(sources, runtime, entry.path, id, product, bounds, toEngineering);
      }
    }
    this.check(signal);
    const usable = sources.filter((row) => {
      if (isUsableAffineMatrix(row.matrix.elements)) return true;
      unknown.push(row.id);
      return false;
    });
    const site = new Box3();
    if (!perimeter.isEmpty()) site.copy(perimeter);
    else for (const row of base?.sources.length ? base.sources : usable) site.union(row.bounds);
    const stationCenter = site.getCenter(new Vector3());
    for (const source of usable) {
      const door = source.door;
      if (!door?.evidence.includes('preview-swing')) continue;
      const hinge = new Vector3(...door.hingePosition),
        tip = new Vector3(...door.closedTip).sub(hinge);
      const inside = stationCenter.clone().sub(hinge);
      door.openAngle = ((tip.x * inside.y - tip.y * inside.x >= 0 ? 1 : -1) * Math.PI) / 2;
    }
    const byId = new Map(usable.map((row) => [row.id, row]));
    for (const occurrence of state.sourceGeometry.catalog.occurrences) {
      const source = byId.get(occurrence.id);
      const rank = source && stationGateRank(occurrence.name);
      if (rank && source) gates.push({ rank, bounds: source.bounds });
    }
    return {
      sources: usable,
      unknown,
      center: site.isEmpty() ? undefined : stationCenter.toArray(),
      approaches: gateApproaches(gates, site),
    };
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
      center: catalog.center,
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
        if (source.doorAddress.parts?.length) this.trustedDoors.add(row.id);
        else this.checkDoorShape(source, asset);
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
    this.siteCenter = manifest.center ? new Vector3(...manifest.center) : undefined;
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
  doorReach(id: string) {
    return Math.min(5, Math.max(3.4, (this.doors.get(id)?.door?.radius ?? 0) + 1));
  }
  resolveDoor(id: string, world: Vector3, partIndex?: number) {
    if (this.canOperate(id)) return id;
    const frame = this.state.projectSourceToViewerMatrix;
    if (!frame) return;
    const hit = world.clone().applyMatrix4(frame.clone().invert());
    let distance = 0.2,
      nearest: string | undefined;
    for (const [key, row] of this.doors) {
      if (!this.trustedDoors.has(key) || !key.startsWith(id + '/leaf/')) continue;
      if (partIndex !== undefined) {
        if (row.doorAddress?.parts?.includes(partIndex)) return key;
        continue;
      }
      const placed = this.placements.get(key);
      if (!placed) continue;
      const box = new Box3(
        new Vector3().fromArray(placed.asset.nodes[0].bounds),
        new Vector3().fromArray(placed.asset.nodes[0].bounds, 3),
      ).applyMatrix4(placed.matrix);
      const d = box.distanceToPoint(hit);
      if (d < distance) {
        distance = d;
        nearest = key;
      }
    }
    return nearest;
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
    let angle = descriptor.openAngle;
    this.lastDoorCheck = { id, person: false };
    const first = await doorSweepObstruction(
      descriptor,
      row.matrix,
      box,
      leaf,
      objects,
      feet,
      signal,
    );
    if (first) {
      const second =
        !closing && descriptor.evidence.includes('preview-swing')
          ? await doorSweepObstruction(
              { ...descriptor, openAngle: -angle },
              row.matrix,
              box,
              leaf,
              objects,
              feet,
              signal,
            )
          : first;
      if (second) {
        this.lastDoorCheck = {
          id,
          person: first.kind === 'person' || second.kind === 'person',
          obstacle:
            second.kind === 'obstacle'
              ? second.id
              : first.kind === 'obstacle'
                ? first.id
                : undefined,
        };
        return this.lastDoorCheck.person
          ? '请退到门扇扫掠范围外，再按 E 操作'
          : '门扇开启范围内有障碍';
      }
      angle = -angle;
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
        address.parts,
      );
      if (signal.aborted) {
        undo();
        signal.throwIfAborted();
      }
      descriptor.openAngle = angle;
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
