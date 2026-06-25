# Fragments 缓存设计

## 1. 当前依赖版本

| 包 | 版本 |
|---|---|
| `@thatopen/components` | 3.4.6 |
| `@thatopen/fragments` | 3.4.5 |
| `web-ifc` | 0.0.77 |
| `three` | 0.184.x |

## 2. API 探查结论

### 2.1 序列化 API（IFC → Fragments 二进制）

**`FragmentsModel.getBuffer(raw?: boolean): Promise<ArrayBuffer>`**

- 位于 `@thatopen/fragments` 的 `FragmentsModel` 类
- `raw = false`（默认）：返回压缩后的 ArrayBuffer
- `raw = true`：返回未压缩的原始 ArrayBuffer
- 用法：`const buffer = await model.getBuffer()` — 从已加载的 FragmentsModel 提取二进制数据

### 2.2 反序列化 API（Fragments 二进制 → 模型）

**`FragmentsModels.load(buffer: ArrayBuffer | Uint8Array, options): Promise<FragmentsModel>`**

- 位于 `@thatopen/fragments` 的 `FragmentsModels` 类
- 通过 `ctx.fragments.core` 访问（`FragmentsManager.core` 返回 `FragmentsModels` 实例）
- options:
  - `modelId: string` — 模型唯一标识
  - `camera?: THREE.PerspectiveCamera | THREE.OrthographicCamera` — 用于 culling/LOD
  - `raw?: boolean` — 是否为未压缩数据（默认 false，与 `getBuffer()` 默认匹配）
  - `onProgress?: (event: LoadProgressEvent) => void` — 加载进度回调
- 返回 `Promise<FragmentsModel>` — 加载后的模型实例
- **关键**：加载后模型自动加入 `ctx.fragments.list`，触发 `onItemSet` 事件，现有 `registerModelEvents` 中的场景添加逻辑自动生效

### 2.3 IfcLoader.load() 返回值

**`IfcLoader.load(data: Uint8Array, coordinate: boolean, name: string, config?): Promise<FragmentsModel>`**

- 返回 `Promise<FragmentsModel>` — 转换后的 Fragments 模型
- 当前代码未使用返回值，但可用于 `getBuffer()` 序列化

### 2.4 FragmentsManager 与 FragmentsModels 的关系

- `ctx.fragments`（`FragmentsManager`，来自 `@thatopen/components`）是组件层封装
- `ctx.fragments.core`（`FragmentsModels`，来自 `@thatopen/fragments`）是底层引擎
- `ctx.fragments.list`（`DataMap<string, FragmentsModel>`）是已加载模型的映射表
- `ifcLoader.load()` 内部调用 `FragmentsModels.load()` 创建模型，模型自动加入 `list`
- 直接调用 `ctx.fragments.core.load()` 也会将模型加入 `list`，触发 `onItemSet` 事件

## 3. 缓存格式

采用 **Fragments 压缩二进制格式**（`getBuffer()` 默认输出）。

- 序列化：`await model.getBuffer()` → `ArrayBuffer`（压缩）
- 反序列化：`await ctx.fragments.core.load(buffer, { modelId, camera })` → 自动解压
- 文件扩展名：`.frag`
- 不需要额外元数据文件，所有元信息存储在 SQLite `fragment_cache` 表中

## 4. 为什么不破坏现有懒加载流程

1. **`loadIfcBuffer` 签名向后兼容**：新增 `entryPath?` 可选参数，不传时走原 IFC load 路径
2. **缓存命中时复用现有事件系统**：`ctx.fragments.core.load()` 触发 `onItemSet`，现有 `registerModelEvents` 自动处理场景添加、相机绑定、模型列表更新
3. **缓存未命中时走原路径**：`ifcLoader.load()` 正常执行，额外做 `getBuffer()` + 写入缓存（非阻塞，失败不影响主流程）
4. **GIM 打开阶段不创建 Viewer**：缓存逻辑完全在 `loadIfcBuffer` 内部，GIM 打开流程不涉及
5. **本地 IFC 打开不启用缓存**：`openIfcService.ts` 不传 `entryPath`，走普通 IFC load

## 5. 降级策略

如果 `getBuffer()` 或 `core.load()` 在运行时抛出异常：
- **序列化失败**：`console.warn` 并跳过缓存写入，IFC 正常加载不受影响
- **反序列化失败**：`console.warn` 并回退到 `ifcLoader.load()` 正常 IFC 转换
- **文件读写失败**：同上，不影响主流程

如果 ThatOpen API 类型不明确：
- 在 `fragmentsCacheLoader.ts` 内做最小范围类型适配（如 `as any` 仅用于 camera 获取）
- 不在业务层大面积使用 `any`

### 5.1 实际遇到的类型适配

**问题**：`ctx.world.camera` 在 OBC 类型系统中声明为基类 `OBC.Camera`（接口），而 `.three` 属性只定义在 `SimpleCamera` 子类上。直接访问 `ctx.world.camera.three` 会报 TS2322。

**原因**：OBC 的 `World` 接口将 `camera` 字段声明为 `Camera`（基类），但运行时实际是 `OrthoPerspectiveCamera`（继承自 `SimpleCamera`）。这是 ThatOpen 组件库的类型设计问题，不是本项目代码问题。

**适配方式**：在 `fragmentsCacheLoader.ts` 内使用 `(ctx.world.camera as unknown as OBC.SimpleCamera).three`，与 `ifcLoader.ts` 中已有的 `(ctx.world.camera as any).three` 适配方式一致，但更类型安全（`as unknown as` 比 `as any` 更严格）。

**未使用 `any`**：`tryWriteFragmentsCache` 的 `model` 参数使用结构化类型 `{ getBuffer(raw?: boolean): Promise<ArrayBuffer> }` 而非 `FragmentsModel` 完整类型，避免引入额外的 `any`。

## 6. 缓存版本失效

- 独立版本常量：`FRAGMENTS_CACHE_VERSION = "fragments-cache-v1"`
- `validate_fragment_cache` 检查 `stored fragments_version == FRAGMENTS_CACHE_VERSION`
- 版本不匹配 → `valid = false` → 回退 IFC 转换 → 重建缓存
- 不自动删除旧文件，本轮只回退重建

## 7. 缓存命中路径

```
loadIfcBuffer(ctx, name, ifcBuffer, state, onProgress, entryPath)
  └→ loadModelWithFragmentsCache(ctx, state, name, ifcBuffer, entryPath, onProgress)
       ├→ validateFragmentCache(projectId, entryPath, ifcBuffer.byteLength)
       │   └→ valid=true → readFragmentCacheFile(projectId, entryPath)
       │        └→ ctx.fragments.core.load(fragBuffer, { modelId, camera })
       │             └→ onItemSet 事件自动触发 → 场景添加 + 模型列表更新
       └→ valid=false → 回退 IFC load（见未命中路径）
```

## 8. 缓存未命中回退路径

```
loadIfcBuffer(ctx, name, ifcBuffer, state, onProgress, entryPath)
  └→ loadModelWithFragmentsCache(ctx, state, name, ifcBuffer, entryPath, onProgress)
       ├→ validateFragmentCache → valid=false（或非 Tauri / 无 projectId）
       └→ ctx.ifcLoader.load(ifcBuffer, true, modelId, { processData: { progressCallback } })
            └→ 返回 FragmentsModel
            └→ model.getBuffer() → ArrayBuffer（压缩）
            └→ writeFragmentCacheFile(projectId, entryPath, bytes) → { path, size }
            └→ upsertFragmentCacheRecord(projectId, entryPath, modelId, ifcSize, fragSize)
            └→ 写入失败 → console.warn，不影响加载
```
