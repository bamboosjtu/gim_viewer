import type { IfcEntry } from '../../../gim/types.js';
import { setIfcStatus } from '../../../services/presentation/shell_statusBar.js';
import type { IfcLoadSource } from '../../../viewer/ifcEntryLoader.js';

const stageLabels: Readonly<Record<string, string>> = {
  'checking-cache': '查询LOD缓存',
  'lod-cache-hit': 'LOD缓存命中',
  'cold-convert': '冷转换中',
  'far-ready': '远景就绪',
  'cache-write-start': '缓存写入中',
  'cache-written': '缓存已写',
  'cache-write-failed': '远景就绪(缓存写入失败)',
};

interface IfcLoadProgressOptions {
  total: number;
  isCurrent(): boolean;
  loadedCount(): number;
  skippedCount(): number;
}

/** The active model owns temporary progress; tail cache writes update the terminal summary. */
export function createSubstationIfcLoadProgress(options: IfcLoadProgressOptions) {
  const sources = new Map<string, IfcLoadSource>();
  const stages = new Map<string, string>();
  const cacheWriteFailures = new Set<string>();
  let failures = 0;
  let activePath = '';
  let settled = false;

  const cacheSummary = () => {
    const cold = [...sources.values()].filter((source) => source === 'ifc').length;
    const lod = [...sources.values()].filter((source) => source === 'lod-cache').length;
    return `冷转换 ${cold} · LOD缓存 ${lod}`;
  };
  const skipped = () => {
    const count = options.skippedCount();
    return count ? ` · 已跳过 ${count} 个超大 IFC` : '';
  };
  const publishTerminal = () => {
    if (!options.isCurrent()) return;
    setIfcStatus(
      `IFC 已结束 · 已加载 ${options.loadedCount()}/${options.total} · ${cacheSummary()}${failures ? ` · 失败 ${failures}` : ''}${skipped()}${cacheWriteFailures.size ? ` · 缓存写入失败 ${cacheWriteFailures.size}` : ''}`,
    );
  };
  const acceptsProgress = () => options.isCurrent() && !settled;

  return {
    acceptsProgress,
    failedCount: () => failures,
    finishQueue: () => {
      activePath = '';
    },
    settle: () => {
      settled = true;
      activePath = '';
      publishTerminal();
    },
    begin(entry: IfcEntry, index: number, queueSize: number, sourceSize: number) {
      const publish = (extra = '') => {
        if (!acceptsProgress()) return;
        setIfcStatus(
          `IFC ${index + 1}/${queueSize} · ${entry.name} · ${stages.get(entry.path) ?? '待检查'}${extra ? ` · ${extra}` : ''} · ${cacheSummary()}${skipped()}`,
        );
      };
      activePath = entry.path;
      stages.set(entry.path, stageLabels['checking-cache']);
      publish();
      const started = performance.now();
      const timer = setInterval(() => {
        if (acceptsProgress() && activePath === entry.path) {
          publish(
            `${Math.round(sourceSize / 1048576)} MiB · ${Math.floor((performance.now() - started) / 1000)}秒`,
          );
        }
      }, 1000);

      return {
        publish,
        stage(stage: string, meta?: Record<string, unknown>) {
          if (!options.isCurrent()) return;
          if (stage === 'cache-write-failed') cacheWriteFailures.add(entry.path);
          if (stage === 'cache-written') cacheWriteFailures.delete(entry.path);
          if (settled) {
            if (stage === 'cache-write-failed' || stage === 'cache-written') publishTerminal();
            return;
          }
          stages.set(
            entry.path,
            (stageLabels[stage] ?? stage) +
              (typeof meta?.phase === 'string' && meta.phase ? ` · ${meta.phase}` : ''),
          );
          if (activePath === entry.path)
            publish(typeof meta?.ms === 'number' ? `${meta.ms}ms` : '');
        },
        recordSource(source: IfcLoadSource) {
          sources.set(entry.path, source);
          stages.set(entry.path, source === 'ifc' ? '冷转换完成' : 'LOD缓存恢复完成');
        },
        loaded(source: IfcLoadSource | 'unknown') {
          stages.set(entry.path, source === 'ifc' ? '冷转换完成' : 'LOD缓存恢复完成');
          publish();
        },
        failed(message: string) {
          stages.set(entry.path, '失败');
          publish(message.slice(0, 80));
          failures++;
        },
        dispose: () => clearInterval(timer),
      };
    },
  };
}

export type SubstationIfcLoadProgress = ReturnType<typeof createSubstationIfcLoadProgress>;
