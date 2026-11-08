# 缓存域

本文件是文档中唯一的缓存契约索引。修改持久化含义时只失效受影响域；实际常量以链接源码为准，不在其他文档复制版本号。

## 存储面

| 存储 | 内容 | 生命周期 |
|---|---|---|
| SQLite `gim_cache_schema_v1.db` | 工程记录、变电/线路语义、DEV 几何引用 | 安装数据目录；按域版本和源 SHA 失效 |
| 原生文件缓存 | 解压清单、DEV GLB 模板/目录、IFC LOD 产物 | 工程数据目录；逐条原子文件 + 完成凭据 |
| IndexedDB | 浏览器/开发上下文的 DEV LOD、IFC 远景/区域/属性派生 | WebView profile；键绑定源与依赖版本 |
| localStorage | 视图偏好、自动定位、底图选择、调试开关 | 设备/会话偏好，不作为工程事实 |
| 内存会话 | 工程实体图、导航、选择、相机历史、临时预览 | 工程关闭即释放 |

首次正式发布前，SQLite 物理 schema 固定为 v1，不维护开发库的升级兼容。结构变更后由开发者删除旧库并重建。语义、几何与投影缓存域仍独立失效。

SQLite 共享 `gim_project`；变电表使用 `substation_*`，线路表使用 `powerline_*`。读取时按工程 ID、源 SHA 和域版本校验，不能只凭表中有行判定命中。

无 GIMPKG 头的裸 7z/ZIP 先由原生解压层按签名和配额处理，工程类型仍由内容决定；原生清单按源 SHA 绑定。裸 7z 与 GIMPKGS 使用同一通用来源 pack 保存非 IFC 条目，独立落盘的 IFC 保留缓存路径；pack 选择不决定工程或设备语义。若改走 WASM 回退，全部归档条目都要持久化后才能发布完整 SQLite 索引。工程来源图 `partial` 表示来源覆盖不完整，可能不写 Engineering Worker 的来源/实体/导航派生缓存；它不否定已通过校验的 SQLite 变电核心缓存。

## 当前契约

| 域 | 当前契约 | 权威定义 | 失效/校验范围 |
|---|---|---|---|
| 线路语义 | `gim-line-parser-v1` | [db.rs](../../desktop/src-tauri/src/db.rs) | 源 SHA、完整事务、graph/属性 |
| 变电语义 | `gim-substation-parser-v28` | [db.rs](../../desktop/src-tauri/src/db.rs) | 原始属性、CBM/DEV/IFC 引用、索引 receipt |
| DEV 几何 | `geometry-cache-v18-dev-wide-outline` | [db.rs](../../desktop/src-tauri/src/db.rs)、[DEV 目录](../../desktop/src/services/devSpatialCatalog.ts) | occurrence 引用、manifest、GLB 完整性 |
| DEV LOD 派生 | 几何版本组合 `dev-spatial-catalog-v2`；有源 SHA 的浏览器上下文使用 IndexedDB `gim-dev-lod-v1` | [DEV 目录](../../desktop/src/services/devSpatialCatalog.ts)、[LOD 缓存](../../desktop/bridge/devLodCache.ts) | 源 SHA、DEV 路径、几何版本与 LOD；L0 持久化、仅热点 L1 选择性持久化、L2 默认内存；模板/目录逐条原子提交 |

| 变电 Spatial | `substation-spatial-semantic-v6` | [Spatial 快照](../../desktop/src/services/substationSpatialSemanticCache.ts) | 精确大小写身份、宿主链、原始 IFC Name；缺失/损坏重建 |
| IFC Spatial parser | `gim-substation-parser-v25` | [Spatial 快照](../../desktop/src/services/substationSpatialSemanticCache.ts) | 独立于变电语义域 |
| 工程来源 | `engineering-source-v12` | [来源契约](../../desktop/src/gim/engineering/buildSources.ts)、[编码](../../desktop/src/services/engineeringCacheCodec.ts)、[来源表](../../desktop/src/services/engineeringSourceCodec.ts) | 源 SHA、条目清单、来源/IFC parser 契约、完整性；独立原子文件 |
| 工程实体 | `engineering-entity-v4` + `engineering-wholes-10` + `engineering-catalog-v2` | [实体编码](../../desktop/src/services/engineeringCacheCodec.ts)、[目录规则](../../desktop/src/engineering/catalogRules.json)、[目录契约](../../desktop/src/engineering/catalog.json) | 绑定来源内容摘要、实体 schema、规则版本；只重建实体 |
| 工程导航 | `engineering-navigation-v9` + `engineering-composition-v11` + `engineering-source-tree-v1` + `engineering-inventory-v5` + 目录版本 | [三视图投影](../../desktop/src/gim/engineering/navigation.ts)、[组成](../../desktop/src/engineering/composition.ts)、[来源树](../../desktop/src/gim/engineering/sourceProjection.ts)、[清册](../../desktop/src/engineering/inventoryTemplate.ts)、[导航缓存](../../desktop/src/services/engineeringNavigationCache.ts) | 绑定来源摘要、实体快照指纹和空间投影策略版本；校验节点可达性、完整投影标记与覆盖率；部分范围不写导航缓存 |
| IFC 浏览 LOD | `bim-lod-v8` 组合 | [features](../../desktop/src/config/features.ts)、[LOD 缓存](../../desktop/bridge/ifcLodCache.ts) | 源 SHA、条目、LOD 策略、单次解析、依赖版本；分远景/近景/属性独立失效 |
| IFC 区域模板 | `near-templates-v1`，附加于浏览 LOD 键 | [features](../../desktop/src/config/features.ts) | 模板几何与逐对象放置；不重建有效远景 |
| Android 线路语义 | `mobile-powerline-v3` | [移动存储](../../app/src-tauri/src/storage.rs)、[领域投影](../../packages/powerline-core/src/domain.ts) | 私有源 SHA/大小、对象与属性范围、FAM 分类 |
| Android HNum | `hnum-xz-v2` | [领域定义](../../packages/powerline-core/src/domain.ts) | 源 SHA、MOD 路径；跨 Body 唯一点号 |
| 视图状态 | `gim-view-state-v2`（localStorage） | [viewStateStore](../../desktop/src/services/viewStateStore.ts) | 工程 SHA/路径；相机、树展开、选择路径；不参与工程事实 |

暖开 catalog 命中率只要求可成功表示的来源；有原始范围或引用证据的失败来源未产出目录缓存时，报告单列其未命中集合并与全部 DEV 来源数核对。其他 miss、读取错误和无证据失败不能被样本级白名单掩盖。

## 发布与恢复

### 先发布、后写缓存

工程实体构建完成后先提交 `engineeringSources/snapshot/navigation`，再进入 `finishBuild → saveResult`。缓存编码/写入失败只改变 `engineeringCacheStatus`，不回滚已发布模型；工程切换或取消后，迟到的缓存结果不得提交。

保存按 `sources → entities → navigation` 逐域请求 Worker 编码：

- Worker 的 `encode-cache` 绑定 `buildId`，并要求请求域等于当前 `plan[0]`；
- 编码成功才 `plan.shift()`，失败清空 plan；
- 每域写入后立即释放 `encoded.bytes`，再编码下一域，避免三个域的压缩缓冲同时驻留；
- 每次 `await` 后检查当前会话/构建身份；旧构建结果不写。

### 分片与上限

单域 JSON 超过 64 MiB 时按 64 MiB 分片独立 gzip；压缩体上限 384 MiB，解码后总 plain 上限 1 GiB。分片只在编码/恢复时存在，不改变 artifact 身份、来源 SHA 或域版本。读取时校验每片长度、顺序、总 plain 大小和 gzip 边界，任何一片缺失/损坏按整域失败处理。

### 恢复判定

- `sources`、`entities`、`navigation` 分别尝试；缺失/损坏的域按依赖重建，不删除其他有效域。
- 只有实体和导航都命中时才标 `hit`；仅来源恢复（实体/导航仍需重建）标 `partial`，并写入明确原因。
- 导航只持久化具备全部 IFC 范围且投影完成的树；部分 IFC 范围、空间投影未完成或组成覆盖率不足时不写导航缓存。
- 来源恢复后仍校验来源清单/IFC 清单与域版本；只有来源文件存在不足以证明完整命中。

### 原子性与暖恢复顺序

- **原子文件**：每个缓存文件有独立头、源 SHA 和完成凭据；先写临时文件，校验后 rename。工程来源、实体、导航各自独立，不能把部分写当成完整发布。
- **来源域**：原值/字段形状去重表保留 FAM 原行、重复字段、occurrence 地址和 IFC 空间上下文；缺条目/解析失败时不写完整来源凭据。
- **实体/导航域**：绑定来源内容摘要；来源有效而实体规则变化时，只重建实体和导航，不重解析 IFC 或重编几何。实体快照未变时导航可独立重建。
- **DEV 域**：模板和目录分别原子提交；manifest 损坏使几何域失效，但不删除有效语义域。单 DEV 坏 GLB 可局部回退原始几何。大 DEV 的装配子树部分只在 Worker 内存中存在，合并后仍写同一 DEV 模板键；部分不拥有独立持久化身份。L0 生成即持久化；L1 只在选中/显式提升或淘汰后再次请求时写入；L2、空、unsupported 与 source-invalid 终态默认不持久化。
- **DEV 派生文件耐久性**：模板与目录仍用同目录临时文件和原子 rename 替换，保留源 SHA/版本校验。它们可由原始 GIM 重建，因此不再对每个产物强制 `fsync`；断电后若某条派生文件缺失或校验失败，按该条目失效重编。语义 SQLite 的事务与原子发布契约不变。吞吐收益及断电恢复需要本地验证。
- **IFC 域**：bim-lod 远景产物、区域模板、按需属性分别缓存；远景 HIT 跳过源读取，近景 HIT 跳过源模型和对象求值；源 SHA 改变拒绝近景。
- **暖恢复顺序**：语义/来源 → 实体 → 导航 → 几何/IFC。任何一步失败只影响该域，不能回滚已合法提交的其他域。

匿名 B1-3 裸 7z 已完成一轮原生冷暖：SQLite 核心冷发布和暖恢复均通过。B1-4 的完整冷暖、重复运行内存回落与认可基线仍待验收；单组成功和 Node/Worker 候选不能替代完整矩阵，见[问题与限制](../open-issues.md)。

## 失效规则

| 变化 | 应失效 | 不应失效 |
|---|---|---|
| 源文件 SHA/大小变化 | 全部工程域 | 其他工程 |
| 分类规则/目录版本变化 | 工程实体、导航 | 来源、DEV/IFC 几何 |
| 来源适配/IFC 外露变化 | 工程来源、实体、导航 | 已完成的 DEV 几何 |
| DEV 模板/primitive 版本变化 | DEV 几何、DEV LOD 目录 | 变电语义、Spatial、IFC 域 |
| Spatial 解析/宿主规则变化 | Spatial 快照 | 变电语义、DEV 几何 |
| IFC 浏览 LOD 策略变化 | 远景/近景/属性对应键 | DEV 几何、工程实体 |
| UI 展示变化 | 视图状态或无需缓存 | 工程数据/几何 |

旧格式直接失效重建，不提供迁移、旧快照读取或历史兼容分支。缓存损坏只删除受影响域；删除工程时再清理该工程全部缓存。

## 诊断

缓存状态至少区分：`none`、`miss`、`hit`、`partial`、`saving`、`saved`、`error`。诊断需包含域版本、源 SHA、条目/节点计数和失败原因，不能用一个布尔值代表全部恢复。

相关实现：[projectCacheService](../../desktop/src/services/projectCacheService.ts)、[engineeringCacheCodec](../../desktop/src/services/engineeringCacheCodec.ts)、[substationSpatialSemanticCache](../../desktop/src/services/substationSpatialSemanticCache.ts)、[devSpatialCatalog](../../desktop/src/services/devSpatialCatalog.ts)。

工程组成投影只持久化路径、归属引用与推断状态，不包含 `evidence` 投影依据数组。导航 JSON 位于工程导航派生文件，SQLite 提供工程身份授权，没有独立的投影依据列；原始来源证据与实体识别字段保持各自契约。

## 相关文档

- [系统架构](../architecture.md)
- [打开与生命周期](lifecycle.md)
- [工程实体运行时](engineering-runtime.md)
- [DEV 几何运行时](dev-geometry.md)
- [IFC 运行时](ifc-runtime.md)
- [验证](../validation.md)
