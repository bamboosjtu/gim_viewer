/**
 * Low-frequency Substation Runtime ownership sampling.
 *
 * This module is deliberately a collector, not a profiler framework.  It
 * counts logical Three/Fragments/semantic owners and delegates timing storage
 * to the existing perfTimings contract.  No geometry bytes are copied and no
 * third-party Fragments internals are patched.
 */

import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import {
  perfCurrentSession,
  perfIsCurrentSession,
  perfRecordMemorySample,
  perfRecordRuntimeResourceSnapshot,
  type PerfRuntimeResourceSnapshot,
  type PerfSession,
} from '../utils/perfTimings.js';
import { isTauri } from '@desktop/runtime.js';

type ObjectLike = {
  [key: string]: unknown;
  children?: unknown[];
  isGroup?: boolean;
  isMesh?: boolean;
  geometry?: unknown;
  material?: unknown;
  userData?: Record<string, unknown>;
  traverse?: (callback: (object: ObjectLike) => void) => void;
};

type TemplatePoolLike = {
  metrics?: () => {
    templateParseCount?: number;
  };
  currentResourceCounts?: () => {
    templateCount?: number;
    sharedGeometryCount?: number;
    sharedMaterialCount?: number;
    sharedTextureCount?: number;
  };
};

interface SceneResourceCounts {
  sceneObjectCount: number | null;
  groupCount: number | null;
  meshCount: number | null;
  uniqueGeometryCount: number | null;
  uniqueMaterialCount: number | null;
  uniqueTextureCount: number | null;
  rendererInfoGeometries: number | null;
  rendererInfoTextures: number | null;
  rendererInfoPrograms: number | null;
}

const DEV_TEMPLATE_POOL_KEY = '__gimDevGlbTemplatePool';
const DEV_TEMPLATE_PLACEMENT_KEY = '__gimDevGlbTemplatePlacement';
const DEV_LEGACY_PLACEMENT_KEY = '__gimDevGlbLegacyPlacement';

function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function asObject(value: unknown): ObjectLike | null {
  return value && typeof value === 'object' ? value as ObjectLike : null;
}

function collectSceneResourceCounts(ctx: ViewerContext | null | undefined): SceneResourceCounts {
  const world = asObject(ctx?.world);
  const sceneContainer = asObject(world?.scene);
  const scene = asObject(sceneContainer?.three);
  if (!scene) {
    return {
      sceneObjectCount: null,
      groupCount: null,
      meshCount: null,
      uniqueGeometryCount: null,
      uniqueMaterialCount: null,
      uniqueTextureCount: null,
      rendererInfoGeometries: null,
      rendererInfoTextures: null,
      rendererInfoPrograms: null,
    };
  }

  let sceneObjectCount = 0;
  let groupCount = 0;
  let meshCount = 0;
  const geometries = new Set<object>();
  const materials = new Set<object>();
  const textures = new Set<object>();
  const visit = (object: ObjectLike): void => {
    sceneObjectCount += 1;
    if (object.isGroup === true) groupCount += 1;
    if (object.isMesh === true) {
      meshCount += 1;
      if (object.geometry && typeof object.geometry === 'object') {
        geometries.add(object.geometry);
      }
      const values = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of values) {
        if (!material || typeof material !== 'object') continue;
        materials.add(material);
        for (const value of Object.values(material as Record<string, unknown>)) {
          if (value && typeof value === 'object' && (value as { isTexture?: boolean }).isTexture === true) {
            textures.add(value);
          }
        }
      }
    }
  };

  if (typeof scene.traverse === 'function') {
    scene.traverse(visit);
  } else {
    const walk = (object: ObjectLike): void => {
      visit(object);
      for (const child of object.children ?? []) {
        const childObject = asObject(child);
        if (childObject) walk(childObject);
      }
    };
    walk(scene);
  }

  const renderer = asObject(world?.renderer);
  const rendererInfo = asObject(renderer?.info) ?? asObject(asObject(renderer?.three)?.info);
  const rendererMemory = asObject(rendererInfo?.memory);
  const programs = rendererInfo?.programs;
  return {
    sceneObjectCount,
    groupCount,
    meshCount,
    uniqueGeometryCount: geometries.size,
    uniqueMaterialCount: materials.size,
    uniqueTextureCount: textures.size,
    rendererInfoGeometries: countOrNull(rendererMemory?.geometries),
    rendererInfoTextures: countOrNull(rendererMemory?.textures),
    rendererInfoPrograms: Array.isArray(programs) ? programs.length : null,
  };
}

function collectCbmNodeCount(root: unknown): number {
  const rootNode = asObject(root);
  if (!rootNode) return 0;
  let count = 0;
  const walk = (node: ObjectLike): void => {
    count += 1;
    for (const child of node.children ?? []) {
      const childNode = asObject(child);
      if (childNode) walk(childNode);
    }
  };
  walk(rootNode);
  return count;
}

function getFragmentModelCount(ctx: ViewerContext | null | undefined): number | null {
  const list = asObject(asObject(ctx)?.fragments)?.list;
  const size = asObject(list)?.size;
  return countOrNull(size);
}

function getRendererInfoCount(value: unknown): number | null {
  return countOrNull(value);
}

function collectTemplateCounts(state: AppState): {
  templateCount: number | null;
  templateParseCount: number | null;
  sharedGeometryCount: number | null;
  sharedMaterialCount: number | null;
  sharedTextureCount: number | null;
} {
  const pool = state.modRootGroup?.userData?.[DEV_TEMPLATE_POOL_KEY] as TemplatePoolLike | undefined;
  if (!pool || typeof pool !== 'object') {
    return {
      // No pool means no session-owned DEV template resources.  Zero is more
      // useful than null for cleanup assertions; unavailable renderer/process
      // values remain null in their own fields.
      templateCount: 0,
      templateParseCount: 0,
      sharedGeometryCount: 0,
      sharedMaterialCount: 0,
      sharedTextureCount: 0,
    };
  }
  const metrics = typeof pool.metrics === 'function' ? pool.metrics() : undefined;
  const current = typeof pool.currentResourceCounts === 'function'
    ? pool.currentResourceCounts()
    : undefined;
  return {
    templateCount: countOrNull(current?.templateCount),
    templateParseCount: countOrNull(metrics?.templateParseCount),
    sharedGeometryCount: countOrNull(current?.sharedGeometryCount),
    sharedMaterialCount: countOrNull(current?.sharedMaterialCount),
    sharedTextureCount: countOrNull(current?.sharedTextureCount),
  };
}

function collectPlacementCounts(state: AppState): {
  sharedPlacementCount: number;
  legacyPlacementCount: number;
} {
  let sharedPlacementCount = 0;
  let legacyPlacementCount = 0;
  for (const group of state.loadedXmlModGroups.values()) {
    const userData = group.userData as Record<string, unknown> | undefined;
    if (userData?.[DEV_TEMPLATE_PLACEMENT_KEY] === true) sharedPlacementCount += 1;
    if (userData?.[DEV_LEGACY_PLACEMENT_KEY] === true) legacyPlacementCount += 1;
  }
  return { sharedPlacementCount, legacyPlacementCount };
}

/** Synchronous ownership counts; safe to call before/after cleanup. */
export function collectSubstationRuntimeResourceSnapshot(
  state: AppState,
  label: string,
  ctx?: ViewerContext | null,
  meta?: Record<string, unknown>,
): Omit<PerfRuntimeResourceSnapshot, 'atMs' | 'sessionId'> {
  const scene = collectSceneResourceCounts(ctx);
  const template = collectTemplateCounts(state);
  const placements = collectPlacementCounts(state);
  const spatial = state.substationSpatialIndex;
  const fragmentModelCount = getFragmentModelCount(ctx);
  const uniqueGeometryCount = scene.uniqueGeometryCount == null
    ? template.sharedGeometryCount
    : template.sharedGeometryCount == null
      ? scene.uniqueGeometryCount
      : Math.max(scene.uniqueGeometryCount, template.sharedGeometryCount);
  const uniqueMaterialCount = scene.uniqueMaterialCount == null
    ? template.sharedMaterialCount
    : template.sharedMaterialCount == null
      ? scene.uniqueMaterialCount
      : Math.max(scene.uniqueMaterialCount, template.sharedMaterialCount);
  const uniqueTextureCount = scene.uniqueTextureCount == null
    ? template.sharedTextureCount
    : template.sharedTextureCount == null
      ? scene.uniqueTextureCount
      : Math.max(scene.uniqueTextureCount, template.sharedTextureCount);

  return {
    label,
    sceneObjectCount: scene.sceneObjectCount,
    groupCount: scene.groupCount,
    meshCount: scene.meshCount,
    uniqueGeometryCount,
    uniqueMaterialCount,
    uniqueTextureCount,
    rendererInfoGeometries: getRendererInfoCount(scene.rendererInfoGeometries),
    rendererInfoTextures: getRendererInfoCount(scene.rendererInfoTextures),
    rendererInfoPrograms: getRendererInfoCount(scene.rendererInfoPrograms),
    templateCount: template.templateCount,
    templateParseCount: template.templateParseCount,
    sharedPlacementCount: placements.sharedPlacementCount,
    legacyPlacementCount: placements.legacyPlacementCount,
    sharedGeometryCount: template.sharedGeometryCount,
    sharedMaterialCount: template.sharedMaterialCount,
    sharedTextureCount: template.sharedTextureCount,
    loadedXmlModGroupCount: state.loadedXmlModGroups.size,
    loadedStlGroupCount: state.loadedStlGroups.size,
    fragmentModelCount,
    loadedIfcModelCount: state.loadedModels.size,
    currentIfcEntryCount: state.currentIfcEntries.length,
    cbmNodeCount: collectCbmNodeCount(state.currentCbmTree),
    spatialNodeCount: spatial?.nodes.length ?? 0,
    spatialObjectCount: spatial?.objects.length ?? 0,
    spatialLinkCount: spatial?.links.length ?? 0,
    fileDevRelationCount: state.fileDevRelations.length,
    modRootPresent: state.modRootGroup != null,
    stlRootPresent: state.stlRootGroup != null,
    meta: {
      currentProjectType: state.currentProjectType,
      spatialIndexPresent: spatial != null,
      ...meta,
    },
  };
}

function getJsHeapSample(): {
  usedJSHeapSize: number | null;
  totalJSHeapSize: number | null;
  jsHeapSizeLimit: number | null;
} {
  const memory = typeof performance !== 'undefined'
    ? (performance as Performance & {
      memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
    }).memory
    : undefined;
  return {
    usedJSHeapSize: countOrNull(memory?.usedJSHeapSize),
    totalJSHeapSize: countOrNull(memory?.totalJSHeapSize),
    jsHeapSizeLimit: countOrNull(memory?.jsHeapSizeLimit),
  };
}

export interface SubstationResourceSampleOptions {
  /** State/generation guard in addition to the performance session guard. */
  isCurrent?: () => boolean;
}

/**
 * Capture a paired memory + logical resource checkpoint.  Counts are captured
 * synchronously before the optional Rust IPC so a later A→B switch cannot
 * turn an old resource graph into a new project's sample.
 */
export async function sampleSubstationRuntimeResources(
  state: AppState,
  label: string,
  session: PerfSession = perfCurrentSession(),
  ctx?: ViewerContext | null,
  meta?: Record<string, unknown>,
  options: SubstationResourceSampleOptions = {},
): Promise<void> {
  if (!perfIsCurrentSession(session) || (options.isCurrent && !options.isCurrent())) return;
  const resourceSnapshot = collectSubstationRuntimeResourceSnapshot(state, label, ctx, meta);
  const jsHeap = getJsHeapSample();
  // Resource ownership is a synchronous checkpoint.  Record it before the
  // optional Rust IPC so a slow process-memory command cannot move the
  // resource timestamp into a later lifecycle phase.
  perfRecordRuntimeResourceSnapshot(label, resourceSnapshot, session);
  let rssBytes: number | null = null;
  let rssSource = 'unavailable-not-tauri';
  let processPid: number | null = null;
  let processTreeRssBytes: number | null = null;
  let processCount: number | null = null;
  let processTreeAvailable = false;
  let processTreeSource = 'unavailable-not-tauri';
  let processTreeReason: string | undefined = 'not-tauri-runtime';
  let processError: string | undefined;

  if (isTauri()) {
    try {
      const { getProcessMemory } = await import('@desktop/database.js');
      const processMemory = await getProcessMemory();
      rssBytes = processMemory.rssBytes ?? null;
      rssSource = processMemory.rssSource ?? processMemory.source;
      processPid = processMemory.pid ?? null;
      processTreeRssBytes = processMemory.processTreeRssBytes ?? null;
      processCount = processMemory.processCount ?? null;
      processTreeAvailable = processMemory.processTreeAvailable === true;
      processTreeSource = processMemory.processTreeSource ?? 'unavailable';
      processTreeReason = processMemory.processTreeReason ?? undefined;
    } catch (error) {
      processError = error instanceof Error ? error.message : String(error);
      rssSource = 'unavailable-tauri-command-error';
      processTreeSource = 'unavailable-tauri-command-error';
      processTreeReason = 'get-process-memory-failed';
    }
  }

  if (!perfIsCurrentSession(session) || (options.isCurrent && !options.isCurrent())) return;
  perfRecordMemorySample(label, {
    rssBytes,
    rssSource,
    tauriProcessRssBytes: rssBytes,
    processPid,
    processTreeRssBytes,
    processCount,
    processTreeAvailable,
    processTreeSource,
    ...(processTreeReason ? { processTreeReason } : {}),
    jsHeapUsedBytes: jsHeap.usedJSHeapSize,
    jsHeapTotalBytes: jsHeap.totalJSHeapSize,
    jsHeapLimitBytes: jsHeap.jsHeapSizeLimit,
    meta: {
      ...meta,
      ...(processError ? { processMemoryError: processError } : {}),
    },
  }, session);
}

/** 开发/验收用的单次稳定窗口采样；普通路径不启动高频 sampler。 */
export function scheduleSubstationResourceCheckpoint(
  state: AppState,
  label: string,
  session: PerfSession,
  ctx: ViewerContext | null | undefined,
  meta?: Record<string, unknown>,
  options: SubstationResourceSampleOptions = {},
  delayMs = 250,
): void {
  setTimeout(() => {
    void sampleSubstationRuntimeResources(state, label, session, ctx, meta, options);
  }, Math.max(0, delayMs));
}

/** session 是项目身份快照时常用的 state guard，避免只靠 perf id。 */
export function projectSessionGuard(state: AppState, session: ProjectLoadSession): () => boolean {
  return () => state.isCurrentSession(session);
}
