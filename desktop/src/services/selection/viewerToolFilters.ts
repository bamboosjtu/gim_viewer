import type { FragmentsModel, SpatialTreeItem } from '@thatopen/fragments';
import type { AppState } from '../../app/state.js';
import type { ViewerContext } from '../../viewer/viewerEngine.js';
import { devRepresentationHint } from '../../viewer/devRepresentationIdentity.js';
import { getEngineeringRepresentations } from '../engineering/engineeringRepresentationService.js';
import { refreshToolGeometryFilter } from '../engineering/engineeringSelection.js';
import { setSourceLayerVisibility } from './selectionVisibility.js';
import type { ViewerCommand } from '../../shared/viewerCommands.js';

interface Floor {
  model: string;
  label: string;
  local: Set<number>;
  spatialKey?: string;
}
interface Mask {
  allow: Set<number> | null;
  deny: Set<number>;
  express: Set<number>;
  allowedExpress: Set<number> | null;
}
function collectStoreys(tree: SpatialTreeItem) {
  const floors = new Map<number, Set<number>>();
  function visit(node: SpatialTreeItem, members?: Set<number>, parentCategory?: string | null) {
    if (
      (node.category ?? parentCategory)?.toUpperCase() === 'IFCBUILDINGSTOREY' &&
      node.localId != null
    ) {
      members = new Set();
      floors.set(node.localId, members);
    }
    if (node.localId != null) members?.add(node.localId);
    for (const child of node.children ?? []) visit(child, members, node.category);
  }
  visit(tree);
  return floors;
}
export class ViewerToolFilters {
  private hiddenRoots = new Set<string>();
  private hiddenSources = new Set<string>();
  private hiddenLocals = new Map<FragmentsModel, Set<number>>();
  private hiddenExpress = new Map<string, Set<number>>();
  private hiddenGuids = new Map<string, Set<string>>();
  private floors = new Map<string, Floor>();
  private byModel = new WeakMap<
    FragmentsModel,
    Promise<{ types: string[]; floors: Map<number, Set<number>> }>
  >();
  private categoryMembers = new WeakMap<FragmentsModel, Map<string, Promise<number[]>>>();
  private membersOfType(model: FragmentsModel, type: string) {
    let cache = this.categoryMembers.get(model);
    if (!cache) {
      cache = new Map();
      this.categoryMembers.set(model, cache);
    }
    let ids = cache.get(type);
    if (!ids) {
      const pattern = new RegExp('^' + type.replace(/[^a-zA-Z0-9_]/g, '') + '$', 'i');
      ids = model.getItemsOfCategories([pattern]).then((rows) => Object.values(rows).flat());
      cache.set(type, ids);
      const owned = cache;
      void ids.catch(() => owned.delete(type));
    }
    return ids;
  }
  private revision = 0;
  private optionRevision = 0;
  constructor(
    private state: AppState,
    private ctx: ViewerContext,
  ) {}
  private get snap() {
    return this.state.viewerCommands.snapshot;
  }
  get active() {
    return !!(
      this.hiddenRoots.size ||
      this.hiddenSources.size ||
      this.hiddenLocals.size ||
      this.hiddenExpress.size ||
      this.snap.hiddenTypes.length ||
      this.snap.floor
    );
  }
  reset(release = true) {
    this.optionRevision++;
    this.revision++;
    this.hiddenRoots.clear();
    this.hiddenSources.clear();
    this.hiddenLocals.clear();
    this.hiddenExpress.clear();
    this.hiddenGuids.clear();
    if (release) this.floors.clear();
    this.state.toolGeometryFilter = null;
  }
  private models() {
    return [...this.ctx.fragments.list.values()].map((model) => ({
      model,
      id: this.state.ifc.resolveLogicalModelId(model.modelId) ?? model.modelId,
    }));
  }
  async options() {
    const session = this.state.captureProjectSession(),
      seq = ++this.optionRevision;
    const floors = new Map<string, Floor>(),
      types = new Set<string>();
    const spatial = this.state.substationSpatialIndex;
    const options = await Promise.all(
      this.models().map(async ({ model, id }) => {
        let cache = this.byModel.get(model);
        if (!cache) {
          cache = Promise.all([model.getCategories(), model.getSpatialStructure()]).then(
            ([types, tree]) => ({ types, floors: collectStoreys(tree) }),
          );
          this.byModel.set(model, cache);
          void cache.catch(() => this.byModel.delete(model));
        }
        const info = await cache;
        const label =
          this.state.currentIfcEntries.find((entry) => entry.modelId === id)?.name ?? id;
        const nodes = spatial?.nodes.filter((n) => n.modelId === id && n.kind === 'storey') ?? [];
        const localFloors = [...info.floors.keys()];
        const names = localFloors.length
          ? await model.getItemsData(localFloors, {
              attributesDefault: false,
              attributes: ['Name', 'LongName'],
            })
          : [];
        const floorNames = new Map<number, string>();
        for (const row of names) {
          const field = row.LongName ?? row.Name,
            identifier = row._localId;
          if (
            field &&
            !Array.isArray(field) &&
            typeof field.value === 'string' &&
            identifier &&
            !Array.isArray(identifier) &&
            typeof identifier.value === 'number'
          )
            floorNames.set(identifier.value, field.value);
        }
        const guids = localFloors.length ? await model.getGuidsByLocalIds(localFloors) : [];
        for (const [i, local] of localFloors.entries()) {
          const node = guids[i] ? nodes.find((n) => n.globalId === guids[i]) : undefined;
          floors.set(JSON.stringify([id, local]), {
            model: id,
            local: info.floors.get(local)!,
            spatialKey: node?.key,
            label: label + ' / ' + (node?.name || floorNames.get(local) || '楼层 #' + local),
          });
        }
        for (const node of nodes) {
          if ([...floors.values()].some((f) => f.spatialKey === node.key)) continue;
          floors.set(JSON.stringify([id, node.key]), {
            model: id,
            spatialKey: node.key,
            local: new Set(),
            label: label + ' / ' + node.name,
          });
        }
        for (const type of info.types) types.add(type);
        for (const obj of this.state.ifc.regionalRuntimes.get(id)?.index.objects ?? [])
          types.add(obj.ifcType);
        return {
          id,
          label,
          visible: this.state.ifc.loadedModels.get(id)?.visible ?? model.object.visible,
        };
      }),
    );
    if (seq !== this.optionRevision || !this.state.isCurrentSession(session)) return;
    const removedFloor = this.snap.floor && !floors.has(this.snap.floor);
    this.floors = floors;
    if (removedFloor) {
      this.snap.floor = '';
      this.snap.hasMask = this.active;
      this.snap.message = '原楼层来源已移除';
      await this.apply();
      if (!this.state.isCurrentSession(session)) return;
    }
    this.snap.options = {
      models: options,
      types: [...types].sort(),
      floors: [...floors].map(([id, f]) => ({ id, label: f.label })),
    };
    this.state.viewerCommands.notify();
  }
  private add<K, T>(map: Map<K, Set<T>>, model: K, ids: Iterable<T>) {
    const values = map.get(model) ?? new Set<T>();
    for (const id of ids) values.add(id);
    if (values.size) map.set(model, values);
  }
  private hide() {
    const selection = this.state.selection,
      scope = selection.engineeringSelection,
      target = selection.selectionRequest?.target;
    if (!selection.canIsolateSelection || !target) throw Error('请选择具有可靠表示范围的对象');
    if (scope && scope.requestId === selection.selectionRequest?.id) {
      if (
        scope.ifc.some((ref) => !ref.globalId) ||
        selection.selectionGeometry?.status === 'ambiguous'
      )
        this.snap.message = '范围待确认，仅隐藏已绑定的几何表示';
      if (
        scope.ifc.some((ref) => !ref.globalId) ||
        selection.selectionGeometry?.status === 'ambiguous'
      ) {
        this.snap.message = '粗略或多义表示保留，仅隐藏已绑定的范围';
      }
      for (const source of scope.sourceIds) this.hiddenSources.add(source);
      for (const ref of scope.ifc) {
        this.add(this.hiddenExpress, ref.modelId, [ref.expressId]);
        if (ref.globalId) this.add(this.hiddenGuids, ref.modelId, [ref.globalId]);
      }
    } else if (target.kind === 'cbm') this.hiddenRoots.add(target.key);
    else if (target.kind === 'ifc-object') {
      const match = /^ifc:(.*):object:(\d+)$/.exec(target.key);
      const model = this.models().find(
        (m) => m.id === match?.[1] || m.model.modelId.toLowerCase() === match?.[1],
      );
      if (!match || !model) throw Error('当前 IFC 来源未就绪');
      const id = Number(match[2]);
      this.add(this.hiddenExpress, model.id, [id]);
      const guid = this.state.ifc.regionalRuntimes
        .get(model.id)
        ?.index.objects.find((o) => o.expressId === id)?.globalId;
      if (guid) this.add(this.hiddenGuids, model.id, [guid]);
    } else if (target.kind === 'ifc-element') {
      const split = target.key.lastIndexOf(':'),
        id = target.key.slice(0, split),
        local = Number(target.key.slice(split + 1));
      if (split < 0 || !Number.isInteger(local)) throw Error('IFC 对象身份不可用');
      const model = this.ctx.fragments.list.get(id);
      if (!model) throw Error('IFC 模型已移除');
      this.add(this.hiddenLocals, model, [local]);
    } else throw Error('当前选择缺少可隐藏的范围');
  }
  async command(c: ViewerCommand) {
    if (c.kind === 'refreshOptions') {
      await this.options();
      return;
    }
    if (c.kind === 'model') {
      const row = this.models().find((m) => m.id === c.id);
      if (row) setSourceLayerVisibility(this.state, row.id, row.model, c.visible);
      return;
    }
    if (c.kind === 'restore') {
      this.reset(false);
      this.snap.floor = '';
      this.snap.inferred = false;
      this.snap.hiddenTypes = [];
      this.state.selection.setOnlySelected(false);
    } else if (c.kind === 'isolate') {
      this.state.selection.setOnlySelected(true);
      return;
    } else if (c.kind === 'hide') this.hide();
    else if (c.kind === 'type') {
      const types = new Set(this.snap.hiddenTypes);
      if (c.visible) types.delete(c.id);
      else types.add(c.id);
      this.snap.hiddenTypes = [...types];
    } else if (c.kind === 'floor') {
      if (c.id && !this.floors.has(c.id)) throw Error('楼层尚未就绪');
      this.snap.floor = c.id;
      this.snap.inferred = c.inferred;
    }
    this.snap.hasMask = this.active;
    await this.apply();
  }
  async apply() {
    const seq = ++this.revision,
      session = this.state.captureProjectSession(),
      current = () => seq === this.revision && this.state.isCurrentSession(session);
    const floor = this.floors.get(this.snap.floor);
    const index = getEngineeringRepresentations(this.state)?.index;
    const owners = new Set<string>(),
      cbms = new Set<string>();
    const spatial = this.state.substationSpatialIndex;
    const node = floor?.spatialKey && spatial?.nodeByKey.get(floor.spatialKey);
    const spatialObjects = new Map<number, string>();
    if (node && spatial) {
      const stack = [node],
        seen = new Set<string>();
      while (stack.length) {
        const next = stack.pop()!;
        if (seen.has(next.key)) continue;
        seen.add(next.key);
        for (const objKey of next.objectKeys) {
          const obj = spatial.objectByKey.get(objKey);
          if (!obj) continue;
          spatialObjects.set(obj.expressId, obj.globalId);
          for (const source of index?.sourcesForIfc(obj.modelId, obj.expressId) ?? []) {
            const owner = index?.ownerBySource.get(source);
            if (owner) owners.add(owner);
          }
        }
        for (const link of spatial.linksBySpatialKey.get(next.key) ?? [])
          if (
            link.confidence === 'confirmed' ||
            (this.snap.inferred && link.confidence === 'inferred')
          )
            cbms.add(link.cbmPath);
        for (const k of next.childKeys) {
          const child = spatial.nodeByKey.get(k);
          if (child && child.kind !== 'storey') stack.push(child);
        }
      }
      if (this.snap.inferred) {
        const suffix =
          '/storey:' + encodeURIComponent('floor:' + node.sourcePath + '#' + node.expressId);
        const composition = this.state.engineering.navigation?.composition;
        const groups = [...(composition?.nodes.values() ?? [])].filter((n) =>
          n.key.endsWith(suffix),
        );
        while (groups.length) {
          const n = groups.pop()!;
          if (n.inferred && n.targetId) owners.add(n.targetId);
          for (const k of n.children) {
            const child = composition?.nodes.get(k);
            if (child) groups.push(child);
          }
        }
      }
    }
    const masks = new Map<string, Mask>();
    for (const { model, id } of this.models()) {
      const deny = new Set(this.hiddenLocals.get(model)),
        express = new Set(this.hiddenExpress.get(id));
      const guids = new Set(this.hiddenGuids.get(id));
      for (const g of deny.size ? await model.getGuidsByLocalIds([...deny]) : [])
        if (g) guids.add(g);
      if (!current()) return;
      if (guids.size) this.add(this.hiddenGuids, id, guids);
      for (const l of guids.size ? await model.getLocalIdsByGuids([...guids]) : [])
        if (l !== null) deny.add(l);
      const allow = floor ? new Set(floor.model === id ? floor.local : []) : null;
      if (allow && floor?.model === id && spatialObjects.size) {
        const explicit = [...new Set(spatialObjects.values())].filter(Boolean);
        for (const n of await model.getLocalIdsByGuids(explicit)) if (n !== null) allow.add(n);
      }
      const floorGuids = new Set(allow?.size ? await model.getGuidsByLocalIds([...allow]) : []);
      const allowedExpress = floor
        ? new Set<number>(floor.model === id ? spatialObjects.keys() : [])
        : null;
      if (floor || guids.size || this.snap.hiddenTypes.length)
        for (const obj of this.state.ifc.regionalRuntimes.get(id)?.index.objects ?? []) {
          if (guids.has(obj.globalId) || this.snap.hiddenTypes.includes(obj.ifcType))
            express.add(obj.expressId);
          if (floorGuids.has(obj.globalId)) {
            allowedExpress?.add(obj.expressId);
            for (const src of index?.sourcesForIfc(id, obj.expressId) ?? []) {
              const owner = index?.ownerBySource.get(src);
              if (owner) owners.add(owner);
            }
          }
        }
      for (const type of this.snap.hiddenTypes) {
        for (const local of await this.membersOfType(model, type)) deny.add(local);
      }
      masks.set(id, { allow, deny, express, allowedExpress });
    }
    if (!current()) return;
    const allowedSources = index?.sourcesForOwners(owners) ?? new Set<string>();
    if (floor && index && allowedSources.size) {
      const guids = new Map<string, Set<string>>();
      for (const s of allowedSources)
        for (const b of index.bySource.get(s) ?? [])
          if (b.kind === 'ifc' && !b.nonphysical) {
            masks.get(b.modelId)?.allowedExpress?.add(b.expressId);
            if (b.globalId) this.add(guids, b.modelId, [b.globalId]);
          }
      for (const { id, model } of this.models()) {
        const list = guids.get(id);
        if (list)
          for (const n of await model.getLocalIdsByGuids([...list]))
            if (n !== null) masks.get(id)?.allow?.add(n);
      }
    }
    if (!current()) return;
    this.state.toolGeometryFilter =
      floor || this.hiddenSources.size || this.hiddenRoots.size
        ? (root, mesh, group) => {
            if (this.hiddenRoots.has(root)) return false;
            const hint = devRepresentationHint(mesh, group);
            if (index?.includesDev(root, hint, this.hiddenSources)) return false;
            return !floor || cbms.has(root) || !!index?.includesDev(root, hint, allowedSources);
          }
        : null;
    refreshToolGeometryFilter(this.state);
    const pending: Promise<void>[] = [];
    for (const { model, id } of this.models()) {
      const mask = masks.get(id);
      if (!mask) continue;
      const visibility = this.state.selection.selectionVisibility?.registerModel(id, model);
      if (visibility) pending.push(visibility.setBrowseMask(mask.allow, mask.deny));
      this.state.ifc.regionalRuntimes.get(id)?.setBrowseMask(mask.allowedExpress, mask.express);
    }
    this.state.substationConnectionPreview?.setBrowsePredicate?.(
      this.active
        ? (id, n) => {
            const mask = masks.get(id);
            return (
              !!mask && !mask.express.has(n) && (!mask.allowedExpress || mask.allowedExpress.has(n))
            );
          }
        : null,
    );
    await Promise.all(pending);
    if (current()) await this.ctx.fragments.core.update(true);
  }
}
