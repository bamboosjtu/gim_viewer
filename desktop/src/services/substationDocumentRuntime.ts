import { reportBackgroundError } from '../utils/backgroundErrors.js';
import { loadPresentation } from './presentationPort.js';
/** Optional STD/SLD parsing and cache restore. */
import type { AppState, ProjectLoadSession } from '../app/state.js';
import { perfBegin, perfMarkProductMoment, type PerfSession } from '../utils/perfTimings.js';
import { setupSldGridIdInteraction } from './substationPresentation.js';

export async function buildAndCommitSubstationStdSld(
  state: AppState,
  files: Map<string, File> | null,
  cacheEntryPaths: readonly string[],
  session: ProjectLoadSession,
  perfSession: PerfSession,
  showMessage: (text: string) => void,
  source: 'cold' | 'warm',
): Promise<boolean> {
  if (!state.isCurrentSession(session)) return false;
  const label = source === 'cold' ? '变电 STD/SLD 解析' : '变电 STD/SLD 缓存恢复';
  perfMarkProductMoment('stdSldStart', { source }, perfSession);
  const endStdSld = perfBegin(label, undefined, perfSession);
  try {
    const {
      commitStdSldResult,
      findMissingStdSldCacheParts,
      parseStdSldOnGimExtracted,
      restoreStdSldFromCache,
    } = await import('./stdSldService.js');
    if (!state.isCurrentSession(session)) return false;

    const result = files
      ? await parseStdSldOnGimExtracted(state, files)
      : await restoreStdSldFromCache(state);
    if (!state.isCurrentSession(session)) return false;

    if (!files) {
      const missingParts = findMissingStdSldCacheParts(cacheEntryPaths, result);
      if (missingParts.length > 0) {
        throw new Error(`本地缓存缺少电气图数据（${missingParts.join('/')}）`);
      }
    }

    // STD/SLD services return a local result and do not commit AppState.  The
    // session fence immediately before/after this commit is intentional:
    // delayed A results must never become B's source-tracing state.
    commitStdSldResult(state, result);
    if (!state.isCurrentSession(session)) return false;

    let rendered = false;
    try {
      const { renderSldView } = await loadPresentation('sldView');
      if (!state.isCurrentSession(session)) return false;
      renderSldView(state);
      rendered = true;
    } catch (err) {
      if (state.isCurrentSession(session)) {
        console.warn(`[GIM] SLD 视图渲染失败（${source}）:`, err);
      }
    }
    if (!state.isCurrentSession(session)) return false;

    // Register the callback only after the corresponding documents/index have
    // been committed.  The callback itself keeps a session guard for clicks
    // that arrive while another project is opening.
    if (result) {
      void Promise.resolve(setupSldGridIdInteraction(state, showMessage, session)).catch(reportBackgroundError);
    }
    endStdSld(undefined, {
      source,
      available: result != null,
      schEntries: result?.schEntries.length ?? 0,
      hasStd: result?.stdDoc != null,
      hasSld: result?.sldDoc != null,
      rendered,
    });
    perfMarkProductMoment('stdSldReady', {
      source,
      available: result != null,
      schEntries: result?.schEntries.length ?? 0,
      hasStd: result?.stdDoc != null,
      hasSld: result?.sldDoc != null,
      rendered,
    }, perfSession);
    return result != null;
  } catch (err) {
    if (!state.isCurrentSession(session)) return false;
    // Do not leave a partial document/index from a failed current-session
    // attempt visible.  This clears only the STD/SLD projection; IFC and core
    // semantic state remain intact.
    try {
      const { commitStdSldResult } = await import('./stdSldService.js');
      if (!state.isCurrentSession(session)) return false;
      commitStdSldResult(state, null);
    } catch (clearErr) {
      console.warn('[GIM] 清理失败的 STD/SLD 状态失败:', clearErr);
    }
    endStdSld('（失败）', {
      source,
      error: err instanceof Error ? err.message : String(err),
    });
    perfMarkProductMoment('stdSldReady', {
      source,
      available: false,
      error: err instanceof Error ? err.message : String(err),
    }, perfSession);
    console.warn(`[GIM] STD/SLD 后台任务失败（${source}），不影响 IFC interactive:`, err);
    return false;
  }
}
