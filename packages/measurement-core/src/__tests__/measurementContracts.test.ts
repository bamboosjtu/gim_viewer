import { describe, it, expect } from "vitest";
import {
  MemoryLedger,
  BufferLedger,
  uniqueBufferCapacity,
  calibrateClock,
  DurationStats,
} from "../index.js";

describe("measurement core values", () => {
  it("deduplicates shared views and conserves unique ownership across transfer/copy/eviction", () => {
    const buffer = new ArrayBuffer(64);
    expect(
      uniqueBufferCapacity([
        new Uint8Array(buffer),
        new Float32Array(buffer),
        buffer,
      ]),
    ).toBe(64);
    const tracked = new BufferLedger();
    tracked.retain(buffer, "cache");
    tracked.retain(new Uint8Array(buffer), "cache");
    tracked.release(buffer, "cache");
    expect(tracked.bytes).toBe(64);
    tracked.transfer(buffer, "cache", "host");
    tracked.release(buffer, "host");
    expect(tracked.bytes).toBe(0);
    const ledger = new MemoryLedger();
    ledger.acquire("a", "worker", 64, "buffer-capacity");
    ledger.acquire("a", "cache", 64, "buffer-capacity");
    ledger.transfer("a", "worker", "worker");
    ledger.transfer("a", "worker", "in-flight");
    ledger.copy("a", "b", "host");
    expect(ledger.snapshot().uniqueBytesByKind["buffer-capacity"]).toBe(128);
    ledger.releaseOwner("in-flight");
    ledger.releaseOwner("cache");
    expect(ledger.snapshot().uniqueBytesByKind["buffer-capacity"]).toBe(64);
    ledger.releaseOwner("host");
    ledger.releaseOwner("host");
    expect(ledger.snapshot().uniqueAllocations).toBe(0);
  });
  it("calibrates clock offset with uncertainty and reports bounded quantiles", () => {
    expect(calibrateClock(10, 112, 114, 16)).toEqual({
      offsetMs: -100,
      uncertaintyMs: 2,
    });
    expect(() => calibrateClock(10, 112, 110, 16)).toThrow();
    const stats = new DurationStats();
    for (let i = 1; i <= 100; i++) stats.add(i);
    const result = stats.snapshot();
    expect(result.count).toBe(100);
    expect(result.p95!.lowerMs).toBeLessThanOrEqual(95);
    expect(result.p95!.upperMs).toBeGreaterThanOrEqual(95);
  });
});
