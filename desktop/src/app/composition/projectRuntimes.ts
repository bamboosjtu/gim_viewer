import type { GimRuntimeOpenContext } from '../../services/project/gimOpenCore.js';
import type { GimRuntimeType } from '../../services/project/gimSourceService.js';
import { openPowerlineProject } from '../../features/powerline/application/openPowerlineProject.js';
import { openSubstationProject } from '../../features/substation/application/substationRuntime.js';

export async function dispatchProjectRuntime(
  type: GimRuntimeType,
  context: GimRuntimeOpenContext,
): Promise<void> {
  const scope = context.state.sessionScope(context.session);
  if (!scope.isCurrent()) return;
  if (type === 'transmission_line') {
    await openPowerlineProject(context);
    return;
  }
  if (type === 'substation' && (await openSubstationProject(context)) !== 'equipment') return;
  if (!scope.isCurrent()) return;
  const { openEquipmentProject } =
    await import('../../features/equipment/application/openEquipmentProject.js');
  if (scope.isCurrent()) await openEquipmentProject(context);
}
