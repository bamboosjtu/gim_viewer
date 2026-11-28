import { compileIfcObject, type IfcObjectInput } from '@gim/gim-sdk/geometry';

/** Regional cache records were captured by a source-coordinate worker. New providers can supply an explicit frame. */
export function compileIfcParts(
  object: Pick<IfcObjectInput, 'modelId' | 'sourcePath' | 'expressId' | 'globalId'>,
  result: Pick<IfcObjectInput, 'parts'> & Partial<Pick<IfcObjectInput, 'frame'>>,
  sourceVersion: string,
  lod: 1 | 2,
) {
  return compileIfcObject(
    { ...object, sourceVersion, parts: result.parts, frame: result.frame ?? { kind: 'source' } },
    lod,
  );
}
