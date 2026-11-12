# 打开与生命周期

本文件描述从用户选择文件到工程可浏览、缓存发布和释放的主流程。缓存版本与域见[缓存域](caches.md)，工程实体构建见[工程实体运行时](engineering-runtime.md)。

## 目录

- [源身份与类型](#源身份与类型)
- [打开决策](#打开决策)
- [会话与取消](#会话与取消)
- [首开阶段](#首开阶段)
- [变电索引发布](#变电索引发布)
- [暖启动校验](#暖启动校验)
- [关闭与切换](#关闭与切换)
- [失败与部分结果](#失败与部分结果)
- [相关文档](#相关文档)

## 源身份与类型

1. 选择文件后计算 SHA-256、读取大小和 `GIMPKGS`/`GIMPKGT` 头；mac 头决定类型族，裸 7z/ZIP 先验证内容。
2. 登记 `gim_project`：路径只来自原生文件对话框或数据库记录授权，页面不能提交任意路径。
3. `GIMPKGS` 先按 CBM 入口判断变电还是独立设备；没有 CBM 时要求唯一、全部 DEV 可达且无环的 DEV 装配根，并实际有几何引用。多根、断引用、环形装配不猜第一个入口。
4. `GIMPKGT` 进入线路流程。裸归档必须通过内容检查，不能仅凭压缩签名认定类型。
5. 同一工程重新打开时源 SHA、大小或 magic 变化即视为新源：旧缓存不能覆盖，旧会话的结果不能提交。

## 打开决策

```text
选择源 → SHA/magic → 登记/查工程 → 清理旧会话 → 校验缓存
                                              ├─ 合法：分域恢复
                                              └─ 缺失/无效：解压 → 解析 → 分阶段发布
```

- 解压优先原生 Tauri 命令，浏览器开发模式或原生不可用才走 WASM。两者都执行路径、重复条目、声明/累计大小和资源配额检查。
- 解压先写 staging，全部条目通过校验后再原子提交；中断不能留下“部分有效”的正式缓存。
- 变电/设备语义和几何可以分域恢复；缓存命中不等于所有 IFC/DEV 表示立即可见。
- 包内引用索引按提取文件 Map 复用，CBM/DEV 递归、几何与属性读取共享索引，不在每次引用查询时重新扫描归档清单。物化可替换 Map 中的文件值；修改路径键集合应创建新 Map，条目数量变化也会重建索引。索引由 WeakMap 持有，不延长源文件 Map 的生命周期。
- 单次 CBM 树构建按实际 DEV 路径复用文档和在途读取，只读/解析每份 DEV 一次；每个装配 occurrence 仍独立展开，保留实例路径、逐边矩阵和分支 visited。索引性能回归对比不同引用数量下的 Map 全清单枚举次数，并覆盖物化、清单变更与源 Map 隔离；不以机器相关的毫秒阈值代替资源计数。`check:engineering-boundaries` 拦截直接从 `files.keys()` 重建索引的调用，统一使用 `getFileEntryResolver(files)`。

- 设备重开复用提取源和 DEV/LOD 派生缓存，但重新建立小型设备树，不发布完整变电语义凭据。
- 线路缓存以 `begin/chunks/finish` 三阶段提交，`finish` 才写入有效 parser 标记；半成品不能作为合法缓存。

索引回归入口为 [entryResolver.test.ts](../../desktop/src/gim/__tests__/entryResolver.test.ts) 与 [cbmParser.test.ts](../../desktop/src/gim/__tests__/cbmParser.test.ts)：重复查询、多个装配 occurrence 不得增加索引构建次数；同时监测 `keys/entries/values/forEach/[Symbol.iterator]` 全清单枚举入口，避免换一种遍历写法绕过资源计数。

## 会话与取消

`ProjectLoadSession` 固定 generation、projectId、sourceSha256 和几何 token。所有异步任务在以下边界重新校验：

- 写 `AppState`、场景、属性、树或缓存前；
- Worker 返回结果后、批量提交中、迟到回调中；
- 切换工程、关闭工程、用户新选择或相机新动作后。

旧会话的 Worker、解压、解析、恢复和缓存写入必须取消或拒绝提交。释放几何、材质、模型、地图、索引和 Worker 的所有权归当前运行时；重复清理不得双重释放。

`Viewer 就绪` 与 `IFC 引擎就绪` 是独立条件：

- `AppState.initialized` 表示视图可交互；DEV-only 设备不启动 IFC WASM 或 Fragments Worker。
- `ifcLoader` 按持久 ViewerContext 共享 IFC 初始化 Promise；第一次需要 IFC 时才初始化，失败允许下次重试。
- 清理模型时保留引擎和一次注册的监听；工程切换不能跳过 IFC 初始化或重复创建 Worker。

## 首开阶段

变电的首开不是一条串行链，而是四条可独立结算的链：

| 链 | 开始条件 | 完成/发布 |
|---|---|---|
| 容器/来源 | 文件可读 | 解压清单、CBM/DEV/FAM/IFC 文件可用 |
| 核心语义 | 解压或缓存可用 | CBM 树、IFC 清单、文件—DEV 关系；两阶段索引先提交第一阶段 |
| 工程实体 | 来源文件可读 | 来源图 → 整体/成员 → 三视图；不等 Viewer/LOD |
| 几何/IFC | Viewer 创建后 | DEV 编译与 IFC 转换并行；场景放置等待首个 IFC 真实坐标锚点 |

关键顺序：

1. 核心语义就绪后，UI 可以先显示工程树/来源状态；DEV 与 IFC 继续后台。
2. 工程实体 Worker 从实际来源图构建，不接收旧业务树节点；构建完成前三视图显示“正在识别/读取”。
3. DEV 目录和模板编译可以早于工程实体完成；实体完成后通过来源 ID 绑定表示，不重新编译几何。
4. IFC 首个锚点决定场景坐标基准；缓存恢复保持持久化加载顺序，不按文件名重排。
5. Spatial 语义在独立 Worker 中构建；工程实体可在 Spatial 到达前先发布部分结果，随后用空间容器补充来源/建筑分组。

## 变电索引发布

变电 SQLite 语义索引分两阶段：

- **第一阶段**：CBM 树、IFC 清单、`FileDevRelation`、entries 和关系写入，使用空引用链提交版本和 receipt。此时暖启动已可恢复基本语义。
- **第二阶段**：后台解析 FAM/DEV 属性，在单事务中替换属性表、重算 receipt 并置 `substation_properties_complete=1`。
- 几何引用链（DEV→SOLIDMODEL→PHM/MOD）第二阶段暂不重解析；暖启动几何按源文件回退解析，仍正确。
- 第二阶段被关闭/切换中断时，第一阶段缓存仍有效；下次暖启动检测标记为 0，用已解压源补写。

状态栏分别显示“暖启动已就绪 · 属性补写中”“索引已发布”“索引发布未完成”；不能用“核对工程记录”覆盖解压、索引和 IFC 阶段。

## 暖启动校验

1. 语义级先校验 parser/domain 版本、索引 receipt、IFC 清单和必需路径。
2. 通过后进入逐 entry fast path，不在打开关键路径逐个 stat/open 全部 CBM/FAM/DEV/PHM/MOD/STL 源文件；大工程可达数万条。
3. 只有版本、receipt、IFC 清单或 count 不一致时才执行完整源文件扫描。
4. GLB manifest 结构、几何域版本只决定几何 domain 能否复用，不阻塞语义 HIT；缺失/截断的单个源文件由 DEV 批量读取按 entry 隔离。DEV 工作集预取和缺失模板恢复只接纳与来源清单长度完全相等的字节；短/超长缓存保留原懒读入口，并记录长度不符，不把前缀安装为完整来源。
5. 源文件路径校验使用单次调用的 `CacheValidationContext`：只规范化可信工程 root，逐 entry 检查相对路径、工程身份、两种 root、symlink/reparse 和实际大小；不把数据库 candidate 规范化后证明归属。
6. 缓存损坏、版本不匹配或路径不安全时拒绝该域，不用部分结果冒充完整；其他域仍可独立使用。

来源 Map 的路径键集合固定时可以替换已物化的 File 值。大小写/分隔符索引只保存原路径，命中后读取 Map 的当前值；路径键集合改变必须使用新 Map，不能靠重扫整包适配每个来源请求。

## 关闭与切换

- 关闭/切换先使当前 generation 失效，再取消 Worker、请求和缓存写槽；已完成但未消费的结果不能提交。
- 编辑器/选择状态、相机历史、临时筛选、未落盘预览随会话释放；持久缓存保留。
- 释放顺序覆盖：工程实体 Worker、导航监听、虚拟列表引用、DEV/IFC 运行时、地图、Spatial、属性缓存和场景装饰。
- 旧请求的迟到错误只写日志或当前会话状态，不改写新工程的加载/选择状态。

## 失败与部分结果

| 情况 | 当前行为 |
|---|---|
| 单文件缺失/读取失败 | 保留来源记录和原因；其他对象继续；不发布完整来源凭据 |
| 单 DEV/IFC 表示失败 | 该 occurrence 进入 failed/unsupported/partial；不删除整体 |
| 工程来源不完整 | `engineeringStatus=partial`，三视图可浏览部分结果；不写完整缓存 |
| Spatial 未就绪 | 来源/实体先发布；建筑楼层分组留待空间容器补充 |
| 缓存损坏 | 只重建受影响域；旧格式直接失效，不迁移 |
| 工程切换时旧任务完成 | 会话守卫拒绝提交，释放旧资源 |

空源、unsupported、partial、运行失败是不同终态，不能用一个 `settled` 或“工程已打开”合并。

会话失效先递增工程代次和几何 token，再逐项释放资源；单项释放异常不会中断其余清理。DEV runtime 槽替换时释放旧实例；工程和几何批次分别校验，几何换代不取消同工程语义任务。解压返回 `ok | cancelled`，空归档报错。发布状态、定时器和 Worker pending 请求均由会话清理终止，过期提交队列必须 reject 等待者。

工程身份检查统一使用 `shared/projectSession.isCurrentProject`；携带完整批次身份的几何上下文使用 `isCurrentGeometry`，额外核对 token。几何换代不失效同工程的语义任务。现有异步入口仍保留提交前的显式守卫，资源作用域与可注入 SessionScope 随后续 SDK 边界抽取推进，不将几何 token 混入所有语义守卫。

## 相关文档

- [系统架构](../architecture.md)
- [缓存域](caches.md)
- [工程实体运行时](engineering-runtime.md)
- [表示与绑定](representations.md)
- [IFC 运行时](ifc-runtime.md)
- [验证](../validation.md)
