import { GEOMETRY_CACHE_VERSION } from '@gim/contracts-native';
export const STEEL_SECTION_POLICY = 'open-steel-section-v1';
export function deviceTemplateCacheKey(
  sourceIdentity: string,
  devPath: string,
  lod: 0 | 1 | 2,
): string {
  return `${GEOMETRY_CACHE_VERSION}|${sourceIdentity}|${STEEL_SECTION_POLICY}:${devPath.toLowerCase()}|lod${lod}`;
}
