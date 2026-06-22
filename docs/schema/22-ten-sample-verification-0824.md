# 十样本全量复核报告（2026-08-24）

> 本轮任务：验证此前基于"1 变电（demo-substation/JinQu）+ 2 线路（SLW3D）"的分析结论能否外推。
> 方法：`desktop/scripts/gim_survey/` 六个 Python 批量脚本对 4 变电 + 6 线路全量重扫，
> 输出 `_generated/container-survey.csv`、`file-inventory.csv`、`ref-chain-summary.csv`、
> `<sid>/{refs-integrity,entityname-distribution,mod-kind,primitive-survey,reachability,entityname-geometry,transform-stl}.csv`、`line-grammar-summary.csv`。

## 1. 核心结论：哪些外推成立、哪些被推翻

### 1.1 成立（升级为候选通用规则）

| 结论 | 样本支持度 |
| --- | --- |
| 魔数 GIMPKGS=变电 / GIMPKGT=线路 | 10/10 |
| payload 全部 7z；偏移必须搜索定位 | 10/10 |
| 四目录结构 + 大小写随工程类型 | 10/10 |
| 三层引用完整性硬缺失率 = 0 | 10/10（共 ~35 万条引用） |
| KEY=VALUE 文本格式；键名大小写不敏感 | 10/10 |
| 线路 MOD 恒为已知 4 类文本格式族 | 6/6 零逃逸 |
| POINT=5 token / LINE=2 token / type∈{13,42} / G 记录 6 token | 6/6 |
| SOLIDMODELn 与 TRANSFORMMATRIXn 一一对应 | 10/10 |
| 线路 MOD 无 TransformMatrix 字段 | 6/6 |
| entityName→几何 kind 映射（CROSS→POINT_LINE 等） | 6/6 线路复现 |
| STL 被 PHM 100% 引用且零复用 | 9/9（变电站02无 STL） |

### 1.2 被推翻或需重大修正

| # | 旧结论 | 新事实 | 波及文档 |
| --- | --- | --- | --- |
| 1 | payload offset=784 | 变电站02/变电站03为 **776**（不同导出软件） | 01 |
| 2 | DEV=PHM=MOD 数量一一对应 | 仅 JinQu 如此；BIMBase PHM≫MOD≫DEV | 02 |
| 3 | PHM 只引用 MOD/STL、无嵌套 | 变电站03 **2289 条 PHM→PHM**，最深 4 层 | 05/07/13 |
| 4 | 几何资源只有 .mod/.stl | 新增 **.gl**（BIMBase，45 个零引用孤儿） | 02/07/08 |
| 5 | 变电 MOD primitive 封闭在 14 类 | 新增 ≥13 类（Boolean/Wire/Cable/GimGeCableConcentration…） | 08/10 |
| 6 | Visible=True/False | Bentley/BIMBase 用小写 true/false | 08/10 |
| 7 | PHM 矩阵恒 IDENTITY、单级变换 | BIMBase/SDDP 含数千个非单位阵，两级变换部分成立 | 09 |
| 8 | STL 100% binary | 线路03 3 个 ASCII STL（AssimpScene） | 12 |
| 9 | 变电 STL=二次柜专属 | BIMBase 的 STL=一次设备（避雷器/接地开关等） | 12 |
| 10 | 变电必有三件套 SCH/STD/SLD | 仅 JinQu/SDDP 有 | 02 |
| 11 | 空 FAM 罕见 | 线路03 772 个空 FAM（占 11%） | 06 |
| 12 | BoltNum 仅 4/8；Bolt 首段 15 token | 出现 12；首段实为 12 token、分号段 {2,6} 两形态 | 11 |
| 13 | CODE 值域 {201,30..35} | 新增 1019/191/81/82/37/404/523 | 11 |
| 14 | TEXT_KEY_VALUE 两种签名 | 至少 5 种（含 α1α2、ZPOSTARRAY 变体） | 11 |
| 15 | 可达率接近 100% 且孤儿=EMPTY_DEVICE_XML | 变电站04 475 个带 Entity 的 XML MOD 孤儿 | 07 |

## 2. 导出软件是最大的混杂变量

本轮最重要的方法论发现：**多项旧"格式规则"实为导出软件的导出习惯**。

| 维度 | JinQu_GRevitTools | Bentley Substation | BIMBase电力套件 | SDDP | SLW3D | 输电数字化勘测系统 |
| --- | --- | --- | --- | --- | --- | --- |
| payload offset | 784 | **776** | **776** | 784 | 784 | 784 |
| DEV:PHM:MOD 数量 | 1:1:1 | 1:1:0.53 | 1:8.6:6.7 | 1:0.99:3.0 | - | - |
| PHM 矩阵 | IDENTITY | IDENTITY | **大量非单位** | **少量非单位** | IDENTITY | IDENTITY |
| STL 角色 | 二次柜 | 无 STL | **一次设备** | 1 个 | 金具 | 金具+ASCII |
| primitive 家族 | 14 类封闭 | +新类 | +新类(.gl) | +新类 | - | - |
| 三件套 | 有 | 无 | 无 | 有 | - | - |

后续任何"变电样本结论"都必须标注产出工具；跨工具成立的才可视为格式规则。

## 3. 对实现的影响清单

1. **几何遍历**：PHM 递归 + 防环（当前 parser max depth=1 假设需改）；`.gl` 纳入文件发现。
2. **渲染**：无条件应用 PHM `TRANSFORMMATRIXn`；STL loader 增加 ASCII 分支。
3. **变电 XML parser**：primitive 分发改为开放式枚举 + 兜底跳过；Visible 大小写不敏感。
4. **线路 parser**：BoltNum 动态读取；KV 弱 schema 兜底已证实必要；CODE 不做业务映射。
5. **CBM 解析**：ENTITYNAME 归一化比较（PARTINDEX/PartIndex/F4SYSTEM 等）；空 FAM 容忍。
6. **容器解析**：保持签名搜索，禁止 offset 写死。

## 4. 后续复核项（2026-08-24 第二批，已完成）

| 项目 | 结果 | 结论落盘 |
| --- | --- | --- |
| IFCGUID 新样本复算 | 变电站01 去重口径精确命中 94.81%（硬未命中仅 134 个唯一 GUID）；变电站02/03 无设备级 IFCGUID；变电站04 全空占位。**设备级 IFCGUID 是 JinQu 特有机制** | 05 号复核段 |
| CBM/DEV 层矩阵覆盖率 | 覆盖率 37.9%~77.6% 无稳定值；JinQu 的 CBM 矩阵 93.8% 为 IDENTITY，其余工具几乎全为非单位阵；SUBDEVICE 非单位占比 59%~94% | 09 号复核段 |
| StretchedBody Normal/Color 复核 | Normal 长度分化（JinQu 恒 304.8，其余以单位向量 1.0 为主）；A 通道出现大量 0/255 多值——**渲染端透明度语义风险** | 10 号复核段 |
| R8.5/R8.6 六维度设备聚合 | 线路映射 6/6 完全复现；变电 STL/MOD 分工随工具分化表已建立 | 12 号复核段 |
| 悬链线证据复现 | KVALUE 特征 6/6 复现但零值占比剧烈分化（0%~53%）；`POINTn.MATRIX0` 结构确认、x 对称性跨样本成立；**y 分量 ±6~12m 推翻“可忽略”旧结论** | 15 号复核段 |

新增脚本：`ifc_guid_check.py`、`cbm_dev_matrix.py`、`stretched_color.py`、`device_type_survey.py`、`catenary_evidence.py`。

## 5. 剩余开放项

> **2026-08-24 P0 批次已完成**，结论落盘：
>
> | 项目 | 结果 | 落盘 |
> | --- | --- | --- |
> | PHM 嵌套矩阵组合语义 | 平移/旋转/镜像承载于嵌套边（中位 49.9mm、阶梯 125mm 叠层链、191 条 det=-1 纯镜像）；叶级恒 IDENTITY；组合为标准层级级联。渲染需递归+防环+负行列式处理 | phm.md / 09 号 |
> | Color A 通道语义 | **A=0 是“不透明默认值”**（均匀覆盖全部实体类型，若作透明度则设备全不可见）；非零 A 才是透明意图候选；刻度随工具变化（百分制 vs 255） | 10 号 |
> | 新 primitive 字段 + 缺件量化 | 缺件率：JinQu 4.3% / Bentley **25.9%** / BIMBase 16.4% / SDDP 6.0%；主因是 Boolean（Entity1/2 引用式 CSG）无法独立重建；Wire 内嵌完整弧垂 FitCoordArray 可直接样条渲染 | 08 号 |
>
> **2026-08-24 P1 批次已完成**，结论落盘：
>
> | 项目 | 结果 | 落盘 |
> | --- | --- | --- |
> | `.gl` 引用机制 | 45 个全部与设备级 .cbm/.dev 同 UUID（隔离开关/绝缘子等），是 BIMBase 旁路辅助几何（电缆集中布置线），设计上不进渲染链；如需可视化按同 UUID 绑定加载 | 07 号 |
> | FileDevRelation 跨工具对比 | 计数键双形态（FILE.NUM/FILES.NUM）、子计数键双形态（DEV.NUM/DEVS.NUM）、IFC 名三种来源；parser 不能写死 JinQu 奇偶配对结构 | 05 号 |
> | SDDP 三件套格式 | **.std 与 .sld 为同一份 SVG 文档**（NBT1 版本），JinQu 为分离的 STD(XML/DLT1)+SLD(SVG/DLT1)；stdParser 对 SDDP 会解析失败，需按版本分发 | sch.md |
> | LOGICALMODEL 层级 | 由根级 SUBLOGICALMODELS 引用的无几何占位节点，可识别后跳过 | 04 号 |
> | CODE 业务映射 | **跨样本映射表建立**：201=房屋、191=河流、1019=树木、30~37=电力线（电压等级细分）、523=地下通信电缆 | 11 号 |
> | 新 KV 签名定性 | 含 α1α2/ZPOSTARRAY 的文件是**杆塔基础参数表**（掏挖基础放坡角 / 承台灌注桩 ZCOUNT+桩位坐标），非塔身参数 | 11 号 |
>
> **2026-08-24 P2 批次已完成**：
>
> | 项目 | 结果 | 落盘 |
> | --- | --- | --- |
> | KVALUE 零值语义（M5-C 部分） | **零 K 值 ⟺ 跳线**（六样本 100%：零值线两挂点距离全部 <5m）；`f=k·L²` 物理量级通过（中位 5~13m），KVALUE 高置信为弧垂系数 | 15 号 |
> | WIRETYPE 来源 | 在 WIRE→DEV→FAM 链中，键名即 WIRETYPE；DEVICETYPE 提供大类 | 15 号 |
> | ISJUMPER 替代方案 | 用「挂点重合」或「KVALUE=0」判定跳线；SPLIT 值域 {1,2,4,6} 疑似分裂数待确认 | 15 号 |
> | R 记录 9-token 变体 | 全普查仍仅 demo-line1 2 条；5-token=钢管（φ径X壁厚+材质）、11-token=角钢（规格+材质+双向量）；9-token 为空规格+数值参数组合，弱 schema 兜底继续保留 | 11 号已有弱 schema 结论维持 |
> | MOD 复用率 | 变电 4 样本 **100% 单次引用零复用**；线路低复用（max 9~40，多为金具/绝缘子跨塔复用）。GLB 缓存收益主要在线路侧 | 本节 |
> | 变电大坐标地理配准 | CBM 平移跨度 50~144m（mm 单位确认），符合站区尺度；配准公式候选=`BLHA 原点 ENU 映射 + 方位角旋转`，定向需地面真值验证 | 本节 |
>
> **2026-08-24 P3 批次（最后三个开放项）已完成**：
>
> | 项目 | 结果 | 落盘 |
> | --- | --- | --- |
> | Boolean CSG 策略输入 | Difference 77%/Union 19%/Intersection 2.5%；全部本文件内引用；49% 链式嵌套需拓扑排序。建议 three-bvh-csg 加载期重建+MOD 级缓存 | 08 号 |
> | A 刻度判定规则 | `max(A)>100 → /255 否则 /100`（文件级判定）；不透明哨兵两族（JinQu/SDDP=A满值，Bentley/BIMBase=0）；统一伪码已给出 | 10 号 |
> | KVALUE 精确系数 | k 为「档距×线型」级常数（同档同型完全一致）；OPGW<CONDUCTOR 跨样本成立；幂指数 p≈1.65 偏离 2 提示斜档距修正项；渲染用 f=kL² 形态正确 | 15 号 |
>
> 至此本轮十样本复核驱动的全部分析课题关闭。剩余为实现阶段事项
> （Boolean CSG 实现、A 规则落地、斜档距修正对照设计资料）。
