import { GEOMETRY_CACHE_VERSION } from '@gim/contracts-native';
export const DEV_SHAPE_POLICY = 'open-steel-section-v1+sdk-box-cylinder-project-column-major-v1';
export function deviceTemplateCacheKey(
  sourceIdentity: string,
  devPath: string,
  lod: 0 | 1 | 2,
): string {
  return `${GEOMETRY_CACHE_VERSION}|${sourceIdentity}|${DEV_SHAPE_POLICY}:${devPath.toLowerCase()}|lod${lod}`;
}
