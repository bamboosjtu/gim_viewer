---
name: gim-sample-verification
description: 对 GIM 样本执行容器、文件清单、引用链、完整性、几何可达性和 MOD 静态验证；用于用户引入新样本、要求对照 demo 结构化诊断或 parser 变更后的样本复核。
---

# GIM 样本验证

从当前工作区定位仓库，不硬编码工作目录。先确认 `demo/`、`desktop/` 与 `docs/schema/`。
默认对源包、解包内容和 SQLite 只读；允许生成独立统计输出和更新用户授权的文档。
不要修改 parser、数据库或渲染实现，不覆盖既有统计资产。用户的明确任务范围优先。

## 开始检查

1. 阅读仓库 AGENTS.md、[格式入口](../../../docs/schema/README.md) 与
   [样本台账](../../../docs/schema/sample-corpus.md)。
2. 记录源路径、大小、SHA、magic 和 payload 签名位置。使用匿名样本 ID。
3. 确认解包目录与源身份匹配；已有目录不能仅凭名称认定来自同一包。
4. 选独立输出目录，固定脚本参数和统计口径。可在内存读归档，避免为静态复核改写样本。
5. 解包需要写入文件；用户任务已授权时在独立目标执行，否则先完成可只读的检查。

研究报告和脚本结果都是待核对证据，当前源包与源码用于确定事实。
不把目录布局、厂商名称、固定偏移、同 UUID 或同下标当成通用契约。

## 主题与基线

| 检查 | 权威文档 |
|---|---|
| 容器、编码和角色 | [container](../../../docs/schema/container.md) |
| CBM/FAM、路径、身份、IFC | [semantic-model](../../../docs/schema/semantic-model.md) |
| DEV/PHM、可达性、矩阵、STL/GL | [geometry-model](../../../docs/schema/geometry-model.md) |
| XML primitive 与支持边界 | [substation-mod](../../../docs/schema/substation-mod.md) |
| 线路四类文本族与挂点 | [powerline-mod](../../../docs/schema/powerline-mod.md) |
| SCH/STD/SLD | [logical-model](../../../docs/schema/logical-model.md) |
| 内部 IR、生命周期、缓存 | [architecture](../../../docs/architecture.md) |
| 正确性与运行验收方法 | [validation](../../../docs/validation.md) |

## 执行顺序

先做容器和清单，再提取引用图；核对声明数量、缺失/歧义、根可达性和原始属性。
之后按工程类型分析几何与内容 grammar。最后将样本事实、parser 支持和真实渲染证据分开报告。

变电必须检查：IFC 全局文件发现与 IFCGUID 对象关联分离；PARTINDEX 身份与父物理子树；
PHM→PHM 递归、逐边矩阵、分支防环；FAM 原始物理行；可选 GL 与逻辑文件；
primitive 存在、解析和渲染三种状态。

线路必须检查：F2/F3/F4 图与共享边界；异名 DEV/FAM；原属性长度与几何长度；
塔位、WIRE 挂点和 CROSS 点的角色；同塔跳线；四类文本 MOD 和未知记录。

计数分别列示文件、可达叶子、unique DEV、occurrence、业务对象与引用边。
矩阵注明列主序、乘法方向、阈值、单位和轴转换。不能默认全部矩阵单位阵。
静态验证不能证明桌面选择、缓存等价、连续响应或工程级曲线公式通过。

## 工具与资产

脚本参数见 [scripts/README](scripts/README.md)。脚本读取源但会生成输出。
PowerShell 清单/几何脚本通常接受 `-SampleId`、`-SampleRoot`、`-OutDir`，
容器脚本使用 `-GimPath`。显式传独立 OutDir，避免写入技能内现有 CSV。

批量 Python 调研位于 [desktop/scripts/gim_survey](../../../desktop/scripts/gim_survey/)。
先检查实际样本集合、默认输出和算法；固定头布局与部分扫描分类不等于现行 parser。
脚本覆盖差异记录为诊断，不通过修改源或猜测身份把结果变为通过。

## 输出和文档维护

报告包括输入 SHA、方法/参数、结果、适用范围、缺失/歧义、不支持及未执行项。
默认更新现有主题文档，不按研究轮次新增长期正文。
样本身份和核心统计只更新台账；运行版本只更新架构；
未解决问题、待补证据和待开发功能只更新 [open-issues](../../../docs/open-issues.md)。
删除过程叙述、历史版本和已关闭问题复盘。schema 只使用匿名 ID，
不得写真实工程名、地理归属或内部标识。原始 research HTML 与样本保持不变。

交付前检查内部链接、源码路径、匿名化、统计口径及原始资产哈希。
说明实际做了哪些检查，不能把未运行的测试或缺样本 skip 报为通过。
