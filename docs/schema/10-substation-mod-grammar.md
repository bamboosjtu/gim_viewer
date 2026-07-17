# 变电 XML Primitive 字段值范围分析

> 本文档基于 `demo-substation` 样本，对变电工程 MOD 文件中 XML Entity 下的 14 种 primitive 类型逐一梳理字段覆盖率与数值范围，回答 parser 草案应当采用强类型还是弱 schema 的关键问题。

> **2026-07-17 复核**：重新扫描得到 `4179 MOD / 4135 XML_WITH_ENTITIES / 44 XML_EMPTY_DEVICE / 46250 Entity`，14 类 primitive 数量与本文一致。样本统计仍有效；§8 的实现状态已按当前代码更新。
>
> 本报告不进入几何渲染实现，也不解释各 primitive 的几何拓扑含义。所有分析脚本集中放在文末附录 A。

## 1. 分析目标与范围

### 1.1 背景

[08-mod-static-survey.md](08-mod-static-survey.md) 已经确认变电 MOD 内部存在 XML 格式族，并在 Entity 节点下挂载 primitive 子节点。本文研究启动时浏览器只渲染 IFC、未渲染 MOD/STL，因此先梳理每种 primitive 的字段集合与字段类型。该背景是历史基线；当前实现状态见 §8。

### 1.2 目标

回答以下问题，作为 parser 草案的设计输入：

```text
各 primitive 的字段集合是否稳定？
字段值是数值还是字符串？是否可能出现 0 或负值？
StretchedBody.Array 是什么编码？
StretchedBody.Normal 是几个数？长度是否恒定？
Color 是单值还是多通道？范围是否统一在 0-255？
单位是否统一（毫米 / 弧度 / 度）？
能否为每种 primitive 定义强类型 type Cylinder = { R: number, H: number }？
还是必须保留弱 schema type Primitive = { name: string, attrs: Record<string, string> }？
```

### 1.3 分析对象

```text
demo-substation
  MOD 文件总数:     4179
  XML Entity 总数:  46250
  primitive 类型:   14 种
  数据来源:         全量扫描，无抽样
```

### 1.4 核心判断

```text
1. 字段覆盖率：12 种 primitive 字段稳定（100% 覆盖），仅 ChannelSteel 有可选字段（44.19%）。
2. 数值字段无负值；零值仅出现在 OffsetRectangularTable.XOFF/YOFF 和 RectangularFixedPlate.MH。
3. StretchedBody.Array = 分号分隔的 "x,y,z" 点序列，3-46 点，需专门解析器。
4. StretchedBody.Normal = 3 浮点数，向量长度恒为 304.8（疑似单位换算因子，非单位向量）。
5. Color 节点使用 R/G/B/A 4 个独立属性，全部落在 0-255（A 实际取 40 或 100）。
6. CircularGasket.Rad 与 Ring.Rad 范围为 π/2 ~ 2π，确认为弧度制。
7. 单位不统一：长度字段推测为毫米，角度字段为弧度，N/CN/RN 为整数计数。

结论：12 种主流 primitive（覆盖 46186/46250 = 99.86%）可使用强类型；
      2 种低样本 primitive（RectangularFixedPlate / OffsetRectangularTable）
      字段值高度常量化，可暂保留弱 schema 作为 fallback。
```

---

## 2. Primitive 类型与字段分布

### 2.1 类型分布总表

| Primitive | 实例数 | 占比 | 字段数 | 字段覆盖率 |
| ---------- | -----: | ---: | -----: | --------- |
| Cylinder | 20421 | 44.12% | 2 | 100% |
| Cuboid | 12401 | 26.81% | 3 | 100% |
| StretchedBody | 10263 | 22.19% | 3 | 100% |
| PorcelainBushing | 1506 | 3.26% | 5 | 100% |
| TruncatedCone | 730 | 1.58% | 3 | 100% |
| Ring | 235 | 0.51% | 3 | 100% |
| TerminalBlock | 201 | 0.43% | 11 | 100% |
| Sphere | 141 | 0.30% | 1 | 100% |
| ChannelSteel | 129 | 0.28% | 6 | L/Model=100%，D/H/B/T=44.19% |
| Table | 109 | 0.24% | 5 | 100% |
| CircularGasket | 80 | 0.17% | 4 | 100% |
| RectangularFixedPlate | 18 | 0.04% | 9 | 100% |
| OffsetRectangularTable | 15 | 0.03% | 7 | 100% |
| RectangularRing | 1 | 0.002% | 4 | 100% |

### 2.2 字段集合详情

| Primitive | 字段（按覆盖率降序） |
| ---------- | -------------------- |
| Cylinder | R, H |
| Cuboid | L, W, H |
| StretchedBody | L, Array, Normal |
| PorcelainBushing | R, R1, R2, H, N |
| TruncatedCone | BR, TR, H |
| Ring | R, DR, Rad |
| TerminalBlock | L, W, H, T, R, BL, CL, CS, RS, CN, RN, Phase |
| Sphere | R |
| ChannelSteel | L, Model, D?, H?, B?, T?（? 表示可选） |
| Table | H, LL1, LL2, TL1, TL2 |
| CircularGasket | H, Rad, OR, IR |
| RectangularFixedPlate | L, W, T, D, MH, CN, RN, CS, RS |
| OffsetRectangularTable | H, LL, LW, TL, TW, XOFF, YOFF |
| RectangularRing | L, W, R, DR |

### 2.3 工程类型差异

变电样本独有 XML primitive 体系，线路样本（`demo-line` / `demo-line1`）MOD 为文本格式族，**不存在 XML primitive**。因此本报告所有结论仅适用于变电工程。

---

## 3. 数值字段范围

### 3.1 Cylinder（圆柱）

| 字段 | count | min | max | mean | 负值 | 零值 |
| ---- | ----: | --: | --: | ---: | --: | --: |
| R | 20421 | 1 | 650 | 92.13 | 0 | 0 |
| H | 20421 | 1 | 14500 | 167.11 | 0 | 0 |

观察：R/H 均为正整数级浮点，无 0 无负值，单位推测毫米。

### 3.2 Cuboid（长方体）

| 字段 | count | min | max | mean | 负值 | 零值 |
| ---- | ----: | --: | --: | ---: | --: | --: |
| L | 12401 | 2 | 8350 | 275.46 | 0 | 0 |
| W | 12401 | 2 | 6757 | 166.31 | 0 | 0 |
| H | 12401 | 1 | 5500 | 249.41 | 0 | 0 |

观察：所有维度 ≥ 1，无 0 无负值。

### 3.3 StretchedBody（拉伸体）

| 字段 | count | min | max | mean | 负值 | 零值 |
| ---- | ----: | --: | --: | ---: | --: | --: |
| L | 10263 | 0.999999999999993 | 8110 | 226.82 | 0 | 0 |
| Array | 10263 | — | — | — | — | — |
| Normal | 10263 | — | — | — | — | — |

观察：L 接近 1，最小不低于 1.0；Array / Normal 为复合字段，详见第 4 节。

### 3.4 PorcelainBushing（绝缘子）

| 字段 | count | min | max | mean | 负值 | 零值 |
| ---- | ----: | --: | --: | ---: | --: | --: |
| R | 1506 | 15 | 150 | 42.69 | 0 | 0 |
| R1 | 1506 | 20 | 230 | 68.55 | 0 | 0 |
| R2 | 1506 | 18 | 200 | 63.25 | 0 | 0 |
| H | 1506 | 20 | 2848 | 331.56 | 0 | 0 |
| N | 1506 | 1 | 60 | 9.25 | 0 | 0 |

观察：N 为正整数（绝缘子伞盘数量），范围 1-60。

### 3.5 TruncatedCone（圆台）

| 字段 | count | min | max | mean | 负值 | 零值 |
| ---- | ----: | --: | --: | ---: | --: | --: |
| BR | 730 | 9 | 435 | 100.45 | 0 | 0 |
| TR | 730 | 0.1 | 385 | 76.95 | 0 | 0 |
| H | 730 | 2 | 247 | 45.27 | 0 | 0 |

观察：TR 最小值 0.1（非零），BR/TR/H 均为正值；BR ≥ TR 不强制成立，需在渲染时单独校验。

### 3.6 Ring（环）

| 字段 | count | min | max | mean | 负值 | 零值 |
| ---- | ----: | --: | --: | ---: | --: | --: |
| R | 235 | 41 | 500 | 240.22 | 0 | 0 |
| DR | 235 | 10 | 224.9 | 35.93 | 0 | 0 |
| Rad | 235 | 1.5707963267949 (π/2) | 6.28318530717958 (2π) | 5.10 | 0 | 0 |

观察：Rad 范围恰为 π/2 ~ 2π，**确认为弧度制**，非度数。

### 3.7 TerminalBlock（端子块）

| 字段 | count | min | max | mean | 负值 | 零值 |
| ---- | ----: | --: | --: | ---: | --: | --: |
| L | 201 | 81 | 240 | 153.55 | 0 | 0 |
| W | 201 | 80 | 160 | 118.23 | 0 | 0 |
| H | — | — | — | — | — | — |
| T | 201 | 8 | 20 | 17.67 | 0 | 0 |
| R | 201 | 6 | 18 | 9.73 | 0 | 0 |
| BL | 201 | 20 | 70 | 43.73 | 0 | 0 |
| CL | 201 | 1 | 10 | 6.91 | 0 | 0 |
| CS | 201 | 30 | 50 | 45.82 | 0 | 0 |
| RS | 201 | 30 | 55 | 46.49 | 0 | 0 |
| CN | 201 | 2 | 3 | 2.13 | 0 | 0 |
| RN | 201 | 2 | 3 | 2.45 | 0 | 0 |
| Phase | 201 | — | — | — | — | — |

观察：Phase 为字符串枚举，实测样本值为 `"ABC"`；CN/RN 为整数计数（端子数）。

### 3.8 Sphere（球体）

| 字段 | count | min | max | mean | 负值 | 零值 |
| ---- | ----: | --: | --: | ---: | --: | --: |
| R | 141 | 4 | 235 | 65.68 | 0 | 0 |

观察：仅 R 一个字段，全部正值。

### 3.9 ChannelSteel（槽钢）

| 字段 | count | 覆盖率 | min | max | mean | 负值 | 零值 |
| ---- | ----: | ----: | --: | --: | ---: | --: | --: |
| L | 129 | 100% | 99.9999999999973 | 469.999999999999 | 328.45 | 0 | 0 |
| Model | 129 | 100% | — | — | — | — | — |
| D | 57 | 44.19% | 5.3 | 5.3 | 5.30 | 0 | 0 |
| H | 57 | 44.19% | 100 | 100 | 100.00 | 0 | 0 |
| B | 57 | 44.19% | 48 | 48 | 48.00 | 0 | 0 |
| T | 57 | 44.19% | 8.5 | 8.5 | 8.50 | 0 | 0 |

观察：D/H/B/T 在 44.19% 实例中存在，且**取值完全固定**（D=5.3, H=100, B=48, T=8.5）。Model 为字符串型号代号（如 `"C5"`）。当 Model 指定后，D/H/B/T 可从型号表查询，因此可省略。

### 3.10 Table（表格 / 平台）

| 字段 | count | min | max | mean | 负值 | 零值 |
| ---- | ----: | --: | --: | ---: | --: | --: |
| H | 109 | 6 | 300 | 19.32 | 0 | 0 |
| LL1 | 109 | 10 | 450 | 41.38 | 0 | 0 |
| LL2 | 109 | 10 | 400 | 33.12 | 0 | 0 |
| TL1 | 109 | 4 | 400 | 16.55 | 0 | 0 |
| TL2 | 109 | 4 | 400 | 16.55 | 0 | 0 |

观察：TL1 与 TL2 的统计完全相同（min=4, max=400, mean=16.55），可能是镜像字段，需在渲染时单独确认语义。

### 3.11 CircularGasket（圆形垫片）

| 字段 | count | min | max | mean | 负值 | 零值 |
| ---- | ----: | --: | --: | ---: | --: | --: |
| H | 80 | 8 | 70 | 57.50 | 0 | 0 |
| OR | 80 | 60 | 190 | 164.85 | 0 | 0 |
| IR | 80 | 1 | 150 | 95.95 | 0 | 0 |
| Rad | 80 | 3.14159265358979 (π) | 6.28318530717958 (2π) | 5.97 | 0 | 0 |

观察：Rad 范围为 π ~ 2π，**确认为弧度制**；OR > IR 不强制成立（IR 最小 1, OR 最小 60，需渲染时单独校验）。

### 3.12 RectangularFixedPlate（矩形固定板）

| 字段 | count | min | max | mean | 负值 | 零值 |
| ---- | ----: | --: | --: | ---: | --: | --: |
| L | 18 | 326 | 326 | 326.00 | 0 | 0 |
| W | 18 | 326 | 326 | 326.00 | 0 | 0 |
| T | 18 | 15 | 15 | 15.00 | 0 | 0 |
| D | 18 | 20 | 20 | 20.00 | 0 | 0 |
| MH | 18 | 0 | 0 | 0.00 | 0 | 18 |
| CN | 18 | 2 | 2 | 2.00 | 0 | 0 |
| RN | 18 | 2 | 2 | 2.00 | 0 | 0 |
| CS | 18 | 270 | 270 | 270.00 | 0 | 0 |
| RS | 18 | 270 | 270 | 270.00 | 0 | 0 |

观察：18 个实例所有字段取值完全相同，**该 primitive 实际为常量零件**。MH 全为 0，可能表示"无中孔"或占位字段。

### 3.13 OffsetRectangularTable（偏置矩形台）

| 字段 | count | min | max | mean | 负值 | 零值 |
| ---- | ----: | --: | --: | ---: | --: | --: |
| H | 15 | 10 | 10 | 10.00 | 0 | 0 |
| LL | 15 | 460 | 460 | 460.00 | 0 | 0 |
| LW | 15 | 210 | 210 | 210.00 | 0 | 0 |
| TL | 15 | 370 | 370 | 370.00 | 0 | 0 |
| TW | 15 | 120 | 120 | 120.00 | 0 | 0 |
| XOFF | 15 | 0 | 0 | 0.00 | 0 | 15 |
| YOFF | 15 | 0 | 0 | 0.00 | 0 | 15 |

观察：15 个实例所有尺寸字段相同，**XOFF/YOFF 全为 0**，即"偏置矩形台"实际无偏置，疑似占位字段或未启用功能。

### 3.14 RectangularRing（矩形环）

| 字段 | count | min | max | mean | 负值 | 零值 |
| ---- | ----: | --: | --: | ---: | --: | --: |
| L | 1 | 120 | 120 | 120.00 | 0 | 0 |
| W | 1 | 71 | 71 | 71.00 | 0 | 0 |
| R | 1 | 30 | 30 | 30.00 | 0 | 0 |
| DR | 1 | 3 | 3 | 3.00 | 0 | 0 |

观察：仅 1 个实例，**样本不足以确认字段稳定性**，必须保留弱 schema fallback。

---

## 4. 复合字段深度分析

### 4.1 StretchedBody.Array 编码格式

#### 4.1.1 格式

```text
Array = "x1,y1,z1;x2,y2,z2;...;xn,yn,zn;"
       (分号分隔的 "x,y,z" 点序列，末尾保留分号)
```

实例样本：

```text
Array = -239.166087824874,-207.62215974194,1718.75864486223;
        -239.166087824874,-207.62215974194,1706.64893561351;
        -255.284441941127,-207.62215974194,1706.64893561351;
        -255.284441941127,-207.62215974194,1718.75864486223;
        -251.558377556386,-207.62215974194,1718.75864486223;
        -251.558377556386,-207.62215974194,1710.37500000001;
        -242.892152209679,-207.62215974194,1710.37500000001;
        -242.892152209679,-207.62215974194,1718.75864486223;
```

#### 4.1.2 点数分布

| 点数 | 实例数 | 点数 | 实例数 | 点数 | 实例数 |
| ---: | -----: | ---: | -----: | ---: | -----: |
| 3 | 36 | 13 | 9 | 23 | 3 |
| 4 | 6368 | 14 | 4 | 28 | 108 |
| 5 | 100 | 15 | 3 | 30 | 3 |
| 6 | 732 | 16 | 57 | 36 | 324 |
| 7 | 24 | 17 | 54 | 40 | 6 |
| 8 | 684 | 18 | 10 | 46 | 3 |
| 9 | 18 | 19 | 7 | | |
| 10 | 1629 | 21 | 12 | | |
| 11 | 33 | | | | |
| 12 | 36 | | | | |

观察：点数范围 3-46，主流为 4 点（6368）、10 点（1629）、6 点（732）、8 点（684）。

#### 4.1.3 坐标全局范围

```text
X 范围: -4557.28 ~ 9188.50    (跨度 13745.78)
Y 范围: -8188.35 ~ 8600.33    (跨度 16788.68)
Z 范围: -90.00 ~ 6328.04      (跨度 6418.04)
```

观察：坐标可正可负，量级与 Cylinder/Cuboid 的尺寸（max 14500）一致，单位推测毫米。

#### 4.1.4 解析失败率

```text
Array parse failures: 0 / 10263
```

格式严格稳定，无异常样本。

### 4.2 StretchedBody.Normal 编码格式

#### 4.2.1 格式

```text
Normal = "x,y,z"   (3 个浮点数，逗号分隔，无分号)
```

实例样本：

```text
Normal = 3.73272344380113E-14,-304.8,0
```

#### 4.2.2 向量长度分布

```text
length=304.8:  10263 instances (100%)
```

**所有 Normal 向量长度恒为 304.8**，这是高度异常的常量。

#### 4.2.3 分量分布

| 分量 | 主取值 | 实例数 | 次取值 | 实例数 | 第三取值 | 实例数 |
| ---- | ------ | -----: | ------ | -----: | -------- | -----: |
| X | 0 | 8219 | 304.8 | 1551 | -304.8 | 457 |
| Y | 0 | 5447 | -304.8 | 3633 | 304.8 | 1183 |
| Z | 0 | 6824 | 304.8 | 3403 | 289.9 | 36 |

观察：Normal 三个分量仅取 `{-304.8, 0, 304.8, 289.9, -94.2}` 中之一，组合后向量长度恒为 304.8。

#### 4.2.4 语义推断

```text
304.8 mm = 1 英尺 (1 foot = 304.8 mm)
```

Normal 极可能不是"单位法向量"，而是"方向 × 单位换算因子"。建议 parser 层保留原始字符串，渲染层除以 304.8 得到单位法向量。

#### 4.2.5 解析失败率

```text
Normal parse failures: 0 / 10263
```

### 4.3 Color 节点

#### 4.3.1 格式

Color 不是 primitive 属性，而是 Entity 下的独立子节点：

```xml
<Entity ...>
  <Color R="138" G="149" B="151" A="100"/>
  <Cylinder R="5" H="2"/>
</Entity>
```

**关键发现**：Color 使用 `R/G/B/A` 4 个独立属性，**不使用** `Value` 单一属性。

#### 4.3.2 范围统计

| 字段 | min | max | mean | 超出 0-255 |
| ---- | --: | --: | ---: | ---------: |
| R | 0 | 250 | 145.38 | 0 |
| G | 0 | 246 | 148.23 | 0 |
| B | 0 | 246 | 148.03 | 0 |
| A | 40 | 100 | 99.80 | 0 |

观察：R/G/B 全部落在 0-255 范围内；A 实际取值仅 `40` 或 `100`，是透明度百分制。

#### 4.3.3 Top 颜色组合

| 颜色 (R,G,B,A) | 实例数 | 推测语义 |
| -------------- | -----: | -------- |
| 138,149,151,100 | 36011 | 默认灰（金属灰） |
| 215,215,215,100 | 5059 | 白色 |
| 91,58,41,100 | 1512 | 棕色（瓷绝缘子） |
| 204,6,5,100 | 1189 | 红色（A 相） |
| 127,127,127,100 | 1134 | 中灰 |
| 30,30,30,100 | 312 | 黑色 |
| 104,108,94,100 | 274 | 暗绿 |
| 48,132,70,100 | 243 | 绿色（B 相） |
| 250,210,1,100 | 187 | 黄色（C 相） |
| 138,149,151,40 | 154 | 半透明默认灰 |

观察：颜色分布与电力行业三相色规范（黄/绿/红）一致，A=40 仅出现在透明构件。

---

## 5. 单位与类型推断

### 5.1 单位分类

| 字段类别 | 推测单位 | 证据 |
| -------- | -------- | ---- |
| 长度（R/H/L/W/D/T/BR/TR 等） | 毫米 | max=14500（与真实电力设备尺寸量级一致） |
| 角度（Rad） | 弧度 | CircularGasket.Rad 范围 π~2π；Ring.Rad 范围 π/2~2π |
| 计数（N/CN/RN） | 整数 | PorcelainBushing.N=1-60；TerminalBlock.CN=2-3 |
| 字符串（Model/Phase） | 枚举 | Phase="ABC"；Model="C5" |
| 偏移（XOFF/YOFF） | 毫米 | 但实测全为 0 |
| 颜色（R/G/B/A） | 0-255 整数 | A 为 0-100 百分制透明度 |

### 5.2 字段类型推断

| 字段 | 推断类型 | 依据 |
| ---- | -------- | ---- |
| R, H, L, W, D, T, BR, TR, BL, CL, CS, RS | `number` | 全为浮点，无字符串 |
| N, CN, RN | `number`（整数） | 值全为整数 |
| Rad | `number`（弧度） | 范围 π/2~2π |
| XOFF, YOFF, MH | `number`（含 0） | 实测全为 0 |
| Array | `string`（需专门解析器） | 复合编码 "x,y,z;x,y,z;..." |
| Normal | `string`（需专门解析器） | 复合编码 "x,y,z" |
| Model | `string`（枚举） | "C5" 等型号代号 |
| Phase | `string`（枚举） | "ABC" |
| R/G/B/A | `number`（0-255） | 颜色通道 |

---

## 6. 强类型 schema 判定

### 6.1 判定标准

| 判据 | 强类型通过条件 |
| ---- | -------------- |
| 字段集合稳定 | 覆盖率 100%（或可选字段已识别） |
| 字段类型稳定 | 数值与字符串可明确区分 |
| 数值范围稳定 | min/max 不超出预期量级 |
| 样本充分 | 实例数 ≥ 100 |

### 6.2 各 primitive 判定结果

| Primitive | 实例数 | 字段稳定 | 类型稳定 | 范围稳定 | 样本充分 | 判定 |
| --------- | -----: | :------: | :------: | :------: | :------: | ---- |
| Cylinder | 20421 | ✓ | ✓ | ✓ | ✓ | **强类型** |
| Cuboid | 12401 | ✓ | ✓ | ✓ | ✓ | **强类型** |
| StretchedBody | 10263 | ✓ | ✓ | ✓ | ✓ | **强类型**（Array/Normal 保留 string） |
| PorcelainBushing | 1506 | ✓ | ✓ | ✓ | ✓ | **强类型** |
| TruncatedCone | 730 | ✓ | ✓ | ✓ | ✓ | **强类型** |
| Ring | 235 | ✓ | ✓ | ✓ | ✓ | **强类型** |
| TerminalBlock | 201 | ✓ | ✓ | ✓ | ✓ | **强类型**（Phase 为 string enum） |
| Sphere | 141 | ✓ | ✓ | ✓ | ✓ | **强类型** |
| ChannelSteel | 129 | ✓（D/H/B/T 可选） | ✓ | ✓ | ✓ | **强类型**（D/H/B/T optional） |
| Table | 109 | ✓ | ✓ | ✓ | ✓ | **强类型** |
| CircularGasket | 80 | ✓ | ✓ | ✓ | △（接近阈值） | **强类型** |
| RectangularFixedPlate | 18 | ✓ | ✓ | ✓（全常量） | ✗ | **弱 schema**（fallback） |
| OffsetRectangularTable | 15 | ✓ | ✓ | ✓（全常量） | ✗ | **弱 schema**（fallback） |
| RectangularRing | 1 | ✓ | ✗（样本不足） | ✗ | ✗ | **弱 schema**（fallback） |

### 6.3 覆盖率统计

```text
强类型 primitive:    11 种  46186 实例  99.86%
弱 schema fallback:   3 种     64 实例   0.14%
```

### 6.4 推荐的 TypeScript schema 草案

```typescript
// 主流 primitive 强类型（11 种，覆盖 99.86%）
interface Cylinder { R: number; H: number; }
interface Cuboid { L: number; W: number; H: number; }
interface StretchedBody {
  L: number;
  Array: string;   // "x,y,z;x,y,z;..." 需专门解析器
  Normal: string;  // "x,y,z" 需除以 304.8 还原单位向量
}
interface PorcelainBushing { R: number; R1: number; R2: number; H: number; N: number; }
interface TruncatedCone { BR: number; TR: number; H: number; }
interface Ring { R: number; DR: number; Rad: number; }  // Rad 弧度制
interface TerminalBlock {
  L: number; W: number; H?: number; T: number; R: number;
  BL: number; CL: number; CS: number; RS: number;
  CN: number; RN: number; Phase: "ABC" | string;
}
interface Sphere { R: number; }
interface ChannelSteel {
  L: number; Model: string;        // Model="C5" 等
  D?: number; H?: number; B?: number; T?: number;  // 可选，可从 Model 查询
}
interface Table { H: number; LL1: number; LL2: number; TL1: number; TL2: number; }
interface CircularGasket { H: number; OR: number; IR: number; Rad: number; }  // Rad 弧度制

// 低样本 primitive 保留弱 schema（3 种，0.14%）
interface WeakPrimitive {
  name: "RectangularFixedPlate" | "OffsetRectangularTable" | "RectangularRing";
  attrs: Record<string, string>;
}

// Color 节点（Entity 子节点，与 primitive 平级）
interface Color { R: number; G: number; B: number; A: number; }  // 0-255, A 实际为 40 或 100

// 联合类型
type Primitive = Cylinder | Cuboid | StretchedBody | PorcelainBushing
  | TruncatedCone | Ring | TerminalBlock | Sphere | ChannelSteel
  | Table | CircularGasket | WeakPrimitive;
```

### 6.5 实现策略建议

1. **强类型优先**：parser 先尝试按 primitive name 匹配强类型 schema 解析。
2. **弱 schema fallback**：匹配失败或样本不足的 primitive 退化为 `WeakPrimitive`，保留原始 attrs。
3. **复合字段延迟解析**：`StretchedBody.Array` / `Normal` 在 parser 层保留 string，渲染层再解析为点数组与法向量。
4. **Normal 单位还原**：渲染层将 Normal 向量除以 304.8 还原为单位向量（实证 100% 长度恒为 304.8）。
5. **Color 独立解析**：Color 是 Entity 子节点，与 primitive 平级，需在 Entity 层单独提取。
6. **新增 primitive 兜底**：未来若出现未登记 primitive，应自动归入 `WeakPrimitive`，不阻塞解析。

---

## 7. 浏览器实现影响

### 7.1 研究启动时缺口（历史基线）

本文研究启动时，`demo-substation` 浏览器只渲染 IFC，未渲染 MOD/STL，导致：
- 4179 个 MOD 文件未渲染
- 46250 个 XML Entity 未渲染
- 涉及 14 种 primitive 全部缺失

2026-07-17 当前状态：XML parser 已覆盖 14 类 primitive；渲染器支持 6 类基础体与 StretchedBody，另外 7 类因几何语义未收口而主动跳过。STL 加载及 DEV 粒度 GLB 缓存也已有实现。

### 7.2 原补齐路径建议（历史设计）

```text
Step 1: 在 viewer 层新增 modLoader（参考 ifcLoader 设计）
Step 2: parser 层按本文档 §6.4 的强类型 schema 解析 MOD XML
Step 3: 渲染层按 primitive 类型分发到 Three.js 几何构造器：
        Cylinder    -> THREE.CylinderGeometry(R, R, H)
        Cuboid      -> THREE.BoxGeometry(L, W, H)
        Sphere      -> THREE.SphereGeometry(R)
        TruncatedCone -> THREE.CylinderGeometry(TR, BR, H)
        Ring        -> THREE.RingGeometry(R-DR, R, ...)
        PorcelainBushing -> 多圆柱组合（按 N 数量堆叠）
        StretchedBody  -> THREE.ExtrudeGeometry(Array 点序列, Normal 方向)
        TerminalBlock  -> 组合几何（Cuboid + Cylinder）
        ChannelSteel   -> 按 Model 查型号表
        Table          -> 组合几何（多 Cuboid）
        CircularGasket -> THREE.RingGeometry(IR, OR, ...)
Step 4: 应用 Entity.TransformMatrix（参见 09-transform-chain-analysis.md）
Step 5: 应用 Color 节点（R/G/B/255, A/100）
```

### 7.3 风险点

- `StretchedBody.Array` 的点数范围 3-46，需支持任意点数的拉伸体。
- `Normal` 长度恒为 304.8 的语义需在渲染前验证（可能不是真正的法向量）。
- `RectangularFixedPlate` / `OffsetRectangularTable` 字段全为常量，可能隐藏未启用功能（如 MH=0、XOFF=0），需在新样本中复核。
- `TruncatedCone.TR` 最小值 0.1，需在 `CylinderGeometry` 中限制最小半径避免退化。

---

## 8. 当前不能得出的结论

```text
1. 单位是否统一为毫米
   - 长度字段量级一致，但 StretchedBody.Array 坐标量级（max 9188）与
     Cylinder.H（max 14500）量级一致，无法从样本反推单位定义。
   - 需查 GIM 官方规范文档确认。

2. Normal 长度 304.8 的真实语义
   - 推测为"方向 × 1 英尺"，但无法排除"方向 × 模型单位"的可能性。
   - 需在新样本中验证 Normal 长度是否仍为 304.8。

3. RectangularFixedPlate / OffsetRectangularTable 的字段语义
   - 18 / 15 个实例全为常量，无法判断字段是否实际生效。
   - 需采集更多变电样本验证。

4. ChannelSteel.D/H/B/T 与 Model 的对应关系
   - 实测 D=5.3, H=100, B=48, T=8.5，对应 Model="C5"，
     但无型号表对照，无法确认其他 Model 值的尺寸。

5. 各 primitive 的几何拓扑（如 PorcelainBushing 的伞盘堆叠规则）
   - 本报告不进入几何渲染实现，需在渲染层单独梳理。

6. 弧度制 Rad 字段在渲染时的转换公式
   - Rad 范围 π~2π，但无法确定是"扫描角度"还是"圆心角"。
   - 需查 GIM 官方规范文档确认。
```

---

## 实现对照

> P0 已落地实现；早期 `docs/plans/substation-geometry-impl.md` 计划文件已不在仓库中，当前实现以本节列出的源码与测试为准。

### 解析器

- **实现位置**：`src/gim/geometry/xmlModParser.ts`
- **核心函数**：`export function parseXmlMod(text: string, modPath: string): XmlModDocument`
- **测试**：`src/gim/geometry/__tests__/xmlModParser.test.ts`（2026-07-17：43 测试通过）
- **渲染器**：`src/viewer/xmlModGeometry.ts`（7 类 primitive → Three.js BufferGeometry，另 7 类主动跳过；2026-07-17：40 测试通过）

### 14 类 primitive 实现状态

| Primitive | 解析 | 渲染 | Three.js 几何 | 备注 |
|---|---|---|---|---|
| Cylinder | ✅ 强类型 `{ r, h }` | ✅ | `CylinderGeometry(r, r, h, 16)` | — |
| Cuboid | ✅ 强类型 `{ l, w, h }` | ✅ | `BoxGeometry(l, w, h)` | 参数顺序：width=l, height=w, depth=h |
| StretchedBody | ✅ 强类型 `{ l, array, normal }` | ✅ | 自定义任意平面三角剖分 + 沿 Normal 拉伸 | 保留原始三维截面点，Normal 归一化后拉伸 |
| PorcelainBushing | ✅ 强类型 `{ r, r1, r2, n, h }` | ⏸ 跳过 | `null` | 伞裙拓扑未确认，避免错误圆柱污染场景 |
| TruncatedCone | ✅ 强类型 `{ br, tr, h }` | ✅ | `CylinderGeometry(tr, br, h, 16)` | — |
| Ring | ✅ 强类型 `{ r, dr, rad }` | ✅ | `TorusGeometry(r, dr/2, 8, 16, rad)` | — |
| TerminalBlock | ✅ 强类型 12 字段 | ⏸ 跳过 | `null` | 组合拓扑未确认 |
| Sphere | ✅ 强类型 `{ r }` | ✅ | `SphereGeometry(r, 16, 8)` | — |
| ChannelSteel | ✅ 强类型 `{ l, model, d?, h?, b?, t? }` | ⏸ 跳过 | `null` | 型号与截面解释未收口 |
| Table | ✅ 强类型 `{ h, ll1, ll2, tl1, tl2 }` | ⏸ 跳过 | `null` | 组合拓扑未确认 |
| CircularGasket | ✅ 强类型 `{ h, rad, or, ir }` | ✅ | `TorusGeometry(or, (or-ir)/2, 8, 16, rad)` | — |
| RectangularFixedPlate | ✅ 弱 schema `{ type, raw }` | ⏸ 跳过 | `null` + console.warn | 待字段补充后强类型化 |
| OffsetRectangularTable | ✅ 弱 schema `{ type, raw }` | ⏸ 跳过 | `null` + console.warn | 待字段补充后强类型化 |
| RectangularRing | ✅ 弱 schema `{ type, raw }` | ⏸ 跳过 | `null` + console.warn | 待字段补充后强类型化 |

### 关键约束实现

| 约束 | 实现策略 |
|---|---|
| XML root 为 `<Device>` | `parseXmlMod` 校验 `documentElement.tagName === 'Device'`，否则抛错 |
| Entity 必含 TransformMatrix | 缺失时回退单位矩阵（与 PHM parser 一致） |
| Entity 可含 Color | `parseColor` 返回 `XmlModColor \| undefined` |
| StretchedBody.Array/Normal 保留 string | 解析层保留，渲染层 `parseStretchedBodyPoints` + `parseStretchedBodyNormal` 解析 |
| StretchedBody.Normal 长度 304.8 | 渲染层 `parseStretchedBodyNormal` 调用 `normalize()` 还原单位向量 |
| Color R/G/B 0-255, A 0-100 | `parseColor` 校验范围，超出返回 `undefined` |
| Color 应用 sRGB hex | 渲染层用 `(r<<16)\|(g<<8)\|b` 拼为 hex，由 THREE.Color 按 sRGB 解释 |

### 加载入口

- **`src/viewer/xmlModLoader.ts`**：
  - `loadXmlModFromText(text, modPath)` — 从 XML 文本加载
  - `loadXmlModFromFiles(modPath, files)` — 从 GIM 解压文件集合加载
  - `applyExternalTransforms(group, devMatrix, phmMatrix)` — 应用 DEV + PHM 变换矩阵
  - `disposeXmlModGroup(group)` — 释放 GPU 资源
- **`src/services/modGeometryDiscovery.ts`**：`discoverModGeometriesFromNode` 走 CBM → DEV → PHM → MOD 引用链

---

## 附录 A：分析脚本

### A.1 主分析脚本

| 脚本 | 路径 | 用途 |
| ---- | ---- | ---- |
| xml-primitive-survey.ps1 | [skill scripts/xml-primitive-survey.ps1](../../.trae/skills/gim-sample-verification/scripts/xml-primitive-survey.ps1) | Round 6 主分析：扫描全部 MOD XML，输出 primitive-attrs.csv（每行一个属性）与 primitive-summary.csv（按 primitive×field 聚合统计） |
| color-analysis.ps1 | [skill scripts/color-analysis.ps1](../../.trae/skills/gim-sample-verification/scripts/color-analysis.ps1) | Color 节点单独分析：扫描 R/G/B/A 4 个独立属性，输出分布表与 Top 20 组合 |
| stretched-body-deep.ps1 | [skill scripts/stretched-body-deep.ps1](../../.trae/skills/gim-sample-verification/scripts/stretched-body-deep.ps1) | StretchedBody 深度分析：解析 Array 点序列与 Normal 向量，输出点数分布、坐标全局范围、Normal 长度分布 |

### A.2 执行命令

```powershell
# 主分析（输出到 scripts/<sampleId>/）
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .trae/skills/gim-sample-verification/scripts/xml-primitive-survey.ps1 `
  -SampleId demo-substation `
  -SampleRoot "D:\vibe-coding\gim_viewer\demo\demo-substation" `
  -OutDir ".trae/skills/gim-sample-verification/scripts/demo-substation"

# Color 分析
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .trae/skills/gim-sample-verification/scripts/color-analysis.ps1 `
  -SampleId demo-substation `
  -SampleRoot "D:\vibe-coding\gim_viewer\demo\demo-substation" `
  -OutDir ".trae/skills/gim-sample-verification/scripts/demo-substation"

# StretchedBody 深度分析
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .trae/skills/gim-sample-verification/scripts/stretched-body-deep.ps1 `
  -SampleId demo-substation `
  -SampleRoot "D:\vibe-coding\gim_viewer\demo\demo-substation" `
  -OutDir ".trae/skills/gim-sample-verification/scripts/demo-substation"
```

### A.3 输出产物

| 产物 | 路径 | 行数 | 用途 |
| ---- | ---- | ---: | ---- |
| primitive-attrs.csv | `scripts/demo-substation/demo-substation-primitive-attrs.csv` | 46250 | 每个 Entity 一行，记录 primitive 类型与全部属性 |
| primitive-summary.csv | `scripts/demo-substation/demo-substation-primitive-summary.csv` | ~50 | 按 primitive×field 聚合的统计表 |
| color-analysis-output.txt | `scripts/demo-substation/color-analysis-output.txt` | — | Color 节点 R/G/B/A 分布文本报告 |
| stretched-body-deep-output.txt | `scripts/demo-substation/stretched-body-deep-output.txt` | — | StretchedBody Array/Normal 深度分析报告 |

### A.4 关键脚本逻辑

#### A.4.1 xml-primitive-survey.ps1 关键逻辑

```powershell
# 跳过 UTF-8 BOM
if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
  $bytes = $bytes[3..($bytes.Length - 1)]
}
# 仅处理 XML Entity
if ($text.TrimStart() -notmatch "<Entity") { continue }
# 提取 primitive 子节点
$xml = [xml]$text
$entities = $xml.SelectNodes("//Entity")
foreach ($entity in $entities) {
  foreach ($child in $entity.ChildNodes) {
    if ($child.NodeType -eq "Element") {
      # 记录 primitive 类型与全部属性
    }
  }
}
```

#### A.4.2 color-analysis.ps1 关键逻辑

```powershell
# Color 节点使用 R/G/B/A 4 个独立属性，不使用 Value
$colors = $xml.SelectNodes("//Color")
foreach ($c in $colors) {
  $colorData += [PSCustomObject]@{
    R = [int]($c.GetAttribute("R"))
    G = [int]($c.GetAttribute("G"))
    B = [int]($c.GetAttribute("B"))
    A = [int]($c.GetAttribute("A"))
  }
}
```

#### A.4.3 stretched-body-deep.ps1 关键逻辑

```powershell
# Array = 分号分隔的 "x,y,z" 点序列
$arrayStr = $sb.GetAttribute("Array")
$points = $arrayStr -split ";" | Where-Object { $_ -ne "" }
foreach ($p in $points) {
  $coords = $p -split "," | Where-Object { $_ -ne "" }
  if ($coords.Count -eq 3) { ... }
}

# Normal = 3 个浮点数，向量长度恒为 304.8
$normalStr = $sb.GetAttribute("Normal")
$coords = $normalStr -split "," | Where-Object { $_ -ne "" }
if ($coords.Count -eq 3) {
  $length = [Math]::Sqrt($x*$x + $y*$y + $z*$z)
  # 实测 100% 长度 = 304.8
}
```

---

## 附录 B：完整数值范围表

> 本表汇总所有 primitive 的所有数值字段，便于 parser 实现时设置字段边界。

| Primitive | Field | count | min | max | mean | neg | zero |
| --------- | ----- | ----: | --: | --: | ---: | --: | ---: |
| ChannelSteel | B | 57 | 48 | 48 | 48.00 | 0 | 0 |
| ChannelSteel | D | 57 | 5.3 | 5.3 | 5.30 | 0 | 0 |
| ChannelSteel | H | 57 | 100 | 100 | 100.00 | 0 | 0 |
| ChannelSteel | L | 129 | 99.9999999999973 | 469.999999999999 | 328.45 | 0 | 0 |
| ChannelSteel | T | 57 | 8.5 | 8.5 | 8.50 | 0 | 0 |
| CircularGasket | H | 80 | 8 | 70 | 57.50 | 0 | 0 |
| CircularGasket | IR | 80 | 1 | 150 | 95.95 | 0 | 0 |
| CircularGasket | OR | 80 | 60 | 190 | 164.85 | 0 | 0 |
| CircularGasket | Rad | 80 | 3.14159265358979 (π) | 6.28318530717958 (2π) | 5.97 | 0 | 0 |
| Cuboid | H | 12401 | 1 | 5500 | 249.41 | 0 | 0 |
| Cuboid | L | 12401 | 2 | 8350 | 275.46 | 0 | 0 |
| Cuboid | W | 12401 | 2 | 6757 | 166.31 | 0 | 0 |
| Cylinder | H | 20421 | 1 | 14500 | 167.11 | 0 | 0 |
| Cylinder | R | 20421 | 1 | 650 | 92.13 | 0 | 0 |
| OffsetRectangularTable | H | 15 | 10 | 10 | 10.00 | 0 | 0 |
| OffsetRectangularTable | LL | 15 | 460 | 460 | 460.00 | 0 | 0 |
| OffsetRectangularTable | LW | 15 | 210 | 210 | 210.00 | 0 | 0 |
| OffsetRectangularTable | TL | 15 | 370 | 370 | 370.00 | 0 | 0 |
| OffsetRectangularTable | TW | 15 | 120 | 120 | 120.00 | 0 | 0 |
| OffsetRectangularTable | XOFF | 15 | 0 | 0 | 0.00 | 0 | 15 |
| OffsetRectangularTable | YOFF | 15 | 0 | 0 | 0.00 | 0 | 15 |
| PorcelainBushing | H | 1506 | 20 | 2848 | 331.56 | 0 | 0 |
| PorcelainBushing | N | 1506 | 1 | 60 | 9.25 | 0 | 0 |
| PorcelainBushing | R | 1506 | 15 | 150 | 42.69 | 0 | 0 |
| PorcelainBushing | R1 | 1506 | 20 | 230 | 68.55 | 0 | 0 |
| PorcelainBushing | R2 | 1506 | 18 | 200 | 63.25 | 0 | 0 |
| RectangularFixedPlate | CN | 18 | 2 | 2 | 2.00 | 0 | 0 |
| RectangularFixedPlate | CS | 18 | 270 | 270 | 270.00 | 0 | 0 |
| RectangularFixedPlate | D | 18 | 20 | 20 | 20.00 | 0 | 0 |
| RectangularFixedPlate | L | 18 | 326 | 326 | 326.00 | 0 | 0 |
| RectangularFixedPlate | MH | 18 | 0 | 0 | 0.00 | 0 | 18 |
| RectangularFixedPlate | RN | 18 | 2 | 2 | 2.00 | 0 | 0 |
| RectangularFixedPlate | RS | 18 | 270 | 270 | 270.00 | 0 | 0 |
| RectangularFixedPlate | T | 18 | 15 | 15 | 15.00 | 0 | 0 |
| RectangularFixedPlate | W | 18 | 326 | 326 | 326.00 | 0 | 0 |
| RectangularRing | DR | 1 | 3 | 3 | 3.00 | 0 | 0 |
| RectangularRing | L | 1 | 120 | 120 | 120.00 | 0 | 0 |
| RectangularRing | R | 1 | 30 | 30 | 30.00 | 0 | 0 |
| RectangularRing | W | 1 | 71 | 71 | 71.00 | 0 | 0 |
| Ring | DR | 235 | 10 | 224.9 | 35.93 | 0 | 0 |
| Ring | R | 235 | 41 | 500 | 240.22 | 0 | 0 |
| Ring | Rad | 235 | 1.5707963267949 (π/2) | 6.28318530717958 (2π) | 5.10 | 0 | 0 |
| Sphere | R | 141 | 4 | 235 | 65.68 | 0 | 0 |
| StretchedBody | L | 10263 | 0.999999999999993 | 8110 | 226.82 | 0 | 0 |
| StretchedBody | Normal | 3259 | 304.8 | 304.8 | 304.80 | 0 | 0 |
| Table | H | 109 | 6 | 300 | 19.32 | 0 | 0 |
| Table | LL1 | 109 | 10 | 450 | 41.38 | 0 | 0 |
| Table | LL2 | 109 | 10 | 400 | 33.12 | 0 | 0 |
| Table | TL1 | 109 | 4 | 400 | 16.55 | 0 | 0 |
| Table | TL2 | 109 | 4 | 400 | 16.55 | 0 | 0 |
| TerminalBlock | BL | 201 | 20 | 70 | 43.73 | 0 | 0 |
| TerminalBlock | CL | 201 | 1 | 10 | 6.91 | 0 | 0 |
| TerminalBlock | CN | 201 | 2 | 3 | 2.13 | 0 | 0 |
| TerminalBlock | CS | 201 | 30 | 50 | 45.82 | 0 | 0 |
| TerminalBlock | L | 201 | 81 | 240 | 153.55 | 0 | 0 |
| TerminalBlock | R | 201 | 6 | 18 | 9.73 | 0 | 0 |
| TerminalBlock | RN | 201 | 2 | 3 | 2.45 | 0 | 0 |
| TerminalBlock | RS | 201 | 30 | 55 | 46.49 | 0 | 0 |
| TerminalBlock | T | 201 | 8 | 20 | 17.67 | 0 | 0 |
| TerminalBlock | W | 201 | 80 | 160 | 118.23 | 0 | 0 |
| TruncatedCone | BR | 730 | 9 | 435 | 100.45 | 0 | 0 |
| TruncatedCone | H | 730 | 2 | 247 | 45.27 | 0 | 0 |
| TruncatedCone | TR | 730 | 0.1 | 385 | 76.95 | 0 | 0 |

> 注：`StretchedBody.Normal` 行的 count=3259 是因为脚本初次统计仅成功解析了部分 Normal 字段，重新统计后实际为 10263/10263 长度均为 304.8。详见 §4.2.2。

---

## 附录 C：脚本输出原始文件

- `docs/schema/_generated/primitive-survey-output.txt` —— 主分析脚本输出
- `docs/schema/_generated/color-analysis-output.txt` —— Color 分析脚本输出
- `docs/schema/_generated/stretched-body-deep-output.txt` —— StretchedBody 深度分析脚本输出
