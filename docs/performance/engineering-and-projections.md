# 实体识别与视图投影

本页约束语义产品的成本及其与几何的依赖边界。领域事实见[实体模型](../engineering/entities.md)，当前目录以独立 JSON 配置为准，工作簿仅作参考；性能门禁不改分类或宿主业务规则。

## 保留的做法

Parser/Adapter 提供来源证据，Core 判断类别、身份和成员，来源树/清册/组成树独立投影，几何按物理地址编译与放置。分类、树排序、组合分组和标准展示变化不改变物理根、矩阵、模板键或有效模板编译次数。

识别复用文档属性记录，保留 Pset/分段、实例/类型范围及单位，occurrence 赋值另存。字段选择、词汇索引、名称缓存和排序器有明确生命周期，不能逐属性/逐实例重复初始化、全表搜索或复制原文。标准要求是独立数据查询，不进入编译器或充当身份生成器。

详情只查询已物化子集，明确未加载/未驻留/覆盖不足和分页结束；显式物化才恢复证据。索引同修订复用，可重建证据通过压缩检查点释放 Worker 大图和堆容量；解析覆盖不因详情释放而变成未解析。

## 门禁

- 树展开、排序、搜索和属性查看不重新归一化工程，不全包重读 FAM，不重编未变化几何。
- 同名/共享模板不合并实例；逐来源分区守恒，PARTINDEX 唯一/歧义/未匹配与真实物理引用分别保留。
- 强证据冲突、名称兜底和缺字段仍保留候选/待归；不能通过少生成实体、吞并独立设备或隐藏未知对象减少工作量。
- 空间/几何细化只更新投影，不回写实体身份。缺 IFC/投影失败时，其他视图和已发布快照仍可浏览。
- 规则或词典变化只失效需要重建的域；新识别证据的必要成本按记录、字符串、索引和驻留逐项归因，不能只凭数量增长接受峰值回退。

## 反例与本地复核

历史上存在重复 IFC 语义构建、逐属性重复扫描、提前建立全量详情索引、空闲 Worker 保留整图及导航大对象来回复制。优先复用结果、分页和释放拥有的数据，不删可追溯证据来换速度。

观察 `engineering.extract/normalize`、证据驻留、导航投影/编码、缓存命中和真实几何编译次数。领域正确性及人工归属真值与性能分别验收。

代码：[纯领域](../../packages/gim-sdk/src/semantic/normalize.ts)、[证据 Provider](../../packages/gim-sdk/src/source/evidenceProvider.ts)、[导航](../../packages/gim-sdk/src/projection/navigation.ts)。检查：[实体/来源边界](../../desktop/src/services/__tests__/engineeringService.test.ts)、[证据检查点](../../desktop/src/services/__tests__/engineeringEvidenceCheckpoint.test.ts)、[导航缓存](../../desktop/src/services/__tests__/engineeringNavigationCache.test.ts)、[表示](../../desktop/src/services/__tests__/sourceGeometryService.test.ts)。
