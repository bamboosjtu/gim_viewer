import { it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../../app/state.js';
import { createSelectionVisibility } from '../selectionVisibility.js';
import { sameToolVisibility, ViewerToolFilters } from '../viewerToolFilters.js';
import { ViewerViewHistory } from '../../../viewer/viewHistory.js';

function fixture() {
  const state = new AppState();
  state.activateProject(1, 'fixture');
  function source(modelId: string) {
    const visible = new Map([
      [1, true],
      [2, true],
      [3, true],
    ]);
    const model = {
      modelId,
      object: new THREE.Group(),
      getCategories: async () => ['IFCROOF', 'IFCWALL'],
      getSpatialStructure: async () => ({
        category: 'IFCBUILDINGSTOREY',
        localId: null,
        children: [
          {
            category: null,
            localId: 10,
            children: [
              { category: null, localId: 1 },
              { category: null, localId: 2 },
            ],
          },
        ],
      }),
      getItemsIdsWithGeometry: async () => [1, 2, 3],
      getItemsOfCategories: async () => ({ IFCROOF: [1] }),
      getItemsData: async () => [{ Name: { value: '一层' } }],
      getLocalIdsByGuids: async (ids: string[]) => ids.map(Number),
      getGuidsByLocalIds: async (ids: number[]) => ids.map(String),
      getVisible: async (ids: number[]) => ids.map((id) => visible.get(id)!),
      setVisible: async (ids: number[], v: boolean) => {
        for (const id of ids) visible.set(id, v);
      },
    };
    state.ifc.loadedModels.set(modelId, { modelId, runtimeModelId: modelId, visible: true });
    return { model, visible };
  }
  const a = source('A'),
    b = source('B'),
    ctx = {
      fragments: {
        list: new Map([
          ['A', a.model],
          ['B', b.model],
        ]),
        core: { update: vi.fn() },
      },
    } as any;
  state.selection.selectionVisibility = createSelectionVisibility(state, ctx);
  for (const item of [a, b])
    state.selection.selectionVisibility.registerModel(item.model.modelId, item.model);
  const controls = new THREE.EventDispatcher();
  const position = new THREE.Vector3(1, 2, 3);
  ctx.world = { camera: { controls: Object.assign(controls, {
    getPosition: (out: THREE.Vector3) => out.copy(position),
    getTarget: (out: THREE.Vector3) => out.set(0, 0, 0),
    setLookAt: async (x: number, y: number, z: number) => { position.set(x, y, z); },
  }) } };
  const filters = new ViewerToolFilters(state, ctx);
  const history = new ViewerViewHistory(ctx, 20, {
    getVisibility: () => filters.captureVisibility(),
    sameVisibility: sameToolVisibility,
    setVisibility: (snapshot, current) => filters.restoreVisibility(snapshot, current),
  });
  state.viewState.viewHistory = history;
  return { state, a, b, ctx, filters, history, position };
}

it('restores a hidden roof with the previous camera and can then return to the unfiltered view', async () => {
  const { a, ctx, filters, history, position } = fixture();
  await filters.command({ kind: 'type', id: 'IFCROOF', visible: false });
  position.set(5, 6, 7);
  ctx.world.camera.controls.dispatchEvent({ type: 'update' });
  expect(await history.back()).toBe(true);
  expect(position.toArray()).toEqual([1, 2, 3]);
  expect(a.visible.get(1)).toBe(false);
  expect(await history.back()).toBe(true);
  expect(a.visible.get(1)).toBe(true);
  history.dispose();
});

it('restores floor, temporary hiding and layer changes in the order they were applied', async () => {
  const { state, a, b, filters, history } = fixture();
  await filters.options();
  const floor = state.viewerCommands.snapshot.options.floors[0].id;
  await filters.command({ kind: 'model', id: 'B', visible: false });
  await filters.command({ kind: 'floor', id: floor, inferred: true });
  state.selection.beginSelection({ kind: 'ifc-element', key: 'A:2' });
  await filters.command({ kind: 'hide' });
  await filters.command({ kind: 'restore' });
  expect(await history.back()).toBe(true);
  expect(state.viewerCommands.snapshot.floor).toBe(floor);
  expect(state.viewerCommands.snapshot.inferred).toBe(true);
  expect([...a.visible.values()]).toEqual([true, false, false]);
  expect(await history.back()).toBe(true);
  expect([...a.visible.values()]).toEqual([true, true, false]);
  expect(await history.back()).toBe(true);
  expect(a.visible.get(3)).toBe(true);
  expect(b.model.object.visible).toBe(false);
  expect(await history.back()).toBe(true);
  expect(b.model.object.visible).toBe(true);
  history.dispose();
});

it('rejects a restored floor whose IFC lookup finishes in a later project generation', async () => {
  const { state, a, filters, history } = fixture();
  await filters.options();
  await filters.command({ kind: 'floor', id: state.viewerCommands.snapshot.options.floors[0].id, inferred: true });
  await filters.command({ kind: 'restore' });
  let finish!: () => void;
  a.model.getGuidsByLocalIds = (ids) => new Promise((resolve) => {
    finish = () => resolve(ids.map(String));
  });
  const back = history.back();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  state.activateProject(2, 'replacement');
  finish();
  expect(await back).toBe(false);
  expect(state.viewerCommands.snapshot.floor).toBe('');
  expect([...a.visible.values()]).toEqual([true, true, true]);
  history.dispose();
});
it('keeps same-name storeys distinct, composes cumulative hiding, and preserves the layer on restore', async () => {
  const { state, filters, a, b } = fixture();
  await filters.options();
  const floors = state.viewerCommands.snapshot.options.floors;
  expect(floors).toHaveLength(2);
  expect(floors[0].id).not.toBe(floors[1].id);
  await filters.command({ kind: 'floor', id: floors[0].id, inferred: false });
  expect(b.model.object.visible).toBe(false);
  expect(a.visible.get(3)).toBe(false);
  await filters.command({ kind: 'type', id: 'IFCROOF', visible: false });
  expect(a.visible.get(1)).toBe(false);
  state.selection.beginSelection({ kind: 'ifc-element', key: 'A:2' });
  await filters.command({ kind: 'hide' });
  state.selection.beginSelection(null);
  expect(a.visible.get(2)).toBe(false);
  await filters.command({ kind: 'model', id: 'B', visible: false });
  await filters.command({ kind: 'restore' });
  expect([...a.visible.values()]).toEqual([true, true, true]);
  expect(b.model.object.visible).toBe(false);
  await filters.command({ kind: 'floor', id: floors[1].id, inferred: true });
  expect(a.model.object.visible).toBe(false);
});

it('only opts in to inferred CBM links on the selected source floor', async () => {
  const { state, filters } = fixture();
  const node = {
    kind: 'storey',
    key: 'A/storey:10',
    modelId: 'A',
    expressId: 10,
    sourcePath: 'A.ifc',
    globalId: '10',
    name: '一层',
    childKeys: [],
    objectKeys: [],
  };
  state.substationSpatialIndex = {
    nodes: [node],
    nodeByKey: new Map([[node.key, node]]),
    objectByKey: new Map(),
    linksBySpatialKey: new Map([
      [
        node.key,
        [
          { cbmPath: 'direct', confidence: 'confirmed' },
          { cbmPath: 'estimated', confidence: 'inferred' },
        ],
      ],
    ]),
  } as unknown as typeof state.substationSpatialIndex;
  await filters.options();
  const id = state.viewerCommands.snapshot.options.floors.find((f) => f.label === 'A / 一层')!.id;
  const mesh = new THREE.Mesh(),
    root = new THREE.Group();
  root.add(mesh);
  await filters.command({ kind: 'floor', id, inferred: false });
  expect(state.toolGeometryFilter?.('direct', mesh, root)).toBe(true);
  expect(state.toolGeometryFilter?.('estimated', mesh, root)).toBe(false);
  await filters.command({ kind: 'floor', id, inferred: true });
  expect(state.toolGeometryFilter?.('estimated', mesh, root)).toBe(true);
  expect(state.toolGeometryFilter?.('unrelated', mesh, root)).toBe(false);
});

it('rejects type membership arriving after a session switch', async () => {
  const { state, a, filters } = fixture();
  let finish!: () => void;
  a.model.getItemsOfCategories = vi.fn(
    () =>
      new Promise<{ IFCROOF: number[] }>((resolve) => {
        finish = () => resolve({ IFCROOF: [1] });
      }),
  );
  const pending = filters.command({ kind: 'type', id: 'IFCROOF', visible: false });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  state.activateProject(2, 'new');
  finish();
  await pending;
  expect([...a.visible.values()]).toEqual([true, true, true]);
});
