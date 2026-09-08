export type DevGeometryTelemetryPath = 'cold' | 'warm';

export type DevGeometryTelemetryPhase =
  | 'discovery'
  | 'sourceReadModStlParseMeshBuildBakeGltfSerialize'
  | 'glbWrite'
  | 'glbRead'
  | 'glbParse'
  | 'placementTransform'
  | 'bbox'
  | 'sceneCommit'
  | 'yield'
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
  finishDev: (devPath: string, startedAt: number) => void;
  snapshot: (totalMs: number) => DevGeometryTelemetry;
} {
  const phases = new Map<DevGeometryTelemetryPhase, MutablePhase>();
  const devs = new Map<string, MutableDevSummary>();

  const record = (phase: DevGeometryTelemetryPhase, durationMs: number, devPath?: string): void => {
    const safe = safeDuration(durationMs);
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

  return {
    beginDev: (devPath, count) => {
      const existing = devs.get(devPath);
      if (existing) existing.placementCount = count;
      else devs.set(devPath, { placementCount: count, totalMs: 0, phases: {} });
      return performance.now();
    },
    record,
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
        phases: phaseSnapshot,
        worstDevPaths,
      };
    },
  };
}
