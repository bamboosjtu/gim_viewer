/** Geometry loading options, progress and captured-session guards. */
import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { DevCheckpointHandler } from './substationBackgroundRuntime.js';

/** 自动加载选项 */
/** 自动加载选项 */
export interface GeometryAutoLoadOptions {
  onDevCheckpoint?: DevCheckpointHandler;
  /** 调用方 token（用于防竞态：项目切换后递增，后台任务检测不匹配则停止） */
  token?: number;
  /** 工程加载代次（与 token 配合，防止同一 token 被错误复用）。 */
  generation?: number;
  /** 捕获的 project_id；未提供时使用调用瞬间的 state.currentProjectId。 */
  projectId?: number | null;
  /** 捕获的源 GIM SHA-256；防止同一 project_id 的旧任务跨源写入场景。 */
  sourceSha256?: string | null;
  /** 可直接复用的不可变工程会话快照。 */
  session?: ProjectLoadSession;
  /** 是否加载 .mod 文件（默认 true） */
  includeMod?: boolean;
  /** 是否加载 .stl 文件（默认 false，P0 不默认加载 STL） */
  includeStl?: boolean;
  /** 缓存校验结果；false 时不得把过期 GLB 当作可用 fast path。 */
  geometryCacheValid?: boolean;
  /** manifest/source/entry 结构是否有效；单个 GLB 文件损坏仍可按 DEV 隔离。 */
  geometryCacheManifestValid?: boolean;
  /** geometry cache 版本标记文件是否匹配。 */
  geometryCacheVersionFileMatch?: boolean;
}

/** 自动加载进度 */
/** 自动加载进度 */
export interface AutoLoadProgress {
  phase: 'collecting' | 'discovering' | 'loading_mod' | 'loading_stl' | 'done';
  collectedDevPaths: number;
  discoveredMods: number;
  discoveredStls: number;
  loadedMods: number;
  loadedStls: number;
  totalMods: number;
  totalStls: number;
  /** 快速缓存阶段已检查的 DEV 任务数；用于区分“已处理”和“成功渲染”。 */
  processedMods?: number;
  currentPath?: string;
}

/** 检查 token 是否仍然有效（防竞态：项目切换后递增 token，旧任务检测不匹配则停止） */
export function isGeometryTokenValid(state: AppState, token?: number): boolean {
  if (token === undefined) return true;
  return state.geometryLoadToken === token;
}

export function isGeometryContextValid(
  state: AppState,
  token: number | undefined,
  generation: number | undefined,
  projectId: number | null | undefined,
  sourceSha256?: string | null,
): boolean {
  if (!isGeometryTokenValid(state, token)) return false;
  if (generation !== undefined && state.projectGeneration !== generation) return false;
  if (projectId !== undefined && state.currentProjectId !== projectId) return false;
  if (sourceSha256 !== undefined && state.currentSourceSha256 !== sourceSha256) return false;
  return true;
}

/** Yield between raw geometry batches so UI events can run. */
export const YIELD_MS = 16;
