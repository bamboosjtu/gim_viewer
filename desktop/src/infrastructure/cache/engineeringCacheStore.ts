import { readCachedEntry, writeCacheFile } from '@desktop/database.js';
import { StaleSessionError } from '../../shared/sessionScope.js';
import {
  engineeringCacheEntry,
  type EngineeringCacheDomain,
  type EngineeringCacheIdentity,
  type EngineeringCacheResult,
} from './engineeringCacheCodec.js';
import { releaseEngineeringBytes } from './engineeringTableJson.js';
import { decodeSourceGeometryCache, sourceGeometryCacheEntry } from './sourceGeometryCache.js';

type WriteResult = { status: 'saved' } | { status: 'disabled' | 'error'; error: string };

// An admitted native write may finish after a session closes. The next write
// to the same artifact waits for it before invoking the bridge.
const pendingWrites = new Map<string, Promise<void>>();

/** Owns the derived-file I/O of one engineering build. */
export class EngineeringCacheStore {
  private readonly cancellation = new AbortController();

  constructor(
    private readonly projectId: number,
    readonly identity: EngineeringCacheIdentity,
    private readonly isCurrent: () => boolean,
    private readonly beforeWrite?: Promise<unknown>,
  ) {
    if (beforeWrite) void beforeWrite.catch(() => {});
  }

  close(): void {
    this.cancellation.abort();
  }

  private requireCurrent(current = this.isCurrent): void {
    if (this.cancellation.signal.aborted || !this.isCurrent() || !current())
      throw new StaleSessionError();
  }

  private async wait(pending: Promise<unknown>, current: () => boolean): Promise<void> {
    this.requireCurrent(current);
    const { signal } = this.cancellation;
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new StaleSessionError());
    });
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await Promise.race([pending, cancelled]);
      this.requireCurrent(current);
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  async waitForSourceCommit(current = this.isCurrent): Promise<void> {
    if (this.beforeWrite) await this.wait(this.beforeWrite, current);
    this.requireCurrent(current);
  }

  async readGeometry(entries: ReadonlyMap<string, unknown>) {
    this.requireCurrent();
    const { sourceSha256 } = this.identity;
    const bytes = await readCachedEntry(this.projectId, sourceGeometryCacheEntry(sourceSha256));
    try {
      this.requireCurrent();
      return decodeSourceGeometryCache(bytes, sourceSha256, entries);
    } finally {
      releaseEngineeringBytes(bytes);
    }
  }

  async readDomains() {
    this.requireCurrent();
    const read = (domain: EngineeringCacheDomain) =>
      readCachedEntry(this.projectId, engineeringCacheEntry(this.identity, domain));
    const [sources, entities, navigation] = await Promise.allSettled([
      read('sources'),
      read('entities'),
      read('navigation'),
    ]);
    this.requireCurrent();
    return {
      sources: sources.status === 'fulfilled' ? sources.value : undefined,
      entities: entities.status === 'fulfilled' ? entities.value : undefined,
      navigation: navigation.status === 'fulfilled' ? navigation.value : undefined,
    };
  }

  async saveDomain(
    domain: EngineeringCacheDomain,
    encode: () => Promise<EngineeringCacheResult>,
    current: () => boolean,
    onEncoded: (metrics: EngineeringCacheResult['metrics']) => void,
  ): Promise<WriteResult> {
    this.requireCurrent(current);
    const artifact = await encode();
    try {
      this.requireCurrent(current);
      onEncoded(artifact.metrics);
      if (artifact.error || !artifact.bytes)
        return {
          status: artifact.disabled ? 'disabled' : 'error',
          error: artifact.disabled ?? artifact.error ?? '工程缓存编码未返回内容',
        };
      await this.write(engineeringCacheEntry(this.identity, domain), artifact.bytes, current);
      return { status: 'saved' };
    } finally {
      if (artifact.bytes) releaseEngineeringBytes(artifact.bytes);
      artifact.bytes = undefined;
    }
  }

  async saveGeometry(encode: () => Promise<Uint8Array | undefined>): Promise<boolean> {
    this.requireCurrent();
    const bytes = await encode();
    if (!bytes) {
      this.requireCurrent();
      return false;
    }
    try {
      await this.waitForSourceCommit();
      await this.write(sourceGeometryCacheEntry(this.identity.sourceSha256), bytes, this.isCurrent);
      return true;
    } finally {
      releaseEngineeringBytes(bytes);
    }
  }

  private async write(entry: string, bytes: Uint8Array, current: () => boolean): Promise<void> {
    const key = `${this.projectId}/${entry}`;
    let previous = pendingWrites.get(key);
    while (previous) {
      await this.wait(previous, current);
      previous = pendingWrites.get(key);
    }
    this.requireCurrent(current);
    const writing = writeCacheFile(this.projectId, entry, bytes, this.identity.sourceSha256);
    pendingWrites.set(
      key,
      writing.then(
        () => {},
        () => {},
      ),
    );
    try {
      await writing;
      this.requireCurrent(current);
    } finally {
      pendingWrites.delete(key);
    }
  }
}
