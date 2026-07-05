# STL 静态角色与 MOD 关系分析

> 本文档回答 Round 8 的 6 个关键问题：STL 是 ASCII 还是 binary、是否被 PHM 引用、对应哪些 CBM entityName、与 MOD 的关系（互斥 / 并列 / fallback）、变电中 XML MOD 与 STL 是否服务不同设备、线路中 STL 是否主要服务特殊构件。
>
> 数据来源：对 demo-line / demo-line1 / demo-substation 三样本的全量扫描（无抽样）。分析脚本见文末附录 A。

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

### 7.5 与既有约束的关系

- 项目硬约束："MVP 不实现悬链线、3D 线路、MOD 解析"
- 本轮仅形成"加载策略建议"，**不进入 STL 渲染实现**
- Wire_Device STL 加载属于待评估项，需在 M5+ 阶段决策
- 变电 STL 加载属于可选补齐项，MVP 阶段可全部跳过

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
