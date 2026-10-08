# 容器、编码与文件角色

## 容器布局

`.gim` 是带 GIM 自定义头部的压缩容器，不能直接当标准 ZIP 从偏移零读取。

```text
GIMPKG* + 可变元数据/零填充 + 压缩 payload
```

| 标记 | 含义/处理 |
|---|---|
| `GIMPKGS` | 变电源类型 |
| `GIMPKGT` | 线路源类型 |
| `37 7A BC AF 27 1C` | 7z payload 签名 |
| `50 4B 03 04` | ZIP payload 签名 |

当前实现在头部搜索窗口内定位压缩签名，窗口上限 1 MiB。
定位后仍须通过解压器和资源/路径约束校验，签名命中本身不证明归档合法。
十个在册包全部是 7z；ZIP 是实现兼容分支，不能由十包统计宣称已获真实 ZIP 样本验收。
包中的 payload 位置见 [台账](sample-corpus.md)。

头部含源工程元数据，字段分段和长度不应写成固定偏移的通用协议。
源 magic 用于工程类型，文件名、缓存 projectType 或 ENTITYNAME 大小写不能替代它。
非 magic 元数据可供诊断，不用未经确认的字段布局驱动业务分支。

实现入口：[gimExtractor](../../desktop/src/gim/gimExtractor.ts)、
[projectType](../../desktop/src/gim/projectType.ts)、
[原生解压](../../desktop/src-tauri/src/gim_extract.rs)。

## 目录和条目解析

常见目录为 CBM、DEV、PHM、MOD；线路包常使用 Cbm、Dev、Phm、Mod。
目录名和扩展名按大小写不敏感解析，统一斜线；原路径仍保留用于来源显示。
目录是导出组织细节，不是固定文件角色契约。

IFC 可位于 DEV 或 CBM，属性 sidecar、PHM/MOD/STL 也不能靠固定目录拼接。
解析优先使用规范化条目路径，必要时以唯一文件名候选解析；
同名多候选不能静默任选。相对路径、异常路径、缺文件和歧义都应有明确结果。
全局 lookup 见 [fileLookup](../../desktop/src/gim/fileLookup.ts)。

## 文件角色

| 扩展名 | 内容与角色 | 主关联 |
|---|---|---|
| `.cbm` | 工程/设备语义与引用骨架 | project 根、CBM 子引用、DEV/FAM/IFC/SCH |
| `.fam` | 分节属性与标签/内部键/值 | BASEFAMILY、BASEFAMILYPOINTER 等 |
| `.dev` | 设备模板、固体/子设备清单 | CBM OBJECTMODELPOINTER，PHM/DEV |
| `.phm` | 装配引用、矩阵和颜色 | SOLIDMODEL 指向 PHM/MOD/STL 等 |
| `.mod` | 变电 XML 或线路四类文本族 | 由内容分型，不通用地按 KEY=VALUE 解析 |
| `.stl` | ASCII 或二进制三角网格 | PHM 引用的几何叶子 |
| `.gl` | 可选 XML 辅助来源 | 同 UUID DEV sidecar，不自动进入主链 |
| `.ifc` | IFC STEP 模型 | 文件级引用与可选 IFCGUID 对象关联 |
| `.sch` | 逻辑入口 KV 清单 | STD/SLD |
| `.std` | STD 电气 XML 或 SVG 内容 | 内容 root 决定解析能力 |
| `.sld` | 带行业扩展属性的 SVG | gridId、符号及图纸结构 |

文件存在、引用可达、可解析、可渲染和可关联是不同能力。
STL 不必存在，DEV/PHM/MOD 数量不必相等；SCH/STD/SLD 也不是所有工程的必备文件。

## 文本和空值

文本读取处理 UTF-8 BOM、CRLF/LF 和空行。CBM/DEV/PHM/SCH 常为 `KEY=VALUE` 变体；
FAM 使用分节和多段 `=`，HNum 使用逗号记录，XML/SVG 由结构 parser 处理。
不能用同一个全局 Map 解析全部文本文件。

键和 ENTITYNAME 比较使用各 parser 的归一化规则；XML primitive 标签保留大小写敏感。
数值先确认词法、有限性和范围，声明数量与实得记录分开。
空串、占位哨兵与数值零按字段语义处理，零电压/零长度/零坐标不自动证明业务对象无效。
空值入口见 [gimValueSemantics](../../desktop/src/gim/gimValueSemantics.ts)。

## 完整性口径

容器可解压不等于所有引用都完整。检查声明数量、目标解析、候选歧义、循环与根可达性。
原始清单只数实际文件，目录条目、解压哈希标记与统计输出不纳入源文件总数。
不以 basename UUID 唯一性替代源包身份；跨包可以复用相同根引用名。
