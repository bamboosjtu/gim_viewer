import type { ProjectLoadSession } from '../../shared/projectSession.js';
import type { SourceGeometryState } from '../../shared/sourceGeometryState.js';
import type { CbmNode } from '../../gim/types.js';
import type { GimProjectType } from '../../gim/projectType.js';
import type { SourceGeometryOccurrence } from '../../gim/engineering/geometryOccurrences.js';
import { collectEquipmentGeometryOccurrences } from '../../gim/equipmentGeometryOccurrences.js';
import { createEntryResolver, getFileEntryResolver } from '../../gim/entryResolver.js';

/** The renderer consumes physical source placements. Engineering classification
 * and view projection never choose or manufacture geometry roots. */
interface SourceGeometryContext {
  currentProjectType: GimProjectType | null;
  currentFiles: Map<string, File> | null;
  currentCbmTree: CbmNode | null;
  substationEntryPaths: string[];
  sourceGeometry: SourceGeometryState;
  isCurrentSession(session: ProjectLoadSession): boolean;
}
export async function getSourceGeometryOccurrences(
  state: SourceGeometryContext,
  session: ProjectLoadSession,
): Promise<SourceGeometryOccurrence[]> {
  const isCurrent = () => state.isCurrentSession(session);
  if (state.currentProjectType === 'equipment') {
    if (!isCurrent()) return [];
    const resolve = state.currentFiles
      ? getFileEntryResolver(state.currentFiles)
      : createEntryResolver(state.substationEntryPaths);
    return collectEquipmentGeometryOccurrences(state.currentCbmTree).map((row) => ({
      ...row,
      devPath: resolve(row.devPath, row.sourceContextId) ?? row.devPath,
    }));
  }
  return state.sourceGeometry.read(isCurrent);
}
