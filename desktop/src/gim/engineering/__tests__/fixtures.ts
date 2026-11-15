import {collectEngineeringSources,normalizeEngineeringSources} from '../buildSources.js';

/** Test composition only: production publishes source collection and recognition independently. */
export function buildTestEngineeringSources(scope:string,...input:Parameters<typeof collectEngineeringSources>){
  const sources=collectEngineeringSources(...input);
  return {sources,snapshot:normalizeEngineeringSources(scope,sources)};
}
