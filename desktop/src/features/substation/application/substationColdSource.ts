import { reportBackgroundError } from '../../../utils/backgroundErrors.js';
import type { IfcEntry } from '../../../gim/types.js';
import type { AppState, ProjectLoadSession } from '../../../app/state.js';
import { beginEngineeringBuild } from '../../../services/engineeringService.js';
import { isTauri } from '@desktop/runtime.js';
import { perfCurrentSession } from '../../../utils/perfTimings.js';
import { buildAndCommitSubstationSpatialSemantic } from '../runtime/substationSpatialRuntime.js';
import { createSpatialSemanticStarter } from '../../../services/spatialSemanticStarter.js';
import { buildAndCommitSubstationStdSld } from '../runtime/substationDocumentRuntime.js';
import { publishSubstationColdCore } from '../runtime/substationColdCore.js';
interface SubstationSemanticOptions {
  sourcePublication?: Promise<unknown>;
  /**
   * The spatial IFC index is useful for the spatial navigation projection,
   * but it is not part of the minimum CBM/FAM/DEV semantic contract.  Cold
   * open uses this switch to let the core navigation start before the index
   * finishes; direct callers keep the historical await behaviour by default.
   */
  deferSpatialSemantic?: boolean;
  /**
   * Production opening supplies this callback so the deferred spatial task is
   * started by the Substation Runtime only after first interactive.  Keeping
   * the starter opaque here avoids coupling core semantic parsing to IFC
   * scheduling details.
   */
  onSpatialSemanticStart?: (start: () => Promise<boolean>) => void;
  /** Start STD/SLD parsing or cache restore only after first interactive. */
  onStdSldStart?: (start: () => Promise<boolean>) => void;
}

export async function onGimExtracted(
  state: AppState,
  files: Map<string, File>,
  showMessage: (text: string) => void,
  projectName?: string,
  projectTypeName?: string,
  session: ProjectLoadSession = state.captureProjectSession(),
  options: SubstationSemanticOptions = {},
): Promise<IfcEntry[]> {
  const scope = state.sessionScope(session);
  if (!scope.isCurrent()) return [];
  try {
    const perfSession = perfCurrentSession();
    const core = await publishSubstationColdCore(
      state,
      files,
      showMessage,
      projectName,
      projectTypeName,
      session,
    );
    if (!core) return [];
    const { ifcEntries, cbmTree, fileDevRelations } = core;

    const spatialSemantic = createSpatialSemanticStarter((onIndexReady) =>
      buildAndCommitSubstationSpatialSemantic(
        state,
        files,
        ifcEntries,
        cbmTree,
        fileDevRelations,
        session,
        perfSession,
        showMessage,
        '变电 IFC 空间索引',
        {
          projectId: isTauri() ? session.projectId : undefined,
          sourceSha256: session.sourceSha256,
          beforeCacheWrite: options.sourcePublication,
          onIndexReady,
        },
      ),
    );
    const startSpatialSemantic = spatialSemantic.complete;
    scope.withSession(() => {
      void Promise.resolve(
        beginEngineeringBuild(state, files, {
          beforeCacheWrite: options.sourcePublication,
          ensureIfcSemantics: spatialSemantic.ready,
        }),
      ).catch(reportBackgroundError);
    });
    if (options.deferSpatialSemantic) {
      // The entity build and the legacy scene path share this idempotent starter.
      // Source normalization can request semantics before geometry readiness;
      // neither caller starts a second IFC semantic parser.
      options.onSpatialSemanticStart?.(startSpatialSemantic);
    } else {
      // Preserve the historical direct-call contract: callers that do not opt
      // into deferred spatial semantic receive completion before returning.
      await scope.read(async () => startSpatialSemantic());
    }

    let stdSldPromise: Promise<boolean> | null = null;
    const startStdSld = (): Promise<boolean> => {
      if (!stdSldPromise) {
        stdSldPromise = buildAndCommitSubstationStdSld(
          state,
          files,
          session,
          perfSession,
          showMessage,
          'cold',
        );
      }
      return stdSldPromise;
    };
    if (options.onStdSldStart) {
      // Production passes this starter to loadAllIfcFiles.  Registering it is
      // deliberately side-effect free before first interactive.
      options.onStdSldStart(startStdSld);
    } else if (!options.deferSpatialSemantic) {
      // Preserve the direct-call contract for callers that do not use the
      // deferred Runtime opening path.
      await scope.read(async () => startStdSld());
    }

    return ifcEntries;
  } catch (error) {
    if (!scope.isCurrent()) return [];
    throw error;
  }
}

/** 从 ArrayBuffer 加载 GIM 文件的完整流程（浏览器和 Tauri 共用，不创建 Viewer） */
