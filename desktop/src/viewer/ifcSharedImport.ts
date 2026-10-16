import { IfcAPI, type LoaderSettings, type FlatMesh } from 'web-ifc';

/** Scoped to a single conversion Worker. Installed Fragments creates separate
 * geometry/property APIs and offers no public parsed-model input. Borrow only
 * the exact same source/settings; restore prototypes before disposing owner. */
export async function withSharedIfcImport<T>(
  owner: IfcAPI,
  model: number,
  bytes: Uint8Array,
  settings: LoaderSettings,
  observe: (mesh: FlatMesh) => void,
  run: () => Promise<T>
): Promise<T> {
  if (model !== 0) throw Error('Installed Fragments requires IFC model 0');
  const proto = IfcAPI.prototype;
  const original = {
    Init: proto.Init,
    OpenModel: proto.OpenModel,
    Dispose: proto.Dispose,
    CloseModel: proto.CloseModel,
    GetLine: proto.GetLine,
    StreamMeshes: proto.StreamMeshes,
  };
  const borrowed = new WeakSet<IfcAPI>(),
    rows = new Map<number, any>();
  const signature = JSON.stringify((owner as any).CreateSettings(settings));
  proto.Init = async function () {
    if (this === owner) throw Error('Shared IFC owner is already initialized');
    const a = this as any,
      b = owner as any;
    for (const key of [
      'wasmModule',
      'modelSchemaList',
      'modelSchemaNameList',
      'ifcGuidMap',
      'deletedLines',
    ])
      a[key] = b[key];
    borrowed.add(this);
  };
  proto.OpenModel = function (input, requested) {
    if (
      !borrowed.has(this) ||
      input !== bytes ||
      JSON.stringify((owner as any).CreateSettings(requested)) !== signature
    )
      throw Error('Shared IFC import source/settings mismatch');
    return model;
  };
  proto.Dispose = function () {
    if (!borrowed.has(this))
      throw Error('Shared IFC owner cannot be disposed by importer');
  };
  proto.CloseModel = function (id) {
    if (!borrowed.has(this) || id !== model)
      throw Error('Unexpected shared IFC close');
  };
  proto.GetLine = function (id, expressId, ...args) {
    if (id === model && !args.some(Boolean) && rows.has(expressId))
      return { ...rows.get(expressId) };
    return original.GetLine.call(this, id, expressId, ...args);
  };
  proto.StreamMeshes = function (id, ids, callback, scale = true) {
    if (id !== model || !borrowed.has(this))
      throw Error('Unexpected shared IFC stream');
    original.StreamMeshes.call(
      this,
      id,
      ids,
      (mesh, index, total) => {
        if (!rows.has(mesh.expressID))
          rows.set(
            mesh.expressID,
            original.GetLine.call(owner, model, mesh.expressID, false)
          );
        if (rows.size > 2048) rows.delete(rows.keys().next().value!);
        observe(mesh);
        callback(mesh, index, total);
      },
      scale
    );
  };
  try {
    return await run();
  } finally {
    Object.assign(proto, original);
    rows.clear();
  }
}
