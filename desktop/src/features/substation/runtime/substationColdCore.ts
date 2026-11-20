import { reportBackgroundError } from '../../../utils/backgroundErrors.js';
import { logger } from '../../../utils/logger.js';
import type { AppState, ProjectLoadSession } from '../../../app/state.js';
import type { CbmNode } from '../../../gim/types.js';
import type { IfcEntry } from '../../../gim/types.js';
import { discoverIfcFromCBM, scanIfcFiles, buildIfcGuidIndex } from '../../../gim/gimIndexer.js';
import { buildCbmTree, buildCbmNodeIndex } from '../../../gim/cbmParser.js';
import { parseFileDevRelation } from '../../../gim/fileDevParser.js';
import { perfBegin, perfCurrentSession } from '../../../utils/perfTimings.js';
import { sampleSubstationMemory } from './substationRuntimeTelemetry.js';
import {
  collectCbmNodeCount,
  markSubstationCoreSemanticReady,
  renderSubstationCoreUi,
} from '../presentation/substationPresentation.js';

export interface SubstationColdCore {
  ifcEntries: IfcEntry[];
  cbmTree: CbmNode;
  fileDevRelations: Awaited<ReturnType<typeof parseFileDevRelation>>;
}

/**
 * Publish the minimum cold-open source contract: IFC discovery, CBM tree,
 * FileDevRelation and the core navigation UI. Spatial/STD-SLD scheduling and
 * entity publication stay in the Runtime that calls this function.
 */
export async function publishSubstationColdCore(
  state: AppState,
  files: Map<string, File>,
  showMessage: (text: string) => void,
  projectName: string | undefined,
  projectTypeName: string | undefined,
  session: ProjectLoadSession,
): Promise<SubstationColdCore | null> {
  const scope = state.sessionScope(session);
  if (!scope.isCurrent()) return null;
  const perfSession = perfCurrentSession();
  try {
    scope.withSession(() => {
      state.currentFiles = files;
      state.substationEntryPaths = [...files.keys()];
      state.projectName = projectName || '';
    });

    const endIfcDiscovery = perfBegin('变电 IFC discovery', undefined, perfSession);
    let ifcEntries = await scope.read(async () => discoverIfcFromCBM(files));
    if (ifcEntries.length === 0) ifcEntries = scanIfcFiles(files);
    endIfcDiscovery(undefined, { count: ifcEntries.length });
    void sampleSubstationMemory(state, 'IFC discovery 后', perfSession, {
      ifcCount: ifcEntries.length,
    }).catch(reportBackgroundError);
    scope.withSession(() => {
      state.currentIfcEntries = ifcEntries;
    });

    const endCbmCore = perfBegin('变电 CBM/FAM/DEV/FileDevRelation', undefined, perfSession);
    const cbmTree = await scope.read(async () => buildCbmTree(files, projectTypeName));
    if (!cbmTree) return null;
    scope.withSession(() => {
      state.currentCbmTree = cbmTree;
      state.ifcGuidIndex = buildIfcGuidIndex(cbmTree, ifcEntries);
      state.cbmNodeIndex = buildCbmNodeIndex(cbmTree);
    });

    let fileDevRelations: Awaited<ReturnType<typeof parseFileDevRelation>> = [];
    try {
      fileDevRelations = await scope.read(async () => parseFileDevRelation(files));
    } catch (error) {
      if (!scope.isCurrent()) return null;
      logger.warn('[GIM] FileDevRelation 解析失败，保留空间/功能系统视图:', error);
    }

    scope.withSession(() => {
      state.fileDevRelations = fileDevRelations;
    });
    scope.withSession(() => {
      state.deviceToIfcFile.clear();
    });
    for (const entry of fileDevRelations) {
      if (!entry.modelId || !/\.ifc$/i.test(entry.ifcFile)) continue;
      for (const devCbm of entry.deviceCbms) {
        scope.withSession(() => {
          state.deviceToIfcFile.set(devCbm, entry.modelId);
        });
      }
    }
    endCbmCore(undefined, {
      cbmNodes: collectCbmNodeCount(cbmTree),
      fileDevRelations: fileDevRelations.length,
      deviceIfcLinks: state.deviceToIfcFile.size,
    });
    void sampleSubstationMemory(state, 'CBM/FAM/DEV/FileDevRelation 后', perfSession, {
      cbmNodes: collectCbmNodeCount(cbmTree),
      fileDevRelations: fileDevRelations.length,
    }).catch(reportBackgroundError);
    scope.withSession(() => {
      markSubstationCoreSemanticReady(state, perfSession);
    });
    await scope.read(async () =>
      renderSubstationCoreUi(
        state,
        showMessage,
        session,
        perfSession,
        '变电 navigation/UI（core semantic）',
      ),
    );
    void Promise.resolve(
      sampleSubstationMemory(state, 'coreSemanticReady', perfSession, {
        source: 'cold',
        cbmNodes: collectCbmNodeCount(cbmTree),
        ifcEntries: ifcEntries.length,
        fileDevRelations: fileDevRelations.length,
      }),
    ).catch(reportBackgroundError);
    return { ifcEntries, cbmTree, fileDevRelations };
  } catch (error) {
    if (!scope.isCurrent()) return null;
    throw error;
  }
}
