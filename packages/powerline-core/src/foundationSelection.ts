import type { KeyValueModFile } from "@gim/gim-primitives/geometry/ir.js";
/** Fig. B.4, Q/GDW 11810.2. Dimensions are mm and the top centre is the origin.
 * e1/e2 occur on other families and carry no displacement for a single pile. */
export function readSinglePile(source: KeyValueModFile) {
  if (
    !("H1" in source) ||
    !["挖孔桩基础", "灌注桩单桩基础"].includes(source.type)
  )
    return;
  const { H1, H2, H3, H4, d, D } = source;
  if (D === undefined || ![H1, H2, H3, H4, d, D].every(Number.isFinite)) return;
  return {
    shaftToRimMm: H1,
    flareHeightMm: H2,
    rimHeightMm: H3,
    toeDepthMm: H4,
    shaftDiameterMm: d,
    baseDiameterMm: D,
  };
}
