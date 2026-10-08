# 系统架构

当前实现包含 Tauri 2 桌面应用和 Android 线路应用，前端使用 TypeScript/Vite，后端使用 Rust。
解析输入、业务编排、视图和持久化有独立职责。变电与线路共享容器与生命周期，使用不同运行时。

## 目录与所有权

| 目录 | 职责 | 依赖边界 |
|---|---|---|
| `desktop/src/app/` | 启动、AppState、工程和选择状态 | 接入业务服务 |
| `desktop/src/gim/` | 容器、纯 parser、索引和地图数据投影 | 不依赖 services/viewer/ui |
| `desktop/src/viewer/` | IFC、Fragments、Three.js、MOD/STL 渲染 | 不依赖 services/ui |
| `desktop/src/ui/` | DOM shell、树、属性、搜索、地图 | 不直接访问数据库 |
| `desktop/src/services/` | 打开、缓存、后台任务、选择编排 | 连接解析、bridge 和视图 |
| `desktop/src/config/` | 功能与调试开关 | 只描述当前配置 |
| `desktop/bridge/` | Tauri IPC DTO 与命令封装 | 隔离 Rust 接口 |
| `desktop/src-tauri/src/` | SQLite、SHA、解压和二进制读取 | 事务、配额、源身份校验 |
| `app/` | Android 线路 UI、Worker、SAF、私有 SQLite | 独立平台 IO；不依赖桌面 Viewer/IFC/Three.js |
| `packages/powerline-core/` | 共享纯线路 parser、graph、路径与领域投影 | 无平台、UI、数据库依赖，桌面使用兼容出口 |
| `packages/plugin-api/` | 中立外部 provider 契约 | AbortSignal/dispose，无地图实例 |
| `crates/gim-native-core/` | 两平台共享有界容器解压 | bytes/path 输入、路径与资源配额 |
| `crates/tauri-plugin-gim-import/` | Android SAF、流式复制与 SHA | ContentResolver，不将整个 GIM 传入 JS |

入口和打开服务按需动态 import 重依赖；不静态引入 Three.js、web-ifc、MapLibre。
解析分支依据源 magic 和文件结构能力，不依据导出厂商名称。

## 源身份与打开生命周期

[打开核心](../desktop/src/services/gimOpenCore.ts) 建立源 SHA、大小、magic 和工程会话。
源 magic 决定工程类型，缓存记录不能覆盖它。读取期间源发生改变时拒绝继续提交，
避免用不同源版本组合索引与几何。

```text
选择源文件 → 身份校验 → 清理前工程 → 校验缓存
                              ├─ 合法：分域恢复
                              └─ 无效：解压 → 语义解析 → 持久化 → 渲染
```

桌面原生提取优先，WASM 用于回退或浏览器开发。
条目解析统一路径分隔符、大小写和唯一文件名候选；不能固定 IFC 在某物理目录。
解压执行路径与资源配额检查，不能把文件可读取等同于引用完整。

工程会话持有 generation、projectId、sourceSha256 与 geometry token。
异步任务在提交状态、场景或派生缓存前验证会话，切换/关闭取消 worker 和后台队列。
释放几何、材质、模型、地图和索引的所有权归当前运行时，重复清理不得产生双重释放。

## 选择提交权

SelectionRequest 使用请求 ID 和取消信号，覆盖属性读取、几何准备、高亮及相机动作。
只有最新选择可以提交可见状态。A 的慢结果不能覆盖 B 的属性、树选择或定位。
同一工程中合法的资源任务可继续复用，不能把一次选择变化当作工程失效。
Fragments reset/apply 高亮通过短串行队列提交；后台 fit 不覆盖用户已经建立的选择。

## 变电语义与 IFC

原始 CBM 属性、FAM 物理行和设计文档来源分别保存。
[substationEvidence](../desktop/src/gim/substationEvidence.ts) 生成文件能力摘要、IFC 证据、
PARTINDEX identity alias 与 GL sidecar 投影。摘要不决定厂商 parser 分支。
语义格式与身份规则见 [语义模型](schema/semantic-model.md)。

IFC 文件发现与 IFCGUID 对象挂接独立。全局 entry resolver 解析 CBM 引用及 IFC 清单。
转换在 IFC Worker 中执行，主线程仍负责 Fragments `core.load`、模型提交与交互。
首个 IFC 的插入顺序是坐标锚点契约；缓存恢复保留持久化顺序，不能按文件名重新排序。

空间语义使用两遍选择性 STEP 扫描，位于独立 Spatial Worker。
长期索引保留空间节点、对象、placement 闭包及关联证据；属性集、材料、类型、数量和分类按需获取。
推断空间链接与直接链接保留来源和置信度，不填造确定归属。

[Spatial snapshot 服务](../desktop/src/services/substationSpatialSemanticCache.ts) 校验源、域和版本后 hydrate Map。
缺失、损坏或不匹配的快照在全部 IFC 尝试完成后重建。它不替代 IFC 几何，也不覆盖变电语义缓存。

## DEV 编译、模板与 occurrence

[MOD 编排服务](../desktop/src/services/modAutoLoadService.ts) 从物理根建立独立 occurrence，
模板身份使用规范化 DEV 路径；实例身份包括 CBM 物理根与装配/引用路径。
PARTINDEX 和 DEV_SUBDEVICE 是语义投影，不生成第二套 seed。

PHM 根据引用扩展名递归，逐边累积矩阵，按当前分支防环。
相同模板在不同路径的合法重复出现保留；不能使用全局 visited 集合删除实例。
父语义节点的 alias 只在其物理装配子树内查候选，身份优先，歧义保留。

冷路径按唯一 DEV 编译 GLB、落盘并渐进提交 placement。
clean static DEV 在会话内只解析一个模板，共享不可变 geometry/material；
每个 occurrence 保留独立节点层级和变换。不能把 placement 烘焙写回共享 geometry。
无法共享的范围使用局部回退。当前不采用 InstancedMesh。

GLB 恢复校验 manifest、源身份、条目状态和文件完整性。
单 DEV 文件失败可局部回退原始几何；manifest 无效使几何域失效，不要求删除有效语义域。
完成标记只在所有目标条目形成确定状态后提交，瞬时失败不能写为完整版本。

| 条目状态 | 含义 |
|---|---|
| `glb` | 可恢复几何 |
| `partial` | 有可渲染部分，同时有未覆盖来源 |
| `empty` | 源内容没有自有可渲染几何，允许零字节标记 |
| `unsupported` | 源存在但当前能力不支持，不能算 empty |
| 运行失败 | 读取/编译异常；不是可接受的完整性终态 |

二进制批读 `batch_read_glb_files` 使用 GIMR 协议；当前批量上限为 256 文件或估算 64 MiB。
内部 IR 区分 XmlModDocument、primitive、DEV/PHM 模板、引用边、装配路径和场景资源。
类型定义以 [geometry/ir.ts](../desktop/src/gim/geometry/ir.ts) 为准，格式契约见 [几何模型](schema/geometry-model.md)。

## 线路运行时

[line CBM core](../desktop/src/gim/lineCbmParserCore.ts) 与
[line 属性 core](../desktop/src/gim/lineAttrParserCore.ts) 用于 Worker 解析。
同一任务共享文本缓存，保留源引用、引用类型、子节点顺序和 FAM/DEV 来源。
大型 MOD 使用原生元数据或按需读取，避免把不需要的大文本重复传给 JS。

线路图是可共享节点的有向图。树是它的展示投影，不通过复制节点制造新的塔位。
入库使用 begin/chunks/finish，finish 才提交有效 parser 标记；失败或取消的半成品不可作为合法缓存。
缓存恢复包不完整时重建，不能用部分 graph 冒充完整工程。

地图数据从有效 BLHA 提取 `[longitude, latitude]` 和高程等源值。
导线挂点、跨越与杆塔坐标的角色分别保存，同塔跳线不构造虚假跨塔档。
MapLibre、Canvas、树和搜索共用对象选择状态。
弧垂为当前视觉近似，工程语义边界见 [线路 MOD](schema/powerline-mod.md)。

## 当前缓存域

下表是文档中唯一的版本定义表。修改持久化含义时只失效受影响域，实际常量以链接源码为准。

| 域 | 当前契约 | 权威定义 | 校验与失效范围 |
|---|---|---|---|
| 线路语义 | `gim-line-parser-v1` | [db.rs](../desktop/src-tauri/src/db.rs) | 源 SHA、完整事务、graph/属性 |
| 变电语义 | `gim-substation-parser-v25` | [db.rs](../desktop/src-tauri/src/db.rs) | 原始属性和语义引用 |
| DEV 几何 | `geometry-cache-v8-occurrence` | [db.rs](../desktop/src-tauri/src/db.rs) | occurrence 引用、manifest 和 GLB |
| Spatial snapshot | `substation-spatial-semantic-v2` | [快照服务](../desktop/src/services/substationSpatialSemanticCache.ts) | 源、链接和序列化结构 |
| IFC Spatial parser contract | `gim-substation-parser-v23` | [快照服务](../desktop/src/services/substationSpatialSemanticCache.ts) | 独立于变电语义域 |
| Fragments | `fragments-cache-v6` | [db.rs](../desktop/src-tauri/src/db.rs)、[features](../desktop/src/config/features.ts) | 源/IFC 身份及实际安装的 fragments/web-ifc 版本 |
| Android 线路语义 | `mobile-powerline-v2` | [移动存储](../app/src-tauri/src/storage.rs)、[领域投影](../packages/powerline-core/src/domain.ts) | 私有源 SHA/大小、业务属性范围、唯一对象和语义表校验 |
| Android HNum 预览 | `hnum-xz-v1` | [领域定义](../packages/powerline-core/src/domain.ts) | 源 SHA、MOD 路径和 Body 内部点引用 |

SQLite 共享 `gim_project`，变电表使用 `substation_*`、线路表使用 `powerline_*`。
FAM 来源记录使用 `(project_id, source_path, source_line)` 区分物理行，不用归一化键覆盖重复原文。

## 配置与加载状态

下表描述桌面配置与加载阶段。移动端默认天地图影像，Canvas 工程覆盖层先就绪，
底图加载独立进行；移动生命周期与存储见 [移动端规格](mobile-spec.md)。

| 配置/状态 | 当前行为 |
|---|---|
| MapLibre | 启用；在线底图不可用时 Canvas 回退 |
| 默认底图 | OSM online；天地图为可配置能力 |
| PMTiles | 关闭 |
| 线路弧垂 | 启用视觉示意 |
| Fragments 缓存 | 默认关闭；`gim-debug-fragments-cache=1` 用于调试对照 |

Fragments 关闭时不读写 `.frag`。开启调试必须记录实际策略，不能与默认路径合并比较。

| 就绪状态 | 定义 |
|---|---|
| coreSemanticReady | 核心语义可供 UI 使用 |
| firstUsable / interactive | 首个可用 IFC 与基本交互，不代表全模型 |
| allIfcReady | 全部 IFC 加载尝试结束，失败数另列 |
| fullModelReady | DEV 管线结束，unsupported/partial 仍单独记录 |

## 安全与发布

SLD 使用白名单净化与 img 沙箱；删除脚本、事件、foreignObject 和外部资源引用，
图形选择数据与原 SVG 执行环境分离。支持标签、样式和局部引用的实际规则以
[sldParser](../desktop/src/gim/sldParser.ts) 为准。
解压限制路径与资源消耗；parser 数量和几何实例有上限，循环引用按分支截断并保留诊断。

桌面 npm 命令在 `desktop/` 执行，移动命令在 `app/` 执行。`npm run build` 完成各端 TypeScript 和 Vite 构建；
`npm run tauri:build` 运行 Tauri 构建并通过 post 脚本生成 portable ZIP。
固定 WebView2 与 WASM 资产由构建脚本准备，产物类型以 Tauri 配置和脚本为准。
`desktop/public/worker-bundle.js`、`libarchive.wasm`、`wasm/web-ifc*.wasm` 是随项目维护的运行时资产。
验证命令见 [验证](validation.md)，性能方法见 [性能](performance.md)。
