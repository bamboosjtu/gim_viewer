# GIM 格式与样本复核

这里记录匿名样本中的格式事实，以及当前软件解析和消费这些数据的边界。每项结论限于已登记样本；不能由导出工具习惯推定通用 GIM 标准。

## 主题导航

| 文档 | 负责内容 |
|---|---|
| [样本台账](sample-corpus.md) | 源身份、数量、别名、覆盖与研究来源 |
| [容器与文件角色](container.md) | magic、压缩载荷、编码、条目解析和文件类型 |
| [语义模型](semantic-model.md) | CBM/FAM、层级/引用图、身份、来源、IFC 关联 |
| [几何模型](geometry-model.md) | DEV/PHM、模板与 occurrence、矩阵、颜色、STL/GL |
| [变电 XML MOD](substation-mod.md) | XML grammar、Entity/Boolean/状态与边界 |
| [XML primitive](xml-primitives.md) | 已实现 primitive 的字段、别名、几何/LOD、近似与限制 |
| [线路文本 MOD](powerline-mod.md) | 四类 grammar、WIRE/挂点与当前示意曲线 |
| [逻辑模型](logical-model.md) | SCH、STD 内容变体、SLD 与关联 |

工程实体和目录是软件领域规则，不是 GIM 格式：见[工程实体模型](../engineering/README.md)与[目录](../engineering/catalogs/README.md)。用户行为见[桌面规格](../software-spec.md)，内部机制见[架构](../architecture.md)。

## 复核顺序

1. 记录原始包大小、SHA、magic、payload 类型和位置。
2. 读取归档或解包清单，排除目录条目、解压标记与外部生成文件。
3. 从 `project.cbm` 建立类型与引用链，统一大小写/分隔符，区分缺失、歧义和不可达。
4. 核对 CBM/FAM 原始行、实体与属性来源，不只查看单值 Map。
5. 逐边检查 DEV/PHM 递归、装配路径、变换和实际可达叶子。
6. 按内容分类 MOD/STL/STD/SLD，区分存在、可解析与可渲染。
7. 将研究报告断言与源事实、当前 parser 和实际视图证据交叉检查。

全包条目数、树可达文件数、唯一模板数和 occurrence 数分别报告。
重复引用是图关系，不自动算文件重复或损坏；未被根引用的来源不自动计为业务对象。

## 来源与实现边界

- 格式文档写“样本观察”或“当前 parser 行为”，不把未复核的厂商习惯写成标准。
- XML primitive 的“已解析/可渲染/近似/不支持”分别记录；解析成功不等于尺寸或安装精度。
- 语义记录的类别、工程属性和设备目录由软件领域层解释，格式层只保留原始字段和来源。
- 变电三视图、目录和归属规则见[工程实体模型](../engineering/README.md)，不要写进格式文档。

## 脚本与输出

[样本验证技能](../../.agents/skills/gim-sample-verification/SKILL.md) 提供工作入口，
[脚本说明](../../.agents/skills/gim-sample-verification/scripts/README.md) 列出参数和输出。
批量静态检查由[样本验证技能](../../.agents/skills/gim-sample-verification/SKILL.md)提供；性能与打开结果使用[Benchmark CLI](../benchmark.md)。

脚本的分类、固定字段假设、阈值与默认样本列表需要核对，不是权威格式定义。
脚本不修改源样本，但会写统计文件；使用独立输出目录，避免覆盖已保存资产。
样本身份与核心数量直接维护于台账，完整 CSV 可保存在独立复核输出。
匿名示例只展示结构，不能复制真实工程名、地理位置或内部编号。

## 相关文档

- [样本台账](sample-corpus.md)
- [容器与文件角色](container.md)
- [语义模型](semantic-model.md)
- [几何模型](geometry-model.md)
- [工程实体模型](../engineering/README.md)
- [系统架构](../architecture.md)
