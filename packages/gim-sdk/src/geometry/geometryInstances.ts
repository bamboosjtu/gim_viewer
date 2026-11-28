import { composePlacement, isUsableAffineMatrix } from "./affineMatrix.js";
import type {
  CompiledGeometrySource,
  GeometryBatch,
  GeometryObjectResult,
  GeometryOccurrence,
  GeometrySourceAddress,
} from "./contracts/geometryBatch.js";

export function placeGeometrySource(
  source: CompiledGeometrySource,
  occurrences: readonly GeometryOccurrence[],
): GeometryBatch {
  const objects: GeometryObjectResult[] = [];
  for (const occurrence of occurrences) {
    const usable = isUsableAffineMatrix(occurrence.localToParent);
    for (const local of source.objects) {
      const address: GeometrySourceAddress = {
        format: source.format,
        sourceVersion: source.sourceVersion,
        sourcePath: source.sourcePath,
        rootOccurrence: occurrence.rootOccurrence,
        assemblyPath: occurrence.assemblyPath,
        referencePath: occurrence.referencePath,
        entityId: local.entityId,
        ordinal: local.ordinal,
      };
      const geometry = local.geometry;
      const parts =
        usable && geometry
          ? [
              {
                ...geometry,
                address,
                instanceId: JSON.stringify([
                  address.format,
                  address.sourceVersion,
                  address.sourcePath,
                  address.rootOccurrence,
                  address.assemblyPath,
                  address.referencePath,
                  address.entityId,
                  address.ordinal,
                ]),
                localToParent: composePlacement(
                  occurrence.localToParent,
                  local.localToSource,
                ),
              },
            ]
          : [];
      objects.push({
        address,
        parts,
        visible: local.visible,
        availability: usable ? local.availability : "unavailable",
        range: local.range,
        ports: local.ports.map((port) => ({ ...port, address })),
        diagnostics: usable
          ? local.diagnostics
          : [
              ...local.diagnostics,
              {
                stage: "compose",
                code: "invalid-source-matrix",
                severity: "error",
                message: "Invalid occurrence placement",
                location: {
                  path: address.sourcePath,
                  ordinal: address.ordinal,
                  entityId: address.entityId,
                },
              },
            ],
      });
    }
  }
  return {
    requestedLod: source.requestedLod,
    templates: source.templates,
    objects,
    diagnostics: source.diagnostics,
  };
}

/** For postMessage(batch, list). Retain uses structured cloning. Move relinquishes
 * all sender aliases, including the compiled source and other placements of it. */
export function geometryTransferList(
  batch: GeometryBatch,
  ownership: "retain" | "move",
): ArrayBuffer[] {
  if (ownership === "retain") return [];
  const buffers = new Set<ArrayBuffer>();
  function add(view: ArrayBufferView | undefined) {
    if (!view) return;
    if (!(view.buffer instanceof ArrayBuffer))
      throw new TypeError(
        "Moving geometry requires exclusively owned ArrayBuffers",
      );
    buffers.add(view.buffer);
  }
  for (const template of batch.templates.values()) {
    if (template.kind === "line-segments") {
      add(template.positions);
      continue;
    }
    const mesh = template.mesh;
    add(mesh.positions);
    add(mesh.normals);
    add(mesh.indices);
    add(mesh.uvs);
  }
  return [...buffers];
}
