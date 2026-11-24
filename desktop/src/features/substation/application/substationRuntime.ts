import { logger } from '../../../utils/logger.js';
import { isTauri } from '@desktop/runtime.js';
import type { GimRuntimeOpenContext } from '../../../services/project/gimOpenCore.js';
import { validateGimCache } from '@desktop/database.js';
import { perfCurrentSession, perfBegin } from '../../../utils/perfTimings.js';
import { showLoading } from '../../../services/project/gimOpenCore.js';
import { openSubstationCold, tryOpenSubstationWarm } from './substationOpenStages.js';
export {
  createNodeClickHandler,
  setupSldGridIdInteraction,
} from '../presentation/substationPresentation.js';
export { loadAllIfcFiles } from '../runtime/substationIfcRuntime.js';

export { onGimExtracted } from './substationColdSource.js';

export async function openSubstationProject(
  context: GimRuntimeOpenContext,
): Promise<'equipment' | void> {
  const scope = context.state.sessionScope(context.session);
  if (!scope.isCurrent()) return;
  const port = context.state.navigation;
  if (port) {
    let activation: Promise<void> | undefined;
    port.execute = (action) => {
      if (action !== 'prepare' || activation) return;
      activation = import('../presentation/patrolBinding.js')
        .then(async ({ bindPatrol }) => {
          if (scope.isCurrent()) await bindPatrol(context.state, scope, context.showMessage);
        })
        .catch((error) => {
          if (scope.isCurrent()) port.set('orbit', String(error));
        })
        .finally(() => {
          activation = undefined;
        });
    };
    scope.own(() => {
      port.execute = undefined;
      port.set('orbit');
    });
  }
  try {
    const perfSession = perfCurrentSession();
    let validation: Awaited<ReturnType<typeof validateGimCache>> | null = null;

    if (context.projectId != null && isTauri()) {
      scope.withSession(() => {
        showLoading('正在检查本地缓存...');
      });
      const endValidation = perfBegin('变电缓存校验（快速路径）', undefined, perfSession);
      try {
        validation = await scope.read(async () =>
          validateGimCache(context.projectId!, 'substation'),
        );
        endValidation(undefined, {
          valid: validation.valid,
          missReason: validation.cache_miss_reason,
          ifcEntries: validation.ifc_entry_count,
          cachedIfc: validation.cached_ifc_count,
        });
      } catch (error) {
        if (!scope.isCurrent()) return;
        endValidation('（失败）', {
          error: error instanceof Error ? error.message : String(error),
        });
        logger.warn(
          '[Substation Runtime] cache validation failed, falling back to cold path:',
          error,
        );
      }
    }

    if (!validation?.valid)
      scope.withSession(() => {
        showLoading('正在解压并校验 GIM 文件...');
      });

    if (validation?.valid && (await tryOpenSubstationWarm(context, scope, perfSession, validation)))
      return;

    return await openSubstationCold(context, scope, perfSession);
  } catch (error) {
    if (!scope.isCurrent()) return;
    throw error;
  }
}
