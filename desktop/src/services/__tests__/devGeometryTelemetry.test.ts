import { describe, expect, it } from 'vitest';
import { createDevGeometryTelemetry } from '../devGeometryTelemetry.js';

describe('DEV geometry aggregate telemetry', () => {
  it('keeps phase histograms and worst DEV summaries without placement traces', () => {
    const telemetry = createDevGeometryTelemetry('warm', 2, 3);
    const first = telemetry.beginDev('DEV/a.dev', 2);
    telemetry.record('glbParse', 10, 'DEV/a.dev');
    telemetry.record('glbParse', 30, 'DEV/a.dev');
    telemetry.record('placementTransform', 4, 'DEV/a.dev');
    telemetry.finishDev('DEV/a.dev', first);

    telemetry.beginDev('DEV/b.dev', 1);
    telemetry.record('glbParse', 20, 'DEV/b.dev');
    telemetry.record('sceneCommit', 2, 'DEV/b.dev');

    const snapshot = telemetry.snapshot(80);
    expect(snapshot.path).toBe('warm');
    expect(snapshot.uniqueDevCount).toBe(2);
    expect(snapshot.placementCount).toBe(3);
    expect(snapshot.totalMs).toBe(80);
    expect(snapshot.phases.glbParse).toMatchObject({
      count: 3,
      totalMs: 60,
      p50Ms: 20,
      p95Ms: 30,
      maxMs: 30,
    });
    expect(snapshot.worstDevPaths[0]?.devPath).toBe('DEV/a.dev');
    expect(snapshot.worstDevPaths[0]?.placementCount).toBe(2);
    expect(snapshot.worstDevPaths[0]?.phases.glbParse).toBe(40);
  });
});
