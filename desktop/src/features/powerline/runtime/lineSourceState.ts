import type { AppState } from '../../../app/state.js';
import type { SessionScope } from '../../../shared/sessionScope.js';
import {
  setProjectIdentity,
  refreshNavigatorTitle,
} from '../../../services/presentation/shell_projectBar.js';
import type { LineParserWorkerResult } from './lineParserWorkerClient.js';
import type { LineParserWorkerFile } from './lineParserWorker.js';

export function publishPowerlineIdentity(state: AppState, projectName: string): void {
  state.currentProjectType = 'transmission_line';
  state.projectName = projectName;
  setProjectIdentity(projectName || null, 'transmission_line');
  refreshNavigatorTitle();
}

export async function commitLineParserResult(
  state: AppState,
  result: LineParserWorkerResult,
  files: Map<string, File>,
  scope: SessionScope,
): Promise<boolean> {
  // 动态 import 也属于异步边界；必须在任何 AppState 写入前完成，避免
  // 工程切换恰好发生在 import 期间时留下“图已是 A、属性仍是 B”的半提交。
  const { restoreLineAttributesToState } = await import('./lineAttrRestoreService.js');
  if (!scope.isCurrent()) return false;
  state.currentGimGraph = result.graph;
  state.currentFiles = files;
  restoreLineAttributesToState(
    {
      fam_properties: result.attributes.famPayloads,
      dev_properties: result.attributes.devPayloads,
    },
    state,
  );
  return scope.isCurrent();
}

export function buildLineSemanticWarmFiles(
  projectId: number,
  items: Array<{ entry_path: string; packed: boolean; size: number; bytes: Uint8Array | null }>,
  createDiskFile: (
    projectId: number,
    entryPath: string,
    size: number,
    semanticPackBacked?: boolean,
  ) => File,
): { files: Map<string, File>; workerFiles: LineParserWorkerFile[] } {
  const files = new Map<string, File>();
  const workerFiles: LineParserWorkerFile[] = [];
  for (const item of items) {
    const path = item.entry_path;
    // currentFiles 永远保持 lazy；即使语义 bytes 已返回给 Worker，也不再
    // 复制到 Blob/File。大 MOD/STL 的 metadata-only 条目同样可按需来源追溯。
    files.set(path, createDiskFile(projectId, path, item.size, item.packed));
    if (item.packed && item.bytes) {
      const bytes = item.bytes;
      const buffer =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? (bytes.buffer as ArrayBuffer)
          : (bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer);
      workerFiles.push({ path, bytes: buffer });
    } else {
      // Worker 只需要路径元数据来保持 filesByType（尤其 MOD/STL）统计，
      // 不把大几何文件送入解析线程。
      workerFiles.push({ path, bytes: new ArrayBuffer(0) });
    }
  }
  return { files, workerFiles };
}
