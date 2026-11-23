import { isTauri } from '@desktop/runtime.js';
import type { AppState } from '../state.js';
import { btnCacheManager, btnClear, btnLoadGim, btnLoadLocal } from '../../ui/dom.js';
import { setupViewerShell } from '../../ui/shell/viewerShell.js';
import { setStatusRight } from '../../ui/shell/statusBar.js';
import { registerPropertyReferenceHandler } from '../../ui/propertyDictionary.js';
import { scheduleHideLoading, showLoading } from '../../services/project/gimOpenCore.js';
import { logger } from '../../utils/logger.js';
import { reportBackgroundError } from '../../utils/backgroundErrors.js';
import { closeProject, openGimProjectFromId, openGimWithDialog } from './projectActions.js';

export function bindProjectShell(state: AppState): void {
  const showError = (label: string, error: unknown) => {
    const generation = state.projectGeneration;
    logger.error(label, error);
    showLoading(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    scheduleHideLoading(() => state.projectGeneration === generation, 3000);
  };
  const openRecent = (id: number) => {
    showLoading('正在打开最近工程...');
    return openGimProjectFromId(state, showLoading, id).catch((error) =>
      showError('打开最近工程失败', error),
    );
  };
  setupViewerShell(state, openRecent);

  registerPropertyReferenceHandler((detail) => {
    const session = state.captureProjectSession();
    const current = () => state.isCurrentSession(session);
    if (!current()) return false;
    if (state.currentProjectType === 'transmission_line') {
      void import('../../ui/lineProjectView.js')
        .then(({ handleLinePropertyReference }) => {
          if (current()) handleLinePropertyReference(detail);
        })
        .catch(reportBackgroundError);
      return true;
    }
    if (state.currentProjectType === 'substation' || state.currentProjectType === 'equipment') {
      void import('../../ui/cbmTreeView.js')
        .then(({ handleSubstationPropertyReference }) => {
          if (current())
            handleSubstationPropertyReference(state, detail, (text) => {
              if (current()) setStatusRight(text);
            });
        })
        .catch(reportBackgroundError);
      return true;
    }
    return false;
  });

  btnLoadGim.addEventListener('click', () => {
    void openGimWithDialog(state, showLoading).catch((error) => showError('加载失败', error));
  });
  btnLoadLocal.addEventListener('click', () => {
    const session = state.captureProjectSession();
    const current = () => state.isCurrentSession(session);
    if (!current()) return;
    void import('../session/openIfc.js')
      .then(async ({ openIfcWithDialog }) => {
        if (current()) await openIfcWithDialog(state, showLoading);
      })
      .catch((error) => {
        if (current()) showError('加载失败', error);
      });
  });
  btnClear.addEventListener('click', () => {
    void closeProject(state).catch(reportBackgroundError);
  });
  btnCacheManager.addEventListener('click', () => {
    if (!isTauri()) {
      const generation = state.projectGeneration;
      showLoading('缓存管理仅在桌面版可用');
      scheduleHideLoading(() => state.projectGeneration === generation, 2000);
      return;
    }
    void import('../../ui/cacheManagerView.js')
      .then(async ({ openCacheManager }) => {
        await openCacheManager((id) => openGimProjectFromId(state, () => {}, id));
      })
      .catch((error) => showError('打开缓存管理失败', error));
  });
}
