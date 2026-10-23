import type { AppState, SelectionCommitGuard } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import { IfcModelVisibility, type IfcVisibilityModel, type IfcSelectionScope } from '../viewer/ifcModelVisibility.js';

/** The service owns one selection scope across all IFC representations.
 * Membership comes only from picked identity or direct GUID references. */
export function createSelectionVisibility(state: AppState, ctx: ViewerContext) {
  const models = new Map<string, IfcModelVisibility>();
  const devBaseline = new Map<import('three').Object3D, boolean>();
  let revision = 0;
  let isolating = false;
  let selectionOwner: number | null | undefined;
  let committedScopes = new Map<string, IfcSelectionScope>();
  const empty = (): IfcSelectionScope => ({localIds: new Set(), globalIds: new Set(), expressIds: new Set()});
  const logical = (id: string) => state.resolveLogicalModelId(id) ?? id;
  const report = (error: unknown) => console.warn('[Selection visibility]', error);
  const api = {
    registerModel(id: string, model: IfcVisibilityModel): IfcModelVisibility {
      const previous = models.get(id);
      if (previous?.model === model) return previous;
      previous?.release();
      const visibility = new IfcModelVisibility(model);
      models.set(id, visibility);
      if (state.onlySelected) void api.sync().catch(report);
      return visibility;
    },
    removeModel(id: string, runtimeId: string): void {
      const entry = models.get(id);
      if (entry?.model.modelId !== runtimeId) return;
      entry.release(); models.delete(id);
    },
    setModelVisible(id: string, visible: boolean): void {
      models.get(id)?.setLayerVisible(visible);
      state.ifcRegionalRuntimes.get(id)?.refreshVisibility();
    },
    async sync(guard?: SelectionCommitGuard): Promise<void> {
      if (guard && !guard.isCurrent()) return;
      const request = state.selectionRequest;
      const ownsHighlight = request && state.selectionHighlightRequestId === request.id;
      if (guard || selectionOwner !== (request?.id ?? null)) {
        committedScopes = new Map(); selectionOwner = request?.id ?? null;
        const scope = (id: string) => {
          const key = logical(id); if (!committedScopes.has(key)) committedScopes.set(key, empty());
          return committedScopes.get(key)!;
        };
        for (const [id, ids] of Object.entries(ownsHighlight ? state.highlightedItems ?? {} : {}))
          for (const localId of ids ?? []) scope(id).localIds.add(localId);
        for (const group of ownsHighlight ? state.highlightedModState?.groups ?? [] : []) {
          const data = group.userData;
          if (data.provider !== 'ifc-regional' && data.provider !== 'ifc-object-fine') continue;
          if (typeof data.modelId !== 'string' || !Number.isInteger(data.expressId)) continue;
          const row = scope(data.modelId); row.expressIds.add(data.expressId);
          if (typeof data.globalId === 'string') row.globalIds.add(data.globalId);
        }
      }
      // Ordinary browsing does not enumerate items, rebuild filters or force
      // a Fragments update. Only isolation and its restoration need this work.
      if (!state.onlySelected && !isolating) return;
      if (state.onlySelected) isolating = true;
      const currentRevision = ++revision, session = state.captureProjectSession();
      const current = () => revision === currentRevision && state.isCurrentSession(session)
        && (!request || state.isCurrentSelection(request)) && (!guard || guard.isCurrent());
      // Copy identities, never render-group references: precision replacement
      // may dispose the highlighted L1 group while this request still owns it.
      const scopes = new Map([...committedScopes].map(([id,row]) => [id, {
        localIds:new Set(row.localIds), globalIds:new Set(row.globalIds), expressIds:new Set(row.expressIds),
      }]));
      if (!state.deviceLodRuntime) {
        const selected = ownsHighlight ? state.highlightedModState?.groups ?? [] : [];
        for (const group of [...state.loadedXmlModGroups.values(), ...state.loadedStlGroups.values()]) {
          if (state.onlySelected) {
            if (!devBaseline.has(group)) devBaseline.set(group, group.visible);
            group.visible = devBaseline.get(group)! && selected.some(item => {
              for (let parent: import('three').Object3D | null = item; parent; parent = parent.parent) if (parent === group) return true;
              return false;
            });
          } else if (devBaseline.has(group)) { group.visible = devBaseline.get(group)!; devBaseline.delete(group); }
        }
      }
      // Apply empty scopes synchronously before any identity lookup. This also
      // covers a DEV selection, ambiguous sources and a cleared selection.
      const pending: Promise<void>[] = [];
      for (const entry of models.values()) {
        if (state.onlySelected) pending.push(entry.setScope(new Set()).catch(report));
      }
      state.substationConnectionPreview?.setSelectionScope?.(state.onlySelected, scopes);
      for (const [id, runtime] of state.ifcRegionalRuntimes)
        runtime.setSelectionScope(state.onlySelected, scopes.get(id)?.expressIds ?? new Set());
      for (const [id, entry] of models) {
        const row = scopes.get(id) ?? empty();
        if (row.localIds.size && state.onlySelected) {
          const guids = await entry.model.getGuidsByLocalIds([...row.localIds]);
          if (!current()) return;
          for (const guid of guids) if (guid) row.globalIds.add(guid);
        }
        if (row.globalIds.size && state.onlySelected) {
          const ids = await entry.model.getLocalIdsByGuids([...row.globalIds]);
          if (!current()) return;
          for (const localId of ids) if (localId !== null) row.localIds.add(localId);
        }
        if (!current()) return;
        const regional = state.ifcRegionalRuntimes.get(id);
        if (regional) {
          for (const guid of row.globalIds) {
            const matches = regional.index.objects.filter(object => object.globalId === guid);
            if (matches.length === 1) row.expressIds.add(matches[0].expressId);
          }
          regional.setSelectionScope(state.onlySelected, row.expressIds);
        }
        scopes.set(id, row);
        if (!state.onlySelected || row.localIds.size) pending.push(entry.setScope(state.onlySelected ? row.localIds : null));
      }
      if (!current()) return;
      state.substationConnectionPreview?.setSelectionScope?.(state.onlySelected, scopes);
      await Promise.all(pending);
      if (current()) { isolating = state.onlySelected; await ctx.fragments.core.update(true); }
    },
    reset(): void {
      revision++; isolating = false; selectionOwner = undefined; committedScopes.clear();
      for (const entry of models.values()) entry.release(); models.clear(); devBaseline.clear();
    },
  };
  return api;
}
