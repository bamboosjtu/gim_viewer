import { canInspectDoorPanels, mappedDoorLeaves, type MappedDoorLeaf } from './mappedDoorLeaves.js';
import { readDoorMotion, type DoorMotionDescriptor } from './doorMotion.js';
import { IFCPRODUCT, type IfcAPI } from 'web-ifc';
import { Box3, Matrix4, Vector3 } from 'three';
import type { RegionalIndex } from '../ifcRegionalData.js';
import { extractIfcObjectFine } from '../ifcObjectFineData.js';

export interface NavigationProduct {
  expressId: number;
  globalId: string;
  type: string;
  label: string;
  bounds: number[];
  door?: DoorMotionDescriptor;
  leaves?: MappedDoorLeaf[];
  allPartsMovable?: boolean;
}
export interface IfcNavigationCatalog {
  products: NavigationProduct[];
  unknown: string[];
}

/** The display index can omit products. Establish the expected physical source set from the original model. */
export function navigationCatalog(
  api: IfcAPI,
  model: number,
  index: RegionalIndex,
): IfcNavigationCatalog {
  const bounds = new Map(index.objects.map((o) => [o.expressId, o.bounds]));
  const ids = api.GetLineIDsWithType(model, IFCPRODUCT, true),
    products: NavigationProduct[] = [],
    unknown: string[] = [];
  try {
    for (let i = 0; i < ids.size(); i++) {
      const id = ids.get(i);
      try {
        const line = api.GetLine(model, id, false) as {
          type: number;
          Representation?: { value: number };
          GlobalId?: { value: string };
          Name?: { value: string };
          ObjectType?: { value: string };
        };
        const type = api.GetNameFromTypeCode(line.type).toUpperCase();
        if (
          !line.Representation ||
          /^(IFCOPENING(ELEMENT|STANDARDCASE)|IFCSPACE|IFCANNOTATION|IFCVIRTUALELEMENT|IFCSPATIALZONE|IFCGRID)$/.test(
            type,
          )
        )
          continue;
        const globalId = String(line.GlobalId?.value ?? '');
        let evaluated: ReturnType<typeof extractIfcObjectFine> | undefined;
        const read = () => (evaluated ??= extractIfcObjectFine(api, model, id, globalId));
        let box = bounds.get(id);
        if (!box) {
          const mesh = read(),
            extent = new Box3(),
            p = new Vector3();
          for (const part of mesh.parts) {
            const m = new Matrix4().fromArray(part.matrix);
            for (const idx of part.indices)
              extent.expandByPoint(p.fromArray(part.vertices, idx * 6).applyMatrix4(m));
          }
          if (extent.isEmpty()) throw Error('无可用空间范围');
          box = [...extent.min.toArray(), ...extent.max.toArray()];
        }
        if (!globalId || box.length !== 6 || !box.every(Number.isFinite))
          throw Error('来源身份或范围未知');
        const label = [line.Name?.value, line.ObjectType?.value].filter(Boolean).join(' ');
        const door = readDoorMotion(api, model, id, type, label, index.unitScale);
        let leaves: MappedDoorLeaf[] | undefined,
          allPartsMovable = false;
        if (!door && canInspectDoorPanels(type, label)) {
          try {
            const result = read();
            leaves = mappedDoorLeaves(type, label, result.parts);
            allPartsMovable =
              leaves.length > 0 &&
              new Set(leaves.flatMap((l) => l.parts)).size === result.parts.length;
          } catch {
            /* The source still participates as static collision. */
          }
        }
        products.push({
          expressId: id,
          globalId,
          type,
          label,
          bounds: box,
          door,
          leaves,
          allPartsMovable,
        });
      } catch {
        unknown.push(String(id));
      }
    }
  } finally {
    (ids as unknown as { delete?: () => void }).delete?.();
  }
  return { products, unknown };
}
