import { expect, it, vi } from 'vitest';
import { AppState } from '../../app/state.js';
import { buildIfcNameIndex } from '../ifcNameIndex.js';

it('enriches models once, shares concurrent work and rejects stale names', async () => {
  const state = new AppState();
  const session = state.activateProject(1, 'A');
  state.currentIfcEntries = [{ modelId: 'ifc-a', path: 'CBM/a.ifc', name: 'a.ifc' }];
  const node: any = { ifcFile: 'CBM/a.ifc', ifcGuid: 'guid', name: 'CBM' };
  state.ifcGuidIndex.set('guid', node);
  const model = { getLocalIdsByGuids: vi.fn(async () => [1]),
    getItemsData: vi.fn(async () => [{ Name: { value: 'IFC' } }]) };
  const models = new Map([[state.getRuntimeModelId('ifc-a', session), model]]);
  const ctx: any = { fragments: { list: models } };
  await Promise.all([buildIfcNameIndex(ctx, state, { session }), buildIfcNameIndex(ctx, state, { session })]);
  expect(node.name).toBe('IFC');
  expect(model.getItemsData).toHaveBeenCalledTimes(1);
  expect(model.getItemsData).toHaveBeenCalledWith([1], {
    attributesDefault: false, attributes: ['Name'],
    relationsDefault: { attributes: false, relations: false },
  });
  // A new model instance must be enriched even when the logical ID is reused.
  let finish!: (data: any) => void;
  const next = { ...model, getItemsData: vi.fn(() => new Promise<any>(resolve => { finish = resolve; })) };
  models.set(state.getRuntimeModelId('ifc-a', session), next);
  const pending = buildIfcNameIndex(ctx, state, { session });
  await vi.waitFor(() => expect(next.getItemsData).toHaveBeenCalledOnce());
  state.activateProject(2, 'B');
  finish([{ Name: { value: 'stale' } }]);
  await pending;
  expect(node.name).toBe('IFC');
});
