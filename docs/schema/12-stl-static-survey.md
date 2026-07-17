# STL 静态角色与 MOD 关系分析

> 本文档回答 Round 8 的 6 个关键问题：STL 是 ASCII 还是 binary、是否被 PHM 引用、对应哪些 CBM entityName、与 MOD 的关系（互斥 / 并列 / fallback）、变电中 XML MOD 与 STL 是否服务不同设备、线路中 STL 是否主要服务特殊构件。
>
> 数据来源：对 demo-line / demo-line1 / demo-substation 三样本的全量扫描（无抽样）。分析脚本见文末附录 A。

> **2026-07-17 复核**：直接按 binary STL 长度公式 `84 + 50 × triangleCount` 扫描三组样本，`demo-line=181/750304 triangles`、`demo-line1=82/238194`、`demo-substation=1803/834874`，全部为 binary STL；文件数、三角形 min/max/avg 和 header 特征均与本文一致。

## 1. 分析目标与范围

### 1.1 背景

[02-gim-file-inventory.md](02-gim-file-inventory.md) 与 [03-gim-file-role-matrix.md](03-gim-file-role-matrix.md) 已确认两个 demo 都有 STL 文件，且粗判为 binary-like。但尚未回答 STL 在 GIM 引用链中的精确角色：

- STL 是 ASCII 还是 binary？
- STL 是否全部被 PHM 引用？
- STL 对应哪些 CBM entityName？
- STL 与 MOD 是互斥关系、并列关系，还是 fallback 关系？
- 变电中 XML MOD 和 STL 是否服务不同设备类型？
- 线路中 STL 是否主要服务特殊构件？

### 1.2 三样本基础数据

| 指标 | demo-line | demo-line1 | demo-substation |
| ---- | --------: | ---------: | --------------: |
| CBM 文件数 | 27829 | 4998 | 8701 |
| DEV 文件数 | 4518 | 1148 | 4179 |
| PHM 文件数 | 1836 | 563 | 4179 |
| MOD 文件数 | 1807 | 508 | 4179 |
| **STL 文件数** | **181** | **82** | **1803** |
| 工程类型 | 线路 | 线路 | 变电 |

### 1.3 核心结论

```text
1. STL 格式：100% binary（三样本 2066 个 STL 全部为标准 binary STL）
   - demo-line / demo-line1：80 字节 header 全为空白（0x20 填充）
   - demo-substation：80 字节 header 内容为 "name"（前 4 字节）
   - 文件大小满足 84 + 50*N 公式，N = 三角面片数

2. STL PHM 引用率：100%（三样本全部 STL 被 PHM 引用，无孤儿）
   - 单 PHM 引用模式：每个 STL 仅被 1 个 PHM 引用（无 STL 复用）
   - 与 MOD 复用对比：MOD 在线路样本最大复用 70 次，STL 完全不复用

3. STL entityName 映射（线路）：
   - Wire_Device：100% STL（demo-line 11773 CBM refs → 8 unique STLs，平均 8KB / 159 三角面）
   - Tower_Device：~62% STL（大模型，平均 156-187KB / 3196-3821 三角面）+ ~38% MOD（参数化）
   - CROSS：0% STL（100% TEXT_POINT_LINE MOD）
   - WIRE：0% STL（100% TEXT_KEY_VALUE MOD）

4. STL entityName 映射（变电）：
   - F4System：37% has STL（30 STL-only + 76 STL+MOD 并存）/ 63% MOD-only
   - PARTINDEX：0.3% has STL（10 STL+MOD 并存）/ 99.7% MOD-only

5. STL 与 MOD 关系（关键差异）：
   - 线路样本：PHM 级互斥（0 个 PHM 同时引用 STL 和 MOD）→ STL 与 MOD 是"分流"关系
   - 变电样本：86 个 PHM 同时引用 STL 和 MOD（2.1% of PHM）→ STL 与 MOD 可"并列"共存
   - 结论：STL 与 MOD 既不是单纯互斥也不是单纯并列，**因工程类型而异**

6. 浏览器策略影响：
   - 线路：STL 与 MOD 互斥，无重复渲染风险；按 entityName 分流即可
   - 变电：86 个 PHM 同时有 STL+MOD，需查 STL/MOD 是否描述同一几何（潜在重复风险）
   - 优先级建议：线路按 entityName 决定（Wire_Device→STL，CROSS/WIRE→MOD）；
                变电按 entityName+几何规模决定（F4System STL-only→STL，其他→MOD）
   - Fallback：线路无 STL↔MOD fallback（互斥），变电可考虑 MOD 解析失败时 fallback STL
```

---

## 2. STL 格式检测：ASCII vs binary

### 2.1 判定方法

```text
1. 读取前 84 字节
2. 取偏移 80 处的 4 字节 int32 LE = N（声称的三角面数）
3. 验证文件大小 == 84 + 50 * N
4. 若 size 匹配：判定为 binary STL
5. 若 size 不匹配 + 首 5 字节 == "solid"：判定为 ASCII STL
6. 否则：unknown
```

### 2.2 三样本格式分布

| 样本 | STL 总数 | binary | ASCII | unknown |
| ---- | -------: | -----: | ----: | ------: |
| demo-line | 181 | 181 (100%) | 0 | 0 |
| demo-line1 | 82 | 82 (100%) | 0 | 0 |
| demo-substation | 1803 | 1803 (100%) | 0 | 0 |

**结论**：GIM 工程中的 STL **全部为标准 binary STL**，无 ASCII 变体。Parser 可按统一二进制格式实现，无需兼容 ASCII 分支。

### 2.3 STL header 内容

| 样本 | Header 内容（80 字节） |
| ---- | --------------------- |
| demo-line | 全空白（0x20 填充） |
| demo-line1 | 全空白（0x20 填充） |
| demo-substation | "name" + 0x00 填充 |

变电样本的 header 含 "name" 字符串（推测为导出工具的固定标识），线路样本 header 全空白。Header 内容对解析无影响（标准 binary STL parser 跳过前 80 字节即可）。

### 2.4 三角面数与文件规模

| 指标 | demo-line | demo-line1 | demo-substation |
| ---- | --------: | ---------: | --------------: |
| 三角面数 min | 120 | 120 | 60 |
| 三角面数 max | 98204 | 11322 | 3112 |
| 三角面数 mean | 4145.33 | 2904.80 | 463.05 |
| 三角面数 total | 750304 | 238194 | 834874 |
| 文件大小 min | 5.94 KB | 5.94 KB | 3.01 KB |
| 文件大小 max | 4795.20 KB | 552.91 KB | 152.04 KB |
| 文件大小 mean | 202.49 KB | 141.92 KB | 22.69 KB |
| 文件大小 total | 35.79 MB | 11.36 MB | 39.95 MB |

**关键观察**：
- demo-line 的 STL 最大达 4.8 MB / 98204 三角面（杆塔整体模型）
- demo-substation 的 STL 普遍小（平均 22.69 KB / 463 三角面，最大 152 KB）
- 量级差异表明：线路 STL 承载完整杆塔几何，变电 STL 承载小型设备零件

---

## 3. STL PHM 引用率与复用

### 3.1 引用率

| 样本 | STL 总数 | 被 PHM 引用 | 未被引用 | 覆盖率 |
| ---- | -------: | ----------: | -------: | -----: |
| demo-line | 181 | 181 | 0 | 100.0% |
| demo-line1 | 82 | 82 | 0 | 100.0% |
| demo-substation | 1803 | 1803 | 0 | 100.0% |

**结论**：STL **100% 被 PHM 引用**，无孤儿 STL 文件。

### 3.2 STL 复用模式

| 样本 | ref-count=1（单 PHM 引用） | ref-count>1（多 PHM 复用） |
| ---- | -------------------------: | -------------------------: |
| demo-line | 181 (100%) | 0 |
| demo-line1 | 82 (100%) | 0 |
| demo-substation | 1803 (100%) | 0 |

**结论**：**STL 完全不复用**，每个 STL 唯一对应一个 PHM。与 MOD 的复用模式形成对比（demo-line MOD 最大复用 70 次）。

含义：STL 文件是"一次性资源"，每个 PHM 拥有独立的 STL 几何。加载策略无需考虑 STL 共享缓存，但需要考虑 PHM 间是否有几何重复（如多个相同塔型 → 不同 STL 文件但内容可能相同）。

---

## 4. STL 与 MOD 在 PHM 级的关系

### 4.1 PHM 引用模式分布

| 模式 | demo-line | demo-line1 | demo-substation |
| ---- | --------: | ---------: | --------------: |
| PHM 总数 | 1836 | 563 | 4179 |
| PHM with ONLY STL (no MOD) | 181 (9.9%) | 82 (14.6%) | 30 (0.7%) |
| PHM with STL + MOD | **0 (0.0%)** | **0 (0.0%)** | **86 (2.1%)** |
| PHM with MOD only | 1655 (90.1%) | 481 (85.4%) | 4049 (96.9%) |
| PHM with no SOLIDMODEL ref | 0 | 0 | 14 (0.3%) |

### 4.2 关键差异

**线路样本（demo-line / demo-line1）**：
- PHM 级**完全互斥**：0 个 PHM 同时引用 STL 和 MOD
- 每个 PHM 要么只有 STL，要么只有 MOD
- 含义：STL 与 MOD 在线路工程中是"分流"关系，由 PHM 决定走哪条路径

**变电样本（demo-substation）**：
- 86 个 PHM 同时引用 STL 和 MOD（**并列共存**）
- 30 个 PHM 仅引用 STL（无 MOD）
- 4049 个 PHM 仅引用 MOD
- 14 个 PHM 无 SOLIDMODEL 引用（与 [07-dev-phm-geometry-reachability.md](07-dev-phm-geometry-reachability.md) §8 的 14 个空 PHM 一致）
- 含义：STL 与 MOD 在变电工程中可并列共存，需评估是否描述相同几何

### 4.3 关系判定

```text
线路样本：PHM 级互斥关系
  - STL 和 MOD 是平行路径，由 PHM 决定走哪条
  - 同一 PHM 不会同时拥有 STL 和 MOD
  - 不存在 fallback 关系（MOD 失败不会回退到 STL）

变电样本：并列关系（86 PHM 同时引用）
  - STL 和 MOD 在同一 PHM 中可共存
  - 需进一步分析：是否描述同一几何的不同表达，还是描述不同部件
  - 潜在重复渲染风险（需要按 entityName 进一步判定，详见 §5）
```

---

## 5. STL 对应的 CBM entityName

### 5.1 线路样本 entityName × STL presence

| entityName | total CBM refs | has STL | STL-only | STL+MOD | MOD-only |
| ---------- | -------------: | ------: | -------: | ------: | --------: |
| **Wire_Device** | 11773 | 11773 (100%) | 11773 | 0 | 0 |
| **Tower_Device** | 4309 | 2682 (62%) | 2682 | 0 | 1627 (38%) |
| CROSS | 315 | 0 (0%) | 0 | 0 | 315 (100%) |
| WIRE | 5460 | 0 (0%) | 0 | 0 | 5460 (100%) |

**demo-line1 对照**：

| entityName | total CBM refs | has STL | STL-only | MOD-only |
| ---------- | -------------: | ------: | -------: | --------: |
| Wire_Device | 1953 | 1953 (100%) | 1953 | 0 |
| Tower_Device | 782 | 585 (75%) | 585 | 197 (25%) |
| CROSS | 152 | 0 (0%) | 0 | 152 (100%) |
| WIRE | 1013 | 0 (0%) | 0 | 1013 (100%) |

**线路样本核心模式**：
- `Wire_Device` → 100% STL（**唯一**几何来源）
- `Tower_Device` → 62-75% STL + 25-38% MOD（**分流**：部分塔用 STL 整体几何，部分塔用 MOD 参数化）
- `CROSS` → 100% MOD（TEXT_POINT_LINE 经纬度点线）
- `WIRE` → 100% MOD（TEXT_KEY_VALUE 导线参数）

### 5.2 变电样本 entityName × STL presence

| entityName | total CBM refs | has STL | STL-only | STL+MOD | MOD-only |
| ---------- | -------------: | ------: | -------: | ------: | --------: |
| **F4System** | 285 | 106 (37%) | 30 | 76 | 179 (63%) |
| **PARTINDEX** | 3894 | 10 (0.3%) | 0 | 10 | 3884 (99.7%) |

**变电样本核心模式**：
- `F4System` → 37% 含 STL（30 STL-only + 76 STL+MOD 并存）/ 63% MOD-only
- `PARTINDEX` → 99.7% MOD-only，仅 10 个 CBM refs 含 STL（且都与 MOD 并存）

### 5.3 entityName × MOD-kind 组合（demo-line Top 10）

| refs | uniqueSTLs | uniqueMODs | signature |
| ---: | ---------: | ---------: | --------- |
| 11773 | 8 | 0 | Wire_Device \| stl=1 \| modKinds=（空） |
| 5460 | 0 | 9 | WIRE \| stl=0 \| modKinds=TEXT_KEY_VALUE |
| 1300 | 0 | 1452 | Tower_Device \| stl=0 \| modKinds=TEXT_KEY_VALUE;TEXT_SECTION_KV_RECORD |
| 633 | 32 | 0 | Tower_Device \| stl=8 \| modKinds=（空） |
| 624 | 23 | 0 | Tower_Device \| stl=19 \| modKinds=（空） |
| 329 | 20 | 0 | Tower_Device \| stl=5 \| modKinds=（空） |
| 327 | 0 | 31 | Tower_Device \| stl=0 \| modKinds=TEXT_HNUM_COMMA_RECORD |
| 315 | 0 | 315 | CROSS \| stl=0 \| modKinds=TEXT_POINT_LINE |
| 310 | 19 | 0 | Tower_Device \| stl=4 \| modKinds=（空） |
| 275 | 40 | 0 | Tower_Device \| stl=10 \| modKinds=（空） |

**关键观察**：
- `Tower_Device` 进一步细分为 3 个子模式：
  - **stl=0 + TEXT_KEY_VALUE/SECTION_KV_RECORD**：参数化杆塔基础 + 螺栓表
  - **stl=0 + TEXT_HNUM_COMMA_RECORD**：杆塔主体骨架（H/Body/P/R/G 记录）
  - **stl=N + modKinds=空**：完整杆塔 STL 模型（无 MOD 文本参数）
- 同一 entityName 可对应不同子模式，**entityName 单独不能决定几何路径**，还需查 SOLIDMODEL 扩展名

### 5.4 entityName × MOD-kind 组合（demo-substation Top 5）

| refs | uniqueSTLs | uniqueMODs | signature |
| ---: | ---------: | ---------: | --------- |
| 3884 | 0 | 3884 | PARTINDEX \| stl=0 \| modKinds=XML_WITH_ENTITIES |
| 165 | 0 | 165 | F4System \| stl=0 \| modKinds=XML_WITH_ENTITIES |
| 30 | 30 | 0 | F4System \| stl=1 \| modKinds=（空） |
| 14 | 0 | 0 | F4System \| stl=0 \| modKinds=（空） |
| 10 | 10 | 10 | F4System \| stl=1 \| modKinds=XML_WITH_ENTITIES |

**关键观察**：
- 变电样本 STL 全部为 `XML_WITH_ENTITIES` MOD（与变电 XML primitive 体系一致）
- 30 个 F4System 节点 STL-only（无 MOD），可能是不可参数化的复杂设备
- 86 个 F4System / PARTINDEX 节点 STL+MOD 并存（10+76），需进一步判定是否重复

---

## 6. STL 规模分布（按 entityName）

### 6.1 线路样本

| 样本 | entityName | STL refs | 平均大小 | 最大大小 | 平均三角面 | 最大三角面 |
| ---- | ---------- | -------: | -------: | -------: | ---------: | ---------: |
| demo-line | Tower_Device | 27007 | 187 KB | 4795 KB | 3821 | 98204 |
| demo-line | Wire_Device | 11773 | 8 KB | 11 KB | 159 | 224 |
| demo-line1 | Tower_Device | 7450 | 156 KB | 553 KB | 3196 | 11322 |
| demo-line1 | Wire_Device | 1953 | 7 KB | 11 KB | 144 | 224 |

> "STL refs" 为 entityName 触达 STL 的总次数（含重复），实际 unique STL 数见 §5。

**Tower_Device STL**：
- 平均 156-187 KB / 3196-3821 三角面
- 最大可达 4.8 MB / 98204 三角面（demo-line 的最大杆塔）
- 量级表明：承载完整杆塔几何（主材 + 斜材 + 横担 + 塔腿）

**Wire_Device STL**：
- 平均 7-8 KB / 144-159 三角面
- 最大 11 KB / 224 三角面（与 Tower_Device 相比小 2 个数量级）
- 量级表明：承载小型五金件 / 金具 / 绝缘子串附件
- demo-line 与 demo-line1 的 Wire_Device STL 大小高度一致（max 11 KB），推测为同一规格的金具模型

### 6.2 变电样本

| entityName | STL refs | 平均大小 | 最大大小 | 平均三角面 | 最大三角面 |
| ---------- | -------: | -------: | -------: | ---------: | ---------: |
| F4System | 1769 | 23 KB | 152 KB | 463 | 3112 |
| PARTINDEX | 34 | 23 KB | 34 KB | 465 | 704 |

**变电 STL 规模特点**：
- 平均 23 KB / 463 三角面（远小于线路 Tower_Device 的 187 KB）
- 最大 152 KB / 3112 三角面（远小于线路最大 4.8 MB）
- 量级表明：变电 STL 承载小型设备零件，不是整体变电站模型
- F4System 与 PARTINDEX 的 STL 规模相近，但 PARTINDEX 仅 34 次 STL 触达（极少）

---

## 7. 浏览器实现影响

### 7.1 加载策略建议

```text
线路样本（demo-line / demo-line1）：
  - Wire_Device → 直接加载 STL（无 MOD 选择，无重复风险）
  - Tower_Device → 检查 SOLIDMODEL 扩展名：
      *.stl → 加载 STL（杆塔整体几何）
      *.mod → 按 MOD kind 加载（TEXT_HNUM 杆塔骨架 / TEXT_KEY_VALUE+SECTION_KV 参数）
  - CROSS → 加载 TEXT_POINT_LINE（经纬度点线，地图叠加）
  - WIRE → 加载 TEXT_KEY_VALUE（导线参数，属性面板）

变电样本（demo-substation）：
  - F4System → 检查 SOLIDMODEL 扩展名：
      *.stl only → 加载 STL（复杂几何设备）
      *.mod only → 加载 XML_WITH_ENTITIES（参数化 primitive）
      *.stl + *.mod → 优先加载 XML_WITH_ENTITIES（已实现）+ 评估是否需要 STL 补充
  - PARTINDEX → 加载 XML_WITH_ENTITIES（仅 10 个节点有 STL，可暂不处理 STL 路径）
```

### 7.2 优先级建议

| 决策点 | 推荐 | 理由 |
| ------ | ---- | ---- |
| 线路优先解析 | **MOD 优先**（CROSS/WIRE/Tower_Device-参数化分支） | MOD 已可解析，覆盖 90% 节点 |
| 线路 Wire_Device | **STL 直接加载** | 无 MOD 替代，必须解析 STL |
| 线路 Tower_Device-STL 分支 | **延后**（M5+） | STL 平均 187 KB，加载成本可控但需 Three.js STLLoader |
| 变电优先解析 | **MOD 优先**（XML_WITH_ENTITIES 已实现） | 覆盖 96.9% PHM |
| 变电 STL-only 节点 | **延后**（30 个 F4System 节点） | 占比 0.7%，可在后期补齐 |
| 变电 STL+MOD 并存节点 | **暂不加载 STL** | 86 个 PHM 已有 MOD，STL 可能是冗余备份 |

### 7.3 重复渲染风险评估

```text
线路样本：无重复风险
  - PHM 级互斥（0 PHM 同时有 STL 和 MOD）
  - 同一节点只会显示一种几何来源

变电样本：存在潜在重复风险
  - 86 个 PHM 同时有 STL 和 MOD
  - 若 STL 与 MOD 描述同一几何的不同表达：可能重复渲染同一构件
  - 若 STL 与 MOD 描述 PHM 内不同部件（如 STL = 外壳，MOD = 内部零件）：可同时渲染
  - 风险评估需结合 PHM TRANSFORMMATRIX 与 STL/MOD 的 bounding box 比对
  - 当前阶段建议：**仅加载 MOD，跳过 STL**（避免重复风险，可后期补齐）

STL/MOD 同 PHM 是否描述同一几何：当前不能得出结论
  - 需要采样 86 个 PHM 的 STL/MOD 几何 bounding box 比对
  - 需要检查 STL 三角面是否对应 MOD primitive 的并集
  - 本轮不进入几何解析，保留为后续待办
```

### 7.4 Fallback 路径评估

```text
线路样本：不需要 STL↔MOD fallback
  - PHM 级互斥，MOD 解析失败不会回退到 STL
  - 失败处理：直接报错，提示用户该节点几何无法显示

变电样本：可考虑 STL fallback
  - 86 个 PHM 有 STL+MOD，若 XML primitive 解析失败可尝试 STL
  - 但 fallback 增加复杂度，建议 MVP 阶段不做
  - 30 个 STL-only 节点必须有 STL 加载器才能显示
```

### 7.5 与研究启动时约束的关系（历史记录）

- 当时的项目硬约束为："MVP 不实现悬链线、3D 线路、MOD 解析"
- 当时本轮仅形成"加载策略建议"，不进入 STL 渲染实现
- 该范围后续已调整；当前已存在 STL 加载与 DEV 粒度 GLB 缓存，不能再把本节当作实现现状

---

## 8. 当前不能得出的结论

```text
1. 86 个变电 PHM 中 STL 与 MOD 是否描述同一几何
   - 需采样 86 个 PHM 的 STL 三角面与 MOD primitive 进行 bounding box 比对
   - 若 bounding box 完全重合 → STL 是 MOD 的备选表达（重复风险高）
   - 若 bounding box 不重合 → STL 描述 MOD 未覆盖的部件（可同时渲染）
   - 本轮不进入几何解析，保留为后续待办

2. Wire_Device STL 是否为标准金具模型
   - demo-line 与 demo-line1 的 Wire_Device STL 大小高度一致（max 11 KB）
   - 推测为同一规格的金具（如绝缘子串、联金、联板），但未对照金具型号表
   - 需结合上游 CBM 的金具名称字段验证

3. Tower_Device 中 STL 分支与 MOD 分支是否描述同类塔型
   - 38% Tower_Device 用 MOD（参数化），62% 用 STL（整体几何）
   - 是否同一塔型可有两种表达（设计师选择），还是不同塔型只能选一种？
   - 需结合 CBM 的塔型字段（如 TOWER_TYPE / TOWER_HEIGHT）验证

4. STL header 中 "name" 字符串的含义（仅 demo-substation）
   - 推测为导出工具的固定标识，但未对照导出工具源码
   - 不影响解析（标准 binary STL parser 跳过 header）

5. 变电 STL 的复用率是否真的为 0
   - 实测 100% 单 PHM 引用，但多个 STL 文件可能内容相同（不同 UUID 但同几何）
   - 需对 STL 文件做内容 hash 比对验证
   - 若内容重复，可考虑建立几何缓存池减少 GPU 内存

6. 线路 Wire_Device STL 是否实际渲染
   - 当前 Wire_Device 在 CBM 中出现 11773 次（demo-line），但 PHM 仅 181 个
   - 多个 CBM 共享同一 PHM 的 STL，渲染时只需加载 1 次
   - 但需评估 181 个 STL 全加载的内存成本（约 36 MB，可接受）

7. STL 三角面数是否包含法向量信息
   - 标准 binary STL 每个三角面含 12 个 float（normal + 3 vertices）+ 2 字节 attribute
   - 50 字节/三角面，含法向量
   - 但部分导出工具将法向量置零，需运行时重新计算
   - 本轮未做 STL 内容解析，未验证法向量是否有效
```

---

## 附录 A：分析脚本

### A.1 主分析脚本

| 脚本 | 路径 | 用途 |
| ---- | ---- | ---- |
| stl-static-survey.ps1 | [skill scripts/stl-static-survey.ps1](../../.trae/skills/gim-sample-verification/scripts/stl-static-survey.ps1) | Round 8 主分析：STL 格式检测 + PHM 引用扫描 + CBM 上游溯源 |

### A.2 执行命令

```powershell
# 单样本分析（输出到 skill scripts/<sampleId>/）
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .trae/skills/gim-sample-verification/scripts/stl-static-survey.ps1 `
  -SampleId demo-line `
  -SampleRoot "D:\vibe-coding\gim_viewer\demo\demo-line"

# 三样本对照（依次执行）
foreach ($s in @("demo-line","demo-line1","demo-substation")) {
  powershell -NoProfile -ExecutionPolicy Bypass -File `
    .trae/skills/gim-sample-verification/scripts/stl-static-survey.ps1 `
    -SampleId $s -SampleRoot "D:\vibe-coding\gim_viewer\demo\$s"
}
```

### A.3 输出产物

| 产物 | 路径 | 行数 | 用途 |
| ---- | ---- | ---: | ---- |
| stl-summary.csv | `scripts/<sampleId>/<sampleId>-stl-summary.csv` | STL 文件数 | 每个 STL 文件一行，记录 format/size/triangles/header |
| stl-phm-refs.csv | `scripts/<sampleId>/<sampleId>-stl-phm-refs.csv` | PHM 文件数 | 每个 PHM 一行，记录 stlRefs/modRefs/totalRefs 与目标列表 |
| stl-upstream.csv | `scripts/<sampleId>/<sampleId>-stl-upstream.csv` | entityName×MOD-kind 组合数 | 每个签名一行，记录 refs/uniqueStls/uniqueMods |

### A.4 关键脚本逻辑

#### A.4.1 STL 格式判定

```powershell
function Test-StlFormat($path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  if ($bytes.Length -lt 84) { return "unknown" }
  $tri = [BitConverter]::ToInt32($bytes, 80)
  $expectedBin = 84 + $tri * 50
  if ($expectedBin -eq $bytes.Length) { return "binary" }
  $first5 = [System.Text.Encoding]::ASCII.GetString($bytes[0..4])
  if ($first5 -eq "solid") { return "ascii" }
  return "unknown"
}
```

#### A.4.2 PHM → STL 引用扫描

```powershell
foreach ($pf in $phmFiles) {
  $text = Read-TextFileLoose $pf.FullName
  $lines = $text -split "`r?`n"
  $refs = @()
  foreach ($line in $lines) {
    if ($line -match "^\s*SOLIDMODEL\d+\s*=\s*(.+\.(mod|stl))\s*$") {
      $refs += $matches[1].Trim()
    }
  }
  $phmRefs[$pf.Name.ToLower()] = $refs
}
```

#### A.4.3 CBM → DEV → PHM → STL 上游溯源

```powershell
# 1. 扫描所有 CBM 提取 (entityName, OBJECTMODELPOINTER) 对
foreach ($cf in $cbmFiles) {
  $text = Read-TextFileLoose $cf.FullName
  # ... 提取 ENTITYNAME 和 OBJECTMODELPOINTER
}

# 2. 递归收集 DEV → DEV → PHM（处理 SUBDEVICE 嵌套）
function Get-AllPhmFromDev($devName, $visited) {
  if ($visited.ContainsKey($devName)) { return @() }
  $visited[$devName] = $true
  $phms = @()
  if ($devToPhmMap.ContainsKey($devName.ToLower())) { $phms += $devToPhmMap[$devName.ToLower()] }
  if ($devToDevMap.ContainsKey($devName.ToLower())) {
    foreach ($childDev in $devToDevMap[$devName.ToLower()]) {
      $phms += Get-AllPhmFromDev $childDev $visited
    }
  }
  return $phms | Sort-Object -Unique
}

# 3. 从 PHM 收集 STL 引用，按 entityName 聚合
foreach ($devName in $cbmDevEntries.Keys) {
  $entityNames = $cbmDevEntries[$devName]
  $vis = @{}
  $allPhms = Get-AllPhmFromDev $devName $vis
  $stlRefs = @()
  foreach ($phmName in $allPhms) {
    if ($phmToStlMap.ContainsKey($phmName.ToLower())) {
      $stlRefs += $phmToStlMap[$phmName.ToLower()]
    }
  }
  # 按 entityName 聚合 STL 引用
}
```

---

## 附录 B：完整数据表

### B.1 STL 格式与规模

| 样本 | STL 总数 | 格式 | 三角面 min | 三角面 max | 三角面 mean | 大小 total |
| ---- | -------: | ---- | ---------: | ---------: | ----------: | ----------: |
| demo-line | 181 | binary | 120 | 98204 | 4145 | 35.79 MB |
| demo-line1 | 82 | binary | 120 | 11322 | 2905 | 11.36 MB |
| demo-substation | 1803 | binary | 60 | 3112 | 463 | 39.95 MB |

### B.2 PHM 引用模式

| 模式 | demo-line | demo-line1 | demo-substation |
| ---- | --------: | ---------: | --------------: |
| PHM 总数 | 1836 | 563 | 4179 |
| PHM ONLY STL | 181 (9.9%) | 82 (14.6%) | 30 (0.7%) |
| PHM STL+MOD | 0 (0.0%) | 0 (0.0%) | 86 (2.1%) |
| PHM MOD only | 1655 (90.1%) | 481 (85.4%) | 4049 (96.9%) |
| PHM no ref | 0 | 0 | 14 (0.3%) |

### B.3 entityName × STL presence（demo-line）

| entityName | total | has STL | STL-only | STL+MOD | MOD-only |
| ---------- | ----: | ------: | -------: | ------: | --------: |
| Wire_Device | 11773 | 11773 (100%) | 11773 | 0 | 0 |
| Tower_Device | 4309 | 2682 (62%) | 2682 | 0 | 1627 |
| CROSS | 315 | 0 | 0 | 0 | 315 |
| WIRE | 5460 | 0 | 0 | 0 | 5460 |

### B.4 entityName × STL presence（demo-line1）

| entityName | total | has STL | STL-only | MOD-only |
| ---------- | ----: | ------: | -------: | --------: |
| Wire_Device | 1953 | 1953 (100%) | 1953 | 0 |
| Tower_Device | 782 | 585 (75%) | 585 | 197 |
| CROSS | 152 | 0 | 0 | 152 |
| WIRE | 1013 | 0 | 0 | 1013 |

### B.5 entityName × STL presence（demo-substation）

| entityName | total | has STL | STL-only | STL+MOD | MOD-only |
| ---------- | ----: | ------: | -------: | ------: | --------: |
| F4System | 285 | 106 (37%) | 30 | 76 | 179 |
| PARTINDEX | 3894 | 10 (0.3%) | 0 | 10 | 3884 |

### B.6 STL 规模按 entityName

| 样本 | entityName | 平均大小 | 最大大小 | 平均三角面 | 最大三角面 |
| ---- | ---------- | -------: | -------: | ---------: | ---------: |
| demo-line | Tower_Device | 187 KB | 4795 KB | 3821 | 98204 |
| demo-line | Wire_Device | 8 KB | 11 KB | 159 | 224 |
| demo-line1 | Tower_Device | 156 KB | 553 KB | 3196 | 11322 |
| demo-line1 | Wire_Device | 7 KB | 11 KB | 144 | 224 |
| demo-substation | F4System | 23 KB | 152 KB | 463 | 3112 |
| demo-substation | PARTINDEX | 23 KB | 34 KB | 465 | 704 |

---

## 9. STL 设备类型分析（按 SYMBOLNAME / TYPE）

> 本节通过 CBM → DEV → PHM → STL 完整链反查 STL 对应的具体设备类型，回答 "STL 主要渲染什么设备"。
>
> - 脚本：[_generated/stl-device-type-survey.ps1](_generated/stl-device-type-survey.ps1)
> - JSON 输出：[_generated/stl-device-type-survey-demo-substation.json](_generated/stl-device-type-survey-demo-substation.json) / [_generated/stl-device-type-survey-demo-line.json](_generated/stl-device-type-survey-demo-line.json) / [_generated/stl-device-type-survey-demo-line1.json](_generated/stl-device-type-survey-demo-line1.json)
> - MOD 设备类型对照见 §10

### 9.1 变电样本（demo-substation）

**总体规模**：STL 文件 1803 个，三角面 834,874 个，总大小 39.95 MB；含 STL 的 CBM 节点 116 个（106 F4System + 10 PARTINDEX），分类命中率 100%。

**按 SYMBOLNAME（DEV 设备符号名）Top 5**：

| 排名 | SYMBOLNAME | STL 数 | 三角面 | CBM 数 | 占比 |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 光纤配线柜 | 222 | 67,764 | 3 | 12.08% |
| 2 | 220kV线路保护测控柜 | 148 | 66,296 | 4 | 8.05% |
| 3 | 主变电能表柜 | 86 | 16,024 | 2 | 4.68% |
| 4 | 综合配线柜 | 74 | 20,800 | 1 | 4.03% |
| 5 | 光传输设备柜1 | 74 | 20,952 | 1 | 4.03% |

Top 5 合计 **32.88%**，Top 20 **全部为"柜"类设备**。

**关键结论**：

- **STL 100% 渲染二次设备柜**（DEV TYPE=SecondaryCabinet）— 不渲染一次设备（变压器/断路器由 IFC 承载），不渲染建筑结构（由 IFC 承载）
- **STL-only 节点（30 个 F4System）**：全部为 SecondaryCabinet 类型，包括通信柜、保护测控柜、电能表柜、数据网柜等复杂柜体（含面板/指示灯/按钮细节，无法用 XML primitive 表达）
- **STL+MOD 并存节点（86 个）**：STL 描述柜体外观，MOD 描述内部参数化构件
- **F4System 主导**：占 98.15% STL 引用（1803/1837），PARTINDEX 仅 34 个 STL（柜内局部构件）
- **复用率极低**：仅 34 个 STL 被多 CBM 共享（如"备用柜"29 个 CBM 共享同一 STL），其余 1769 个一对一对应

### 9.2 线路样本（demo-line / demo-line1）

**总体规模对比**：

| 维度 | demo-line | demo-line1 | demo-substation |
| --- | ---: | ---: | ---: |
| 工程类型 | GIMPKGT 线路（工程头标识 500kV；FAM 含 AC220kV/AC500kV 混合设备属性） | GIMPKGT 线路（500kV） | GIMPKGS 变电 |
| STL 文件总数 | 181 | 82 | 1803 |
| STL 三角面总数 | 750,304 | 238,194 | 834,874 |
| STL 总大小 (MB) | 35.79 | 11.36 | 39.95 |
| 含 STL 的 CBM 数 | 14455 | 2538 | 116 |
| STL-only CBM 数 | 14455 (100%) | 2538 (100%) | 0 (0%) |
| 实际承载 STL 的 entityName | Tower_Device + Wire_Device | Tower_Device + Wire_Device | F4System + PARTINDEX |
| 主导 SYMBOLNAME | INSULATOR / SPACER / DAMPER | INSULATOR / SPACER / DAMPER | 光纤配线柜 / 保护测控柜 |

**entityName 分布（demo-line）**：

| entityName | STL 数 | 三角面 | CBM 数 | STL-only |
| --- | ---: | ---: | ---: | ---: |
| Tower_Device | 27007 | 103,196,318 | 4309 | 2682 |
| Wire_Device | 11773 | 1,877,432 | 11773 | 11773 |
| F4System / CROSS / WIRE | 0 | 0 | 5861 / 315 / 5460 | 0 |

**按 SYMBOLNAME Top 3**（线路样本主导金具类型）：

| 排名 | SYMBOLNAME | demo-line STL 数 | demo-line1 STL 数 | 含义 |
| ---: | --- | ---: | ---: | --- |
| 1 | INSULATOR（绝缘子） | 27007 | 7450 | 串绝缘子 |
| 2 | SPACER（间隔棒） | 7305 | 1493 | 导线间隔棒 |
| 3 | DAMPER（防振锤） | 4468 | 460 | 防振锤 |

**关键结论**：

- **STL 100% 渲染金具**：绝缘子 + 间隔棒 + 防振锤，不渲染塔本体（塔本体由 MOD 文本格式族渲染）
- **STL-only 模式**：线路样本 STL 节点 100% 为 STL-only（无 MOD 共存），STL 是唯一几何来源
- **塔型字段（TOWERTYPE）与 STL 无关**：TOWERTYPE（如 `5B2-WKZ204A` / `500-MC31S-ZJTSD07`）只出现在 CBM 上，对应 stlCount 全部为 0
- **单塔 STL 配置固定**：每塔挂 18-19 串绝缘子，三角面约 53556-60570，分布稳定
- **塔型族差异**：demo-line 塔型以 `5B2/562/5E7` 开头，demo-line1 塔型以 `500-MC31S/500-MC31D` 开头；两样本工程头均标识 500kV，不能仅凭前缀把 demo-line 判为 220kV。两样本单塔 STL 配置一致

### 9.3 三样本对比：STL 设备类型差异

| 维度 | 线路样本（demo-line / demo-line1） | 变电样本（demo-substation） |
| --- | --- | --- |
| STL 渲染对象 | 金具（绝缘子/间隔棒/防振锤） | 二次设备柜（通信柜/保护测控柜/电能表柜） |
| SYMBOLNAME 语言 | 英文大写（INSULATOR/SPACER/DAMPER） | 中文柜体名（光纤配线柜/220kV线路保护测控柜） |
| DEV TYPE | N/A（金具类型） | SecondaryCabinet（二次柜） |
| STL 与 MOD 关系 | 互斥（STL-only 100%） | 共存（STL+MOD 100%） |
| 几何内容 | 三角网格（绝缘子串/间隔棒/防振锤） | 三角网格（柜体外壳/面板/屏柜） |
| 复用模式 | 多 CBM 共享同一 STL（181 文件覆盖 14455 CBM） | 一对一为主（1803 文件覆盖 116 CBM） |
| 单 STL 三角面 | demo-line ~4143 / demo-line1 ~2905 | ~463（远小于线路） |
| CBM 覆盖率 | demo-line 52% / demo-line1 51% | 1.36%（仅 116/8539 CBM） |

**核心差异**：线路 STL 渲染"线路金具"（绝缘子/间隔棒/防振锤），变电 STL 渲染"二次设备柜"（通信柜/保护测控柜/电能表柜），两类工程的 STL 设备类型**完全不同**。

---

## 10. MOD 设备类型对比分析（demo-substation）

> 本节通过 CBM → DEV → PHM → MOD 完整链反查 MOD 对应的具体设备类型，回答 "MOD 主要渲染什么设备"，并与 STL 设备类型对比。
>
> - 脚本：[_generated/mod-device-type-survey.ps1](_generated/mod-device-type-survey.ps1)
> - JSON 输出：[_generated/mod-device-type-survey.json](_generated/mod-device-type-survey.json)
> - 变电 MOD 的 14 种 primitive 字段范围详见 [10-substation-mod-grammar.md](10-substation-mod-grammar.md)

### 10.1 总体规模

| 指标 | 数值 |
| --- | --- |
| MOD 文件总数 | 4179（与 PHM 文件数一致） |
| MOD XML Entity 总数 | 46250（与 [10-substation-mod-grammar.md](10-substation-mod-grammar.md) §1.3 一致） |
| Primitive 总数 | 46250（每个 Entity 含 1 个 primitive） |
| MOD 总大小 | 15.39 MB |
| MOD kind 分布 | XML_WITH_ENTITIES 4135 (98.95%) + XML_EMPTY_DEVICE 44 (1.05%) |
| 含 MOD 引用的 CBM 节点 | 4179（100% F4System + 100% PARTINDEX） |
| MOD 聚合引用数 | 8029（同一 MOD 被多 CBM 共享，覆盖率 192.13%） |
| 分类命中率 | 100% |

### 10.2 按 TYPE Top 5 设备类型

| 排名 | TYPE | MOD 数 | Entity 数 | CBM 数 | 主要 primitive |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | OTHERS | 3870 | 31830 | 3870 | Cylinder(14561) + Cuboid(9689) + StretchedBody(5177) |
| 2 | SecondaryCabinet（二次柜） | 2030 | 13767 | 106 | Cuboid(7518) + Cylinder(4252) + StretchedBody(1871) |
| 3 | HGIS（气体绝缘开关） | 397 | 10008 | 32 | Cylinder(7756) + StretchedBody(1494) + Cuboid(461) |
| 4 | FrameCapacitor（框架电容） | 132 | 8664 | 36 | Cylinder(2844) + Cuboid(2244) + StretchedBody(2148) |
| 5 | GroundTransformer / ArcExtinguishingCoil | 32 | 4656 | 4 | Cylinder(2264) + Cuboid(1120) + StretchedBody(1060) |

### 10.3 按 SYMBOLNAME Top 5 设备类型

| 排名 | SYMBOLNAME | MOD 数 | Entity 数 | CBM 数 |
| ---: | --- | ---: | ---: | ---: |
| 1 | 框架式电容器（典设A2-6） | 108 | 7548 | 12 |
| 2 | 10kV 接地变及消弧线圈装置 | 32 | 4656 | 4 |
| 3 | 220kV GIS 电缆出线间隔 | 77 | 2674 | 7 |
| 4 | 220kV GIS 出线间隔 | 65 | 2610 | 5 |
| 5 | 通信柜 | 80 | 2600 | 10 |

### 10.4 按 primitive 类型分布与设备归属

| Primitive | 实例数 | 占比 | 主要设备归属（Top 3） |
| --- | ---: | ---: | --- |
| Cylinder（圆柱） | 20421 | 44.15% | OTHERS(14561) + HGIS(7756) + SecondaryCabinet(4252) |
| Cuboid（长方体） | 12401 | 26.81% | OTHERS(9689) + SecondaryCabinet(7518) + FrameCapacitor(2244) |
| StretchedBody（拉伸体） | 10263 | 22.19% | OTHERS(5177) + HVSwitchCabinet(3564) + FrameCapacitor(2148) |
| PorcelainBushing（绝缘子） | 1506 | 3.26% | FrameCapacitor(1032) + OTHERS(1386) + GroundTransformer(108) |
| TruncatedCone（圆台） | 730 | 1.58% | OTHERS(505) + FrameCapacitor(288) + LightningArrester(162) |
| Ring（环） | 235 | 0.51% | OilImmersedTransformer(57) + HGIS(54) + ACIsolatingSwitch(54) |
| TerminalBlock（端子块） | 201 | 0.43% | OTHERS(78) + HGIS(45) + DryTypeReactor(36) |
| Sphere（球体） | 141 | 0.30% | OTHERS(114) + HGIS(87) + SecondaryCabinet(24) |
| ChannelSteel（槽钢） | 129 | 0.28% | FrameCapacitor(72) + OTHERS(72) + LightningArrester(36) |
| Table（平台） | 109 | 0.24% | OTHERS(101) + SecondaryCabinet(101) + HGIS(6) |
| CircularGasket（圆形垫片） | 80 | 0.17% | OTHERS(72) + LightningArrester(36) + FrameCapacitor(36) |
| RectangularFixedPlate | 18 | 0.04% | LightningArrester(18) — 100% 独占 |
| OffsetRectangularTable | 15 | 0.03% | OpenGroundingEquipment(15) + OTHERS(15) |
| RectangularRing | 1 | 0.00% | SecondaryCabinet(1) + OTHERS(1) |

**关键 primitive → 设备强映射**：

- `PorcelainBushing` → 框架式电容器（68.5% 集中于电容器组）
- `RectangularFixedPlate` → 避雷器（100% 独占，专用底板）
- `ChannelSteel` → 电容器 + 支柱绝缘子（支架型材）
- `OffsetRectangularTable` → 中性点成套装置 + 电流互感器（设备底座）

### 10.5 STL vs MOD 设备类型对比

| 对比维度 | STL（1803 文件 / 834874 三角面 / 39.95MB） | MOD（4179 文件 / 46250 Entity / 15.39MB） |
| --- | --- | --- |
| **设备属性** | 100% 渲染二次设备柜（SecondaryCabinet） | 渲染设备全谱系（一次设备 + 二次柜 + 框架电容 + 接地变等） |
| **主导 TYPE** | SecondaryCabinet 单一类型 | OTHERS + SecondaryCabinet + HGIS + FrameCapacitor + GroundTransformer |
| **主导 SYMBOLNAME** | 光纤配线柜、220kV线路保护测控柜、主变电能表柜 | 框架式电容器、10kV接地变、220kV GIS间隔、通信柜 |
| **CBM 覆盖** | 116 CBM（仅 F4System 4645 中的 2.5%） | 4179 CBM（100% F4System + 100% PARTINDEX） |
| **几何内容** | 三角网格（柜体外壳/面板/屏柜） | 14 种参数化 primitive（圆柱/长方体/拉伸体/绝缘子等） |
| **典型设备** | 通信柜、保护测控柜、电能表柜（二次弱电设备） | 电容器、接地变、GIS间隔、避雷器、隔离开关（一次强电设备） |

**核心结论**：

- **STL 渲染二次设备柜**：通信柜、保护测控柜、电能表柜等，几何内容是柜体外壳/面板的三角网格
- **MOD 渲染一次电气设备**：电容器组、接地变压器、GIS 间隔、避雷器、隔离开关等，几何内容是 14 种参数化 primitive
- MOD 与 STL **几乎不重叠**：MOD 主导设备类型与 STL 完全不同，二者分工清晰
- **渲染分工**：MOD 覆盖 4179 CBM（一次设备主体），STL 覆盖 116 CBM（二次柜细节）；MOD + STL 联合可覆盖变电样本全部 8539 CBM 节点

### 10.6 F4System vs PARTINDEX 的 MOD 差异

| entityName | MOD 数 | Entity 数 | CBM 数 | primitive 覆盖 |
| --- | ---: | ---: | ---: | --- |
| F4System | 4135 | 46250 | 4645 | 全部 14 种 primitive（含独占 RectangularFixedPlate 18 + 大部分 TerminalBlock 123） |
| PARTINDEX | 3894 | 32946 | 3894 | 前 4 类主导（Cylinder 14573 + Cuboid 10073 + StretchedBody 5897 + PorcelainBushing 1386） |

- **F4System** 是 MOD 渲染的"主要承载实体"（一次设备主导，含全部 14 种 primitive）
- **PARTINDEX** 多为设备级再聚合的几何副本，低样本 primitive 显著少于 F4System

### 10.7 浏览器实现影响（更新）

基于 §9 + §10 的设备类型分析结论，对 §7 浏览器实现建议做以下补充：

1. **变电工程渲染分工**：
   - MOD 渲染一次设备（电容器/GIS/接地变/避雷器等，4179 CBM，参数化 primitive）
   - STL 渲染二次柜细节（116 CBM，三角网格）
   - IFC 渲染建筑/结构（IFCFILE 与 MOD 完全无关联）
2. **线路工程渲染分工**：
   - MOD 渲染塔本体（TEXT_HNUM_COMMA_RECORD 文本格式族，详见 [11-line-mod-grammar.md](11-line-mod-grammar.md)）
   - STL 渲染金具（绝缘子/间隔棒/防振锤，181/82 文件）
3. **MOD 渲染入口**：按 primitive 类型分发到 Three.js 几何构造器（参考 [10-substation-mod-grammar.md](10-substation-mod-grammar.md) §6.4 已实现的强类型 schema）
4. **STL 渲染优先级**：
   - 变电：MVP 阶段可全部跳过（仅 116 CBM，占比 1.36%），优先加载 MOD 覆盖 100%
   - 线路：金具 STL 不可跳过（线路样本 STL-only 100%，STL 是唯一几何来源）

### 10.8 线路样本（demo-line / demo-line1）MOD 设备类型分析

> 本节与 §10.1-§10.6 的变电样本分析对称，回答 "线路 MOD 主要渲染什么设备"。
>
> - 脚本：[_generated/mod-device-type-survey.ps1](_generated/mod-device-type-survey.ps1)（已扩展支持三样本）
> - JSON 输出：[_generated/mod-device-type-survey-demo-line.json](_generated/mod-device-type-survey-demo-line.json) / [_generated/mod-device-type-survey-demo-line1.json](_generated/mod-device-type-survey-demo-line1.json)
> - 线路 MOD 4 类文本格式族 grammar 详见 [11-line-mod-grammar.md](11-line-mod-grammar.md)

#### 10.8.1 总体规模

| 指标 | demo-line | demo-line1 | demo-substation（对照） |
| --- | ---: | ---: | ---: |
| 工程类型 | GIMPKGT 线路（工程头标识 500kV） | GIMPKGT 线路（500kV） | GIMPKGS 变电 |
| MOD 文件总数 | 1807 | 508 | 4179 |
| MOD 总大小 | 50.72 MB | 20.06 MB | 15.39 MB |
| MOD kind 分布 | 4 类文本格式族 | 4 类文本格式族 | XML_WITH_ENTITIES 主导（98.95%） |
| XML Entity 总数 | 0（不适用） | 0（不适用） | 46250 |
| Primitive 总数 | 0（不适用） | 0（不适用） | 46250 |
| 含 MOD 引用的 CBM 节点 | 7402 | 1362 | 4179 |
| MOD 聚合引用数 | 8702（覆盖率 481.6%） | 1518（覆盖率 298.8%） | 8029（覆盖率 192.1%） |
| 分类命中率 | 100% | 100% | 100% |

**关键观察**：

- 线路 MOD 与变电 MOD **结构完全不同**：线路是 4 类文本格式族（无 XML Entity / primitive 概念），变电是统一 XML_WITH_ENTITIES（14 种 primitive 参数化几何）
- 线路 MOD 平均单文件规模更大（demo-line 28 KB / demo-line1 39 KB vs 变电 3.7 KB），因 TEXT_HNUM_COMMA_RECORD 单文件可达 2.3 MB（杆塔主体全量骨架）
- 线路 MOD 复用率更高（demo-line 481.6% / demo-line1 298.8%），因同一塔型的 TEXT_HNUM_COMMA_RECORD 被多 CBM 共享

#### 10.8.2 按 modKind 分布

| modKind | demo-line 文件数 | 占比 | demo-line1 文件数 | 占比 | 主要设备归属 |
| --- | ---: | ---: | ---: | ---: | --- |
| TEXT_SECTION_KV_RECORD | 1300 | 71.94% | 156 | 30.71% | Tower_Device 螺栓表（SYMBOL=BASE） |
| TEXT_POINT_LINE | 315 | 17.43% | 300 | 59.06% | CROSS 跨越点（SYMBOL=EQUIPMENT） |
| TEXT_KEY_VALUE | 161 | 8.91% | 34 | 6.69% | Tower_Device 基础参数(152/34) + WIRE 导线参数(9/0) |
| TEXT_HNUM_COMMA_RECORD | 31 | 1.72% | 18 | 3.54% | Tower_Device 杆塔主体骨架（SYMBOL=TOWER） |

**关键观察**：

- 4 种 kind 的设备归属 100% 稳定（无跨 kind 混用），与 [11-line-mod-grammar.md](11-line-mod-grammar.md) §1.4 核心判断一致
- 两样本 kind 分布比例不同：demo-line1 跨越点占比更高（59.1% vs 17.4%）；两者工程头均标识 500kV，因此该差异只能归因于样本工程本身，不能据此归因于电压等级
- TEXT_HNUM_COMMA_RECORD 文件数最少（31/18），但单文件规模最大（杆塔主体骨架，含 P/R/G 记录可达 4 万行）

#### 10.8.3 modKind → 设备类型对应关系（100% 稳定）

| modKind | SYMBOLNAME | entityName | 设备语义 | CBM 数（demo-line / demo-line1） |
| --- | --- | --- | --- | ---: |
| TEXT_HNUM_COMMA_RECORD | TOWER | Tower_Device | 杆塔主体（角钢/钢管骨架） | 327 / 40 |
| TEXT_KEY_VALUE（WIRE 子签名） | WIRE | WIRE | 导线参数（型号/截面/弧垂） | 5460 / 1013 |
| TEXT_KEY_VALUE（BASE 子签名） | BASE | Tower_Device | 杆塔基础参数（H1-H4/d/e1/e2） | 1300 / 157 |
| TEXT_POINT_LINE | EQUIPMENT | CROSS | 跨越点（经纬度点线表） | 315 / 152 |
| TEXT_SECTION_KV_RECORD | BASE | Tower_Device | 螺栓表（BoltNum/BoltN 记录） | 1300 / 156 |

**关键结论**：

- **TEXT_KEY_VALUE 按 key set 签名稳定二分**（[11-line-mod-grammar.md](11-line-mod-grammar.md) §5.4）：152+34 文件为 Tower_Device 基础参数（小写 key：type/H1-H4/d/e1/e2），9+0 文件为 WIRE 导线参数（大写 key：TYPE/SECTIONALAREA/...）
- **每类 kind 与 entityName 100% 单射对应**：无 kind 跨 entityName 复用，无 entityName 跨 kind 混合（除 TEXT_KEY_VALUE 二分外）
- **SYMBOLNAME 与 entityName 同义**：TOWER↔Tower_Device、WIRE↔WIRE、EQUIPMENT↔CROSS、BASE↔Tower_Device（基础/螺栓表子集）

#### 10.8.4 按 entityName 分布

| entityName | demo-line MOD 数 | demo-line CBM 数 | demo-line1 MOD 数 | demo-line1 CBM 数 | 主要 modKind |
| --- | ---: | ---: | ---: | ---: | --- |
| WIRE | 5460 | 5460 | 1013 | 1013 | TEXT_KEY_VALUE（导线参数） |
| Tower_Device | 2927 | 4309 | 353 | 782 | TEXT_HNUM + SECTION_KV + KEY_VALUE(BASE) |
| CROSS | 315 | 315 | 152 | 152 | TEXT_POINT_LINE |
| Wire_Device | 0 | 11773 | 0 | 1953 | （无 MOD，100% STL） |
| F4System | 0 | 5861 | 0 | 1072 | （无 MOD，仅结构节点） |

**关键观察**：

- **Wire_Device 100% 无 MOD**：与 §9.2 STL 分析对称，Wire_Device（金具）100% 由 STL 渲染，MOD 完全不覆盖
- **F4System 100% 无 MOD**：F4System 在线路工程中是结构层节点（GROUP/SECTION 父节点），不承载设备几何
- **WIRE 100% 由 TEXT_KEY_VALUE 渲染**：导线参数（型号/截面/温度/比载/张力）以 KV 形式存储，无几何 primitive
- **Tower_Device 是 MOD 主承载**：3 种 kind 共同渲染（主体骨架 + 螺栓表 + 基础参数），与 §9.2 STL 分支（62-75% 用 STL 整体几何）形成互补

#### 10.8.5 线路样本关键结论

- **MOD 100% 渲染"塔 + 线 + 跨越点"**：Tower_Device（杆塔主体/螺栓/基础）+ WIRE（导线参数）+ CROSS（跨越点点线表），不渲染金具（金具由 STL 承载）
- **4 种文本格式族与设备类型 100% 单射对应**：无歧义，parser 可按 modKind 直接分发到对应 schema（[11-line-mod-grammar.md](11-line-mod-grammar.md) §7.2 已确认可强类型化）
- **TEXT_HNUM_COMMA_RECORD 是杆塔主体几何的唯一来源**：31+18 文件，承载 P（节点坐标）+ R（杆件）+ G（挂点）记录，parser 草案见 [11-line-mod-grammar.md](11-line-mod-grammar.md) §7.3
- **TEXT_POINT_LINE 是跨越点的唯一来源**：绝对坐标点线表（POINT 5 token + LINE 2 token），用于地图叠加显示跨越对象
- **TEXT_KEY_VALUE 的二分性**：Tower_Device 基础参数（小写 key）与 WIRE 导线参数（大写 key）按 key 大小写即可稳定分离

### 10.9 三样本对比：MOD 设备类型差异

| 对比维度 | demo-line（工程头标识 500kV 线路） | demo-line1（500kV 线路） | demo-substation（变电） |
| --- | --- | --- | --- |
| **MOD 渲染对象** | 杆塔主体 + 导线 + 跨越点 | 杆塔主体 + 导线 + 跨越点 | 一次电气设备（电容器/GIS/接地变/避雷器等） |
| **MOD 格式** | 4 类文本格式族 | 4 类文本格式族 | XML_WITH_ENTITIES（XML primitive） |
| **MOD kind 分布** | SECTION_KV 71.9% + POINT_LINE 17.4% + KV 8.9% + HNUM 1.7% | POINT_LINE 59.1% + SECTION_KV 30.7% + KV 6.7% + HNUM 3.5% | XML_WITH_ENTITIES 98.95% + XML_EMPTY_DEVICE 1.05% |
| **几何表达方式** | 文本记录（P/R/G 坐标 + Bolt 表 + KV 参数） | 文本记录（同左） | 14 种参数化 primitive（Cylinder/Cuboid/...） |
| **主导 entityName** | WIRE + Tower_Device + CROSS | WIRE + Tower_Device + CROSS | F4System + PARTINDEX |
| **主导 SYMBOLNAME** | BASE + TOWER + WIRE + EQUIPMENT | BASE + TOWER + WIRE + EQUIPMENT | 框架式电容器/10kV 接地变/220kV GIS 间隔 |
| **CBM 覆盖率** | 26.6%（7402/27718） | 27.4%（1362/4972） | 100%（4179/4179） |
| **平均单文件大小** | 28 KB | 39 KB | 3.7 KB |
| **复用率** | 481.6% | 298.8% | 192.1% |
| **primitive 概念** | 不适用 | 不适用 | 14 种 primitive（46250 实例） |

**核心差异**：

- **设备类型完全不同**：线路 MOD 渲染"杆塔 + 导线 + 跨越点"（输电线路本体），变电 MOD 渲染"一次电气设备"（电容器/GIS/变压器等）
- **格式体系完全不同**：线路是 4 类文本格式族（无 primitive），变电是 XML 参数化 primitive（14 种）
- **parser 路径完全不同**：线路按 modKind 分发到 4 个文本 parser（[11-line-mod-grammar.md](11-line-mod-grammar.md) §7.3），变电按 primitiveType 分发到 14 个 Three.js 几何构造器（[10-substation-mod-grammar.md](10-substation-mod-grammar.md) §6.4）
- **共同点**：分类命中率 100%，4 类 kind / 14 种 primitive 都与设备类型稳定单射对应

### 10.10 浏览器实现影响（最终更新）

基于 §10.1-§10.9 三样本完整分析，对 §7 浏览器实现建议做最终补充：

1. **MOD parser 双轨制**（变电 + 线路完全独立）：
   - 变电：XML_WITH_ENTITIES → 14 种 primitive 强类型 schema（[10-substation-mod-grammar.md](10-substation-mod-grammar.md) §6.4）
   - 线路：4 类文本格式族 → 4 个文本 parser（[11-line-mod-grammar.md](11-line-mod-grammar.md) §7.3）
2. **线路工程渲染分工（最终）**：
   - TEXT_HNUM_COMMA_RECORD → 渲染杆塔主体骨架（P 节点 + R 杆件 + G 挂点，Three.js LineSegments + Points）
   - TEXT_POINT_LINE → 渲染跨越点（地图叠加，CROSS 设备）
   - TEXT_SECTION_KV_RECORD → 属性面板展示螺栓表（BoltNum + BoltN 记录）
   - TEXT_KEY_VALUE → 属性面板展示塔基础参数 + 导线参数（按 key 大小写二分）
   - STL → 渲染金具（绝缘子/间隔棒/防振锤，Wire_Device 100% STL-only）
3. **变电工程渲染分工（最终）**：
   - MOD → 渲染一次设备（电容器/GIS/接地变/避雷器，4179 CBM，14 种 primitive）
   - STL → 渲染二次柜细节（116 CBM，三角网格，MVP 可跳过）
   - IFC → 渲染建筑/结构（与 MOD 完全无关联）
4. **MOD 与 STL 的工程类型对称性**：
   - 线路：MOD 渲染塔本体（参数化骨架） + STL 渲染金具（三角网格）
   - 变电：MOD 渲染一次设备（参数化 primitive） + STL 渲染二次柜（三角网格）
   - 两类工程中 MOD 与 STL 都形成"参数化 + 三角网格"的互补分工
