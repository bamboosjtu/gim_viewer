# 缓存域

本文件是文档中唯一的缓存契约索引。修改持久化含义时只失效受影响域；实际常量以链接源码为准，不在其他文档复制版本号。

## 1. 存储面

| 存储 | 内容 | 生命周期 |
|---|---|---|
| SQLite `gim_cache_schema_v1.db` | 工程记录、变电/线路语义、DEV 几何引用 | 安装数据目录；按域版本和源 SHA 失效 |
| 原生文件缓存 | 解压清单、DEV GLB 模板/目录、IFC LOD 产物 | 工程数据目录；逐条原子文件 + 完成凭据 |
| IndexedDB | 浏览器/开发上下文的 DEV LOD、IFC 远景/区域/属性派生 | WebView profile；键绑定源与依赖版本 |
| localStorage | 视图偏好、自动定位、底图选择、调试开关 | 设备/会话偏好，不作为工程事实 |
| 内存会话 | 工程实体图、导航、选择、相机历史、临时预览 | 工程关闭即释放 |

SQLite 共享 `gim_project`；变电表使用 `substation_*`，线路表使用 `powerline_*`。读取时按工程 ID、源 SHA 和域版本校验，不能只凭表中有行判定命中。

## 2. 当前契约

| 域 | 当前契约 | 权威定义 | 失效/校验范围 |
|---|---|---|---|
| 线路语义 | `gim-line-parser-v1` | [db.rs](../../desktop/src-tauri/src/db.rs) | 源 SHA、完整事务、graph/属性 |
| 变电语义 | `gim-substation-parser-v27` | [db.rs](../../desktop/src-tauri/src/db.rs) | 原始属性、CBM/DEV/IFC 引用、索引 receipt |
| DEV 几何 | `geometry-cache-v17-source-occurrences` | [db.rs](../../desktop/src-tauri/src/db.rs)、[DEV 目录](../../desktop/src/services/devSpatialCatalog.ts) | occurrence 引用、manifest、GLB 完整性 |
| DEV LOD 派生 | 几何版本组合 `dev-spatial-catalog-v2`；有源 SHA 的浏览器上下文使用 IndexedDB `gim-dev-lod-v1` | [DEV 目录](../../desktop/src/services/devSpatialCatalog.ts)、[LOD 缓存](../../desktop/bridge/devLodCache.ts) | 源 SHA、DEV 路径、几何版本与 LOD；模板/目录逐条原子提交 |
| 变电 Spatial | `substation-spatial-semantic-v5` | [Spatial 快照](../../desktop/src/services/substationSpatialSemanticCache.ts) | 精确大小写身份、宿主链、原始 IFC Name；缺失/损坏重建 |
| IFC Spatial parser | `gim-substation-parser-v25` | [Spatial 快照](../../desktop/src/services/substationSpatialSemanticCache.ts) | 独立于变电语义域 |
| 工程来源 | `engineering-source-v8` | [来源契约](../../desktop/src/gim/engineering/buildSources.ts)、[编码](../../desktop/src/services/engineeringCacheCodec.ts)、[来源表](../../desktop/src/services/engineeringSourceCodec.ts) | 源 SHA、条目清单、来源/IFC parser 契约、完整性；独立原子文件 |
| 工程实体 | `engineering-entity-v2` + `engineering-wholes-9` + `engineering-catalog-v2` | [实体编码](../../desktop/src/services/engineeringCacheCodec.ts)、[目录规则](../../desktop/src/engineering/catalogRules.json) | 绑定来源内容摘要、实体 schema、规则版本；只重建实体 |
| 工程导航 | `engineering-navigation-v6` + `engineering-composition-v6` + `engineering-source-tree-v1` + `engineering-inventory-v5` + 目录版本 | [三视图投影](../../desktop/src/gim/engineering/navigation.ts)、[导航缓存](../../desktop/src/services/engineeringNavigationCache.ts) | 绑定来源摘要、实体快照指纹；校验节点可达性/覆盖 |
| Fragments | `fragments-cache-v6` | [features](../../desktop/src/config/features.ts)、[db.rs](../../desktop/src-tauri/src/db.rs) | 源/IFC 身份及实际 fragments/web-ifc 版本；默认路径不启用 |
| IFC 浏览 LOD | `bim-lod-v8` 组合 | [features](../../desktop/src/config/features.ts)、[LOD 缓存](../../desktop/bridge/ifcLodCache.ts) | 源 SHA、条目、LOD 策略、单次解析、依赖版本；分远景/近景/属性独立失效 |
| IFC 区域模板 | `near-templates-v1`，附加于浏览 LOD 键 | [features](../../desktop/src/config/features.ts) | 模板几何与逐对象放置；不重建有效远景 |
| Android 线路语义 | `mobile-powerline-v3` | [移动存储](../../app/src-tauri/src/storage.rs)、[领域投影](../../packages/powerline-core/src/domain.ts) | 私有源 SHA/大小、对象与属性范围、FAM 分类 |
| Android HNum | `hnum-xz-v2` | [领域定义](../../packages/powerline-core/src/domain.ts) | 源 SHA、MOD 路径；跨 Body 唯一点号 |
| 视图状态 | `gim-view-state-v2`（localStorage） | [viewStateStore](../../desktop/src/services/viewStateStore.ts) | 工程 SHA/路径；相机、树展开、选择路径；不参与工程事实 |

## 3. 发布与恢复

- **原子文件**：每个缓存文件有独立头、源 SHA 和完成凭据；先写临时文件，校验后 rename。工程来源、实体、导航各自独立，不能把部分写当成完整发布。
- **来源域**：原值/字段形状去重表保留 FAM 原行、重复字段、occurrence 地址和 IFC 空间上下文；缺条目/解析失败时不写完整来源凭据。
- **实体/导航域**：绑定来源内容摘要；来源有效而实体规则变化时，只重建实体和导航，不重解析 IFC 或重编几何。实体快照未变时导航可独立重建。
- **DEV 域**：模板和目录分别原子提交；manifest 损坏使几何域失效，但不删除有效语义域。单 DEV 坏 GLB 可局部回退原始几何。
- **IFC 域**：远景 Fragments 或 bim-lod 产物、区域模板、按需属性分别缓存；远景 HIT 跳过源读取，近景 HIT 跳过源模型和对象求值；源 SHA 改变拒绝近景。
- **暖恢复顺序**：语义/来源 → 实体 → 导航 → 几何/IFC。任何一步失败只影响该域，不能回滚已合法提交的其他域。

## 4. 失效规则

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

## 5. 诊断

缓存状态至少区分：`none`、`miss`、`hit`、`partial`、`saving`、`saved`、`error`。诊断需包含域版本、源 SHA、条目/节点计数和失败原因，不能用一个布尔值代表全部恢复。

相关实现：[projectCacheService](../../desktop/src/services/projectCacheService.ts)、[engineeringCacheCodec](../../desktop/src/services/engineeringCacheCodec.ts)、[substationSpatialSemanticCache](../../desktop/src/services/substationSpatialSemanticCache.ts)、[devSpatialCatalog](../../desktop/src/services/devSpatialCatalog.ts)。
