# Worker 与内存

本页约束任务供给、后压、空闲回收和数据所有权。当前实现预算见[几何资产](../architecture/geometry-assets.md)，它们不是统一的进程峰值验收线。

## 保留的做法

Worker 数量、模板流水槽、原生 I/O、输出/写入预算分别拥有状态。先判断等的是输入、计算槽、结果消费还是缓存写入，再改变并发。源亲和性复用解析缓存，同时不能让某个源无限挡住无关任务。

普通编译结果、Part 暂存、合并预留和主线程未消费数据共同后压。借出结果后及时确认/释放；源输入、解码中间表、模型和图形资源各有拥有者，不让缓存计数或悬挂 Promise 代替真实生命周期管理。

空闲计算池只有在活动、排队和未消费结果均清空后才缩减，保留最近工作集；新请求按需恢复，不一口气恢复全部线程。暖模板读取/解码容量与计算线程回收独立。可重建证据 Worker 用压缩检查点和覆盖摘要退出，需要详情时再恢复。

## 门禁

- 源文件、模板、模型版本和请求代次决定任务归属；共享在途请求不造成跨工程串用。
- 输入控制/消费确认不另建未结束计算任务；意外终止与受控取消分别记录，不能把 aborted 自动视为完整成功。
- 完成、失败、取消与回退都释放相同的输入/输出额度，旧等待者不在新工程启动原生写入。
- 空闲回收不得销毁仍被场景使用的模板/实例；共享几何与材质只由正确拥有者释放。
- 解除事件、定时器、回调、树/地图监听和原始输入映射引用；重开后检查旧 run 的资源，不能读取新空 Collector 来证明旧对象已释放。
- 调大预算/线程数必须同时看速度与峰值；受管理字节、Worker 堆、WASM 容量、Private Bytes 和 GPU 不直接相加。进程内存未立刻下降也不单独证明泄漏。

## 反例与本地复核

高内存压力时槽位收缩会放大排队，继续加线程可能产生更多积压和 OOM；相反，过早退役解析缓存会让重算变冷。双 Worker、一次恢复全部 Worker 等历史试验不能凭“更并行”恢复。

报告队列等待、槽占用、Worker 实际执行、输入/结果/写入驻留与冷重算代价。轮内开闭保留增长和跨版本峰值分别看；意义及接受由开发者判断，不引入固定增长比例线。

代码：[计算池](../../desktop/src/services/devGeometryWorkerClient.ts)、[模板存储](../../desktop/src/services/devLodTemplateStore.ts)、[证据空闲检查点](../../desktop/src/infrastructure/workers/engineeringWorkerClient.ts)。检查：[工程 Worker 取消](../../desktop/src/infrastructure/workers/__tests__/engineeringWorkerClient.test.ts)、[几何 Worker 所有权](../../desktop/src/services/__tests__/devGeometryWorkerClient.test.ts)、[预算/写入释放](../../desktop/src/services/__tests__/devLodRuntime.test.ts)、[证据回收](../../desktop/src/infrastructure/workers/__tests__/engineeringEvidenceCheckpoint.test.ts)、[测量生命周期](../../desktop/src/measurement/__tests__/hostWorker.test.ts)。
