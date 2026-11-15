# IFC 与空间语义

本页约束 IFC 远景、近景、属性、连接构件和空间语义的重复工作。现行支持范围及精度见 [IFC 运行时](../architecture/ifc-runtime.md)，不能从外部引擎跑分或源大小推断本项目全流程耗时。

## 保留的做法

同一来源的转换 API、OpenModel、索引和语义启动 Promise 尽量复用。空间语义用选择性 STEP 扫描和必要引用闭包，不把数百万属性、样式、表示和关系全部当产品。原始 GlobalId 保留大小写/合法字符，重复身份保留歧义，不能为降低对象数错误合并。

远景直接生成支持的 bounds/拉伸轮廓，近景按空间范围选对象，精确 L2/属性按需求值。远景命中不读/不转换原 IFC，近景命中不重开源求值。重 BRep、映射实例和紧固件多说明工作重，不自动说明源坏；曲线降段也不能消除已离散的全部面。

空间索引先发布解除装配等待，编码在 Worker 中完成，来源屏障/写盘独立跟踪。名称索引、空间语义和属性不重复打开/解析同源；标准目录或空间归属变化不重建有效的远景几何。

连接网格按块复制实际索引及必要顶点区间，消费确认后推进，局部失败局部诊断。只检查被实际引用的数据，不因未引用坏顶点拒绝整个有效对象。

## 门禁

- 统计同源 read/OpenModel/转换/语义构建次数；共享 Promise 防止冷开重复启动、结算后又出现第二个 Spatial 任务。
- 近景按现行区域政策和真实范围选择，所有权/可见性掩码包含 L1 替换；不能跳过 `getVisible` 后选到隐藏远景。
- 缓存命中、普通导入、区域精化、连接重放和属性读取分别计量，不把远景 HIT 写成全部 IFC 完整暖恢复。
- 不保存 WASM 指针或借用 TypedArray 跨 await/堆增长；先复制当前块的独占数据再等待。只用公开引擎接口，不靠私有结构减少一次读取。
- 稀疏索引可能使 min/max 顶点区间仍很大，应报告实际复制量与引用量，不能把“分块”直接当作已消除峰值。
- 缺源、超限、不支持或对象失败保留诊断与产品边界，不能补零或用简单 proxy 冒充精确几何。

## 本地复核

按真实瓶颈选择 IFC 转换、Spatial、连接复制或 L2 路线，分别记录源/WASM/运行时身份、打开次数、复制字节、队列与执行、几何缺口及峰值。Node/mock API 等价不证明固定 WebView2 指针正确或真实工程性能达标。

代码：[转换 Worker](../../desktop/src/viewer/ifcConversionWorker.ts)、[连接批次](../../desktop/src/viewer/ifcConnectionBatches.ts)、[区域 Worker](../../desktop/src/viewer/ifcRegionalWorker.ts)、[空间来源](../../desktop/src/services/substationSpatialWorkerClient.ts)。检查：[IFC 专项](../validation.md#ifc-连接几何本地门禁)、[单次解析](../../desktop/src/viewer/__tests__/ifcSharedImport.test.ts)、[连接块](../../desktop/src/viewer/__tests__/ifcConnectionBatches.test.ts)、[空间发布](../../desktop/src/services/__tests__/substationSpatialWorker.test.ts)。
