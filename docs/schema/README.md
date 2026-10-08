# GIM 格式与样本复核

这里记录匿名样本中的格式事实，以及当前软件解析和消费这些数据的边界。
每项结论限于已登记样本；不能由导出工具习惯推定通用 GIM 标准。

## 主题导航

| 文档 | 负责内容 |
|---|---|
| [样本台账](sample-corpus.md) | 源身份、数量、别名、覆盖与研究来源 |
| [容器与文件角色](container.md) | magic、压缩载荷、编码、条目解析和文件类型 |
| [语义模型](semantic-model.md) | CBM/FAM、层级/引用图、身份、来源、IFC 关联 |
| [几何模型](geometry-model.md) | DEV/PHM、模板与 occurrence、矩阵、颜色、STL/GL |
| [变电 XML MOD](substation-mod.md) | XML grammar、primitive 与实际渲染范围 |
| [线路文本 MOD](powerline-mod.md) | 四类 grammar、WIRE/挂点与当前示意曲线 |
| [逻辑模型](logical-model.md) | SCH、STD 内容变体、SLD 与关联 |

用户可用行为见 [软件规格](../software-spec.md)，内部缓存和生命周期见
[架构](../architecture.md)，所有补证据或开发行动见 [未决事项](../open-issues.md)。

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

## 脚本与输出

[样本验证技能](../../.agents/skills/gim-sample-verification/SKILL.md) 提供工作入口，
[脚本说明](../../.agents/skills/gim-sample-verification/scripts/README.md) 列出参数和输出。
[Python 调研脚本](../../desktop/scripts/gim_survey/) 支持批量分析。

脚本的分类、固定字段假设、阈值与默认样本列表需要核对，不是权威格式定义。
脚本不修改源样本，但会写统计文件；使用独立输出目录，避免覆盖已保存资产。
当前 `docs/schema/_generated/` 不是可用证据目录，正文不引用不存在的产物。

样本身份与核心数量直接维护于台账，完整 CSV 可保存在独立复核输出。
匿名示例只展示结构，不能复制真实工程名、地理位置或内部编号。
