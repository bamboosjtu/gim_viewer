# DEV 几何运行时

本文件描述变电/独立设备的 DEV/PHM/MOD/STL 编译、放置、LOD、Worker 和缓存。XML primitive 的字段表见[XML primitive](../schema/xml-primitives.md)，容器与 DEV/PHM 格式见[几何模型](../schema/geometry-model.md)。

## 目录

- [从来源到 occurrence](#从来源到-occurrence)
- [模板与放置](#模板与放置)
- [MOD/PHM 与 primitive](#modphm-与-primitive)
- [STL 与 GL](#stl-与-gl)
- [LOD 与调度](#lod-与调度)
- [Worker 与预算](#worker-与预算)
- [缓存与失效](#缓存与失效)
- [状态与诊断](#状态与诊断)
- [性能与边界](#性能与边界)
- [相关文档](#相关文档)

## 从来源到 occurrence

DEV 几何不接收工程组成或旧展示树节点，只接收来源图产生的 `SourceGeometryOccurrence`：

```text
CBM 物理根
  → DEV 实际装配（SUBDEVICE，逐边矩阵）
  → PHM 递归（按扩展名，逐边累积）
  → MOD/STL/GL 叶
  → 每个真实引用路径一个 occurrence
```

- 模板身份使用规范化 DEV 路径；实例身份包含根 occurrence 与装配/引用路径。
- 同一模板在多个路径出现时分别放置；不能用一个全局 visited 集合删除合法重复。
- `PARTINDEX` 与 `DEV_SUBDEVICE` 是语义投影，不产生第二个几何 seed；身份通过 `OBJECTMODELPOINTER` 在真实子树内关联。
- 源矩阵无效时保留原文和“位置待确认”诊断，不自动居中或拟合。

## 模板与放置

模板由 Entity、DEV/SUBDEVICE、PHM 逐边 TransformMatrix 和 primitive 组成，尺寸/平移原始单位为 mm。场景统一 `0.001` 缩放到米。

放置链：

```text
projectSourceToViewer × CBM 累计矩阵（平移转米） × 本地装配矩阵
```

- 冷编译和暖恢复使用同一放置函数；不能对暖缓存再整体偏移或重新居中。
- 共享模板的 geometry/material 不可按 occurrence 修改；placement 保留为节点矩阵。
- 镜像（负行列式）同时修正三角形绕序；不在渲染器重复翻转。
- 首个 IFC 的真实坐标锚点是场景基准；DEV 编译可早于锚点，场景提交等待锚点。

### 来源/装配索引、两条流水线与表示绑定

工程实体、几何编译和模型树是三个不同粒度，不能强制共用同一个 GLB 身份：

```text
GIM 原始文件
      │
      ▼
Source / Assembly Index
      │
      ├───────────────┐
      ▼               ▼
工程语义分析        几何编译
EngineeringEntity   GeometryAsset（来源模板复用）
      │               │
      └───────┬───────┘
              ▼
      RepresentationBinding（EngineeringRepresentationIndex）
              │
              ▼
          模型树投影
```

- 几何资产按**来源 DEV 模板**复用；同一模板的多个 occurrence 只改变 placement，不复制或按工程实体重新编译。
- 工程实体只拥有来源成员和业务身份；它可以通过多个 occurrence / 多个模板表示，但不能直接等同于一个 GLB。
- `EngineeringRepresentationIndex` 由来源归属和物理 occurrence catalog 独立连接，保留 `sourceId`、DEV `rootOccurrence/assemblyPath/devPath` 或 IFC `modelId/expressId`；绑定不生成新的几何身份。
- 模型树读取语义与表示索引的投影；切换视图、搜索和选择不能反向改变几何模板键。
- 单 occurrence 与多 occurrence 都走同一条 DEV 模板路径；不再创建实体级 GLB bundle，也不存在 `entity-glb-v1` 持久化域。


## MOD/PHM 与 primitive

- MOD 为 `Device/Entities/Entity` XML；每个 Entity 有可选 TransformMatrix、Color 和首个子 primitive。
- primitive 的规范化标签、字段、别名、近似和 LOD 见[XML primitive](../schema/xml-primitives.md)。
- `StretchedBody` 的 Array/Normal 支持方向基矢和完整位移两种解释；范围与网格共用同一解释函数。
- Boolean 在 L0/L1 采用轮廓近似（Union 组合、Difference/Intersection 保留第一操作数），L2 才执行精确 CSG。
- 远景/中景 L0/L1 跳过小于阈值的附属构件，只保留主体轮廓；全小构件 DEV 回退一个最大轮廓，不伪装成空设备。跳过只影响当前表示，不删除来源引用，也不写空几何结论。
- `ChannelSteel`/`Table` 生成外廓盒体浏览近似（无截面型号表，忽略孔洞与栏栅）；弱 schema 三类保留 raw 并用浏览近似。
- 未识别标签保留 `Unsupported/sourceType`，不能记作 empty。
- Wire/Cable 使用真实管径的样条管，另叠 1px 中心线保证低档位可见；中心线不参与拾取/测量。

## STL 与 GL

- STL 仅在标准二进制或 ASCII 布局可校验时给出范围；私有方言保留 unknown，不因范围未知被剔除。
- 同 UUID `.gl` 是可选辅助来源；不自动加入 SOLIDMODEL 主链。连接端点证据可读取 GL ConnectGuid，但 GL 不参与几何主链。
- 设备模板校验拒绝动画、实例化网格或非法几何的 GLB；失败回退原始几何或记录 source-invalid。

## LOD 与调度

| 级别 | 触发 | 表示 |
|---|---|---|
| L0 | 视野外/首次基础表示 | 低分段 primitive、主体轮廓 |
| L1 | 可见且投影包围盒较大 | 中/高分段、伞裙/端子等细节 |
| L2 | 属性面板显式“查看精细模型” | 精确 CSG/精化，单对象请求 |

自动策略只返回 L0/L1：首次进入 L1 需投影包围盒较大边 ≥40 px；已 L1 时 ≥30 px 保持，低于 30 px 回 L0。选中、搜索或相机靠近只提高当前请求优先级，不自动进入 L2。相机停稳 200 ms 后重新评估；选择立即排队。

全站策略是最终为每个 occurrence 生成 L0，而不是只生成当前视野：视野内设备优先编译，视野外设备保留在请求集合中，按老化优先级在后台继续 L0。L1 只在有效视域内、投影包围盒足够大时按需生成，离开视域回 L0；L2 只由属性面板显式请求。远景 L0 与中景 L1 都使用轮廓表示并跳过小构件与小布尔开孔；L1 增加可见分段，L2 才执行精确 CSG。

调度顺序：当前选择/当前视图缺少的基础表示 → 可见细节 → 全站其余基础表示。等待任务逐步提升优先级，防止后台基础表示饥饿。用户可暂停自动 L1 细化；显式 L2 仍可进入优先队列。

## Worker 与预算

- DEV Worker 池按逻辑核数约 60% 取 2–8 个；IFC 未结束前最多同时运行两个 DEV 编译，首个 IFC 完成后释放到池上限。
- DEV 来源预取与 IFC 几何没有数据依赖；IFC 活跃时立即用 1 MiB 批次预取，避免固定等待并限制读盘竞争。首次几何和 IFC 响应是否改善以同构建原生测量为准。
- 冷、暖路径的模板缓存未命中时，都可按真实 DEV/PHM 引用准备仍未物化的来源，而不由“存在文件清单”推断数据已在内存。按会话串行准备，单文件不超过 8 MiB、单批不超过 4 MiB、累计不超过 32 MiB；高内存压力停止准备，未准备来源保留原按需读取路径。整包路径 resolver 按源文件 Map 共享，已物化的共享依赖不重复读取。
- 大 DEV 先只做 DEV/PHM 发现并生成装配子树计划：按真实 `solid:`/`sub:` 边界分组，单个密集 PHM 退化为连续 MOD 任务批次，再平衡到最多 4 部分。各部分在池内并行编译，由一个 Worker 合并为单个 GLB；模板键、缓存键和 occurrence 放置不变，部分不形成第二模板身份。合并失败时回退一次整体编译。普通 DEV 保持模板级单任务；很小的模板由同一队列连续出队，不单独拆键。
- 单个 MOD 来源超过 32 MiB 且无法按引用边拆分时，按可见根序号分成最多 4 个编译部分；每个部分仍保留原始 MOD 引用与 placement，合并后才发布一个模板。容量错误沿 `cause` 与 Worker 响应保留 `capacity-exceeded`，不能笼统记为解析失败。
- 模板任务用会话内 taskId 关联队列、Worker、反序列化和提交；诊断 ID 不进入持久化。
- 每个 Worker 的来源字节、解码文本、XML IR、DEV/PHM IR 缓存分别有界；模板 LRU 按实际顶点/索引缓冲区计量。
- 未消费 GLB 有结果数/字节预算；首视图基础表示提交以 0 ms 定时让出、单批 8 ms 软预算推进，其余提交以 8 ms 间隔、单批 6 ms 软预算推进，单任务不可中断。
- 进程树 private commit 预算为 7 GiB，80% 暂停预取和自动 L1，90% 回收未保护模板/空闲 Worker。浏览器 JS heap 的 80%/90% 保护独立保留，可见或选中表示受保护；RSS 不代替 private commit。此调度预算与本地性能验收的峰值增幅规则分别记录。

## 缓存与失效

L0/L1/L2 的编译和持久化策略：

| 层级 | 编译 | 持久化 |
|---|---|---|
| L0 | 优先构建、优先显示全站最低成本表示 | 生成即持久化 |
| L1 | 进入有效视域后按需构建 | 热点才选择性持久化：选中/显式提升，或淘汰后再次请求 |
| L2 | 用户显式精化 | 默认不持久化，只保留会话内存模板 |

空、unsupported 和 source-invalid 终态只在 L0 持久化；L1/L2 不写这些标记，可由目录和源重新判定。

DEV 模板是共享资产，不是工程实体资产：很小的 DEV 由同一 Worker 队列合批调度，不拆模板键；大 DEV 按装配子树/MOD 任务拆分并行，重复模板共享同一缓存；最后按 occurrence placement 复用。模板拆分不能改变来源身份或实体成员。

| 缓存 | 键/内容 | 失效 |
|---|---|---|
| DEV 模板 | `DEV_GEOMETRY_VERSION` / 源 SHA / DEV 路径 / LOD | 几何版本、源、模板路径 |
| DEV 目录 | `DEV_SPATIAL_CATALOG_VERSION` / 几何版本 / 源 SHA / DEV 路径 | 目录/几何版本、源 |
| 浏览器 LOD | IndexedDB `gim-dev-lod-v1` | 源 SHA、DEV 路径、LOD |

模板/目录逐条原子提交，局部命中有效；不写“整工程完整几何”标记。manifest 损坏使几何域失效，不删除有效语义域；单 DEV 坏 GLB 局部回退原始几何。

## 状态与诊断

| 状态 | 含义 |
|---|---|
| `glb` | 可恢复几何 |
| `partial` | 有可渲染部分，同时有未覆盖来源 |
| `empty` | 源没有自有可渲染几何，允许零字节标记 |
| `unsupported` | 源存在但当前能力不支持，不能算 empty |
| `source-invalid` | 确定性源几何异常，零字节且保留诊断；不渲染 |
| 运行失败 | 读取/编译异常，不是可接受终态 |

常见原因码：`empty-device-xml`、`assembly-node-without-own-geometry`、`dev-no-solidmodel`、`phm-no-solidmodel`、`parser-unsupported`、`missing-dependency`、`source-invalid`、`capacity-exceeded`、`parse-failed`。缺引用携带原始引用证据；容量/预算与未分类解析失败不冒充源损坏。失败原因与 `failedVisibleRoots` 一并上报，不把 unsupported 并入 empty。

产品时刻与统计：

- `devGeometryReady`/`baseRepresentationsSettled`：基础表示无失败收敛（含明确失败终态）。
- `devCurrentViewSettled`：当前视图所需档位完成；不等待全站。
- `devAllStationReady`：全部 occurrence 达到 L2 或合法空终态；不是普通浏览条件。
- 状态栏按 occurrence 统计已处理/显示/失败，模板任务数另计。

## 性能与边界

- 冷/暖、L0/L1/L2、模板编译/缓存命中分别计量；不能把“语义命中”写成“全站几何就绪”。
- 实例化批次默认关闭；只有固定路线 draw calls 下降 ≥30% 且帧耗时不回退才考虑默认。
- L0/L1 不做 CSG；L2 的 CSG/导出仍可能形成不可中断长尾。
- 真实样本的冷/暖结果以开发者本地 `tmp/gim-bench/` 私有报告为准，`output/` 默认保存匿名派生视图（非匿名 survey 例外）；测量方法见[Benchmark CLI](../benchmark.md)，未达标项见[问题与限制](../open-issues.md)。

## 相关文档

- [几何资产与表示索引](geometry-assets.md)
- [表示与绑定](representations.md)
- [缓存域](caches.md)
- [XML primitive](../schema/xml-primitives.md)
- [几何模型](../schema/geometry-model.md)
- [IFC 运行时](ifc-runtime.md)
