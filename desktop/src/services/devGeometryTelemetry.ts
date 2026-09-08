export type DevGeometryTelemetryPath = 'cold' | 'warm';

export type DevGeometryTelemetryPhase =
  | 'discovery'
  | 'sourceReadModStlParseMeshBuildBakeGltfSerialize'
  | 'glbWrite'
  | 'glbRead'
  | 'glbParse'
  | 'templateParse'
  | 'placementTransform'
  | 'placementMatrix'
  | 'bbox'
  | 'sceneCommit'
  | 'yield'
  | 'placementSlice'
  | 'devTotal';

export interface DevGeometryPhaseSummary {
  count: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface DevGeometryWorstDevSummary {
  devPath: string;
  placementCount: number;
  totalMs: number;
  phases: Partial<Record<DevGeometryTelemetryPhase, number>>;
}

export interface DevGeometryTelemetry {
  path: DevGeometryTelemetryPath;
  uniqueDevCount: number;
  placementCount: number;
  totalMs: number;
  /** DEV template/placement aggregate counters; no per-placement trace retained. */
  uniqueGlbDevCount: number;
  templateParseCount: number;
  templateParseMs: number;
  templateShareableCount: number;
  templateFallbackCount: number;
  fallbackDevPaths: string[];
  fallbackReasons: Record<string, string>;
  sharedPlacementCount: number;
  legacyFallbackPlacementCount: number;
  sharedGeometryCount: number;
  sharedMaterialCount: number;
  sharedTextureCount: number;
  placementMatrixMs: number;
  bboxMs: number;
  sceneCommitMs: number;
  placementYieldCount: number;
  placementSliceCount: number;
  maxPlacementSliceMs: number;
  placementSliceP50Ms: number;
  placementSliceP95Ms: number;
  phases: Partial<Record<DevGeometryTelemetryPhase, DevGeometryPhaseSummary>>;
  worstDevPaths: DevGeometryWorstDevSummary[];
}

interface MutableDevSummary {
  placementCount: number;
  totalMs: number;
  phases: Partial<Record<DevGeometryTelemetryPhase, number>>;
}

interface MutablePhase {
  durations: number[];
  totalMs: number;
  maxMs: number;
}

function safeDuration(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

/**
 * Aggregate geometry spans without retaining a per-placement trace.
 * The recorder is deliberately local to one DEV pipeline invocation.
 */
export function createDevGeometryTelemetry(
  path: DevGeometryTelemetryPath,
  uniqueDevCount: number,
  placementCount: number,
): {
  beginDev: (devPath: string, placementCount: number) => number;
  record: (phase: DevGeometryTelemetryPhase, durationMs: number, devPath?: string) => void;
  recordTemplateParse: (durationMs: number, devPath?: string) => void;
  recordPlacementMatrix: (durationMs: number, devPath?: string) => void;
  recordPlacementSlice: (durationMs: number, yielded: boolean, devPath?: string) => void;
  recordSharedPlacement: (devPath?: string) => void;
  recordLegacyFallbackPlacement: (devPath?: string) => void;
  setTemplateMetrics: (metrics: {
    uniqueGlbDevCount?: number;
    templateParseCount?: number;
    templateParseMs?: number;
    templateShareableCount?: number;
    templateFallbackCount?: number;
    fallbackDevPaths?: string[];
    fallbackReasons?: Record<string, string>;
    sharedGeometryCount?: number;
    sharedMaterialCount?: number;
    sharedTextureCount?: number;
  }) => void;
  finishDev: (devPath: string, startedAt: number) => void;
  snapshot: (totalMs: number) => DevGeometryTelemetry;
} {
  const phases = new Map<DevGeometryTelemetryPhase, MutablePhase>();
  const devs = new Map<string, MutableDevSummary>();
  let uniqueGlbDevCount = uniqueDevCount;
  let templateParseCount = 0;
  let templateParseMs = 0;
  let templateShareableCount = 0;
  let templateFallbackCount = 0;
  let fallbackDevPaths: string[] = [];
  let fallbackReasons: Record<string, string> = {};
  let sharedPlacementCount = 0;
  let legacyFallbackPlacementCount = 0;
  let sharedGeometryCount = 0;
  let sharedMaterialCount = 0;
  let sharedTextureCount = 0;
  let placementMatrixMs = 0;
  let bboxMs = 0;
  let sceneCommitMs = 0;
  let placementYieldCount = 0;
  const placementSliceDurations: number[] = [];

  const record = (phase: DevGeometryTelemetryPhase, durationMs: number, devPath?: string): void => {
    const safe = safeDuration(durationMs);
    if (phase === 'bbox') bboxMs += safe;
    if (phase === 'sceneCommit') sceneCommitMs += safe;
    const phaseStats = phases.get(phase) ?? { durations: [], totalMs: 0, maxMs: 0 };
    phaseStats.durations.push(safe);
    phaseStats.totalMs += safe;
    phaseStats.maxMs = Math.max(phaseStats.maxMs, safe);
    phases.set(phase, phaseStats);
    if (devPath) {
      const dev = devs.get(devPath) ?? { placementCount: 0, totalMs: 0, phases: {} };
      dev.phases[phase] = (dev.phases[phase] ?? 0) + safe;
      if (phase === 'devTotal') dev.totalMs += safe;
      devs.set(devPath, dev);
    }
  };

  const recordTemplateParse = (durationMs: number, devPath?: string): void => {
    const safe = safeDuration(durationMs);
    templateParseCount++;
    templateParseMs += safe;
    record('templateParse', safe, devPath);
    record('glbParse', safe, devPath);
  };

  const recordPlacementMatrix = (durationMs: number, devPath?: string): void => {
    const safe = safeDuration(durationMs);
    placementMatrixMs += safe;
    record('placementMatrix', safe, devPath);
  };

  const recordPlacementSlice = (durationMs: number, yielded: boolean, devPath?: string): void => {
    const safe = safeDuration(durationMs);
    placementSliceDurations.push(safe);
    if (yielded) placementYieldCount++;
    record('placementSlice', safe, devPath);
  };

  return {
    beginDev: (devPath, count) => {
      const existing = devs.get(devPath);
      if (existing) existing.placementCount = count;
      else devs.set(devPath, { placementCount: count, totalMs: 0, phases: {} });
      return performance.now();
    },
    record,
    recordTemplateParse,
    recordPlacementMatrix,
    recordPlacementSlice,
    recordSharedPlacement: (devPath) => {
      sharedPlacementCount++;
      if (devPath) {
        const dev = devs.get(devPath) ?? { placementCount: 0, totalMs: 0, phases: {} };
        devs.set(devPath, dev);
      }
    },
    recordLegacyFallbackPlacement: (devPath) => {
      legacyFallbackPlacementCount++;
      if (devPath) {
        const dev = devs.get(devPath) ?? { placementCount: 0, totalMs: 0, phases: {} };
        devs.set(devPath, dev);
      }
    },
    setTemplateMetrics: (metrics) => {
      if (metrics.uniqueGlbDevCount != null) uniqueGlbDevCount = metrics.uniqueGlbDevCount;
      if (metrics.templateParseCount != null) templateParseCount = metrics.templateParseCount;
      if (metrics.templateParseMs != null) templateParseMs = safeDuration(metrics.templateParseMs);
      if (metrics.templateShareableCount != null) templateShareableCount = metrics.templateShareableCount;
      if (metrics.templateFallbackCount != null) templateFallbackCount = metrics.templateFallbackCount;
      if (metrics.fallbackDevPaths) fallbackDevPaths = metrics.fallbackDevPaths.slice();
      if (metrics.fallbackReasons) fallbackReasons = { ...metrics.fallbackReasons };
      if (metrics.sharedGeometryCount != null) sharedGeometryCount = metrics.sharedGeometryCount;
      if (metrics.sharedMaterialCount != null) sharedMaterialCount = metrics.sharedMaterialCount;
      if (metrics.sharedTextureCount != null) sharedTextureCount = metrics.sharedTextureCount;
    },
    finishDev: (devPath, startedAt) => record('devTotal', performance.now() - startedAt, devPath),
    snapshot: (totalMs) => {
      const phaseSnapshot: Partial<Record<DevGeometryTelemetryPhase, DevGeometryPhaseSummary>> = {};
      for (const [phase, stats] of phases) {
        phaseSnapshot[phase] = {
          count: stats.durations.length,
          totalMs: stats.totalMs,
          p50Ms: percentile(stats.durations, 0.5),
          p95Ms: percentile(stats.durations, 0.95),
          maxMs: stats.maxMs,
        };
      }
      const worstDevPaths = Array.from(devs.entries())
        .map(([devPath, summary]) => ({
          devPath,
          placementCount: summary.placementCount,
          totalMs: summary.totalMs,
          phases: { ...summary.phases },
        }))
        .sort((a, b) => b.totalMs - a.totalMs)
        .slice(0, 10);
      return {
        path,
        uniqueDevCount,
        placementCount,
        totalMs: safeDuration(totalMs),
        uniqueGlbDevCount,
        templateParseCount,
        templateParseMs,
        templateShareableCount,
        templateFallbackCount,
        fallbackDevPaths: fallbackDevPaths.slice(),
        fallbackReasons: { ...fallbackReasons },
        sharedPlacementCount,
        legacyFallbackPlacementCount,
        sharedGeometryCount,
        sharedMaterialCount,
        sharedTextureCount,
        placementMatrixMs,
        bboxMs: bboxMs || (phaseSnapshot.bbox?.totalMs ?? 0),
        sceneCommitMs: sceneCommitMs || (phaseSnapshot.sceneCommit?.totalMs ?? 0),
        placementYieldCount,
        placementSliceCount: placementSliceDurations.length,
        maxPlacementSliceMs: placementSliceDurations.length > 0 ? Math.max(...placementSliceDurations) : 0,
        placementSliceP50Ms: percentile(placementSliceDurations, 0.5),
        placementSliceP95Ms: percentile(placementSliceDurations, 0.95),
        phases: phaseSnapshot,
        worstDevPaths,
      };
    },
  };
}
