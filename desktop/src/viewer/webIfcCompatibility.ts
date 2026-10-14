import { IfcAPI } from 'web-ifc';
let installed = false;
/** Installed 0.0.78 browser WASM exposes StreamMeshes(3), while its JS passes
 * the fourth scaling argument. Node WASM accepts four. Inspect the actual
 * embind signature, preserving default metre scaling in the browser. */
export function installWebIfcStreamCompatibility(): void {
  if (installed) return;
  installed = true;
  const original = IfcAPI.prototype.StreamMeshes;
  IfcAPI.prototype.StreamMeshes = function (
    model,
    ids,
    callback,
    applyLinearScalingFactor = true
  ) {
    const wasm = (this as any).wasmModule;
    if (wasm.StreamMeshes.argCount === 3) {
      if (!applyLinearScalingFactor)
        throw Error(
          'Installed browser WASM cannot disable StreamMeshes scaling'
        );
      wasm.StreamMeshes(model, ids, callback);
    } else original.call(this, model, ids, callback, applyLinearScalingFactor);
  };
}
