import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { SourceGeometryOccurrence } from '../gim/engineering/geometryOccurrences.js';
import { collectEquipmentGeometryOccurrences } from '../gim/equipmentGeometryOccurrences.js';
import { createEntryResolver, getFileEntryResolver } from '../gim/entryResolver.js';

/** The renderer consumes physical source placements. Engineering classification
 * and view projection never choose or manufacture geometry roots. */
export async function getSourceGeometryOccurrences(state: AppState, session: ProjectLoadSession): Promise<SourceGeometryOccurrence[]> {
  if (!state.isCurrentSession(session)) return [];
  if (state.currentProjectType === 'equipment') {
    const resolve = (state.currentFiles ? getFileEntryResolver(state.currentFiles) : createEntryResolver(state.substationEntryPaths));
    return collectEquipmentGeometryOccurrences(state.currentCbmTree).map(row => ({ ...row, devPath: resolve(row.devPath, row.sourceContextId) ?? row.devPath }));
  }
  const catalog = state.engineeringGeometryCatalog ?? await state.engineeringGeometryReady;
  if (!state.isCurrentSession(session)) return [];
  if (!catalog) throw Error('来源物理实例尚不可用，请查看来源解析诊断');
  return catalog.occurrences;
}
