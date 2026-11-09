import {vi} from 'vitest';
import type {DevGeometryPreprocessor} from '../../devGeometryWorkerClient.js';

// Pick retains every public member while excluding class-private state. A new
// production member must be handled here before any consumer fixture can compile.
type WorkerApi=Pick<DevGeometryPreprocessor,keyof DevGeometryPreprocessor>;
export function createDevWorkerMock(overrides:Partial<WorkerApi>={}):WorkerApi{
  return {
    workerCount:1,cacheConcurrency:8,activePaths:[],onActivity:vi.fn(),
    compile:vi.fn<WorkerApi['compile']>().mockRejectedValue(new Error('Unexpected worker compile')),
    bounds:vi.fn<WorkerApi['bounds']>().mockRejectedValue(new Error('Unexpected worker bounds')),
    take:vi.fn<WorkerApi['take']>().mockRejectedValue(new Error('Unexpected worker take')),
    acknowledge:vi.fn(),promote:vi.fn(),cancelQueued:vi.fn(),cancelTask:vi.fn(),cancel:vi.fn(),
    installSources:vi.fn(),setPaused:vi.fn(),setMemoryPressure:vi.fn(),
    takeWorkerQueueStats:vi.fn(()=>null),
    schedulingSnapshot:vi.fn<WorkerApi['schedulingSnapshot']>(),
    resultPressure:{bytes:0,peakBytes:0,count:0,splitOwner:null,splitReservationBytes:0,admittedBytes:0,splitPoolBudgetBytes:0},
    diagnostics:{reads:0,rpcReads:0,sourceHits:0,documentHits:0,readRpcMs:0,decodeMs:0,parseMs:0,queueWaitMs:0,
      boundsTasks:0,compileTasks:0,failedTasks:0,splitCompiles:0,splitParts:0,splitMerges:0,splitFallbacks:0,
      timedOutTasks:0,stallSnapshots:0,idleWorkerReclaims:0,idlePoolShrinks:0,sourceAffinityHits:0,sourceAffinityDeferrals:0,stages:{}},
    ...overrides,
  };
}
