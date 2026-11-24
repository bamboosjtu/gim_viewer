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

function emptyFilters() {
  return {
    roots: new Set<string>(),
    sources: new Set<string>(),
    locals: new Map<string, Set<number>>(),
    express: new Map<string, Set<number>>(),
    guids: new Map<string, Set<string>>(),
    types: [] as readonly string[],
    floor: '',
    inferred: false,
  };
}
type BrowseFilters = ReturnType<typeof emptyFilters>;

export interface ToolVisibilitySnapshot {
  filters: BrowseFilters;
  hiddenLayers: readonly string[];
  isolatedSelection: number | null;
}

export function sameToolVisibility(a: ToolVisibilitySnapshot, b: ToolVisibilitySnapshot): boolean {
  return (
    a.filters === b.filters &&
    a.isolatedSelection === b.isolatedSelection &&
    a.hiddenLayers.length === b.hiddenLayers.length &&
    a.hiddenLayers.every((id, i) => id === b.hiddenLayers[i])
  );
}

function hasMask(filters: BrowseFilters): boolean {
  return !!(
    filters.roots.size ||
    filters.sources.size ||
    filters.locals.size ||
    filters.express.size ||
    filters.types.length ||
    filters.floor
  );
}

function copyMembers<T>(members: Map<string, Set<T>>): Map<string, Set<T>> {
  return new Map([...members].map(([id, values]) => [id, new Set(values)]));
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
  private filters = emptyFilters();
  private applied = this.filters;
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
    return hasMask(this.filters) || hasMask(this.applied);
  }

  captureVisibility(): ToolVisibilitySnapshot {
    const { selection, ifc } = this.state;
    return {
      filters: this.applied,
      hiddenLayers: [...ifc.loadedModels]
        .filter(([, entry]) => !entry.visible)
        .map(([id]) => id)
        .sort(),
      isolatedSelection: selection.onlySelected ? (selection.selectionRequest?.id ?? null) : null,
    };
  }

  async restoreVisibility(
    snapshot: ToolVisibilitySnapshot,
    restoring: () => boolean,
  ): Promise<boolean> {
    const session = this.state.captureProjectSession();
    const current = () => restoring() && this.state.isCurrentSession(session);
    if (!current()) return false;
    const next =
      snapshot.filters.floor && !this.floors.has(snapshot.filters.floor)
        ? { ...snapshot.filters, floor: '', inferred: false }
        : snapshot.filters;
    if ((next !== this.applied || next !== this.filters) && !(await this.apply(next, current)))
      return false;
    if (!current()) return false;
    const hidden = new Set(snapshot.hiddenLayers);
    for (const { id, model } of this.models()) {
      if (this.state.ifc.loadedModels.get(id)?.visible === hidden.has(id))
        setSourceLayerVisibility(this.state, id, model, !hidden.has(id), false);
    }
    const selection = this.state.selection;
    const only =
      snapshot.isolatedSelection !== null &&
      snapshot.isolatedSelection === selection.selectionRequest?.id;
    if (selection.onlySelected !== only) await selection.setOnlySelected(only, false);
    return current();
  }

  reset() {
    this.optionRevision++;
    this.revision++;
    this.filters = this.applied = emptyFilters();
    this.floors.clear();
    this.state.toolGeometryFilter = null;
  }
  private models() {
    return [...this.ctx.fragments.list.values()].map((model) => ({
      model,
      id: this.state.ifc.resolveLogicalModelId(model.modelId) ?? model.modelId,
    }));
  }
  async modelsChanged() {
    const floor = this.floors.get(this.filters.floor);
    if (floor && !this.state.ifc.loadedModels.has(floor.model)) {
      this.snap.message = '原楼层来源已移除';
      await this.apply({ ...this.filters, floor: '', inferred: false });
    } else if (this.active) await this.apply();
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
        const counts = new Map<string, number>();
        for (const guid of guids) if (guid) counts.set(guid, (counts.get(guid) ?? 0) + 1);
        const spatialByGuid = new Map<string, (typeof nodes)[number] | null>();
        for (const node of nodes) {
          if (node.globalId)
            spatialByGuid.set(node.globalId, spatialByGuid.has(node.globalId) ? null : node);
        }
        const represented = new Set<string>();
        for (const [i, local] of localFloors.entries()) {
          const guid = guids[i];
          const unique = guid && counts.get(guid) === 1;
          const node = unique ? spatialByGuid.get(guid) : undefined;
          if (node) represented.add(node.key);
          const key = unique ? ['guid', guid] : ['local', local];
          floors.set(JSON.stringify([id, ...key]), {
            model: id,
            local: info.floors.get(local)!,
            spatialKey: node?.key,
            label: label + ' / ' + (node?.name || floorNames.get(local) || '楼层 #' + local),
          });
        }
        for (const node of nodes) {
          if (represented.has(node.key)) continue;
          floors.set(JSON.stringify([id, 'spatial', node.key]), {
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
    const removedFloor = this.filters.floor && !floors.has(this.filters.floor);
    this.floors = floors;
    if (removedFloor) {
      this.snap.message = '原楼层来源已移除';
      await this.apply({ ...this.filters, floor: '', inferred: false });
      if (seq !== this.optionRevision || !this.state.isCurrentSession(session)) return;
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
  private hide(): BrowseFilters {
    // Copy only for a new hide. Camera history retains the immutable filter value.
    const next = {
      ...this.filters,
      roots: new Set(this.filters.roots),
      sources: new Set(this.filters.sources),
      locals: copyMembers(this.filters.locals),
      express: copyMembers(this.filters.express),
      guids: copyMembers(this.filters.guids),
    };
    const selection = this.state.selection,
      scope = selection.engineeringSelection,
      target = selection.selectionRequest?.target;
    if (!selection.canIsolateSelection || !target) throw Error('请选择具有可靠表示范围的对象');
    if (scope && scope.requestId === selection.selectionRequest?.id) {
      if (
        scope.ifc.some((ref) => !ref.globalId) ||
        selection.selectionGeometry?.status === 'ambiguous'
      ) {
        this.snap.message = '粗略或多义表示保留，仅隐藏已绑定的范围';
      }
      for (const source of scope.sourceIds) next.sources.add(source);
      for (const ref of scope.ifc) {
        this.add(next.express, ref.modelId, [ref.expressId]);
        if (ref.globalId) this.add(next.guids, ref.modelId, [ref.globalId]);
      }
    } else if (target.kind === 'cbm') next.roots.add(target.key);
    else if (target.kind === 'ifc-object') {
      const match = /^ifc:(.*):object:(\d+)$/.exec(target.key);
      const model = this.models().find(
        (m) => m.id === match?.[1] || m.model.modelId.toLowerCase() === match?.[1],
      );
      if (!match || !model) throw Error('当前 IFC 来源未就绪');
      const id = Number(match[2]);
      this.add(next.express, model.id, [id]);
      const guid = this.state.ifc.regionalRuntimes
        .get(model.id)
        ?.index.objects.find((o) => o.expressId === id)?.globalId;
      if (guid) this.add(next.guids, model.id, [guid]);
    } else if (target.kind === 'ifc-element') {
      const split = target.key.lastIndexOf(':'),
        id = target.key.slice(0, split),
        local = Number(target.key.slice(split + 1));
      if (split < 0 || !Number.isInteger(local)) throw Error('IFC 对象身份不可用');
      const model = this.ctx.fragments.list.get(id);
      if (!model) throw Error('IFC 模型已移除');
      this.add(next.locals, this.state.ifc.resolveLogicalModelId(id) ?? id, [local]);
    } else throw Error('当前选择缺少可隐藏的范围');
    return next;
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
    const session = this.state.captureProjectSession();
    const history = this.state.viewState.viewHistory;
    history?.interruptRestore();
    let next = this.filters;
    if (c.kind === 'restore') {
      next = hasMask(next) || next.inferred ? emptyFilters() : next;
    } else if (c.kind === 'isolate') {
      await this.state.selection.setOnlySelected(true, false);
    } else if (c.kind === 'hide') next = this.hide();
    else if (c.kind === 'type') {
      if (next.types.includes(c.id) === c.visible) {
        next = {
          ...next,
          types: c.visible ? next.types.filter((type) => type !== c.id) : [...next.types, c.id],
        };
      }
    } else if (c.kind === 'floor') {
      if (c.id && !this.floors.has(c.id)) throw Error('楼层尚未就绪');
      if (c.id !== next.floor || c.inferred !== next.inferred)
        next = { ...next, floor: c.id, inferred: c.inferred };
    }
    if (!this.state.isCurrentSession(session)) return;
    if (c.kind !== 'isolate' && (next !== this.applied || next !== this.filters)) {
      if (!(await this.apply(next))) return;
    }
    if (c.kind === 'restore' && this.state.selection.onlySelected)
      await this.state.selection.setOnlySelected(false, false);
    if (this.state.isCurrentSession(session)) history?.recordVisibility();
  }
  async apply(next = this.filters, guard?: () => boolean): Promise<boolean> {
    if (!guard) this.filters = next;
    const seq = ++this.revision,
      session = this.state.captureProjectSession(),
      owned = () => seq === this.revision && this.state.isCurrentSession(session),
      current = () => owned() && (!guard || guard());
    const floor = this.floors.get(next.floor);
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
        const node = stack.pop()!;
        if (seen.has(node.key)) continue;
        seen.add(node.key);
        for (const objKey of node.objectKeys) {
          const obj = spatial.objectByKey.get(objKey);
          if (!obj) continue;
          spatialObjects.set(obj.expressId, obj.globalId);
          for (const source of index?.sourcesForIfc(obj.modelId, obj.expressId) ?? []) {
            const owner = index?.ownerBySource.get(source);
            if (owner) owners.add(owner);
          }
        }
        for (const link of spatial.linksBySpatialKey.get(node.key) ?? [])
          if (link.confidence === 'confirmed' || (next.inferred && link.confidence === 'inferred'))
            cbms.add(link.cbmPath);
        for (const k of node.childKeys) {
          const child = spatial.nodeByKey.get(k);
          if (child && child.kind !== 'storey') stack.push(child);
        }
      }
      if (next.inferred) {
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
      const deny = new Set(next.locals.get(id)),
        express = new Set(next.express.get(id));
      const guids = new Set(next.guids.get(id));
      for (const g of deny.size ? await model.getGuidsByLocalIds([...deny]) : [])
        if (g) guids.add(g);
      if (!current()) break;
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
      if (floor || guids.size || next.types.length)
        for (const obj of this.state.ifc.regionalRuntimes.get(id)?.index.objects ?? []) {
          if (guids.has(obj.globalId) || next.types.includes(obj.ifcType))
            express.add(obj.expressId);
          if (floorGuids.has(obj.globalId)) {
            allowedExpress?.add(obj.expressId);
            for (const src of index?.sourcesForIfc(id, obj.expressId) ?? []) {
              const owner = index?.ownerBySource.get(src);
              if (owner) owners.add(owner);
            }
          }
        }
      for (const type of next.types) {
        for (const local of await this.membersOfType(model, type)) deny.add(local);
      }
      masks.set(id, { allow, deny, express, allowedExpress });
    }
    if (!current()) return false;
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
    if (!current()) return false;
    this.filters = next;
    this.state.toolGeometryFilter =
      floor || next.sources.size || next.roots.size
        ? (root, mesh, group) => {
            if (next.roots.has(root)) return false;
            const hint = devRepresentationHint(mesh, group);
            if (index?.includesDev(root, hint, next.sources)) return false;
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
      hasMask(next)
        ? (id, n) => {
            const mask = masks.get(id);
            return (
              !!mask && !mask.express.has(n) && (!mask.allowedExpress || mask.allowedExpress.has(n))
            );
          }
        : null,
    );
    await Promise.all(pending);
    if (!owned()) return false;
    await this.ctx.fragments.core.update(true);
    if (!owned()) return false;
    this.applied = next;
    this.snap.floor = next.floor;
    this.snap.inferred = next.inferred;
    this.snap.hiddenTypes = next.types;
    this.snap.hasMask = hasMask(next);
    if (guard && !guard()) this.state.viewState.viewHistory?.recordVisibility();
    return current();
  }
}
