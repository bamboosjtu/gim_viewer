import { hasErrorCode } from '@gim/contracts-native/errors.js';
import type { WorkerTaskProbe } from '../../measurement/workerProbe.js';
import type { EngineeringSources } from '../../gim/engineering/buildSources.js';
import { projectEngineeringNavigation } from '../../gim/engineering/projection.js';
import {
  decodeEngineeringEntities,
  decodeEngineeringSources,
  encodeEngineeringEntities,
  encodeEngineeringSources,
  engineeringCacheSizes,
  type EngineeringCacheDomain,
  type EngineeringCacheIdentity,
  type EngineeringCacheResult,
} from '../../infrastructure/cache/engineeringCacheCodec.js';
import {
  applyNavigationCacheProjection,
  decodeEngineeringNavigation,
  encodeEngineeringNavigation,
} from '../../infrastructure/cache/engineeringNavigationCache.js';
import type {
  EngineeringBuildResult,
  EngineeringWorkerCommand,
  EngineeringWorkerReply,
} from '../../infrastructure/workers/engineeringWorkerProtocol.js';
import { assembleStoredEngineeringView } from './engineeringAssembly.js';

export interface EngineeringWorkerBuild {
  result: EngineeringBuildResult;
  identity?: EngineeringCacheIdentity;
  digest?: string;
  plan: EngineeringCacheDomain[];
}

export interface EngineeringSourceCheckpoint {
  bytes: Uint8Array;
  identity: EngineeringCacheIdentity;
  revision: number;
}

export function markCacheFailure(
  result: Pick<EngineeringBuildResult, 'cacheError' | 'cacheDisabled'>,
  error: unknown,
): void {
  result.cacheError = String(error);
  if (hasErrorCode(error, 'RESOURCE_LIMIT'))
    result.cacheDisabled = '工程缓存超过单域 384 MiB 预算，已停止本次缓存写入';
}

export async function encodeWorkerBuildCache(
  current: EngineeringWorkerBuild | undefined,
  request: Extract<EngineeringWorkerCommand, { type: 'encode-cache' }>,
  trace: WorkerTaskProbe,
  started: number,
  park: (source: EngineeringSourceCheckpoint) => void,
): Promise<EngineeringWorkerReply> {
  if (
    !current ||
    current.result.buildId !== request.buildId ||
    !current.identity ||
    current.plan[0] !== request.domain
  )
    throw Error('工程缓存请求的构建身份或顺序无效');
  const response: EngineeringCacheResult = {
    buildId: request.buildId,
    domain: request.domain,
    metrics: { encodeMs: 0, plainBytes: 0, encodedBytes: 0 },
  };
  try {
    const { result, identity } = current;
    if (request.projection) {
      if (request.domain !== 'navigation')
        throw Error('Navigation override for non-navigation domain');
      result.navigation = applyNavigationCacheProjection(result.navigation, request.projection);
    }
    if (request.domain === 'sources') {
      const encoded = await encodeEngineeringSources(result.sources, identity);
      current.digest = encoded.digest;
      response.bytes = encoded.bytes;
      park({
        bytes: encoded.bytes.slice(),
        identity,
        revision: result.sources.graph.revision ?? 0,
      });
    } else {
      if (!current.digest) throw Error('工程缓存缺少来源摘要');
      response.bytes =
        request.domain === 'entities'
          ? await encodeEngineeringEntities(
              result.snapshot,
              { sources: result.sources, digest: current.digest },
              identity,
            )
          : await encodeEngineeringNavigation(
              result.navigation,
              result.sources,
              result.snapshot,
              current.digest,
              identity,
            );
    }
    Object.assign(response.metrics, engineeringCacheSizes(response.bytes));
    current.plan.shift();
  } catch (error) {
    const failure: Pick<EngineeringBuildResult, 'cacheError' | 'cacheDisabled'> = {};
    markCacheFailure(failure, error);
    response.error = failure.cacheError;
    response.disabled = failure.cacheDisabled;
    current.plan = [];
  }
  response.metrics.encodeMs = performance.now() - started;
  trace.record('engineering.cache-encode', response.metrics.encodeMs, {
    bytes: response.bytes?.byteLength ?? 0,
  });
  return { type: 'cache', result: response };
}

export async function readWorkerBuildCache(
  request: Extract<EngineeringWorkerCommand, { type: 'restore' }>,
  restoreSources: (sources: EngineeringSources, checkpoint: EngineeringSourceCheckpoint) => void,
): Promise<{ result: EngineeringBuildResult; digest: string; plan: EngineeringCacheDomain[] }> {
  const artifact = await decodeEngineeringSources(request.sourceBytes, request.identity);
  restoreSources(artifact.sources, {
    bytes: request.sourceBytes,
    identity: request.identity,
    revision: artifact.sources.graph.revision ?? 0,
  });
  let snapshot,
    entityCacheHit = false,
    stageErrors: Record<string, string> = {};
  try {
    if (!request.entityBytes) throw Error('entity-cache-missing');
    snapshot = await decodeEngineeringEntities(request.entityBytes, artifact, request.identity);
    entityCacheHit = true;
  } catch {
    const recovered = assembleStoredEngineeringView(
      request.identity.sourceSha256,
      artifact.sources,
    );
    snapshot = recovered.snapshot;
    stageErrors = recovered.stageErrors;
  }
  let navigation,
    navigationCacheHit = false;
  try {
    if (!request.navigationBytes) throw Error('navigation-cache-missing');
    navigation = await decodeEngineeringNavigation(
      request.navigationBytes,
      artifact.sources,
      snapshot,
      artifact.digest,
      request.identity,
    );
    if (
      artifact.sources.graph.ifcPaths.length &&
      (navigation.compositionComplete !== true || navigation.compositionCoverage !== 'full')
    )
      throw Error('navigation-projection-incomplete');
    navigationCacheHit = true;
  } catch {
    navigation = projectEngineeringNavigation(artifact.sources, snapshot);
  }
  Object.assign(stageErrors, navigation.projectionErrors);
  // Drop incoming cache buffers before constructing the display transport.
  request.sourceBytes = new Uint8Array();
  delete request.entityBytes;
  delete request.navigationBytes;
  const plan: EngineeringCacheDomain[] = [];
  if (!stageErrors.recognition && !entityCacheHit) plan.push('entities');
  if (!Object.keys(stageErrors).length && !navigationCacheHit) plan.push('navigation');
  return {
    result: {
      sources: artifact.sources,
      snapshot,
      navigation,
      entityCacheHit,
      navigationCacheHit,
      stageErrors,
    },
    digest: artifact.digest,
    plan,
  };
}
