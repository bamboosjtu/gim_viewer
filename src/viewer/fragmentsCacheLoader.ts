import * as OBC from '@thatopen/components';
import type { ViewerContext } from './viewerEngine.js';
import type { AppState } from '../app/state.js';
import { isTauri } from '../desktop/runtime.js';
import {
  validateFragmentCache,
  readFragmentCacheFile,
  writeFragmentCacheFile,
  upsertFragmentCacheRecord,
} from '../desktop/database.js';

/**
 * 带 Fragments 缓存的 IFC 模型加载器。
 *
 * 命中路径：validateFragmentCache → readFragmentCacheFile → ctx.fragments.core.load()
 * 未命中路径：ctx.ifcLoader.load() → model.getBuffer() → writeFragmentCacheFile + upsertFragmentCacheRecord
 *
 * 所有缓存相关错误均 console.warn，不中断主流程；仅当 IFC 本身加载失败时抛出。
 */

/**
 * 加载 IFC 模型，优先使用 Fragments 缓存。
 *
 * @param ctx Viewer 上下文
 * @param state 应用状态（读取 currentProjectId / loadedModels）
 * @param name IFC 文件名（用于推导 modelId）
 * @param ifcBuffer IFC 文件二进制内容
 * @param entryPath GIM 内部相对路径（作为缓存 key；不传则不启用缓存）
 * @param onProgress IFC 转换进度回调（仅未命中路径会触发）
 */
export async function loadModelWithFragmentsCache(
  ctx: ViewerContext,
  state: AppState,
  name: string,
  ifcBuffer: Uint8Array,
  entryPath: string | null,
  onProgress?: (progress: number) => void,
): Promise<void> {
  const modelId = name.replace(/\.ifc$/i, '');
  const projectId = state.currentProjectId;
  const canUseCache = isTauri() && projectId != null && !!entryPath;

  // 1. 尝试命中 Fragments 缓存
  if (canUseCache && entryPath) {
    const cacheHit = await tryLoadFromFragmentsCache(ctx, state, modelId, entryPath, ifcBuffer.byteLength);
    if (cacheHit) {
      console.log(`[Fragments Cache] 命中: ${entryPath} (modelId=${modelId})`);
      return;
    }
  }

  // 2. 未命中（或不可用）→ 走 IFC 转换
  console.log(`[Fragments Cache] 未命中: ${entryPath ?? '(无 entryPath)'} (modelId=${modelId})`);
  const model = await ctx.ifcLoader.load(ifcBuffer, true, modelId, {
    processData: { progressCallback: (progress) => { onProgress?.(progress); } },
  });
  state.loadedModels.set(modelId, { modelId, visible: true });

  // 3. 转换成功后异步写入缓存（失败不影响主流程）
  if (canUseCache && entryPath) {
    await tryWriteFragmentsCache(model, projectId as number, entryPath, modelId, ifcBuffer.byteLength).catch((err) => {
      console.warn(`[Fragments Cache] 写入失败，不影响当前加载: ${entryPath}`, err);
    });
  }
}

/**
 * 尝试从 Fragments 缓存加载模型。
 * @returns true 表示加载成功；false 表示未命中或加载失败（调用方应回退 IFC 转换）
 */
async function tryLoadFromFragmentsCache(
  ctx: ViewerContext,
  state: AppState,
  modelId: string,
  entryPath: string,
  sourceIfcSize: number,
): Promise<boolean> {
  const projectId = state.currentProjectId;
  if (projectId == null) return false;

  let validation;
  try {
    validation = await validateFragmentCache(projectId, entryPath, sourceIfcSize);
  } catch (err) {
    console.warn(`[Fragments Cache] 校验失败，回退 IFC: ${entryPath}`, err);
    return false;
  }

  if (!validation.valid) {
    if (validation.has_record && !validation.fragments_version_match) {
      console.warn(`[Fragments Cache] 版本不匹配: ${entryPath} (stored=${validation.stored_fragments_version}, current=${validation.current_fragments_version})`);
    }
    return false;
  }

  let fragBytes: Uint8Array;
  try {
    fragBytes = await readFragmentCacheFile(projectId, entryPath);
  } catch (err) {
    console.warn(`[Fragments Cache] 读取失败，回退 IFC: ${entryPath}`, err);
    return false;
  }

  if (fragBytes.byteLength === 0) {
    console.warn(`[Fragments Cache] 缓存文件为空，回退 IFC: ${entryPath}`);
    return false;
  }

  try {
    // ctx.fragments.core 是 FragmentsModels 实例
    // load() 后模型自动加入 ctx.fragments.list，触发 onItemSet 事件
    // 现有 registerModelEvents 会处理场景添加、相机绑定、模型列表更新
    // ctx.world.camera 在 OBC 类型中是基类 Camera，实际运行时是 OrthoPerspectiveCamera
    // 其 .three 属性是 THREE.PerspectiveCamera | THREE.OrthographicCamera
    // 此处沿用 ifcLoader.ts 中已有的最小类型适配方式
    const camera = (ctx.world.camera as unknown as OBC.SimpleCamera).three;
    await ctx.fragments.core.load(fragBytes, { modelId, camera });
    // onItemSet 事件中已更新 state.loadedModels，此处不重复设置
    return true;
  } catch (err) {
    console.warn(`[Fragments Cache] 反序列化失败，回退 IFC: ${entryPath}`, err);
    return false;
  }
}

/**
 * 尝试将已加载的 Fragments 模型写入缓存。
 * 任何步骤失败均 console.warn 并返回，不抛出。
 */
async function tryWriteFragmentsCache(
  model: { getBuffer(raw?: boolean): Promise<ArrayBuffer> },
  projectId: number,
  entryPath: string,
  modelId: string,
  sourceIfcSize: number,
): Promise<void> {
  let buffer: ArrayBuffer;
  try {
    // raw=false（默认）返回压缩二进制，与 core.load() 默认 raw=false 匹配
    buffer = await model.getBuffer();
  } catch (err) {
    console.warn(`[Fragments Cache] 序列化失败，跳过缓存写入: ${entryPath}`, err);
    return;
  }

  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength === 0) {
    console.warn(`[Fragments Cache] 序列化结果为空，跳过缓存写入: ${entryPath}`);
    return;
  }

  let writeResult: { path: string; size: number };
  try {
    writeResult = await writeFragmentCacheFile(projectId, entryPath, bytes);
  } catch (err) {
    console.warn(`[Fragments Cache] 写入文件失败，不影响当前加载: ${entryPath}`, err);
    return;
  }

  try {
    await upsertFragmentCacheRecord(projectId, entryPath, modelId, sourceIfcSize, writeResult.size);
    console.log(`[Fragments Cache] 写入成功: ${entryPath} (size=${writeResult.size})`);
  } catch (err) {
    console.warn(`[Fragments Cache] 写入记录失败，不影响当前加载: ${entryPath}`, err);
  }
}
