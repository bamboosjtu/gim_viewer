import { expect,it,vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { loadIfcEntry } from '../ifcEntryLoader.js';
import { registerModelEvents } from '../ifcLoader.js';
vi.mock('../ifcConversion.js', () => ({ loadRawIfc: (ctx:any,_state:any,_session:any,bytes:Uint8Array,id:string,_path:string,progress:any) =>
  ctx.ifcLoader.load(bytes,true,id,{processData:{progressCallback:progress}}), cancelIfcConversions:vi.fn() }));
type Event<T> = {
  add: (handler: (value: T) => void) => void;
  emit: (value: T) => void;
};

function createEvent<T>(): Event<T> {
  let handler: ((value: T) => void) | null = null;
  return {
    add(next) { handler = next; },
    emit(value) { handler?.(value); },
  };
}

function createContext() {
  const onItemSet = createEvent<{ value: any }>();
  const onBeforeDelete = createEvent<{ value: any }>();
  const onItemDeleted = createEvent<string>();
  const materialOnItemSet = createEvent<{ value: object }>();
  const models = new Map<string, any>() as Map<string, any> & {
    onItemSet: Event<{ value: any }>;
    onBeforeDelete: Event<{ value: any }>;
    onItemDeleted: Event<string>;
  };
  models.onItemSet = onItemSet;
  models.onBeforeDelete = onBeforeDelete;
  models.onItemDeleted = onItemDeleted;
  const makeModel = (runtimeModelId: string, inputBytes?: Uint8Array) => {
    // Normalize the test fixture to an ArrayBuffer-backed view. Newer TypeScript
    // versions model Uint8Array's default buffer as ArrayBufferLike, while the
    // Fragments API returns a concrete ArrayBuffer from getBuffer().
    const bytes: Uint8Array<ArrayBuffer> = inputBytes
      ? new Uint8Array(inputBytes)
      : new Uint8Array([9, 8, 7]);
    return {
      modelId: runtimeModelId,
      object: new THREE.Object3D(),
      useCamera: vi.fn(),
      getBuffer: vi.fn(async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    };
  };
  const addModel = (runtimeModelId: string, bytes?: Uint8Array) => {
    const model = makeModel(runtimeModelId, bytes);
    models.set(runtimeModelId, model);
    onItemSet.emit({ value: model });
    return model;
  };
  const disposeModel = vi.fn((runtimeModelId: string) => {
    const model = models.get(runtimeModelId);
    if (!model) return;
    onBeforeDelete.emit({ value: model });
    models.delete(runtimeModelId);
    onItemDeleted.emit(runtimeModelId);
  });
  const ctx = {
    world: { camera: { three: {} }, scene: { three: new THREE.Scene() } },
    fragments: {
      list: models,
      core: {
        update: vi.fn(),
        disposeModel,
        load: vi.fn(async (bytes: ArrayBuffer, _options: unknown) => {
          const runtimeModelId = (_options as { modelId: string }).modelId;
          addModel(runtimeModelId, new Uint8Array(bytes));
        }),
        models: { materials: { list: { onItemSet: materialOnItemSet } } },
      },
    },
    ifcLoader: {
      load: vi.fn(async (bytes: Uint8Array, _coordinate: boolean, runtimeModelId: string) => {
        addModel(runtimeModelId, bytes);
        return models.get(runtimeModelId);
      }),
    },
  } as any;
  return { ctx, models, addModel };
}

it.each(['full','omit-rel-voids'] as const)('loads source IFC directly for %s without a retired cache route',async openingPolicy=>{
 const state=new AppState();state.activateProject(1,'sha');const {ctx}=createContext();
 registerModelEvents(ctx,state,{onModelAdded:vi.fn(),onModelRemoved:vi.fn()} as any);
 const read=vi.fn(async()=>new Uint8Array([1,2,3]));
 await loadIfcEntry(ctx,state,{name:'a',path:'Sources/a.ifc',modelId:'a'},read,undefined,{openingPolicy});
 expect(read).toHaveBeenCalledTimes(1);expect(ctx.ifcLoader.load).toHaveBeenCalledTimes(1);expect(ctx.fragments.core.load).not.toHaveBeenCalled();
});
