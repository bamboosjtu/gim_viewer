import { identityPlacement } from "../affineMatrix.js";
import type { SelectedSolid } from "./line-assembly.js";
import type { Point3 } from "../analysisGeometry.js";
export interface SelectedPile {
  shaftToRimMm: number;
  flareHeightMm: number;
  rimHeightMm: number;
  toeDepthMm: number;
  shaftDiameterMm: number;
  baseDiameterMm: number;
}
export interface SelectedPileGroup {
  piles: readonly { key: string; topMm: Point3; profile: SelectedPile }[];
  cap?: {
    centerMm: Point3;
    widthMm: number;
    lengthMm: number;
    heightMm: number;
  };
  column?: {
    centerMm: Point3;
    heightMm: number;
    section:
      | { kind: "circle"; diameterMm: number }
      | { kind: "square"; widthMm: number };
  };
  bolts?: readonly {
    key: string;
    diameterMm: number;
    lengthMm: number;
    baseToFoundation: readonly number[];
  }[];
}
const at = (p: Point3) => [...identityPlacement.slice(0, 12), ...p, 1];
/** All centres and placements are supplied by the source adapter. A cap or column centre is its lower face. */
export function selectedFoundationParts(input: SelectedPileGroup) {
  const solids: SelectedSolid[] = [],
    missing: string[] = [];
  for (const { key, topMm, profile: p } of input.piles) {
    const h = p.shaftToRimMm - p.flareHeightMm - p.rimHeightMm,
      r = p.shaftDiameterMm / 2,
      R = p.baseDiameterMm / 2;
    if (!(
      r > 0 &&
      R > 0 &&
      h >= 0 &&
      p.flareHeightMm >= 0 &&
      p.rimHeightMm >= 0 &&
      p.toeDepthMm >= 0
    )) {
      missing.push(key + ":pile-profile");
      continue;
    }
    const [x, y, top] = topMm,
      rim = top - p.shaftToRimMm;
    if (h > 0)
      solids.push({
        key: key + "/shaft",
        shape: { kind: "Cylinder", height: h, radius: r },
        placement: at([x, y, top - h]),
      });
    if (p.flareHeightMm > 0)
      solids.push({
        key: key + "/flare",
        shape: {
          kind: "TruncatedCone",
          height: p.flareHeightMm,
          topRadius: r,
          bottomRadius: R,
        },
        placement: at([x, y, rim + p.rimHeightMm]),
      });
    if (p.rimHeightMm > 0)
      solids.push({
        key: key + "/rim",
        shape: { kind: "Cylinder", height: p.rimHeightMm, radius: R },
        placement: at([x, y, rim]),
      });
    if (p.toeDepthMm > 0) missing.push(key + ":rounded-toe-profile");
  }
  const cap = input.cap;
  if (cap)
    solids.push({
      key: "cap",
      shape: {
        kind: "Cuboid",
        length: cap.lengthMm,
        width: cap.widthMm,
        height: cap.heightMm,
      },
      placement: at(cap.centerMm),
    });
  const c = input.column;
  if (c)
    solids.push({
      key: "column",
      shape:
        c.section.kind === "circle"
          ? {
              kind: "Cylinder",
              radius: c.section.diameterMm / 2,
              height: c.heightMm,
            }
          : {
              kind: "Cuboid",
              length: c.section.widthMm,
              width: c.section.widthMm,
              height: c.heightMm,
            },
      placement: at(c.centerMm),
    });
  for (const b of input.bolts ?? [])
    solids.push({
      key: b.key,
      quality: "preview-only",
      shape: { kind: "Cylinder", radius: b.diameterMm / 2, height: b.lengthMm },
      placement: b.baseToFoundation,
    });
  return { solids, missing };
}
