# 来源读取与索引

本页约束包内路径查找、CBM/DEV/FAM 物化和几何来源供给。身份与歧义规则见[生命周期](../architecture/lifecycle.md)，来源证据见[实体运行时](../architecture/engineering-runtime.md)。

## 保留的做法

全包路径/引用索引按源 Map 身份共享，单个查询不能重枚举清单。物化仅替换值；路径键集合变化使用新 Map。CBM 树、DEV/PHM 递归、属性与几何复用索引和在途读取，实际 occurrence 独立保留矩阵及分支防环。

打开先提供 Inventory，按真实引用取 CBM/DEV；不能先传完全部文件才开始物理遍历。物理与语义阶段共享载体、解析文档和修订。FAM 只物化识别所需范围，其余属性显式查询、分页、有界驻留；属性记录按文档共享，赋值关系按 occurrence 分开。

根来源准备独立推进，原生读取跨根合批并共享每条路径的在途 Promise，完成一批就供 Worker 使用。DEV/PHM 引用发现复用结果，不让一棵深装配树挡住无关浅根。滚动预读有界，当前需要的文档优先；不能用无界预取替代按需供给。

目录窗口内的根可以同时发现依赖，原生 I/O 仍由独立的批数和字节预算约束。Worker 已请求的必要来源与预读共用批读、在途去重及驻留发布，必要请求优先于队列中的预读。内存压力可以暂停预读，但不能因此把预算内的小文件恢复成每个 Worker 各自逐条读取；文件完成后共享给已有 Worker，后续新 Worker 从同一驻留 Map 初始化。超出来源准备预算时仍保留原惰性读取路径。

## 门禁

- 查询、重复模板或 occurrence 数增加时，全包枚举次数不得随之增长；同时监测 keys/entries/values/forEach/迭代器，不能换写法绕过计数。
- 同修订的同文档只读/解析一次；共享依赖并发请求合并。慢根被挂起时，已满足依赖的根仍可完成。
- 来源预读被压力暂停或 Worker 回收重建后，实际请求仍复用有界共享读取；不能用重复 IPC 替代已暂停的预读。根准入窗口不等于 I/O 并发数，扩大窗口须保持原生批数、字节和过期结果保护。
- 来源 Worker 请求输入时，回复不得排到等待它的任务后面；输入控制消息不能另建计算任务或充当终态结果。
- 未引用的解码错误不能污染整批有效来源；未知/多候选保持原文和诊断，不选第一个路径冒充唯一。
- 通知 Worker 后再完成共享 Map 的物化更新，避免对象身份筛选把全部更新丢弃。抽取/释放后解除初始输入回调，不能让空闲客户端长期保留整包原始字节。

## 反例与本地复核

历史回退既有逐节点重建全包索引，也有撤掉批读后恢复大量 Worker→UI→原生 RPC，以及把所有缺失根串到一个 Promise 尾链。全包预取与逐文件惰性读都不能不看实际请求就当作通用最优解。

用枚举数、native batch/RPC 数、重复读取/解析数及实际字节验证结构；本地再看 `engineering.physical-index`、`engineering.source-request`、来源准备 queueWaitMs/prepareMs 和批读 readMs。并发累计值不等于墙钟耗时。

代码：[共享索引](../../desktop/src/gim/entryResolver.ts)、[按需输入](../../desktop/src/services/engineeringSourceInput.ts)、[来源供给](../../desktop/src/services/devLodSourceWorkset.ts)。检查：[索引](../../desktop/src/gim/__tests__/entryResolver.test.ts)、[递归读取](../../desktop/src/gim/__tests__/cbmParser.test.ts)、[根并发/共享依赖](../../desktop/src/services/__tests__/devSourcePipeline.test.ts)、[独立来源构建](../../desktop/src/services/__tests__/engineeringService.test.ts)。
