import type { AppState, SelectionRequest } from '../../app/state.js';
import { selectionPresentation } from '../presentation/selectionPresentationPort.js';
import { beginSelectionStage } from './selectionTiming.js';

/** UI projections follow the request; rendering a tree never starts a selection. */
export async function syncSelectionNavigation(
  state: AppState,
  request: SelectionRequest,
): Promise<void> {
  const end = beginSelectionStage(state, request, 'navigation');
  try {
    await selectionPresentation().syncNavigation(state, request, async () => {
      const { getGridIdByCbmPath } = await import('../../gim/stdSldIndex.js');
      return () =>
        request.target?.kind === 'sld'
          ? request.target.key
          : request.target?.kind === 'cbm' && state.currentStdSldIndex
            ? getGridIdByCbmPath(state.currentStdSldIndex, request.target.key)
            : null;
    });
  } finally {
    end();
  }
}
