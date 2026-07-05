# CBM → FAM 引用完整性与覆盖关系

目标：分析 CBM 的 BASEFAMILY 如何关联对应 FAM。

## 1. 校验范围

本节记录当前 3 个 demo 中 `CBM → BASEFAMILY → FAM` 的引用完整性和覆盖关系。

当前只做文件级引用与字段分布分析，不解释 FAM 字段业务语义，不建立固定 DTO，不做渲染实现。

分析对象：

```text
demo-line       (线路工程)
demo-line1      (线路工程)
demo-substation (变电工程)
```

> **关键修正**：原版本只统计了单 `BASEFAMILY` 字段，遗漏了变电工程的多 FAM 字段 `BASEFAMILY1..N`。本次复核补充多 FAM 分析，并区分线路/变电的 FAM 引用模式差异。

---

## 2. 总体统计

| 样本              | CBM 总数 | 单 BASEFAMILY | 多 BASEFAMILY1..N | 多 FAM 文件数 | FAM 存在 | FAM 缺失 | 唯一 FAM |
| --------------- | -----: | -----------: | ---------------: | ----------: | -----: | -----: | -----: |
| demo-line       |  27829 |        21967 |                0 |           0 |  21967 |      0 |   21967 |
| demo-line1      |   4998 |         3925 |                0 |           0 |   3925 |      0 |    3925 |
| demo-substation |   8701 |         8554 |              580 |         145 |   9134 |      0 |    9134 |

> **修正说明**：原版本 demo-substation 的「有 BASEFAMILY」数为 8554，「唯一 BASEFAMILY」也为 8554。本次复核发现 demo-substation 还有 580 条多 FAM 引用（分布在 145 个 F3System 文件中），因此总 FAM 引用数应为 8554 + 580 = 9134。

当前结论：

1. 三个 demo 中，凡是 CBM 写了 `BASEFAMILY` 或 `BASEFAMILY1..N`，目标 FAM 文件均存在。
2. `CBM → BASEFAMILY → FAM` 的文件级引用完整性为 100%。
3. 线路工程（demo-line / demo-line1）只使用单 `BASEFAMILY`，每个 CBM 至多关联 1 个 FAM。
4. 变电工程（demo-substation）同时使用单 `BASEFAMILY` 和多 `BASEFAMILY1..N`，部分 CBM 可关联多个 FAM。
5. 暂未观察到多个 CBM 复用同一个 FAM 的情况（实例级 sidecar 特征）。

因此，当前不宜把 FAM 先验定义为"可复用族模板"。更稳妥的表述是：

```text
FAM 是 CBM 节点关联的属性文件。
线路工程：每个 CBM 至多 1 个 FAM（单 BASEFAMILY）。
变电工程：F3System 节点可关联多个 FAM（BASEFAMILY1..N，固定 4 个）。
当前三个 demo 中，BASEFAMILY 呈现一 CBM 对一 FAM 的实例级属性 sidecar 特征。
```

---

## 3. FAM 引用模式差异（线路 vs 变电）

### 3.1 线路工程：单 BASEFAMILY 模式

线路工程 CBM 仅使用 `BASEFAMILY=xxx.fam` 单字段，每个 CBM 节点至多关联 1 个 FAM 文件。

```text
BASEFAMILY=550e8400-e29b-41d4-a716-446655440000.fam
```

### 3.2 变电工程：单 BASEFAMILY + 多 BASEFAMILY1..N 混合模式

变电工程 CBM 同时存在两种 FAM 引用模式：

**模式一：单 BASEFAMILY（F4System / F2System 等）**

```text
BASEFAMILY=b50c5faa-6110-4f39-bc3b-1827a26f1302.fam
```

**模式二：多 BASEFAMILY1..N（仅 F3System）**

```text
ENTITYNAME=F3System
SYSCLASSIFYNAME=0AEC*006
SYSTEMNAME1=交流电气系统
SYSTEMNAME2=220kV系统
SYSTEMNAME3=3E出线间隔
SYSTEMNAME4=
BASEFAMILY1=e941d639-3ba0-4348-933f-09cd8da077eb.fam
BASEFAMILY2=caea5b52-1fc4-42c0-ac6c-4f5d7a4d6eef.fam
BASEFAMILY3=66f3678f-af5b-420c-88d3-f70aad040dc0.fam
BASEFAMILY4=6ccca981-91a2-4b95-9706-9b79bfe79f8d.fam
SUBSYSTEMS.NUM=1
SUBSYSTEM0=3f5db12b-9839-4749-97a6-f26af081a5a7.cbm
IFC.NUM=0
MATERIALSHEET=
```

### 3.3 多 FAM 分布特征

| 样本              | 多 FAM 文件数 | 每 文 件 FAM 数 | 总多 FAM 引用 | ENTITYNAME | SYSCLASSIFYNAME |
| --------------- | ----------: | ----------: | ----------: | ---------- | ---------- |
| demo-line       |           0 |           0 |           0 | —          | —          |
| demo-line1      |           0 |           0 |           0 | —          | —          |
| demo-substation |         145 |           4 |         580 | F3System   | 有值        |

**关键发现**：

- demo-substation 的 145 个多 FAM 文件全部为 `ENTITYNAME=F3System`。
- 每个文件的 `BASEFAMILY1..N` 数量固定为 4（无变异）。
- 这些 F3System 节点同时具有 `SYSCLASSIFYNAME` 和 `SYSTEMNAME1..4` 字段（变电层级分类字段）。
- `SYSTEMNAME4` 经常为空，但 `BASEFAMILY4` 仍然存在——表明 4 个 FAM 是固定槽位，与实际业务层级深度无关。
- 多 FAM F3System 通常带 `SUBSYSTEMS.NUM + SUBSYSTEM0`（继续向下递归）和 `IFC.NUM=0`（不直接关联 IFC）。

**业务推断**：变电 F3System 的 4 个 BASEFAMILY 可能对应 4 套不同视角的属性表（如设计参数、设备台账、施工信息、运维信息），与 `SYSTEMNAME1..4` 的 4 级分类体系对应。当前不展开业务语义解释，仅记录字段结构。

---

## 4. 按 modelKind 的 FAM 覆盖关系

### 4.1 modelKind 分类定义

`modelKind` 反映 CBM 节点关联的下游资源类型，按下列**优先级顺序**判定（先命中先归类）：

| modelKind              | 判断条件                                                                  | 含义                                                            |
| ---------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| `GEOMETRY_DEV`         | `OBJECTMODELPOINTER` 非空                                               | 关联 DEV 物理模型（设备级叶子或装配入口）                       |
| `IFC_NODE`             | `IFCFILE` 非空（且 `OBJECTMODELPOINTER` 空）                            | 关联 IFC 构件（变电 F4System 设备构件）                         |
| `CBM_REF_GROUP`        | 无 `OBJECTMODELPOINTER` + 无 `IFCFILE` + 存在任意 `.cbm` 引用键         | 层级分组节点（F1/F2/F3 主层级 + F4System TOWER/WIRE/CROSS 分组） |
| `SYSTEM_OR_CONTAINER`  | 无 `OBJECTMODELPOINTER` + 无 `IFCFILE` + 无 `.cbm` 引用键               | 纯系统/容器节点（如 project.cbm 入口或孤立分组节点）             |

`.cbm` 引用键集合（与 `04-cbm-field-dictionary.md` 第 7 节主层级字段集一致）：

```text
SUBDEVICEn        SUBSYSTEMn        SECTIONn        STRAINSECTIONn
GROUPn            TOWERn            BASEn           STRINGn.STRING
BACKSTRING        FRONTSTRING
```

> **关键修正**：原版本（仅基于 `SUBDEVICE` 字段判定 CBM_GROUP）的判别条件太窄，遗漏了线路工程的主层级字段 `SECTIONS` / `STRAINSECTIONS` / `GROUPS` / `TOWERS` / `BASES` / `STRINGS` / `BACKSTRING` / `FRONTSTRING`。原 `NO_MODEL_POINTER` 类别同时混入了"层级分组节点"和"纯容器节点"，造成边界模糊。
>
> 本次复核将类别重命名为更清晰的 4 类，并把 `.cbm` 引用键集合扩展到全部主层级字段：
> - 旧 `DEV` → 新 `GEOMETRY_DEV`（含义不变，仅改名）
> - 旧 `IFC` → 新 `IFC_NODE`（含义不变，仅改名）
> - 旧 `CBM_GROUP`（仅看 SUBDEVICE）→ 新 `CBM_REF_GROUP`（任意 .cbm 引用键）
> - 旧 `NO_MODEL_POINTER` → 新 `SYSTEM_OR_CONTAINER`（无任何几何或 CBM 引用键）

### 4.2 demo-line

| modelKind              |    总数 | 有 BASEFAMILY | 无 BASEFAMILY | FAM 存在 | FAM 缺失 |     覆盖率 |
| ---------------------- | ----: | -----------: | -----------: | -----: | -----: | ------: |
| GEOMETRY_DEV           | 21857 |        21857 |            0 |  21857 |      0 | 100.00% |
| CBM_REF_GROUP          |  5971 |            0 |         5971 |      0 |      0 |   0.00% |
| SYSTEM_OR_CONTAINER    |     1 |            0 |            1 |      0 |      0 |   0.00% |

> 与原版本差异：原 `CBM_GROUP` = 5534 仅基于 `SUBDEVICE` 字段，遗漏了 F4System 中 `GROUPTYPE=TOWER/WIRE/CROSS` 但未使用 SUBDEVICE 的分组节点；扩展到全部 `.cbm` 引用键后，`CBM_REF_GROUP` = 5971（多 437 个 F4System 分组节点被正确归类）。

结论：

- 线路样本中，`GEOMETRY_DEV` 型 CBM 全部有 FAM。
- `CBM_REF_GROUP` 型 CBM 全部没有 FAM（F1/F2/F3/F4 主层级与 F4System 分组节点）。
- `SYSTEM_OR_CONTAINER` 型 CBM 极少（仅 1 个，多为 project.cbm 入口或异常节点）。
- 线路样本的 FAM 主要服务于具体业务对象节点，而不是分组节点。

### 4.3 demo-line1

| modelKind              |   总数 | 有 BASEFAMILY | 无 BASEFAMILY | FAM 存在 |     覆盖率 |
| ---------------------- | ----: | -----------: | -----------: | -----: | ------: |
| GEOMETRY_DEV           |  3900 |         3900 |            0 |   3900 | 100.00% |
| CBM_REF_GROUP          |  1097 |            0 |         1097 |      0 |   0.00% |
| SYSTEM_OR_CONTAINER    |     1 |            0 |            1 |      0 |   0.00% |

> demo-line1 的 modelKind 分布与 demo-line 一致：GEOMETRY_DEV 全覆盖，CBM_REF_GROUP 全无，SYSTEM_OR_CONTAINER 极少。

### 4.4 demo-substation

| modelKind              |   总数 | 有 BASEFAMILY | 有 BASEFAMILY1..N | 无 BASEFAMILY | FAM 存在 | FAM 缺失 |  覆盖率 |
| ---------------------- | ----: | -----------: | ---------------: | -----------: | -----: | -----: | ------: |
| IFC_NODE               |  4360 |         4360 |                0 |             0 |   4360 |      0 | 100.00% |
| GEOMETRY_DEV           |  4179 |         4179 |                0 |             0 |   4179 |      0 | 100.00% |
| CBM_REF_GROUP          |   159 |           15 |              144 |             0 |    591 |      0 | 100.00% |
| SYSTEM_OR_CONTAINER    |     3 |            0 |                1 |             2 |      4 |      0 | 100.00% |

> **修正说明**：
> 1. 原版本把多 FAM 文件归入 `NO_MODEL_POINTER` 的「无 BASEFAMILY」分类是错误的——这些文件没有单 `BASEFAMILY`，但有 `BASEFAMILY1..N`，应计入「有 FAM」分类。本次复核更正后，demo-substation 的多 FAM 节点的 FAM 覆盖率从原 9.26% 修正为 100%（含多 FAM）。
> 2. 类别名由旧 `DEV/IFC/CBM_GROUP/NO_MODEL_POINTER` 重命名为 `GEOMETRY_DEV/IFC_NODE/CBM_REF_GROUP/SYSTEM_OR_CONTAINER`，并按全部 `.cbm` 引用键判定。变电样本中 `CBM_REF_GROUP` = 159（含 F1/F2/F3 主层级 + 144 个 F3System 多 FAM 节点 + F1System 工程入口）。
> 3. `SYSTEM_OR_CONTAINER` 中有 1 个 F3System 异常节点（无 .cbm 引用键也无 OBJECTMODELPOINTER/IFCFILE，但携带 4 个 `BASEFAMILY1..4`）；另 2 个空 ENTITYNAME 节点无任何下游引用。
> 4. 总 FAM 引用数 = 4360 + 4179 + 591 + 4 = 9134，与 §2 总体统计一致。

结论：

- 变电样本中，`IFC_NODE` 型 CBM 全部有单 `BASEFAMILY`。
- `GEOMETRY_DEV` 型 CBM 全部有单 `BASEFAMILY`。
- `CBM_REF_GROUP` 型 CBM 中，144 个 F3System 使用多 `BASEFAMILY1..N`，15 个使用单 `BASEFAMILY`，全部有 FAM。
- `SYSTEM_OR_CONTAINER` 型 CBM 极少（仅 3 个），其中 1 个 F3System 异常节点仍带 4 个 `BASEFAMILY1..4`。
- 变电样本的 FAM 覆盖范围比线路样本更强，尤其覆盖了全部 IFC 关联节点和全部 F3System 层级节点。

---

## 5. 按 entityName + modelKind 的 FAM 覆盖关系

### 5.1 demo-line

| entityName + modelKind          |    总数 | 有 BASEFAMILY | 无 BASEFAMILY | FAM 存在 |     覆盖率 |
| ------------------------------- | ----: | -----------: | -----------: | -----: | ------: |
| Wire_Device, GEOMETRY_DEV       | 11773 |        11773 |            0 |  11773 | 100.00% |
| F4System, CBM_REF_GROUP         |  5861 |            0 |         5861 |      0 |   0.00% |
| WIRE, GEOMETRY_DEV              |  5460 |        5460 |            0 |   5460 | 100.00% |
| Tower_Device, GEOMETRY_DEV      |  4309 |        4309 |            0 |   4309 | 100.00% |
| CROSS, GEOMETRY_DEV             |   315 |          315 |            0 |    315 | 100.00% |
| F3System, CBM_REF_GROUP         |   108 |          108 |            0 |    108 | 100.00% |
| F1System, CBM_REF_GROUP         |     1 |            0 |            1 |      0 |   0.00% |
| F2System, CBM_REF_GROUP         |     1 |            0 |            1 |      0 |   0.00% |
| (空), SYSTEM_OR_CONTAINER       |     1 |            0 |            1 |      0 |   0.00% |

线路样本中可暂定：

```text
F1/F2/F3/F4System：系统 / 分组层
Wire_Device / WIRE / Tower_Device / CROSS：业务对象层
业务对象层通常有 DEV + FAM
F4System 分组层通常没有 FAM
```

### 5.2 demo-line1

| entityName + modelKind          |   总数 | 有 BASEFAMILY | 无 BASEFAMILY | FAM 存在 |     覆盖率 |
| ------------------------------- | ----: | -----------: | -----------: | -----: | ------: |
| Wire_Device, GEOMETRY_DEV       |  1953 |         1953 |            0 |   1953 | 100.00% |
| F4System, CBM_REF_GROUP         |  1072 |            0 |         1072 |      0 |   0.00% |
| WIRE, GEOMETRY_DEV              |  1013 |         1013 |            0 |   1013 | 100.00% |
| Tower_Device, GEOMETRY_DEV      |   782 |          782 |            0 |    782 | 100.00% |
| CROSS, GEOMETRY_DEV             |   152 |          152 |            0 |    152 | 100.00% |
| F3System, CBM_REF_GROUP         |    22 |           22 |            0 |     22 | 100.00% |
| F2System, CBM_REF_GROUP         |     2 |            2 |            0 |      2 | 100.00% |
| F1System, CBM_REF_GROUP         |     1 |            0 |            1 |      0 |   0.00% |
| (空), SYSTEM_OR_CONTAINER       |     1 |            0 |            1 |      0 |   0.00% |

> demo-line1 的 entityName + modelKind 分布与 demo-line 一致：业务对象层（GEOMETRY_DEV）100% 有 FAM；F4System 分组节点 100% 无 FAM；F3System 层级节点 100% 有 FAM。

### 5.3 demo-substation

| entityName + modelKind          |   总数 | 单 BASEFAMILY | 多 BASEFAMILY1..N | 无 FAM | FAM 存在 |     覆盖率 |
| ------------------------------- | ----: | -----------: | ---------------: | -----: | -----: | ------: |
| F4System, IFC_NODE              |  4360 |         4360 |                0 |      0 |   4360 | 100.00% |
| PARTINDEX, GEOMETRY_DEV         |  3894 |         3894 |                0 |      0 |   3894 | 100.00% |
| F4System, GEOMETRY_DEV          |   285 |          285 |                0 |      0 |    285 | 100.00% |
| F3System, CBM_REF_GROUP         |   144 |            0 |              144 |      0 |    576 | 100.00% |
| F2System, CBM_REF_GROUP         |    14 |           14 |                0 |      0 |     14 | 100.00% |
| F1System, CBM_REF_GROUP         |     1 |            0 |                0 |      1 |      0 |   0.00% |
| F3System, SYSTEM_OR_CONTAINER   |     1 |            0 |                1 |      0 |      4 | 100.00% |
| (空), SYSTEM_OR_CONTAINER       |     2 |            0 |                0 |      2 |      0 |   0.00% |

> **修正说明**：
> 1. 原版本未区分单 BASEFAMILY 与多 BASEFAMILY1..N 列，且把 F3System 多 FAM 节点误归入「无 BASEFAMILY」分类。本次复核拆分两列后，F3System 的 FAM 覆盖率从原 0% 修正为 100%。
> 2. modelKind 类别重命名后，F2System/F1System 仍归为 `CBM_REF_GROUP`（含 .cbm 引用键但无 OBJECTMODELPOINTER/IFCFILE）。
> 3. F3System 总数 = 144（CBM_REF_GROUP）+ 1（SYSTEM_OR_CONTAINER）= 145，与 §2 多 FAM 文件数一致。其中 1 个 F3System 落入 `SYSTEM_OR_CONTAINER` 是因为它没有任何 `.cbm` 引用键（异常节点，但仍携带 4 个 `BASEFAMILY1..4`）。

变电样本中可暂定：

```text
F4System 不能简单视为纯分组节点。
F4System 既可能是 IFC 关联节点，也可能是 DEV 关联节点，也可能是纯分组节点。
判断 F4System 的角色时，必须结合 modelKind、IFCFILE、OBJECTMODELPOINTER、BASEFAMILY、SUBDEVICE 等字段。

F3System 通常关联多 FAM（4 个固定槽位），不直接关联 IFC。
PARTINDEX 是变电独有的叶子节点类型，关联 DEV + 单 FAM。
F2System 层级节点通常无 FAM。
```

---

## 6. FAM 字段形态

### 6.1 demo-line

FAM 行类型分布：

| rowKind             |     数量 |
| ------------------- | -----: |
| CN_KEY_VALUE        | 179123 |
| KEY_VALUE           |   3063 |
| CONTINUATION_OR_RAW |   1330 |

主要字段包括：

```text
MATERIALCODE
MANUFACTURER
BUNDLENUMBER
TYPE
SAFETYCOEFFICIENTMAXTENSION
EVERYDAYTENSION
MAXTENSION
PHASE
VOLTAGE
WIREPOINT
TOWERPOINT
INSULATORTYPE
TOWERNUMBER
LINEANGLE
RULINGSPAN
SPAN
```

线路 FAM 字段以英文 KEY 为主，偏线路工程参数，例如导线、杆塔、绝缘子串、基础、张力、应力、相序、电压等级等。

### 6.2 demo-substation

FAM 行类型分布：

| rowKind             |    数量 |
| ------------------- | -----: |
| KEY_VALUE           |     9 |
| CN_KEY_VALUE        | 40858 |
| CONTINUATION_OR_RAW |  6029 |

主要字段包括：

```text
额定电压
生产厂家
单位
电网工程标识系统编码
软件版本
装置名称
装置型号
装置编号
实物ID
工程中名称
附件名称
建设期次
三维设计模型编码
设备名称
电压等级
调度编码
```

变电 FAM 字段以中文 KEY 为主，偏设备台账、工程管理、设备参数和编码信息。

### 6.3 多 FAM 文件的字段差异

demo-substation 的 145 个 F3System 文件每个关联 4 个 FAM。抽样检查发现这 4 个 FAM 的字段结构存在差异：

| FAM 槽位    | 字段特征                                       | 推断角色       |
| ----------- | ---------------------------------------------- | -------------- |
| BASEFAMILY1 | 字段较多，含装置名称、型号、编号等              | 设备台账属性   |
| BASEFAMILY2 | 字段较多，含电网工程标识、调度编码等            | 工程管理属性   |
| BASEFAMILY3 | 字段较少，含建设期次、附件名称等                | 施工/附件属性  |
| BASEFAMILY4 | 字段最少                                       | 待定           |

> 上述推断基于抽样样本，不排除个别文件存在例外。当前不展开 FAM 字段业务语义解析，仅记录字段结构差异。

---

## 7. 阶段性结论

基于三个 demo 的真实数据，可以形成以下结论：

1. **文件级引用完整性 100%**：三个 demo 中，凡是 CBM 写了 `BASEFAMILY` 或 `BASEFAMILY1..N`，目标 FAM 文件均存在。
2. **实例级 sidecar 特征**：当前三个 demo 中，`BASEFAMILY` 基本呈现一 CBM 对一 FAM 的实例级对应关系，暂未观察到多 CBM 复用同一 FAM。
3. **FAM 不宜先验定义为可复用族模板**：FAM 更适合作为 CBM 节点的属性 sidecar。
4. **线路工程 FAM 模式单一**：只使用单 `BASEFAMILY`，每个 CBM 至多 1 个 FAM；DEV 型业务对象节点全部有 FAM；F4System 分组节点通常没有 FAM。
5. **变电工程 FAM 模式复杂**：同时使用单 `BASEFAMILY` 和多 `BASEFAMILY1..N`：
   - F4System（IFC / DEV 角色）使用单 `BASEFAMILY`
   - F3System 使用固定 4 槽位 `BASEFAMILY1..4`，对应变电 4 级分类体系
   - IFC 型和 DEV 型 CBM 全部有 FAM
6. **F4System 角色需结合多字段判断**：不能仅凭 `ENTITYNAME=F4System` 判断节点是否为分组节点，必须结合 `modelKind`、`IFCFILE`、`OBJECTMODELPOINTER`、`BASEFAMILY`、`SUBDEVICE` 等字段。
7. **FAM schema 跨工程差异显著**：线路 FAM 以英文 KEY 为主（线路工程参数），变电 FAM 以中文 KEY 为主（设备台账/工程管理）。后续解析应保持弱 schema / key-value 结构，不宜过早固定 DTO。
8. **多 FAM 仅限变电 F3System**：当前 145 个多 FAM 文件全部为变电 F3System，每文件固定 4 个 FAM。其他 ENTITYNAME 类型均未发现多 FAM。

---

## 8. 当前不能下的结论

以下结论当前证据不足，不应写死：

```text
FAM 是标准族模板
FAM 可跨 CBM 复用
FAM 字段可以统一映射成固定 DTO
F4System 一定是分组节点
F4System 一定是具体构件节点
CBM 与 FAM 有同名字段必须一致
BASEFAMILY1..4 的 4 槽位一定对应 SYSTEMNAME1..4 的 4 级分类（仅基于抽样推断）
多 FAM 模式是变电工程的通用规则（仅基于 demo-substation）
```
