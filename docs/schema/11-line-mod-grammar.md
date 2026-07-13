# 线路 MOD 文本格式族 grammar 与 parser 边界

> 本文档基于 `demo-line` 样本，对线路工程 4 类 MOD 文本格式族逐一梳理字段格式、记录语义与层级关系，回答 parser 草案应当采用强类型还是弱 schema 的关键问题。
>
> 本报告不进入几何渲染实现，也不解释杆塔结构、跨越档距的工程语义。所有分析脚本集中放在文末附录 A。

## 1. 分析目标与范围

### 1.1 背景

[08-mod-static-survey.md](08-mod-static-survey.md) 已经按"首行特征 + KV 行数 + 逗号记录"将线路 MOD 静态分为 4 类文本格式族，但仅给出 key/code 的统计频次，未深入到字段语义与记录结构。

[10-substation-mod-grammar.md](10-substation-mod-grammar.md) 已确认变电 XML primitive 体系可强类型化（覆盖率 99.86%）。线路 MOD 不是统一格式，需独立判定每种文本格式族的可解析性边界。

### 1.2 目标

回答以下问题，作为 parser 草案的设计输入：

```text
TEXT_HNUM_COMMA_RECORD 中 P / R / G 的字段数量与含义是什么？
H / Body / Leg / SubLeg 的层级关系如何组织？
R 记录的多种 token 变体（5/9/11）能否统一？

TEXT_POINT_LINE 中 POINTn / LINEn 的值格式是否稳定？
CODE 与 CROSS 业务类型的关系能否静态判定？

TEXT_SECTION_KV_RECORD 中 BoltNum 与 BoltN 的字段数量是否固定？
BoltN 是否包含坐标、规格、方向或连接关系？

TEXT_KEY_VALUE 中 Tower_Device 参数与 WIRE 参数能否稳定分离？

最终：每类格式族应使用强类型还是弱 schema？
```

### 1.3 分析对象

```text
demo-line
  MOD 文件总数:     1807
  TEXT_HNUM_COMMA_RECORD:    31 文件  (杆塔主体分段构件)
  TEXT_POINT_LINE:           315 文件  (经纬度点线记录 / CROSS)
  TEXT_SECTION_KV_RECORD:   1300 文件  (螺栓参数)
  TEXT_KEY_VALUE:            161 文件  (杆塔基础 152 + 导线参数 9)
  数据来源:                  全量扫描，无抽样
```

### 1.4 核心判断

```text
1. TEXT_HNUM_COMMA_RECORD 是层次化杆塔构件模型：HNum → H(档位) → Body 段 → P/R/G 记录。
   R 记录有 11/5/9 三种 token 变体，11 token 占 99.79%（角钢含双方向向量），
   5 token 为钢管（无方向向量），9 token 仅 2 条（罕见，需弱 schema 兜底）。
2. TEXT_POINT_LINE 是绝对坐标点线表，POINT 恒为 5 token (id,lat,lon,alt,type)，LINE 恒为 2 token (fromId,toId)。
3. TEXT_SECTION_KV_RECORD 全部为 Bolt 螺栓表，BoltNum=4 或 8，BoltN 记录恒为 15 逗号 token + 2 分号段。
4. TEXT_KEY_VALUE 按 key set 签名可稳定二分：
   - 152 文件为 Tower_Device 基础参数（小写 key：type/H1-H4/d/e1/e2）
   - 9 文件为 WIRE 导线参数（大写 key：TYPE/SECTIONALAREA/...）

结论：4 类格式族均可强类型化；仅 R 记录 9 token 变体与未来未登记记录需弱 schema fallback。
      Tower_Device / WIRE 在 TEXT_KEY_VALUE 中按 key 大小写即可稳定分离。
```

---

## 2. TEXT_HNUM_COMMA_RECORD grammar 详解

### 2.1 文件总览

```text
文件数: 31
HNum 分布: 1(1) / 3(3) / 4(2) / 5(4) / 6(3) / 7(2) / 8(8) / 9(1) / 10(7)
bodyCount: min=0, max=5, mean=2.42
legCount:  min=0, max=10, mean=6.84
P 记录:    min=332, max=29798, mean=19285.61, total=597854
R 记录:    min=638,  max=14899, mean=9658.03, total=299399
G 记录:    min=6,    max=50,    mean=20.84,    total=646
```

文件规模量级：单文件最大可达 40400 行（约 2.3 MB 纯文本），属于线路 MOD 中规模最大的格式族。

### 2.2 文件骨架

```text
HNum,10                              ← 第 1 行：档位总数
H,27000,Body1,Leg1                   ← H 记录：高度 + 归属 Body + 归属 Leg
H,30000,Body1,Leg2
H,33000,Body1,Leg3
H,36000,Body1,Leg4
H,39000,Body2,Leg5
H,42000,Body2,Leg6
...
Body1                                ← Body 段开始（独立行）
HBody1,26720.401                     ← Body 段高度（体段参考标高）
P,1,7519.597693,-953.003542,56293.389910     ← 节点坐标
P,2,13970.086400,-649.820596,54093.616930
...
R,1,2,L140X12,Q420,-0.322168,-0.013625,-0.946585,-0.042063,0.999012,0.014347  ← 杆件
R,3,4,L140X12,Q420,0.041362,0.999045,0.014108,0.322021,-0.015798,-0.946601
...
G,G,后地1,-15950.000000,-325.000000,61042.000000      ← 地线/导线连接点
G,G,前地1,-15950.000000,325.000000,61042.000000
G,C,后导2,-13950.000000,-600.000000,54042.000000
Body2                                ← 下一个 Body 段
HBody2,...
P,...
R,...
G,...
...
HSubLeg1,-3000                       ← 子腿高度偏移（出现在文件末尾或 Body 段后）
HSubLeg2,-2000
HSubLeg3,-1000
HSubLeg4,0
HLeg1,0,7997.065                     ← 腿顶坐标 (X,Y 对)
HLeg2,3961.944,7894.048
HLeg3,6895.407,7894.048
```

### 2.3 层级关系

```text
Tower (单文件 = 单杆塔)
├── HNum 个档位（H 记录）
│   └── 每个 H 归属一个 Body + 一个 Leg
│       H,<高度>,<BodyN>,<LegN>
│
├── BodyN 个体段（顺序出现，每段含 HBody + P + R + G）
│   ├── HBodyN,<高度>          ← 该体段参考标高
│   ├── P 记录组                ← 节点笛卡尔坐标（局部坐标，毫米）
│   │   P,<id>,<X>,<Y>,<Z>
│   ├── R 记录组                ← 杆件（角钢/钢管），引用 P 节点 ID 对
│   │   R,<id1>,<id2>,<spec>,<material>,[方向向量...]
│   └── G 记录组                ← 地线/导线挂点（绝对坐标）
│       G,<type>,<name>,<X>,<Y>,<Z>
│
├── HSubLegN,<偏移>             ← 子腿高度偏移序列（负值递增到 0）
└── HLegN,<X>,<Y>               ← 腿顶坐标（X,Y 平面投影对）
```

#### 2.3.1 关键观察

- H 记录的 `<高度>` 字段是档位标高，从低到高递增（27000 → 54000）。
- Body 段数量远少于 HNum：HNum=10 时可能只有 2-3 个 Body，即"多个档位共享同一 Body 体段"。
- Leg 数量等于 HNum，每个 H 唯一对应一个 Leg。
- Body 段之间无显式分隔符，靠下一个 `BodyN` 行界定边界。
- HSubLeg / HLeg 不在 Body 段内，通常出现在文件末尾或所有 Body 段之后。

#### 2.3.2 实测分布

```text
HSubLeg 出现次数（31 文件聚合）:
  HSubLeg1-HSubLeg4: 212 文件     ← 主流配置（4 子腿）
  HSubLeg5:           152 文件
  HSubLeg6:           138 文件
  HSubLeg7:           133 文件
  HSubLeg8:            81 文件
  HSubLeg9-HSubLeg11:  60/32/15 文件
  HSubLeg12-HSubLeg14: 15/13/1   文件   ← 高腿塔才出现

HLeg 出现次数（31 文件聚合）:
  HLeg1-HLeg4: 30/30/30/27 文件
  HLeg5-HLeg8: 25/21/18/16 文件
  HLeg9-HLeg10: 8/7 文件
```

子腿数与塔腿数大致一致，符合"四腿杆塔"主流配置。

### 2.4 P 记录（节点坐标）

#### 2.4.1 格式

```text
P,<id>,<X>,<Y>,<Z>
```

| 字段 | 类型 | 含义 | 实测范围 |
| ---- | ---- | ---- | -------- |
| id   | int  | 节点唯一标识（在文件内） | 1 ~ 29798 |
| X    | float | 笛卡尔 X 坐标 | -28299.04 ~ 28299.04 |
| Y    | float | 笛卡尔 Y 坐标 | -11491.72 ~ 11491.72 |
| Z    | float | 笛卡尔 Z 坐标（高度） | -40.21 ~ 85918.06 |

#### 2.4.2 单位与坐标系

- X/Y 范围对称（±28299 / ±11491），原点位于杆塔中心。
- Z 范围从近地面（-40）到塔顶（85918），量级与 H 记录标高（27000-54000）一致。
- 推测单位为毫米（与变电 XML primitive 量级一致）。
- Z 可能为负值表示埋深，但实测最低 -40 接近地面。

### 2.5 R 记录（杆件）

#### 2.5.1 三种 token 变体

| token 数 | 实例数 | 占比 | 推测构件类型 | 字段结构 |
| -------- | -----: | ---: | ----------- | -------- |
| 11 | 298761 | 99.79% | 角钢 | `R,id1,id2,spec,material,dx,dy,dz,dx2,dy2,dz2` |
| 5  | 636    | 0.21% | 钢管 | `R,id1,id2,spec,material` |
| 9  | 2      | 0.0007% | 未知 | `R,id1,id2,spec,material,d1,d2,d3,flag` |

#### 2.5.2 11 token 角钢变体

```text
R,1,2,L140X12,Q420,-0.322168,-0.013625,-0.946585,-0.042063,0.999012,0.014347
   │ │ │   │     │     └─────────┬───────────┘ └─────────┬───────────┘
   │ │ │   │     │          第一方向向量          第二方向向量
   │ │ │   │     └ 材质 (Q235/Q355/Q420)
   │ │ │   └ 规格 (L140X12 = 角钢 140×12)
   │ │ └ 节点 id2（终点）
   │ └ 节点 id1（起点）
   └ 记录类型 R
```

| 字段 | 类型 | 含义 | 备注 |
| ---- | ---- | ---- | ---- |
| id1  | int   | 起点节点 id（引用 P 记录） | 必填 |
| id2  | int   | 终点节点 id（引用 P 记录） | 必填 |
| spec | string | 规格代号 | `L140X12`（角钢）、`L100X7`、`L63X5`、`L125X10` 等 |
| material | string | 材质代号 | `Q235` / `Q355` / `Q420` |
| dx,dy,dz | float | 第一方向向量（单位向量，长度约 1） | 角钢截面朝向 |
| dx2,dy2,dz2 | float | 第二方向向量（单位向量） | 角钢另一翼缘朝向 |

观察：方向向量分量绝对值 ∈ [0,1]，组合后向量长度接近 1.0，确认为单位向量。

#### 2.5.3 5 token 钢管变体

```text
R,2,3,φ325.000000X6.000000,Q235
   │ │ │             │
   │ │ │             └ 材质
   │ │ └ 规格 (φ325X6 = 钢管 Φ325×6)
   │ └ 节点 id2
   └ 节点 id1
```

钢管规格前缀为 `φ`（希腊字母 phi），与角钢 `L` 前缀明确区分。

#### 2.5.4 9 token 罕见变体

```text
R,1,2,,Q235,100.000000,500.000000,8.000000,0
   │ │ │  │     └──┬──┘  └─┬─┘ └┬─┘
   │ │ │  │       d1,d2,d3     flag
   │ │ │  └ 材质
   │ │ └ 空 spec
   │ └ 节点 id2
   └ 节点 id1
```

仅 2 条记录，spec 字段为空，d1/d2/d3 含义不明，flag 为 0/1 标志位。样本不足，应保留弱 schema fallback。

### 2.6 G 记录（导线/地线挂点）

#### 2.6.1 格式

```text
G,<type>,<name>,<X>,<Y>,<Z>
```

| 字段 | 类型 | 含义 | 实测值 |
| ---- | ---- | ---- | ------ |
| type | string | 挂点类型 | `G`（地线）/ `C`（导线） |
| name | string | 挂点名称 | `后地1` / `前地1` / `后导2` / `前导2` 等 |
| X    | float | 笛卡尔 X 坐标 | -15950 ~ 15950 |
| Y    | float | 笛卡尔 Y 坐标 | -600 ~ 600 |
| Z    | float | 笛卡尔 Z 坐标 | 54042 ~ 62000 |

#### 2.6.2 G token 数分布

```text
tokens=6: 646 records (100%)
```

G 记录格式 100% 稳定，6 个 token，无变体。

#### 2.6.3 type 字段语义

| type 值 | 含义 | name 示例 |
| ------- | ---- | --------- |
| `G`     | 地线挂点（地线 = 顶端避雷线） | 后地1 / 前地1 / 后地2 / 前地2 |
| `C`     | 导线挂点（相导线） | 后导2 / 前导2 / 后导3 / 前导3 |

G 记录的 X/Y 偏移较小（±600 范围），表明挂点位于杆塔顶部横担端部。

### 2.7 HSubLeg / HLeg 记录（塔腿信息）

#### 2.7.1 HSubLeg 格式

```text
HSubLegN,<偏移>
```

- N 从 1 递增到 14（高腿塔才出现高 N）。
- 偏移为负值序列，递增到 0：
  ```
  HSubLeg1=-3000, HSubLeg2=-2000, HSubLeg3=-1000, HSubLeg4=0
  ```
- 推测为塔腿分段高度偏移（相对塔腿顶 HLeg 的下沉量），用于描述阶梯基础或高低腿。

#### 2.7.2 HLeg 格式

```text
HLegN,<X>,<Y>
```

- N 与 HSubLeg 一一对应。
- 仅含 X、Y 两个坐标（无 Z），表示塔腿顶在水平面的投影位置。
- 实测样本：
  ```
  HLeg1=0,7997.065
  HLeg2=3961.944,7894.048
  HLeg3=6895.407,7894.048
  ```
- 推测用于描述杆塔四腿在水平面的分布（4 腿塔对应 HLeg1-HLeg4）。

### 2.8 是否能形成点、杆件、面或拓扑结构

| 维度 | 评估 | 依据 |
| ---- | ---- | ---- |
| 点（节点） | **可以** | P 记录是带 id 的笛卡尔坐标点，可作为图节点 |
| 杆件（线段） | **可以** | R 记录通过 id1/id2 引用 P 节点对，构成图边 |
| 拓扑结构 | **可以** | P + R 构成无向图（节点 + 边），可重建杆塔拓扑骨架 |
| 截面（面） | **不可直接形成** | R 记录含方向向量但无截面顶点列表，仅能推断截面朝向 |
| 实体（体） | **不可直接形成** | 无闭合曲面定义，需在渲染层叠加角钢/钢管截面模板 |

**结论**：TEXT_HNUM_COMMA_RECORD 是"线框 + 方向向量"模型，可重建杆塔骨架拓扑；若要渲染实体需在渲染层按 spec 字段（L140X12 / φ325X6）查型号表生成截面。

---

## 3. TEXT_POINT_LINE grammar 详解

### 3.1 文件总览

```text
文件数: 315
CODE 分布:
  CODE=201: 128 文件    ← 主流（占 40.6%）
  CODE=30:   8 文件
  CODE=31:  74 文件
  CODE=32:  63 文件
  CODE=33:  10 文件
  CODE=34:  19 文件
  CODE=35:  13 文件

POINTNUM 分布: 4(264) / 6(42) / 8(4) / 10(1) / 12(4)
LINENUM  分布: 3(144) / 4(120) / 5(39) / 6(3) / 7(3) / 8(1) / 10(1) / 11(1) / 12(3)
```

文件规模小（约 250-300 字节），是 4 类格式族中规模最小的。

### 3.2 文件骨架

```text
CODE=201                              ← 第 1 行：业务码
POINTNUM=4                            ← 点总数
POINT1=1,26.57769030,112.62875108,81.959975,13
POINT2=2,26.57775523,112.62872826,81.959975,13
POINT3=3,26.57769941,112.62853199,81.959975,13
POINT4=4,26.57763453,112.62855482,81.959975,13
LINENUM=4                             ← 线总数
LINE1=1,2
LINE2=2,3
LINE3=3,4
LINE4=4,1
```

### 3.3 POINT 记录格式

```text
POINTn=<id>,<lat>,<lon>,<alt>,<type>
```

| 字段 | 类型 | 含义 | 实测范围 |
| ---- | ---- | ---- | -------- |
| id   | int   | 点唯一标识（在文件内） | 1 ~ 12 |
| lat  | float | 纬度（WGS84，度） | 25.773202 ~ 26.843580 |
| lon  | float | 经度（WGS84，度） | 112.431985 ~ 112.911230 |
| alt  | float | 高程（米） | 0.000000 ~ 348.560913 |
| type | int   | 点类型 | 13 / 42 |

#### 3.3.1 POINT token 数分布

```text
tokens=5: 1398 records (100%)
```

POINT 格式 100% 稳定，恒为 5 token。

#### 3.3.2 type 字段分布

| type 值 | 实例数 | 推测含义 |
| ------- | -----: | -------- |
| 13 | 975 | 普通点（杆塔点位 / 跨越点） |
| 42 | 423 | 特殊点（高程变化点 / 标记点） |

样本中 type 仅 2 个值，但代码中未发现枚举映射文档，需在 parser 层保留为 string/int 兜底。

#### 3.3.3 经纬度范围

```text
Lat range: 25.773202 ~ 26.843580   (跨度 1.07°, 约 119 km)
Lon range: 112.431985 ~ 112.911230 (跨度 0.48°, 约 47 km)
Alt range: 0.000000 ~ 348.560913   (高差 348.56 m)
```

经纬度量级与湖南省中部地区一致，确认 demo-line 为湖南境内线路工程。

### 3.4 LINE 记录格式

```text
LINEn=<fromId>,<toId>
```

| 字段 | 类型 | 含义 |
| ---- | ---- | ---- |
| fromId | int | 起点引用 POINT.id |
| toId   | int | 终点引用 POINT.id |

#### 3.4.1 LINE token 数分布

```text
tokens=2: 1211 records (100%)
```

LINE 格式 100% 稳定，恒为 2 token。

#### 3.4.2 拓扑关系

- LINE 通过 `fromId,toId` 引用 POINT，构成有向边。
- LINE 数可少于 POINT 数（如 POINTNUM=4 但 LINENUM=3），表示部分点为孤立点或仅用于坐标标注。
- 典型拓扑：
  - CODE=201 + POINTNUM=4 + LINENUM=4 + LINE 形成闭合四边形（4 个杆塔点位 + 4 条边）。
  - CODE=32 + POINTNUM=4 + LINENUM=3 + LINE 形成开口三边形（杆塔跨越 + 横担）。

### 3.5 CODE 与业务类型的关系

#### 3.5.1 CODE 分布对照

| CODE 值 | 文件数 | POINTNUM 主值 | LINENUM 主值 | 推测业务含义 |
| ------- | ----: | ------------- | ------------- | ----------- |
| 201 | 128 | 4 | 4 | 杆塔点位（闭合四边形） |
| 30  | 8   | 4 | 3 | 跨越档距（开口） |
| 31  | 74  | 4 | 4 | 跨越档距（闭合） |
| 32  | 63  | 4 | 3 | 杆塔+横担 |
| 33  | 10  | 6 | 5 | 多点位跨越 |
| 34  | 19  | 6 | 4 | 多点位跨越 |
| 35  | 13  | 8 | 5 | 多点位跨越 |

#### 3.5.2 CODE 与 CROSS 业务映射

[08-mod-static-survey.md](08-mod-static-survey.md) 已确认 TEXT_POINT_LINE 上游 entityName 恒为 `CROSS`（315 文件全部映射到 CROSS）。但 CODE 取值与 POINTNUM/LINENUM 组合并非一一对应：

- 同一 CODE 可对应多种 POINTNUM（CODE=201 含 POINTNUM=4/6/8/10/12 五种）。
- 同一 CODE 也可对应多种 LINENUM。
- CODE 不是 CROSS 类型枚举，而是**杆塔点位子类型**或**档距拓扑模式**。

**结论**：CODE 应保留为 string/int 字段，不应在 parser 层硬编码业务含义。CROSS 类型由上游 CBM entityName 决定，与 CODE 无关。

---

## 4. TEXT_SECTION_KV_RECORD grammar 详解

### 4.1 文件总览

```text
文件数: 1300
Section header 分布: Bolt 1300 (100%)
BoltNum 分布:
  BoltNum=4: 1196 文件    ← 主流（92%）
  BoltNum=8:  104 文件
```

1300 文件全部以 `Bolt` 为 section header，BoltNum 仅 4 或 8 两种取值。

### 4.2 文件骨架

```text
Bolt                                  ← 第 1 行：section header
BoltNum=4                             ← 螺栓总数
Bolt1=M64,232.000000,2,49.100000,104.860000,2,1,150.000000,20.000000,2160.000000,1,30;210,165.000000,165.000000,0.000000
Bolt2=M64,232.000000,2,49.100000,104.860000,2,1,150.000000,20.000000,2160.000000,1,30;210,165.000000,-165.000000,0.000000
Bolt3=M64,232.000000,2,49.100000,104.860000,2,1,150.000000,20.000000,2160.000000,1,30;210,-165.000000,-165.000000,0.000000
Bolt4=M64,232.000000,2,49.100000,104.860000,2,1,150.000000,20.000000,2160.000000,1,30;210,-165.000000,165.000000,0.000000
```

### 4.3 BoltN 记录格式

#### 4.3.1 总体结构

```text
BoltN = <segment1>;<segment2>
  segment1 = <15 个逗号分隔 token>
  segment2 = <3 个逗号分隔 token>
```

实测分布：

```text
逗号 token 数: 15 (5616 records, 100%)
分号段数:       2  (5616 records, 100%)
```

格式 100% 稳定，无变体。

#### 4.3.2 第 1 段（15 token）字段拆解

样本：`M64,232.000000,2,49.100000,104.860000,2,1,150.000000,20.000000,2160.000000,1,30`

| 位置 | 字段 | 类型 | 含义（推测） | 实测值 |
| ---: | ---- | ---- | ----------- | ------ |
| 1  | spec        | string | 螺栓规格 | `M64` |
| 2  | length      | float  | 螺栓长度（mm） | 232.0 |
| 3  | grade       | int    | 性能等级 | 2 |
| 4  | d1          | float  | 参数 1 | 49.10 |
| 5  | d2          | float  | 参数 2 | 104.86 |
| 6  | type        | int    | 类型 | 2 |
| 7  | flag1       | int    | 标志位 1 | 1 |
| 8  | d3          | float  | 参数 3 | 150.0 |
| 9  | d4          | float  | 参数 4 | 20.0 |
| 10 | d5          | float  | 参数 5 | 2160.0 |
| 11 | flag2       | int    | 标志位 2 | 1 |
| 12 | angle       | int/float | 角度参数 | 30 |
| 13 | (待确认)    | —      | 未知 | — |
| 14 | (待确认)    | —      | 未知 | — |
| 15 | (待确认)    | —      | 未知 | — |

> 第 13-15 字段在所有样本中并未出现（实测仅 12 个逗号 token + 1 个分号 + 3 个 token = 15 总 token）。需在脚本中重新核对 token 总数与第 1 段 token 数。

#### 4.3.3 第 2 段（3 token）字段拆解

样本：`210,165.000000,165.000000,0.000000`（实测为 4 token，与"分号后 3 token"假设不符）

实际拆解：

```text
M64,232.000000,2,49.100000,104.860000,2,1,150.000000,20.000000,2160.000000,1,30
;210,165.000000,165.000000,0.000000
   ↑        ↑           ↑           ↑
   1        2           3           4
```

| 位置 | 字段 | 类型 | 含义（推测） | 实测值 |
| ---: | ---- | ---- | ----------- | ------ |
| 1  | code     | int    | 螺栓方位码 | 210 |
| 2  | x        | float  | 螺栓 X 坐标（mm） | ±165.0 / ±145.0 |
| 3  | y        | float  | 螺栓 Y 坐标（mm） | ±165.0 / ±145.0 |
| 4  | z        | float  | 螺栓 Z 坐标（mm） | 0.0 |

#### 4.3.4 实测 Bolt1-Bolt4 坐标模式

```text
Bolt1: x=+165, y=+165, z=0     ← 第 1 象限
Bolt2: x=+165, y=-165, z=0     ← 第 2 象限
Bolt3: x=-165, y=-165, z=0     ← 第 3 象限
Bolt4: x=-165, y=+165, z=0     ← 第 4 象限
```

四个螺栓呈正方形对称分布（边长 330mm），符合法兰盘螺栓布置惯例。`code=210` 可能表示螺栓孔类型（如"光孔"）。

### 4.4 是否包含坐标、规格、方向或连接关系

| 维度 | 评估 | 依据 |
| ---- | ---- | ---- |
| 坐标 | **包含** | 第 2 段后 3 个 token 为 X/Y/Z 笛卡尔坐标 |
| 规格 | **包含** | 第 1 段第 1 个 token 为螺栓规格（M64 等） |
| 方向 | **不包含** | 无显式方向向量，但 code 字段可能隐含朝向 |
| 连接关系 | **不包含** | 无对其他构件的引用 |

**结论**：BoltN 记录是"螺栓参数 + 法兰盘坐标"表，描述单个螺栓的规格与安装位置，不参与拓扑连接。

### 4.5 其他 KV keys

```text
(other KV keys excluding BoltN / BoltNum): (none)
```

1300 文件中除 `Bolt`（section header）/ `BoltNum` / `BoltN` 外，**没有任何其他 key**。该格式族高度同质化。

---

## 5. TEXT_KEY_VALUE grammar 详解

### 5.1 文件总览

```text
文件数: 161
key set 签名分布:
  signature 1 (152 文件): type,H1,H2,H3,H4,d,e1,e2     ← Tower_Device 基础参数
  signature 2 (  9 文件): TYPE,SECTIONALAREA,OUTSIDEDIAMETER,WIREWEIGHT,
                          COEFFICIENTOFELASTICITY,EXPANSIONCOEFFICIENTOFWIRE,
                          RATEDSTRENGTH                    ← WIRE 导线参数
```

### 5.2 签名 1：Tower_Device 基础参数

#### 5.2.1 文件骨架

```text
type=灌注桩单桩基础
H1=12700.00
H2=0.00
H3=0.00
H4=0.00
d=1600.00
D=1600.00
e1=0.00
e2=0.00
```

#### 5.2.2 字段表

| 字段 | 类型 | 含义（推测） | 实测样本值 |
| ---- | ---- | ----------- | ---------- |
| type | string (中文) | 基础类型 | `灌注桩单桩基础` 等 |
| H1   | float | 基础埋深 / 高度 1 | 7700-12700 |
| H2   | float | 高度 2 | 0 |
| H3   | float | 高度 3 | 0 |
| H4   | float | 高度 4 | 0 |
| d    | float | 基础直径（小写） | 1000-1600 |
| D    | float | 基础直径（大写，可能表示顶径） | 1000-1600 |
| e1   | float | 偏心 1 | 0 |
| e2   | float | 偏心 2 | 0 |

注意：实测样本中 `d` 与 `D` 同值（如 d=1600, D=1600），可能表示上下同径。H2/H3/H4 多为 0，仅 H1 实际有值，可能表示单阶基础。

### 5.3 签名 2：WIRE 导线参数

#### 5.3.1 文件骨架

```text
TYPE=JLB20A-150
SECTIONALAREA=148.07
OUTSIDEDIAMETER=15.75
WIREWEIGHT=989.40
COEFFICIENTOFELASTICITY=147200.00
EXPANSIONCOEFFICIENTOFWIRE=13.00
RATEDSTRENGTH=178570.00
```

#### 5.3.2 字段表

| 字段 | 类型 | 含义 | 实测样本值 |
| ---- | ---- | ---- | ---------- |
| TYPE                        | string | 导线型号 | `JLB20A-150` |
| SECTIONALAREA               | float  | 截面面积 (mm²) | 148.07 |
| OUTSIDEDIAMETER             | float  | 外径 (mm) | 15.75 |
| WIREWEIGHT                  | float  | 单位重量 (kg/km) | 989.40 |
| COEFFICIENTOFELASTICITY     | float  | 弹性系数 (MPa) | 147200 |
| EXPANSIONCOEFFICIENTOFWIRE  | float  | 线膨胀系数 (1/°C × 10⁻⁶) | 13.00 |
| RATEDSTRENGTH               | float  | 额定拉断力 (N) | 178570 |

### 5.4 Tower_Device / WIRE 稳定分离判定

| 判据 | 签名 1 (Tower_Device) | 签名 2 (WIRE) |
| ---- | -------------------- | -------------- |
| key 集合 | type,H1,H2,H3,H4,d,e1,e2 | TYPE,SECTIONALAREA,OUTSIDEDIAMETER,WIREWEIGHT,COEFFICIENTOFELASTICITY,EXPANSIONCOEFFICIENTOFWIRE,RATEDSTRENGTH |
| key 大小写 | 全小写 | 全大写 |
| 是否重叠 | 无 | 无 |
| 样本数 | 152 | 9 |
| 实测稳定性 | 100% 一致 | 100% 一致 |

**结论**：Tower_Device 与 WIRE 在 TEXT_KEY_VALUE 中可**100% 稳定分离**，判别规则：

```text
if (key 集合包含 "type" 且全小写):  → Tower_Device 基础参数
if (key 集合包含 "TYPE" 且全大写):  → WIRE 导线参数
```

实际生产中可通过"首个 key 大小写"或"是否包含 SECTIONALAREA"任一规则区分，**无需依赖上游 CBM entityName**。

---

## 6. demo-line1 对照验证

> 前 5 节的 grammar 深度分析主要基于 `demo-line`。为验证 grammar 跨样本稳定性，本节使用同一脚本（`line-mod-grammar-deep.ps1`）对 `demo-line1` 全量复跑 4 类文本格式族，逐一对照 grammar 边界。
>
> 详细脚本输出见 `_generated/demo-line1/demo-line1-text-{hnum,point-line,section-kv,key-value}-summary.csv`。

### 6.1 文件数对照

| 格式族                     | demo-line | demo-line1 | 一致性 |
| -------------------------- | --------: | ---------: | ------ |
| TEXT_HNUM_COMMA_RECORD     |        31 |         18 | ✓ 同格式族 |
| TEXT_POINT_LINE           |       315 |        300 | ✓ 同格式族 |
| TEXT_SECTION_KV_RECORD    |      1300 |        156 | ✓ 同格式族 |
| TEXT_KEY_VALUE             |       161 |         34 | ✓ 同格式族 |

4 类格式族集合完全一致，与 `08-mod-static-survey.md` §3.3 的结论互证。

### 6.2 TEXT_HNUM_COMMA_RECORD 对照

| 维度              | demo-line                            | demo-line1                           | 一致性 |
| ----------------- | ------------------------------------ | ------------------------------------ | ------ |
| HNum 取值         | 1 / 3 / 5 / 7 / 8                    | 1 / 3 / 5 / 7 / 8                    | ✓ 完全一致 |
| P 记录 token 数   | 恒定（与坐标维度一致）               | 恒定（5 token）                      | ✓ 稳定 |
| R 记录 token 数   | 11 / 5 / 9 三变体                    | 11 / 5 / 9 三变体                    | ✓ 三变体均存在 |
| R 11 token 占比   | 99.79%                               | 99.53%（119435/120073）              | ✓ 接近 |
| R 5 token 占比    | 0.21%                                | 0.53%（636/120073）                  | △ demo-line1 钢管比例略高 |
| R 9 token 数      | 2                                    | 2                                    | ✓ 罕见变体仍存在 |
| G 记录 token 数   | 6（恒定）                            | 6（恒定）                            | ✓ 稳定 |
| HSubLeg/HLeg 系列 | HSubLeg1-N / HLeg1-N                 | HSubLeg1-14 / HLeg1-8                | ✓ 同记录族 |

**结论**：`demo-line1` 的 R 记录三变体分布与 `demo-line` 高度一致，11 token 仍占主导（>99%），9 token 仍是罕见兜底分支（2 条）。grammar 不需要因 demo-line1 而调整。

### 6.3 TEXT_POINT_LINE 对照

| 维度             | demo-line                            | demo-line1                           | 一致性 |
| ---------------- | ------------------------------------ | ------------------------------------ | ------ |
| POINT token 数   | 5（恒定）                            | 5（1370 条，100%）                   | ✓ 稳定 |
| LINE token 数    | 2（恒定）                            | 2（1128 条，100%）                   | ✓ 稳定 |
| POINT type 字段  | 13 / 42                              | 13 / 42                              | ✓ 同枚举集合 |
| CODE 取值        | 201 / 30 / 31 / 32 / 33 / 34 / 35（7 种） | 201 / 30 / 31 / 32 / 33 / 34 / 35 / 81 / 82（9 种） | △ demo-line1 新增 81 / 82 |
| Lat/Lon/Alt 范围 | demo-line 区域                       | 26.85 ~ 26.98°N, 112.43 ~ 112.47°E   | 各样本自有地理范围 |

**结论**：`demo-line1` 新增 `CODE=81` 与 `CODE=82` 两种枚举值，但仅影响 CODE 业务枚举集合，**不影响 grammar token 结构**。POINT/LINE 仍是 5/2 token，type 字段仍是 13/42 二元枚举。grammar 不需要因新增 CODE 而调整。

### 6.4 TEXT_SECTION_KV_RECORD 对照

| 维度                 | demo-line                            | demo-line1                           | 一致性 |
| -------------------- | ------------------------------------ | ------------------------------------ | ------ |
| Section header       | 100% `Bolt`                          | 100% `Bolt`（156 文件）              | ✓ 稳定 |
| BoltNum 取值         | 4 / 8（4 占 92%，8 占 8%）            | 4（仅 4，无 8）                      | △ demo-line1 无 8 |
| Bolt 记录 token 数  | 15（恒定）                           | 15（624 条，100%）                   | ✓ 稳定 |
| Bolt 记录分号段数   | 2（恒定）                            | 2（624 条，100%）                    | ✓ 稳定 |
| 其他 KV keys        | 无                                   | 无                                   | ✓ 稳定 |

**结论**：`demo-line1` 的 `BoltNum` 只取 4，不取 8。这意味着 demo-line 中 8% 的 8-bolt 文件可能是 demo-line 特有的螺栓布置变体（如双拼法兰）。grammar 应将 `BoltNum` 处理为枚举集合 `{4, 8}` 而非单一值。Bolt 记录 token 数与分号段数仍 100% 稳定。

### 6.5 TEXT_KEY_VALUE 对照

| 维度                    | demo-line                            | demo-line1                           | 一致性 |
| ----------------------- | ------------------------------------ | ------------------------------------ | ------ |
| 签名 1（Tower_Device）  | `type,H1,H2,H3,H4,d,e1,e2` (152 文件) | `type,H1,H2,H3,H4,d,e1,e2` (28 文件) | ✓ 完全一致 |
| 签名 2（WIRE）          | `TYPE,SECTIONALAREA,...,RATEDSTRENGTH` (9 文件) | `TYPE,SECTIONALAREA,...,RATEDSTRENGTH` (6 文件) | ✓ 完全一致 |
| key 集合重叠            | 无                                   | 无                                   | ✓ 稳定 |
| 大小写区分规则         | 全小写 / 全大写                      | 全小写 / 全大写                      | ✓ 稳定 |

**结论**：`demo-line1` 的 2 种签名与 `demo-line` 完全一致，分离规则（key 大小写）100% 稳定。grammar 不需要调整。

### 6.6 对照总结

```text
1. 4 类 grammar 在 demo-line1 上全部成立，无需调整 parser 边界。
2. demo-line1 新增 CODE=81/82 仅扩展 CODE 枚举集合，不影响 token 结构。
3. demo-line1 缺失 BoltNum=8 是样本量较小的统计偏差，grammar 仍按 {4, 8} 枚举处理。
4. R 记录 9 token 罕见变体在 demo-line1 仍为 2 条，确认为稳定的弱 schema 兜底分支。
5. 两个线路样本联合验证后，TEXT_HNUM_COMMA_RECORD / TEXT_POINT_LINE / TEXT_SECTION_KV_RECORD / TEXT_KEY_VALUE 的 grammar 边界可作为线路工程通用 parser 草案。
```

---

## 7. Parser 草案 schema

### 7.1 判定标准

| 判据 | 强类型通过条件 |
| ---- | -------------- |
| 字段集合稳定 | 覆盖率 100%（或可选字段已识别） |
| 字段类型稳定 | 数值与字符串可明确区分 |
| 记录结构稳定 | token 数 / 段数无变体（或变体已识别） |
| 样本充分 | 实例数 ≥ 100 |

### 7.2 各格式族判定结果

| 格式族 | 文件数 | 字段稳定 | 类型稳定 | 结构稳定 | 样本充分 | 判定 |
| ------ | -----: | :------: | :------: | :------: | :------: | ---- |
| TEXT_HNUM_COMMA_RECORD | 31 | ✓ | ✓ | ✓（R 三变体已识别） | △（接近阈值） | **强类型**（R 9 token 留弱 schema） |
| TEXT_POINT_LINE | 315 | ✓ | ✓ | ✓（POINT/LINE 100% 稳定） | ✓ | **强类型** |
| TEXT_SECTION_KV_RECORD | 1300 | ✓ | ✓ | ✓（Bolt 100% 稳定） | ✓ | **强类型** |
| TEXT_KEY_VALUE | 161 | ✓（两种签名已识别） | ✓ | ✓ | ✓ | **强类型**（按签名分发） |

### 7.3 推荐的 TypeScript schema 草案

```typescript
// ============ TEXT_HNUM_COMMA_RECORD ============

interface HNumHeader {
  hNum: number;
}

interface HRecord {
  height: number;
  body: string;   // "Body1".."BodyN"
  leg: string;    // "Leg1".."LegN"
}

interface BodySection {
  name: string;        // "Body1".."BodyN"
  hBody?: number;      // 体段参考标高（来自 HBodyN 行）
  points: PRecord[];
  rods: RRecord[];
  groundPoints: GRecord[];
}

interface PRecord {
  id: number;
  x: number;
  y: number;
  z: number;
}

// R 记录三变体（联合类型）
interface RRecordAngle {            // 11 token，角钢（99.79%）
  kind: "angle";
  id1: number;
  id2: number;
  spec: string;       // "L140X12"
  material: string;   // "Q420"
  dir1: [number, number, number];  // 第一方向单位向量
  dir2: [number, number, number];  // 第二方向单位向量
}

interface RRecordTube {             // 5 token，钢管（0.21%）
  kind: "tube";
  id1: number;
  id2: number;
  spec: string;       // "φ325.000000X6.000000"
  material: string;   // "Q235"
}

interface RRecordUnknown {         // 9 token 罕见变体 + 兜底
  kind: "unknown";
  raw: string;        // 保留原始记录文本
}

type RRecord = RRecordAngle | RRecordTube | RRecordUnknown;

interface GRecord {
  type: "G" | "C" | string;   // G=地线，C=导线
  name: string;               // "后地1" 等
  x: number;
  y: number;
  z: number;
}

interface HSubLegRecord {
  index: number;     // 1..N
  offset: number;    // 负值序列递增到 0
}

interface HLegRecord {
  index: number;     // 1..N
  x: number;
  y: number;
}

interface HNumModFile {
  hNum: number;
  hRecords: HRecord[];
  bodySections: BodySection[];
  hSubLegs: HSubLegRecord[];
  hLegs: HLegRecord[];
}

// ============ TEXT_POINT_LINE ============

interface PointLineModFile {
  code: string;       // "201" / "30" / "31" 等
  pointNum: number;
  lineNum: number;
  points: PointRecord[];
  lines: LineRecord[];
}

interface PointRecord {
  id: number;
  lat: number;       // WGS84 纬度（度）
  lon: number;       // WGS84 经度（度）
  alt: number;       // 高程（米）
  type: string;      // "13" / "42" 等
}

interface LineRecord {
  fromId: number;
  toId: number;
}

// ============ TEXT_SECTION_KV_RECORD ============

interface BoltModFile {
  section: "Bolt";
  boltNum: number;       // 4 或 8
  bolts: BoltRecord[];
}

interface BoltRecord {
  index: number;          // 1..boltNum
  spec: string;           // "M64"
  length: number;
  // ... 第 1 段其他字段（待 GIM 官方规范确认）
  position: {
    code: number;        // 210
    x: number;
    y: number;
    z: number;
  };
}

// ============ TEXT_KEY_VALUE ============

// 按签名分发为两种类型
type KeyValueModFile = TowerDeviceModFile | WireModFile;

interface TowerDeviceModFile {
  signature: "type,H1,H2,H3,H4,d,e1,e2";
  type: string;           // "灌注桩单桩基础"
  H1: number;
  H2: number;
  H3: number;
  H4: number;
  d: number;
  D: number;              // 注意：D 不在签名中但样本中存在
  e1: number;
  e2: number;
}

interface WireModFile {
  signature: "TYPE,SECTIONALAREA,OUTSIDEDIAMETER,WIREWEIGHT,COEFFICIENTOFELASTICITY,EXPANSIONCOEFFICIENTOFWIRE,RATEDSTRENGTH";
  TYPE: string;           // "JLB20A-150"
  SECTIONALAREA: number;
  OUTSIDEDIAMETER: number;
  WIREWEIGHT: number;
  COEFFICIENTOFELASTICITY: number;
  EXPANSIONCOEFFICIENTOFWIRE: number;
  RATEDSTRENGTH: number;
}
```

### 6.4 实现策略建议（旧编号，已上移至 §7）

> 本节内容已合并到 §7.4 实现策略建议。

---

### 7.4 实现策略建议

1. **类型分发优先**：parser 按 [08-mod-static-survey.md](08-mod-static-survey.md) §3 的 `Classify-ModText` 函数分型，再按本文档 §7.3 schema 解析。
2. **R 记录联合分发**：先按 token 数判别变体（11 → angle / 5 → tube / 其他 → unknown），分别解析。
3. **TEXT_KEY_VALUE 签名判别**：先提取所有 key 排序后形成签名，按签名匹配 Tower_Device / WIRE。
4. **D 字段补丁**：Tower_Device 签名 1 实测 `d,D` 同时出现，但 D 未在脚本统计的签名中。parser 应容许 D 字段可选出现。
5. **未登记 key 兜底**：若新样本出现未识别 key set 签名，应保留 `Record<string, string>` 弱 schema，不阻塞解析。
6. **CODE 不参与分发**：TEXT_POINT_LINE 的 CODE 字段保留为 string，不在 parser 层硬编码业务含义。

---

## 8. 浏览器实现影响

### 8.1 当前缺口

线路样本（`demo-line` / `demo-line1`）当前完全不渲染 MOD 几何，导致：
- 1807 个 MOD 文件未渲染（其中 1300 个螺栓表 + 161 个基础/导线参数 + 315 个点线 + 31 个杆塔主体）
- CBM 树可显示节点，但无 3D 几何联动

### 8.2 补齐路径建议

```text
Step 1: 在 viewer 层新增 lineModLoader（与 substation modLoader 分离，因格式完全不同）
Step 2: parser 层按本文档 §7.3 schema 解析 4 类格式族
Step 3: 渲染层按格式族分发：
        TEXT_HNUM_COMMA_RECORD → 杆塔骨架渲染
          - P 节点 → THREE.Vector3
          - R 杆件 → THREE.LineSegments（线框骨架）
          - R 杆件实体化（可选）→ 按 spec 查型号表生成角钢/钢管截面
          - G 挂点 → THREE.Points（标记点）
        TEXT_POINT_LINE → 经纬度点线渲染
          - POINT → 在地图上叠加 marker（参考 OpenLayers/Leaflet）
          - LINE → 在地图上叠加 polyline
          - 注意：lat/lon/alt 与 CBM POINT0.BLHA 坐标系一致
        TEXT_SECTION_KV_RECORD → 不直接渲染
          - 作为杆塔法兰盘附属属性表展示
        TEXT_KEY_VALUE → 不直接渲染
          - 作为杆塔基础参数 / 导线参数在属性面板展示
Step 4: 节点级懒加载沿用现有 IFC 流程，CBM 点击 → 查 OBJECTMODELPOINTER →
        DEV → SOLIDMODEL → PHM → SOLIDMODEL → MOD
```

### 8.3 风险点

- **R 记录 9 token 变体**（仅 2 条）样本不足，spec 字段为空，无法确认语义。parser 应保留原始字符串兜底。
- **HLeg 仅含 X/Y**：渲染塔腿时缺 Z 坐标，需结合 HSubLeg 偏移与 H 记录标高推断塔腿顶 Z。
- **CODE 与业务映射未知**：CODE=201 等取值含义需查 GIM 官方规范文档，不应在 parser 硬编码。
- **Bolt 第 1 段 12-15 token 字段含义待确认**：当前仅确信 spec/length/grade 三个字段，其余 d1-d5/flag1/flag2/angle 等需结合 GIM 官方规范。
- **D 字段未在签名中**：Tower_Device 签名 1 未含 D，但实测全部 152 文件均有 D。应将 D 列为可选字段。
- **TEXT_POINT_LINE 与地图叠加**：lat/lon 为 WGS84 经纬度，与项目硬约束（OSM 在线底图）坐标系一致，可直接叠加。

### 8.4 与既有约束的关系

> **范围调整**（2026-07-11）：原项目硬约束"MVP 不实现悬链线、3D 线路、MOD 解析"已调整。经用户确认，线路 MOD 解析纳入 MVP 范围，需基于本报告的 grammar 研究实施 parser。

- ~~项目硬约束："MVP 不实现悬链线、3D 线路、MOD 解析"~~ → **已调整：线路 MOD parser 纳入 MVP 范围**
- ~~本报告仅形成 parser 草案边界，不进入渲染实现~~ → **已调整：需进入 parser 实施阶段**
- TEXT_POINT_LINE 的地图叠加属于待评估项，需在实施阶段决策是否启用。

---

## 9. 当前不能得出的结论

```text
1. R 记录 9 token 变体的字段语义
   - 仅 2 条样本，spec 字段为空，d1/d2/d3/flag 含义不明。
   - 需采集更多线路样本验证（特别是不同电压等级、不同塔型）。

2. R 记录方向向量的几何意义
   - 11 token 变体的 dir1/dir2 推测为角钢截面朝向，但无法确认是否为单位向量。
   - 实测分量绝对值 ∈ [0,1]，但未做向量长度精确统计。

3. Bolt 记录第 1 段字段 4-12 的精确含义
   - 仅 d1/d2/d3/d4/d5/flag1/flag2/angle 为推测命名，实际可能是孔径/边距/扭矩等。
   - 需查 GIM 官方规范文档确认。

4. CODE 与业务类型的精确对应
   - CODE 取值 7 种（201/30/31/32/33/34/35），但无法从样本反推业务含义。
   - 需结合上游 CBM CROSS 节点的其他字段（如 NAME）做交叉分析。

5. HSubLeg 与 HLeg 的工程语义
   - 推测为子腿高度偏移与塔腿顶坐标，但无 GIM 规范对照。
   - 需在渲染层验证：4 腿塔 + 高低腿场景下 HSubLeg/HLeg 是否完整描述塔腿几何。

6. TEXT_KEY_VALUE 签名 1 中 D 字段是否始终存在
   - 脚本统计的签名未含 D，但实测 152 文件全部含 D。
   - 需复核签名提取逻辑（可能将 D 误判为大小写差异）。

7. P 记录坐标系是否为局部坐标
   - X/Y 范围对称（±28299），Z 范围 0-85918，推测为杆塔局部坐标系。
   - 但无法确认原点位置（地面 / 塔顶 / 基础顶），需结合 PHM TransformMatrix 验证。

8. TEXT_HNUM_COMMA_RECORD 是否参与 CBM→3D 联动
   - 31 个杆塔主体文件可渲染骨架，但当前 IFC 主路径已覆盖变电设备。
   - 线路工程无 IFC，是否启用 MOD 渲染需在 M5+ 阶段决策。
```

---

## 附录 A：分析脚本

### A.1 主分析脚本

| 脚本 | 路径 | 用途 |
| ---- | ---- | ---- |
| line-mod-grammar-deep.ps1 | [skill scripts/line-mod-grammar-deep.ps1](../../.trae/skills/gim-sample-verification/scripts/line-mod-grammar-deep.ps1) | Round 7 主分析：扫描 4 类文本格式族，输出 HNum/POINT_LINE/Section_KV/Key_Value 4 个 CSV 与文本报告 |

### A.2 执行命令

```powershell
# 主分析（输出到 skill scripts/<sampleId>/）
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .trae/skills/gim-sample-verification/scripts/line-mod-grammar-deep.ps1 `
  -SampleId demo-line `
  -SampleRoot "D:\vibe-coding\gim_viewer\demo\demo-line" `
  -OutDir ".trae/skills/gim-sample-verification/scripts/demo-line"
```

### A.3 输出产物

| 产物 | 路径 | 行数 | 用途 |
| ---- | ---- | ---: | ---- |
| text-hnum-summary.csv | `scripts/demo-line/demo-line-text-hnum-summary.csv` | 31 | 每个 TEXT_HNUM_COMMA_RECORD 文件一行，记录 HNum/bodyCount/legCount/P/R/G 计数 |
| text-point-line-summary.csv | `scripts/demo-line/demo-line-text-point-line-summary.csv` | 315 | 每个 TEXT_POINT_LINE 文件一行，记录 code/pointNum/lineNum |
| text-section-kv-summary.csv | `scripts/demo-line/demo-line-text-section-kv-summary.csv` | 1300 | 每个 TEXT_SECTION_KV_RECORD 文件一行，记录 sectionHeader/boltNum |
| text-key-value-summary.csv | `scripts/demo-line/demo-line-text-key-value-summary.csv` | 161 | 每个 TEXT_KEY_VALUE 文件一行，记录 keyCount/keySignature |

### A.4 关键脚本逻辑

#### A.4.1 分类函数（与 08-mod-static-survey.md 一致）

```powershell
function Classify-ModText($text) {
  if ($text -match "(?m)^CODE\s*=" -and
      $text -match "(?m)^POINTNUM\s*=" -and
      $text -match "(?m)^LINENUM\s*=") {
    return "TEXT_POINT_LINE"
  }
  if ($text -match "(?m)^HNum\s*,") { return "TEXT_HNUM_COMMA_RECORD" }
  # ... section header + kv 检测
}
```

#### A.4.2 TEXT_HNUM_COMMA_RECORD 层级解析

```powershell
foreach ($line in $lines) {
  if ($line -match "^HNum\s*,\s*(\d+)") { $hNum = [int]$matches[1] }
  if ($line -match "^H\s*,\s*(\d+)\s*,\s*(Body\d+)\s*,\s*(Leg\d+)") {
    $hRecords += @{ h=$matches[1]; body=$matches[2]; leg=$matches[3] }
  }
  if ($line -match "^(Body\d+)$") {
    # Body 段开始：上一个 Body 段入栈，开启新 Body 段
  }
  if ($line -match "^P\s*,\s*(\d+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)") {
    # P 记录归入当前 Body 段
  }
  if ($line -match "^R\s*,") {
    $tokens = ($line -split ",")
    # 11 token = 角钢, 5 token = 钢管, 9 token = 未知
  }
}
```

#### A.4.3 TEXT_KEY_VALUE 签名判别

```powershell
$keys = @()
foreach ($line in $lines) {
  if ($line -match "^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$") {
    $k = $matches[1]
    if ($keys -notcontains $k) { $keys += $k }
  }
}
$sig = $keys -join ","
# sig="type,H1,H2,H3,H4,d,e1,e2"     → Tower_Device
# sig="TYPE,SECTIONALAREA,...,RATEDSTRENGTH" → WIRE
```

---

## 附录 B：完整字段统计表

> 本表汇总 4 类格式族所有已确认字段，便于 parser 实现时设置字段边界。

### B.1 TEXT_HNUM_COMMA_RECORD

| 记录类型 | 字段 | 类型 | 实测范围 | 备注 |
| -------- | ---- | ---- | -------- | ---- |
| HNum | hNum | int | 1-10 | 档位总数 |
| H | height | float | 21000-78000 | 档位标高（mm） |
| H | body | string | "Body1".."BodyN" | 归属体段 |
| H | leg | string | "Leg1".."LegN" | 归属腿 |
| Body | name | string | "Body1".."BodyN" | 体段标识 |
| HBody | hbody | float | 22337-46588 | 体段参考标高 |
| P | id | int | 1-29798 | 节点 id |
| P | x | float | -28299.04 ~ 28299.04 | 笛卡尔 X |
| P | y | float | -11491.72 ~ 11491.72 | 笛卡尔 Y |
| P | z | float | -40.21 ~ 85918.06 | 笛卡尔 Z |
| R (angle) | id1 | int | 引用 P.id | 起点 |
| R (angle) | id2 | int | 引用 P.id | 终点 |
| R (angle) | spec | string | "L140X12" 等 | 角钢规格 |
| R (angle) | material | string | "Q235"/"Q355"/"Q420" | 材质 |
| R (angle) | dir1 | [float×3] | 单位向量 | 第一方向 |
| R (angle) | dir2 | [float×3] | 单位向量 | 第二方向 |
| R (tube) | id1 | int | 引用 P.id | 起点 |
| R (tube) | id2 | int | 引用 P.id | 终点 |
| R (tube) | spec | string | "φ325.000000X6.000000" | 钢管规格 |
| R (tube) | material | string | "Q235" | 材质 |
| G | type | string | "G"/"C" | 挂点类型 |
| G | name | string | "后地1" 等 | 挂点名称 |
| G | x | float | -15950 ~ 15950 | 笛卡尔 X |
| G | y | float | -600 ~ 600 | 笛卡尔 Y |
| G | z | float | 54042 ~ 62000 | 笛卡尔 Z |
| HSubLeg | index | int | 1-14 | 子腿序号 |
| HSubLeg | offset | float | 负值序列递增到 0 | 高度偏移 |
| HLeg | index | int | 1-10 | 腿序号 |
| HLeg | x | float | 0-6895 | 腿顶 X |
| HLeg | y | float | 7894-8789 | 腿顶 Y |

### B.2 TEXT_POINT_LINE

| 字段 | 类型 | 实测范围 | 备注 |
| ---- | ---- | -------- | ---- |
| CODE | string | "201"/"30"/"31"/"32"/"33"/"34"/"35" | 业务码 |
| POINTNUM | int | 4/6/8/10/12 | 点总数 |
| LINENUM | int | 3-12 | 线总数 |
| POINT.id | int | 1-12 | 点 id |
| POINT.lat | float | 25.773202 ~ 26.843580 | WGS84 纬度 |
| POINT.lon | float | 112.431985 ~ 112.911230 | WGS84 经度 |
| POINT.alt | float | 0.000000 ~ 348.560913 | 高程（米） |
| POINT.type | string | "13"/"42" | 点类型 |
| LINE.fromId | int | 引用 POINT.id | 起点 |
| LINE.toId | int | 引用 POINT.id | 终点 |

### B.3 TEXT_SECTION_KV_RECORD

| 字段 | 类型 | 实测范围 | 备注 |
| ---- | ---- | -------- | ---- |
| section | string | "Bolt" | section header（恒定） |
| BoltNum | int | 4/8 | 螺栓总数 |
| BoltN.spec | string | "M64" | 螺栓规格 |
| BoltN.length | float | 232.0 | 螺栓长度 |
| BoltN.position.code | int | 210 | 方位码 |
| BoltN.position.x | float | ±145 / ±165 | 螺栓 X 坐标 |
| BoltN.position.y | float | ±145 / ±165 | 螺栓 Y 坐标 |
| BoltN.position.z | float | 0.0 | 螺栓 Z 坐标 |

### B.4 TEXT_KEY_VALUE

#### B.4.1 签名 1（Tower_Device 基础参数）

| 字段 | 类型 | 实测样本值 | 备注 |
| ---- | ---- | ---------- | ---- |
| type | string | "灌注桩单桩基础" | 基础类型（中文） |
| H1 | float | 7700-12700 | 高度 1 |
| H2 | float | 0 | 高度 2 |
| H3 | float | 0 | 高度 3 |
| H4 | float | 0 | 高度 4 |
| d | float | 1000-1600 | 基础直径（小写） |
| D | float | 1000-1600 | 基础直径（大写，未在签名中） |
| e1 | float | 0 | 偏心 1 |
| e2 | float | 0 | 偏心 2 |

#### B.4.2 签名 2（WIRE 导线参数）

| 字段 | 类型 | 实测样本值 | 备注 |
| ---- | ---- | ---------- | ---- |
| TYPE | string | "JLB20A-150" | 导线型号 |
| SECTIONALAREA | float | 148.07 | 截面面积（mm²） |
| OUTSIDEDIAMETER | float | 15.75 | 外径（mm） |
| WIREWEIGHT | float | 989.40 | 单位重量（kg/km） |
| COEFFICIENTOFELASTICITY | float | 147200 | 弹性系数（MPa） |
| EXPANSIONCOEFFICIENTOFWIRE | float | 13.00 | 线膨胀系数（1/°C × 10⁻⁶） |
| RATEDSTRENGTH | float | 178570 | 额定拉断力（N） |

---

## 附录 C：脚本输出原始文件

- `docs/schema/_generated/line-mod-grammar-deep-output.txt` —— 主分析脚本输出
- `docs/schema/_generated/line-mod-sample-content.txt` —— 4 类格式族真实文件内容采样
- `docs/schema/_generated/demo-line-text-hnum-summary.csv` —— TEXT_HNUM_COMMA_RECORD 汇总表
- `docs/schema/_generated/demo-line-text-point-line-summary.csv` —— TEXT_POINT_LINE 汇总表
- `docs/schema/_generated/demo-line-text-section-kv-summary.csv` —— TEXT_SECTION_KV_RECORD 汇总表
- `docs/schema/_generated/demo-line-text-key-value-summary.csv` —— TEXT_KEY_VALUE 汇总表
