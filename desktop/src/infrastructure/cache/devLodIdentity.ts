import { GEOMETRY_CACHE_VERSION } from '@gim/contracts-native';
export function deviceTemplateCacheKey(
  sourceIdentity: string,
  devPath: string,
  lod: 0 | 1 | 2,
): string {
  return `${GEOMETRY_CACHE_VERSION}|${sourceIdentity}|${devPath.toLowerCase()}|lod${lod}`;
}
