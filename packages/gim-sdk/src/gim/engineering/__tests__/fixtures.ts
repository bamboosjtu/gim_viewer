import {collectSourceGeometryOccurrences,sourceGeometryLocations} from '../geometry.js';
import {normalizeEngineeringSources} from '../semanticAdapter.js';
import {collectEngineeringSources} from '../buildSources.js';

/** Test composition only: production publishes source collection and recognition independently. */
export function buildTestEngineeringSources(scope:string,...input:Parameters<typeof collectEngineeringSources>){
  const sources=collectEngineeringSources(input[0],input[1],input[2],input[3],input[4]??sourceGeometryLocations(collectSourceGeometryOccurrences(input[0])));
  return {sources,snapshot:normalizeEngineeringSources(scope,sources)};
}
