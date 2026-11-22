import type { AppState } from '../../../app/state.js';
import type { GimGraphNode } from '@gim/powerline-core/gimGraphTypes.js';
import type { LineTextModGeometrySource } from '../../../gim/geometry/ir.js';

export interface LineModRuntimeEntry {
  path: string;
  source: LineTextModGeometrySource | null;
  error?: string;
  dependencyKind?: 'dev' | 'phm';
}

type LoadSources = (state: AppState, node: GimGraphNode) => Promise<LineModRuntimeEntry[]>;
let load: LoadSources | undefined;

export function bindLineModSourceReader(reader: LoadSources): void {
  load = reader;
}

export async function loadLineModSourcesForNode(
  state: AppState,
  node: GimGraphNode,
): Promise<LineModRuntimeEntry[]> {
  if (!load) throw Error('Line MOD source reader has not been bound');
  return load(state, node);
}
