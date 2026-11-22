# 序列化与传输

本页约束 JS、Worker 和原生之间的数据复制、编码与峰值。生产格式与失效身份见[缓存域](../architecture/caches.md)；优化不新增旧格式兼容或迁移。

## 保留的做法

原始二进制不转 JSON 数字数组。小文件用有界载体或字节后备接口，读取载体一次，仅解码被请求条目；不提前为整包创建大量 Blob/File 和异步读取。大对象表按需去重，来源图/快照共享同修订事实，导航只回传必要投影增量。

大表 JSON 按有界 UTF-8 批次编码、压缩和解码，避免同时保留整串 UTF-16、未压缩拼接体、gzip 分片和恢复对象。解压尽量写入预分配的最终缓冲，逐行恢复后释放中间表；主线程不重复解析内部 Worker 已生成的模型大小 JSON。

同步解包可借用当前批次视图，最终 GLB/待转移结果仍需拥有独立缓冲。只有完整独占且已消费的存储才可主动分离；借用切片、原始来源和仍需查询的压缩检查点不能误释放。

## 门禁

- 缓冲区所有权、借用、复制、转移、消费和释放均明确；同一个底层缓冲在一次 transfer list 中只出现一次。
- 不能让一个小切片长时间保留巨大父缓冲，或让相邻模板共享将被分离的批次存储。零复制不是无条件目标。
- 来源→实体→导航按域编码/写入/释放，不并发保留三份大型正文；修订变化不能混用图引用和旧元数据。
- 编码/解码分批让出任务，取消不发布部分正文；保持规范字节、引用关系和数据含义，不用删字段来省内存。
- prepared 内部产物复用编码与数量凭据；普通恢复不再做一次 stringify/parse/完整内容摘要来“复核复核结果”。必要外部格式检查按边界执行。

## 反例与本地复核

直接转移全部原始字节、零复制保留大父缓冲、仅优化 JSON 某一叶函数，都出现过 OOM 或无整站收益。导航编码的局部毫秒改善，可能伴随更长的 IFC/几何尾段；撤回的编码试验不作为当前保留能力。

分开观察表构造、编码、摘要、gzip、传输、hydrate 和输入/中间表/结果驻留。往返 elapsed 包含执行与调度，不能全称 IPC；微基准的 CPU 提升不能直接写成启动收益。

代码：[分段表 JSON](../../desktop/src/services/engineeringTableJson.ts)、[传输](../../desktop/src/infrastructure/workers/engineeringWorkerTransport.ts)、[原生批次解包](../../desktop/bridge/database.ts)、[缓存包](../../desktop/bridge/devLodCache.ts)。检查：[表编码](../../desktop/src/services/__tests__/engineeringTableJson.test.ts)、[Worker 传输](../../desktop/src/infrastructure/workers/__tests__/engineeringWorkerTransport.test.ts)、[批次所有权](../../desktop/src/services/__tests__/engineeringSourceBatches.test.ts)、[原生缓存解包](../../desktop/bridge/__tests__/devLodCache.test.ts)。
