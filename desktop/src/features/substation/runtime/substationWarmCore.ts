import { logger } from '../../../utils/logger.js';
import type { GimRuntimeOpenContext } from '../../../services/gimOpenCore.js';
import { validateGimCache } from '@desktop/database.js';
import type { GimIndexResult } from '@desktop/contracts.js';
import type { CbmNode, FileDevEntry, IfcEntry } from '../../../gim/types.js';
import { reportBackgroundError } from '../../../utils/backgroundErrors.js';
import { DEBUG_GIM_CACHE } from '../../../config/debug.js';
import { debugLog } from '../../../utils/logger.js';
import {
  setProjectIdentity,
  refreshNavigatorTitle,
} from '../../../services/presentation/shell_projectBar.js';
import { perfBegin } from '../../../utils/perfTimings.js';
import type { PerfSession } from '../../../utils/perfTimings.js';
import { showLoading } from '../../../services/gimOpenCore.js';
import { sampleSubstationMemory } from './substationRuntimeTelemetry.js';
import {
  collectCbmNodeCount,
  markSubstationCoreSemanticReady,
  renderSubstationCoreUi,
} from '../presentation/substationPresentation.js';

export interface WarmCoreResult {
  index: GimIndexResult;
  engineeringFiles: Map<string, File>;
  cbmTree: CbmNode;
  fileDevRelations: FileDevEntry[];
  cachedIfcEntries: IfcEntry[];
}

/**
 * Restore the warm index and publish the core navigation contract.
 *
 * This function does not decide whether warm is usable; the Runtime validates
 * the cache first. It keeps the same SessionScope reads and late-session guards
 * as the former inline warm branch.
 */
export async function publishSubstationWarmCore(
  context: GimRuntimeOpenContext,
  showMessage: (text: string) => void,
  perfSession: PerfSession,
  validation: Awaited<ReturnType<typeof validateGimCache>>,
): Promise<WarmCoreResult> {
  const { state, session } = context;
  const scope = state.sessionScope(session);
  if (!scope.isCurrent()) throw new Error('warm session changed');

  if (validation.ifc_entry_count > 0) {
    // This is a confirmed IFC-backed open. Start module loading while
    // the native index is being read; no Viewer or session state is created.
    void Promise.all([
      import('../../../services/viewerUIBinding.js').then(({ prepareViewerBindingModules }) =>
        prepareViewerBindingModules(),
      ),
      import('../../../viewer/modelPresentation.js'),
    ]).catch((error) => {
      if (scope.isCurrent()) reportBackgroundError(error);
    });
  }
  const { getGimIndex } = await scope.read(async () => import('@desktop/database.js'));
  // 变电工程缓存命中 → 恢复 GIM 索引（原有逻辑）
  scope.withSession(() => {
    state.currentProjectType = 'substation';
    setProjectIdentity(context.projectName || null, 'substation');
    refreshNavigatorTitle();
  });

  scope.withSession(() => {
    showLoading('正在从本地缓存恢复 GIM 索引...');
  });
  const { restoreGimIndexToState } = await scope.read(
    async () => import('../../../services/gimIndexRestoreService.js'),
  );

  const endRestoreCore = perfBegin(
    '变电 CBM/FAM/DEV/FileDevRelation（缓存命中）',
    undefined,
    perfSession,
  );
  const index = await scope.read(async () => getGimIndex(context.projectId!));

  scope.withSession(() => {
    restoreGimIndexToState(state, index);
  });
  const { createDiskBackedFile: createEngineeringSourceFile } = await scope.read(
    async () => import('@desktop/gimExtract.js'),
  );

  const engineeringFiles = new Map(
    index.entries.map((entry) => [
      entry.entry_path,
      createEngineeringSourceFile(context.projectId!, entry.entry_path, entry.file_size),
    ]),
  );
  endRestoreCore(undefined, {
    entries: index.entries.length,
    cbmNodes: index.cbm_nodes.length,
    ifcModels: index.ifc_models.length,
    fileDevRelations: index.file_dev_entries.length,
    famProperties: index.fam_properties.length,
    devProperties: index.dev_properties.length,
  });
  void sampleSubstationMemory(state, 'CBM/FAM/DEV/FileDevRelation 后（缓存命中）', perfSession, {
    cbmNodes: index.cbm_nodes.length,
    fileDevRelations: index.file_dev_entries.length,
  }).catch(reportBackgroundError);

  debugLog(DEBUG_GIM_CACHE, '[Restore Debug]', {
    indexCounts: {
      entries: index.entries.length,
      cbmNodes: index.cbm_nodes.length,
      ifcModels: index.ifc_models.length,
      fileDevEntries: index.file_dev_entries.length,
      famProperties: index.fam_properties.length,
      devProperties: index.dev_properties.length,
    },
    stateCounts: {
      currentIfcEntries: state.currentIfcEntries.length,
      currentCbmTree: state.currentCbmTree?.path || null,
      cachedIfcPaths: state.properties.cachedIfcPaths.size,
      fileDevRelations: state.fileDevRelations.length,
      cbmNodeIndex: state.cbmNodeIndex.size,
      deviceToIfcFile: state.deviceToIfcFile.size,
    },
  });
  debugLog(DEBUG_GIM_CACHE, '[Tauri] 已从缓存恢复 GIM:', {
    project_id: context.projectId!,
    ifc_entries: state.currentIfcEntries.length,
    cbm_root: state.currentCbmTree?.path || null,
    cached_ifc_paths: state.properties.cachedIfcPaths.size,
    file_dev_relations: state.fileDevRelations.length,
  });

  if (!state.currentCbmTree) {
    throw new Error('缓存索引中没有 CBM 层级树');
  }
  if (state.fileDevRelations.length === 0) {
    logger.warn('[Tauri] 缓存索引中没有文件设备关系');
  }

  // Core navigation is available before optional IFC semantics. Entity
  // construction and scene navigation share one semantic restore/build.
  scope.withSession(() => {
    markSubstationCoreSemanticReady(state, perfSession, { cacheHit: true });
  });
  await scope.read(async () =>
    renderSubstationCoreUi(
      state,
      showMessage,
      session,
      perfSession,
      '变电 navigation/UI（core semantic，缓存命中）',
    ),
  );

  void Promise.resolve(
    sampleSubstationMemory(state, 'coreSemanticReady', perfSession, {
      source: 'warm',
      cacheHit: true,
      cbmNodes: state.currentCbmTree ? collectCbmNodeCount(state.currentCbmTree) : 0,
      ifcEntries: state.currentIfcEntries.length,
      fileDevRelations: state.fileDevRelations.length,
    }),
  ).catch(reportBackgroundError);

  const cbmTree = state.currentCbmTree;
  if (!cbmTree) throw new Error('缓存索引中没有 CBM 层级树');
  return {
    index,
    engineeringFiles,
    cbmTree,
    fileDevRelations: state.fileDevRelations.slice(),
    cachedIfcEntries: state.currentIfcEntries.slice(),
  };
}
