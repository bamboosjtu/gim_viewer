# 系统架构

本文件是架构入口：只保留系统边界、目录归属、运行时主干和跨主题不变量。生命周期、缓存、几何、实体、交互和发布等机制拆分到 `docs/architecture/`，由各专题文档维护；文档地图见[文档首页](README.md)。

当前桌面版本为 `0.2.1`。变电工程使用“设备材料清册 / 工程组成 / 来源”三个独立投影；工程实体识别与 GIM 文件组织、DEV/IFC 几何表达解耦——工程实体、几何编译和模型树是三个不同的问题，不必采用相同的对象粒度。桌面变电、线路、独立设备共享容器、打开和缓存基础能力；Android 仍只面向线路。

## 项目目录与模块归属

新代码按运行面和依赖方向放置，避免把测量、样本登记或平台适配塞进 UI 与 parser。细粒度依赖规则见[分层与依赖](architecture/layers.md)，开发与测试目录见[开发指南](development.md)。

| 目录 | 归属与新增代码位置 |
|---|---|
| `desktop/src/` | 桌面应用；`gim/` 解析、`engineering/` 纯领域、`services/` 编排、`viewer/` 渲染、`ui/` DOM、`measurement/` 产品探针、`app/` 启动与会话 |
| `desktop/bridge/`、`desktop/src-tauri/` | 桌面 TS IPC 与 Rust 原生实现；平台读写不进入纯领域层 |
| `desktop/scripts/benchmarks/` | 本地 Benchmark CLI、报告与无样本协议测试；浏览器功能夹具在 `desktop/tests/` |
| `desktop/local-tests/`、`benchmarks/l0/`、`benchmarks/l1/`、`benchmarks/l2/` | 开发者基础功能注册表与分级性能注册表；不存放 GIM 字节或运行报告 |
| `app/` | Android 线路应用、SAF 导入与移动端界面 |
| `packages/powerline-core/`、`packages/measurement-core/`、`packages/plugin-api/` | 跨端纯线路核心、无平台依赖的测量协议、插件接口 |
| `crates/`、`contracts/` | 原生共享解压与 Android 导入插件；跨语言资源限制契约 |
| `tools/` | 独立 Python 工具；其 QtWebEngine 页面不属于桌面或 Android 前端 |
| `docs/`、`research/` | 当前契约与待复核研究；研究结论不能直接充当产品事实 |
| `tmp/`、`output/`、`demo/` | 忽略的本地暂存、报告与自备工程样本；不进入发布包 |

新增 SDK 前先遵循现有包边界；需要跨端复用时再迁入 `packages/`，不为减少目录数量合并运行面。测量产出的 HTML 属于 `output/` 或 `tmp/`，不是应用入口。

## 运行时主干

```text
GIM 包
 ├─ 容器与来源引用 ──> 来源图 / 原始记录 ──> 工程整体归一化 ──> 工程组成投影
 │                                      └──> 来源投影（CBM/DEV/IFC 空间）
 ├─ DEV/PHM/MOD/STL ─> SourceGeometryOccurrence ─> RepresentationIndex ─┐
 └─ IFC ─────────────> 空间语义 + bim-lod 表示 ─────────────────────────┴─> 选择 / 高亮 / 隔离 / 相机
```

工程实体、几何和模型树的分工：

```text
GIM 原始文件
       │
       ▼
Source / Assembly Index（来源与装配索引）
       │
       ├────────────────────────┐
       ▼                        ▼
工程语义分析                 几何编译
       │                        │
       ▼                        ▼
EngineeringEntity         GeometryAsset
       │                        │
       └──────────┬─────────────┘
                  │
                  ▼
       RepresentationBinding
         工程整体与几何关联
                  │
                  ▼
              模型树投影
```

三条链只通过稳定身份相交：

- **来源链**：文件条目、CBM 引用、DEV 实际装配、IFC 外露对象和空间容器；不依赖展示树深度。
- **实体链**：包内来源 occurrence → 中立对象证据 → 工程整体/待归集合/成员关系 → 三视图。
- **表示链**：真实来源 occurrence → 模板、放置、LOD、IFC 对象；工程整体只绑定来源 ID，不生成新的几何种子。

几何可以先于工程实体完成编译；实体规则变化只重建成员绑定、组成和导航，不强制重新三角化。反过来，实体识别不等待 Viewer、网格、LOD 或 IFC 几何加载。

## 跨主题不变量

1. **源身份优先**：源 SHA、大小和 magic 决定工程身份与类型族；缓存不能覆盖源事实，源变化不能继续提交。
2. **实体身份与几何身份分离**：工程整体 ID 由包内来源证据生成，不由 F2/F3/F4、展示名、数组顺序或 Mesh 生成；同一来源的几何 occurrence 另有稳定身份。
3. **成员关系是分区**：每份来源只能有一个主归属（整体、待归集合或仅来源），别名和辅助证据另存，不重复计数；未知与歧义保留。
4. **表示按来源绑定**：DEV/IFC 表示通过来源 ID 绑定到整体；不能按空间邻近、同名或“第一个候选”补造归属。粗表示跨多个整体时保留歧义。
5. **最新选择提交**：选择请求带会话、请求 ID 和取消信号；旧请求的异步属性、高亮、相机和树结果不能覆盖新选择。相机操作与选择相互独立。
6. **缓存域独立失效**：语义、Spatial、DEV 几何、IFC 浏览 LOD、工程来源/实体/导航分别版本化；一个域损坏不删除其他域。
7. **失败局部化**：单文件、单来源、单表示失败不使整个工程消失；空源、不支持、部分表示和运行失败分别记录，不能混成一个“完成”。

## 专题文档

| 主题 | 文档 |
|---|---|
| 分层、依赖与边界检查 | [分层与依赖](architecture/layers.md) |
| 源身份、打开、会话、首开与关闭 | [打开与生命周期](architecture/lifecycle.md) |
| 存储面、缓存版本与失效 | [缓存域](architecture/caches.md) |
| 工程实体 Worker、三视图发布 | [工程实体运行时](architecture/engineering-runtime.md) |
| 来源 occurrence 与表示索引 | [表示与绑定](architecture/representations.md) |
| DEV/PHM/MOD/STL 编译与 LOD | [DEV 几何运行时](architecture/dev-geometry.md) |
| IFC 发现、空间语义、bim-lod、连接构件 | [IFC 运行时](architecture/ifc-runtime.md) |
| 几何资产复用与分治预算 | [几何资产与表示索引](architecture/geometry-assets.md) |
| 选择、高亮、隔离与视角历史 | [选择与交互](architecture/selection.md) |
| 线路运行时与 Android 边界 | [线路与移动端](architecture/line-mobile.md) |
| 大型服务与原生数据库模块 | [运行时与数据库模块](architecture/runtime-modules.md) |
| 测量协议与 Benchmark 架构 | [测量与 Benchmark](architecture/measurement.md) |
| 安全、配置、诊断与发布 | [平台、安全与发布](architecture/platform.md) |

工程实体本身的契约、三视图规则和目录见[工程实体模型](engineering/README.md)；GIM 格式与 primitive 见 [Schema](schema/README.md)。

## 验证边界

本文件描述结构与不变量，不证明任一构建已满足性能或完整交互。正确性门禁、证据分层和真实复核范围见[验证](validation.md)；性能测量方法见[Benchmark CLI](benchmark.md)，实测结果保存在开发者本地报告；未关闭项见[问题与限制](open-issues.md)。
