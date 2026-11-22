# 线路与移动端

本页约束桌面线路、共享纯逻辑和 Android 的性能边界。当前产品范围见[线路与移动端](../architecture/line-mobile.md)，不把变电三维的完成定义套到线路地图或杆塔局部预览。

## 保留的做法

线路图、属性和 HNum 由共享纯核心提供，平台分别提供存储、文件与显示。Android 不导入桌面 Viewer、Three、IFC 或 DOM；桌面打开入口按需加载 MapLibre。缓存身份绑定原来源，源类型不能被缓存或后缀覆盖。

使用索引和批量语义包，begin/chunks/finish 发布完整状态；合法暖恢复走现有快路径，不重新解压/解析/投影已经有效的范围。按塔/档/跨越来源建立地图数据，路径/命中和绘制分帧复用，避免每次指针事件重建全部线段。

树、Canvas、地图层和搜索共享选择状态，监听与资源由运行时拥有。SAF 导入和文件访问保持有界，耗时解析/存储不塞入交互事件回调。HNum/MOD 只是局部预览，不为打开地图默认生成完整三维或设计级弧垂。

## 门禁

- 相同来源/修订的暖语义包命中，不重复源解析；源身份不符、半成品或损坏包必须有明确结果，不用部分数据冒充完成。
- 共享核心不引入 DOM/Tauri/Three；地图及移动端修改不能借共享模块把桌面重依赖带入启动。
- 全包路径索引与按需属性规则同样适用；不能逐塔/逐属性扫描整个来源清单。
- 图节点共享不等于复制真实塔位；跳线、挂点和跨越不因简化而变成虚假跨塔关系。
- 地图与树切换/重开后监听、定时器、Worker 和选择代次可清理；离线/底图失败不阻止已有线路覆盖层浏览。
- 关闭后内存增加先区分存活对象、堆容量、WASM/原生和图形驻留，不仅凭一次 Private Bytes 曲线认定泄漏。

## 本地复核

按实际改动选择桌面线路或设备/Android 路线，记录导入、语义暖恢复、地图首显、连续交互及开闭保留。不得用桌面 Node、模拟器或高内存机器替代手机权限、SAF、显示与原生内存验收；也不因形式统一而默认重跑全部变电样本。

代码：[共享核心](../../packages/powerline-core/src/index.ts)、[线路运行时](../../desktop/src/features/powerline/application/openPowerlineProject.ts)、[地图几何](../../desktop/src/features/powerline/presentation/lineMapGeometry.ts)。检查：[暖语义](../../desktop/src/features/powerline/runtime/__tests__/lineSemanticWarmFastPath.test.ts)、[解析竞态](../../desktop/src/features/powerline/runtime/__tests__/lineParserWorkerRace.test.ts)、[地图生命周期](../../desktop/src/ui/__tests__/lineMapLifecycle.test.ts)及 Android 原生现有存储测试。
