# 变电几何批量读取与缓存契约

> 本文只描述当前实现的 DEV/PHM/MOD/STL 几何缓存、批量读取和回退边界。
> IFC 语义索引见 [gim_substation.md](../gim_substation.md)；未完成的优化统一列在
> [dev-log.md](../dev-log.md)。

## 1. 适用范围

变电工程的几何来源链为：

```text
CBM placement → DEV → PHM / 子 DEV → MOD 或 STL
```

首次打开由渐进式 DEV GLB 管线编译和渲染；缓存命中优先恢复 DEV 粒度 GLB，只有
单个 DEV 失败时才对该 DEV 做原始 MOD/STL 回退。IFC 仍由 OBC Fragments 独立加载。

## 2. 首次打开流程

```text
可达 CBM/DEV
  → 解析 DEV、PHM、MOD/STL 引用链
  → 每个 unique DEV 编译一次 GLB
  → 写入 glbcache/{projectId}/DEV/
  → 逐个 CBM placement 应用累积矩阵并渲染
  → 完整 manifest 写入成功后提交 geometry cache version
```

- `serializeDevToGlb` 在前端完成 MOD/STL 解析、Geometry IR 构造和 GLB 序列化。
- 同一 DEV 被多个 CBM placement 引用时只编译一次，但每个 placement 保留独立
  的场景实例和变换。
- 任务受 `ProjectLoadSession`、source SHA-256 和 geometry token 保护；工程切换或
  任务中断时不提交不完整 manifest。

## 3. Manifest 契约

每个 unique DEV 必须在 `_manifest.json` 中出现一次：

| 字段 | 约定 |
|---|---|
| `devPath` | 归一化后的 DEV 相对路径，比较大小写不敏感 |
| `status` | `glb` 或 `empty`；`empty` 是合法的确定性结果 |
| `size` | `glb` 为实际字节数，`empty` 为 `0` |
| `geometryCacheVersion` | 当前为 `geometry-cache-v5-dev-status` |
| `sourceSha256` | 生成该缓存的 GIM 内容身份 |

以下条件同时满足才算 geometry cache 完整命中：

1. manifest 版本、source SHA 和 DEV 集合均匹配；
2. 每个 unique DEV 都有 `glb` 或 `empty` 状态；
3. `glb` 文件存在、大小与 manifest 相同且通过 GLB header 校验；
4. manifest 写入和版本标记均成功完成。

manifest 缺失、结构损坏、版本或 source SHA 不匹配时，整个 geometry cache 失效，
但不会使 CBM/FAM/DEV/IFC 语义缓存失效，也不会重新读取原始 GIM 以外的语义索引。

## 4. Warm fast path 与失败隔离

缓存命中时先建立 `Map<devPath, CbmNode[]>`，再按 unique DEV 处理：

```text
manifest status=empty → 记录成功，不读文件、不回退
manifest status=glb   → 批量读一次 GLB → 为所有 placement 独立实例化
单 DEV 缺失/截断/读取错误/解析错误 → 标记 failedDevPath → 仅该 DEV scoped raw fallback
```

- 同一个 DEV 的多个 CBM placement 共享一次 GLB bytes 读取和失败状态。
- 已成功渲染的 GLB DEV 不会因为另一个 DEV 失败而被清理或重新解析。
- 只有 manifest/source 整体损坏才放弃 fast path 并重建 geometry cache；这不等同于
  “全项目 raw MOD fallback”。
- scoped fallback 只查询失败 DEV 可达的 PHM/MOD/STL，不重新加载成功 GLB DEV。

诊断至少包含：`failedDevCount`、`failedDevPaths`、`failureType`、
`partialRawFallbackCount`、`partialRawFallbackInstanceCount`、
`successfulGlbDevCount`、`successfulGlbInstanceCount`、
`fullProjectRawFallbackCount`。正常的单 DEV 失败应保持
`fullProjectRawFallbackCount = 0`。

## 5. 二进制批量读取

Rust command `batch_read_glb_files` 返回 GIMR v2 二进制 envelope，而不是 JSON 数组。
前端按“最多 256 个文件或预计 64 MiB”择小分批；每个请求仍校验 `projectId`、
相对路径和 session 身份。路径组件拒绝 `..`，目录大小写按不敏感键匹配。

线路的语义小文件批读使用同一类 `batch_read_cached_files` 能力，但线路 graph/属性
缓存与本契约的 DEV GLB manifest 相互独立。

## 6. 变换、材质与实例

- DEV、PHM、CBM 和 SUBDEVICE 的累积 `TRANSFORMMATRIX` 使用列主序解释，最终在
  顶点级烘焙到当前实例，避免 `Object3D.applyMatrix4` 分解造成的精度损失。
- PHM `COLORn` 与 `SOLIDMODELn` 一一对应；颜色在实例材质上覆盖，`A=0` 按不透明
  哨兵处理，`max(A)>100` 使用字节制，否则使用百分制。
- 当前不共享 Three.js `BufferGeometry` 或 `InstancedMesh`。placement 可能修改几何，
  因此每个 CBM instance 保持独立加载；同一 DEV 只共享 GLB bytes 和编译结果。

## 7. 与其它缓存的关系

| 缓存域 | 身份/版本 | 失效影响 |
|---|---|---|
| 语义索引 | `SUBSTATION_PARSER_VERSION=gim-substation-parser-v22` | 重建变电 CBM/FAM/DEV/IFC Spatial 索引 |
| 线路语义 | `LINE_PARSER_VERSION=gim-line-parser-v1` | 只重建线路 graph、属性和 semantic pack |
| DEV 几何 | `GEOMETRY_CACHE_VERSION=geometry-cache-v5-dev-status` + source SHA | 只重建 geometry manifest/GLB |
| IFC Fragments | `FRAGMENTS_CACHE_KEY_VERSION` + OBC/web-ifc 版本 + source SHA | 只回退对应 IFC 的 web-ifc 路径 |

geometry cache 版本变化、manifest 损坏或单 DEV 失败，不得清空已经恢复的语义树，
也不得触发其它缓存域的无关重建。

## 8. 运行时验证要点

- 多个 CBM instance 共用同一 DEV 时，GLB 读取最多一次，实例数量和各自位置保持不变。
- `glb + empty` 混合时 fast path 仍算完整命中；合法 empty 不触发 raw fallback。
- 缺失、截断、大小错误或 parse exception 只影响失败 DEV；A→B 工程切换后旧批次
  不得提交到 B。
- 变电导航、CBM↔IFC 关系、MOD/STL 来源和属性面板行为与 cache-off 语义一致。

## 9. 当前不包含的能力

shared geometry、几何 Worker、SQLite geometry BLOB、预编译 `.gimc` 容器和其它大规模
缓存架构不属于当前契约。是否立项由 [dev-log.md](../dev-log.md) 管理；本文不维护运行日志。
