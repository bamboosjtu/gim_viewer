# DEV 几何与 LOD

本页约束 DEV/PHM/MOD/STL 编译、模板复用和浏览层次。矩阵、图元与资源预算的现行事实见[DEV 运行时](../architecture/dev-geometry.md)和[几何资产](../architecture/geometry-assets.md)。

## 保留的做法

编译单位是来源 DEV × LOD，缓存 `.bin` 是容器，不意味着改成逐工程实体编译。模板几何/材质复用，真实 occurrence 各自拥有放置；暖成本按唯一模板和 placement 计，不按分类实体数重复计。改变工程目录不能改变模板键。

全站每个合法 DEV 保留基础 L0，视域内按投影尺寸提供 L1，L2/精确 CSG 只在明确请求时计算。小零件和布尔开孔的省略是声明的浏览表示策略，不是删除工程对象。原始几何回退也遵守浏览 LOD，不能因缓存损坏意外开启全量 L2。

大 DEV 按真实装配/来源边规划分部，控制父任务、Part、合并和整体回退的共同预算。唯一源读取量与重复实例工作量分开估计。重复 STL 优先共享缓冲与变换，不能盲目拆分复制同一大源。全小构件的轮廓兜底由整个 DEV 决定，不能每个 Part 各补一个或全部丢掉。

## 门禁

- 同模板多实例只增加放置，不重复读/解析/编译相同键；在途任务合并。身份和选择通过来源地址，不按名字、距离或数组序号补配。
- 分部/整体表示的索引、位置、法线、绕序、材质与内部/外部矩阵一致；镜像、非均匀缩放、剪切、层级变换不能为提速被抹掉。
- 设备覆盖和实际工作量守恒；empty、unsupported、partial、failed 分列。全部细节过小时仍保留约定的真实来源轮廓，不能整台设备消失。
- 计划、合并、回退、取消共用资源所有权和后压；不得多个分治父任务各自先产出巨量 GLB 再等待合并。
- 尽量复用 loader 的 bounds、一次场景检查与资源收集；不对每次放置执行源 STL 反向审计或逐顶点复核。

## 反例与本地复核

隐藏远景整台小设备、跳过不可见性判断、把每个实体另存 GLB，都曾带来错误或无效工作。STL 分治策略受重复率与输出规模影响，没有当前证据时不盲目恢复旧策略或失效缓存键。

本地观察唯一模板数、每 LOD hit/miss/compile、来源读取、分部/合并次数、排队/执行/导出/解码/提交及内存，区别字节不同与渲染等价。几何等价的离线验收不能变成每次普通浏览的顶点审计。

代码：[编译](../../desktop/src/services/glbCacheService.ts)、[Worker 池](../../desktop/src/services/devGeometryWorkerClient.ts)、[模板](../../desktop/src/services/devGlbTemplateRuntime.ts)。检查：[编译与兜底](../../desktop/src/services/__tests__/glbCacheService.test.ts)、[多实例](../../desktop/src/services/__tests__/devGlbTemplateRuntime.test.ts)、[物理地址](../../desktop/src/services/__tests__/sourceGeometryService.test.ts)。
