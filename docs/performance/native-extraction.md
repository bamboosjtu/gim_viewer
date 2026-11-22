# 原生解压与存储

本页约束容器解码、来源 pack 和原生入库的吞吐。打开身份及存储安全见[生命周期](../architecture/lifecycle.md)，派生缓存策略见[缓存门禁](cache-and-persistence.md)。

## 保留的做法

桌面解压优先原生路径，按压缩格式、平台和可用后端选择流式/seek reader 与 sink。当前 7z 的随包 CLI 优先路径及 Rust 回退以源码为准，不能把某次后端实验的秒数当作全部来源的预期。源文件身份在打开边界建立后向后传递，不让后续 parser、几何和缓存各自回读整个 GIM。

非 IFC 小来源使用 pack/offset，减少海量独立小文件和逐条 IPC；按范围批读并复用已读载体。MOD/STL 不为加入语义 pack 再复制一份。压缩流、字符串、数据库行和输出缓冲有明确所有者，避免一次性把完整解压结果复制到 JS、JSON 和 SQLite 三处。

线路语义采用 begin/chunks/finish，只有 finish 发布完整标记。派生几何保留原子临时文件替换，不能对每件可重建产物无理由强制同步刷盘；具体持久性边界由[缓存域](../architecture/caches.md)维护。

## 门禁

- 原生后端可用时不能无依据退回低吞吐 WASM/全缓冲路径；后端切换记录解压、首次输入和入库阶段，不能混为几何计算。
- 同一批条目不逐件建立索引、发 IPC 或提交事务。用调用数、读取字节、pack/独立条目计数验证，不能只看总完成时间。
- 源类型由 magic 和实际内容决定；裸包、设备和线路仍保留当前入口语义。半成品、取消或缺条目不发布完整缓存。
- 保留路径/容量边界、来源身份和所属子进程回收。7z 可执行文件来源校验有执行安全目的，不能与模型数据的反复审计混为一谈；同样要复用结果、限制频率。
- 注册工作命令的文件/哈希/解压/SQLite 操作在 spawn_blocking 内执行，异步入口不直接持有数据库锁或做路径 I/O；取消保留独立内存通路。线程与注册表检查见[平台线程边界](../architecture/platform.md#原生命令线程边界)。移出 IPC/async 线程不自动证明吞吐提升；保持读取量、事务、源校验次数与 total/invoke 计时范围，实际影响由开发者本地复核。

## 反例与本地复核

并发从一个数字加到更大不天然更快，历史上更高 CBM 并发和直接搬运整包字节均出现过退化/OOM。不要把旧线程数固化为验收目标。分别观察解压、源输入、SQLite 写入与写排水，确认省的是实际 I/O/CPU，没有推迟发布或丢条目。

代码：[原生入口](../../desktop/src-tauri/src/gim_extract_command.rs)、[共享解码器](../../crates/gim-native-core/src/lib.rs)、[7z 流式路径](../../desktop/src-tauri/src/seven_zip_cli.rs)、[来源 pack](../../desktop/src-tauri/src/db/semantic_pack.rs)。

检查：[批读协议](../../desktop/src/infrastructure/native/__tests__/projectFileEnvelope.test.ts)、[来源载体](../../desktop/src/services/__tests__/engineeringSourceBatches.test.ts)及原生库现有值/路径测试。真实容器、磁盘和吞吐只由开发者本地复核，不默认全矩阵。
