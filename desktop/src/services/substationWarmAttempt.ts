import { logger } from '../utils/logger.js';
import type { AppState } from '../app/state.js';

/**
 * Release hosts claimed before a warm attempt can fail. Cold fallback creates
 * a new attempt; old queue, preview, monitor and overview must not survive.
 */
export function releaseWarmIfcAttempt(state: AppState): void {
  const queue = state.substationFineQueue as unknown as {
    cancelPending?: () => void;
  } | null;
  state.substationFineQueue = null;
  try {
    queue?.cancelPending?.();
  } catch (error) {
    logger.warn('[Substation Runtime] warm background queue release failed:', error);
  }
  const preview = state.substationConnectionPreview;
  state.substationConnectionPreview = null;
  try {
    preview?.release();
  } catch (error) {
    logger.warn('[Substation Runtime] warm connection preview release failed:', error);
  }
  const monitor = state.substationResourceMonitor;
  state.substationResourceMonitor = null;
  try {
    monitor?.release();
  } catch (error) {
    logger.warn('[Substation Runtime] warm resource monitor release failed:', error);
  }
  state.viewState.stationOverview = null;
  state.ifcLoading.pending = false;
}
