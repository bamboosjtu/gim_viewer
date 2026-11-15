# 首屏与生命周期

本页约束打开、首次实体可见和后台工作启动。几何、语义和持久化的状态定义以[生命周期](../architecture/lifecycle.md)、[测量](measurement-and-acceptance.md)为准。

## 保留的做法

入口不静态引入 Three、web-ifc、MapLibre；需要相应能力时再初始化，共享一次初始化 Promise。设备/DEV-only 打开不强制启动 IFC，引擎初始化与当前 Viewer 可用分别表达。

几何消费真实物理 occurrence 目录，实体识别和树投影独立发布。来源、Core 或投影失败不撤销合法几何；几何失败不删除语义对象。Inventory、已解析证据与工程识别覆盖是三个范围，不以全包属性解析作为首屏前置。

目录、语义索引和几何先发布，再按各自完成状态写派生缓存。物理目录仍需完成必要引用遍历，不能假装已实现逐根流式发布；应先消除无关输入、分类、全量校核和同步编码等非必要等待。DEV bounds 缓存首批返回即可消费，不等最后一批。

## 门禁

- 识别、投影和缓存人为挂起时，已有来源/真实几何仍可取得；分开测试索引就绪与缓存写入完成。
- 首次几何要求当前有效视口有非空实体进入实际绘制提交流程，不等待 GPU 完成。导航 DOM、几何可用、首次可见和完全结算不得互相冒充。
- 首个 IFC 为空/不可见时继续观察后续模型；全部 IFC 尾部结束后，来源语义、STD/SLD、缓存和已有锚点的 DEV 可继续，不能永远等一个不会触发的绘制回调。
- 正常可见首帧保留绘制机会，再做可后置 CPU 工作；无可见模型时也不能伪造首次可见/交互时刻。
- 发布前核对会话、源 SHA、批次或请求代次，旧数据不能提交。取消只清理当前任务拥有的资源，重复清理幂等。

## 反例与本地复核

把分类挪到 extract 之后，不等于物理目录已摆脱证据图；在主线程 `setTimeout` 内 stringify 大对象，也不等于后台编码。去掉结算等待只改变数字，不能独自算性能优化；变更口径必须声明，完整结算继续包含承诺的缓存与后台终态。

本地分别看来源目录等待、首批 bounds、几何提交到实际绘制间隔、主线程长任务和后台尾段，保留白屏观察。不要通过暂停正常编译/解析来获得漂亮首屏。

代码：[来源编排](../../desktop/src/services/engineeringService.ts)、[首次绘制](../../desktop/src/services/geometryPresentationService.ts)、[IFC 启动](../../desktop/src/services/substationIfcRuntime.ts)。检查：[来源独立性](../../desktop/src/services/__tests__/engineeringService.test.ts)、[目录首批消费](../../desktop/src/services/__tests__/devLodRuntime.test.ts)、[模型绘制](../../desktop/src/viewer/__tests__/modelPresentation.test.ts)、[后台门禁](../../desktop/src/services/__tests__/substationBackgroundRuntime.test.ts)。
