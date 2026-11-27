import { GEOMETRY_CACHE_VERSION } from '@gim/contracts-native';
export const DEV_SHAPE_POLICY =
  'open-steel-section-v1+sdk-basic-solids-project-column-major-v1+perforated-plates-v1+boolean-display-bounds-v1+stl-facets-v1+standard-profiles-v1+assemblies-curves-v1+wire-sweep-clearance-v1+geometry-quality-v1';
export function deviceTemplateCacheKey(
  sourceIdentity: string,
  devPath: string,
  lod: 0 | 1 | 2,
): string {
  return `${GEOMETRY_CACHE_VERSION}|${sourceIdentity}|${DEV_SHAPE_POLICY}:${devPath.toLowerCase()}|lod${lod}`;
}
