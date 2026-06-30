# GIM 文件角色矩阵

## 1. 文件角色总览

| 文件类型 | 线路 demo | 变电 demo | 主要目录         | 粗判格式                 | 当前角色判断               | 当前处理策略           |
| -------- | --------: | --------: | ---------------- | ------------------------ | -------------------------- | ---------------------- |
| .cbm     |     27829 |      8701 | Cbm/CBM          | text-like                | 工程层级与引用关系         | 已作为核心解析对象     |
| .fam     |     26485 |     13056 | Cbm/CBM, Dev/DEV | text-like / unknown-text | 属性文件                   | 继续字段字典分析       |
| .dev     |      4518 |      4179 | Dev/DEV          | text-like                | 设备物理模型与设备属性     | 继续引用关系分析       |
| .phm     |      1836 |      4179 | Phm/PHM          | text-like                | 组合模型 / 装配体候选      | 静态分析引用关系       |
| .mod     |      1807 |      4179 | Mod/MOD          | text-like / unknown-text | 基础几何模型候选           | 仅静态体检，不解析几何 |
| .stl     |       181 |      1803 | Mod/MOD          | binary-like              | 三角网格资源候选           | 仅统计，不解析         |
| .ifc     |         0 |        12 | DEV              | text-like                | 变电 3D / 土建模型交互格式 | 继续走既有 IFC viewer  |
| .sch     |         0 |         1 | CBM              | text-like                | 逻辑模型入口               | 后续分析               |
| .std     |         0 |         1 | CBM              | text-like                | 逻辑模型定义               | 后续分析               |
| .sld     |         0 |         1 | CBM              | text-like                | 主接线图 / 图形表达        | 后续分析               |

```plaintext
CBM
 ├─ DEV
 │   ├─ PHM
 │   │   ├─ MOD
 │   │   └─ STL
 │   └─ DEV / SUBDEVICE
 ├─ IFC
 ├─ FAM
 └─ CBM
```

## 2. 规范背景与 demo 实证差异

内部背景资料中提到：

- 变电工程土建及水暖系统可采用 IFC 进行交互。
- 电气设备、安装材料、线路工程可采用基本图元、参数化模型或 STL 进行交互。
- CBM / DEV / PHM / MOD 分别承担工程骨架、设备模型、组合模型、基础几何模型角色。

但当前两个 demo 的实证结果与规范描述存在一些路径和格式差异：

| 主题         | 背景描述                           | demo 实证                                                              | 当前处理                            |
| ------------ | ---------------------------------- | ---------------------------------------------------------------------- | ----------------------------------- |
| IFC 存放目录 | 背景中可能描述为 CBM 或被 CBM 引用 | demo-substation 的 12 个 IFC 位于 DEV 目录                             | 不写死 IFC 目录，按实际文件索引搜索 |
| MOD 格式     | 背景中提到 XML / 基本图元          | demo-line 存在 key-value 点线型 MOD；demo-substation 存在 XML-like MOD | 按样本分型，不统一假设              |
| 目录大小写   | 规范不强调大小写                   | 线路为 Cbm/Dev/Phm/Mod，变电为 CBM/DEV/PHM/MOD                         | 路径匹配必须大小写不敏感            |
| STL 角色     | 复杂几何三角网格                   | 两个 demo 均存在 STL，且粗判为 binary-like                             | 仅统计，不解析                      |

当前文档以 demo 实证为准；规范背景只作为解释线索，不直接替代样本事实。

---

## 3. FAM 格式观察

当前 demo 中 `.fam` 基本可按 plain text 处理。

线路 `Dev/*.fam` 样例显示，FAM 常见格式不是简单 `key=value`，而是三段式：

```text
中文标签=英文KEY=值
```

示例字段：

```text
电压等级=VOLTAGE=AC500kV
型号=TYPE=5TDZ-62、63-1
导线分裂数=BUNDLENUMBER=4
挂接点信息=WIREPOINT=...
```

需要注意：

- 中文标签可用于人工理解。
- 英文 KEY 适合进入字段字典。
- value 可能跨行续写。
- 无等号行不应直接视为脏数据，可能是上一字段的 continuation。

当前 FAM 解析建议：

| 元素         | 说明                                     |
| ------------ | ---------------------------------------- |
| label        | 第一个 `=` 前的中文标签                  |
| key          | 第二个字段中的英文 KEY                   |
| value        | 第二个 `=` 后的原始值                    |
| continuation | 后续无等号行，暂记录为上一字段的续行候选 |

---

## 4. MOD 内部格式初步分型

### 4.1 线路工程

线路 MOD 共 1807 个。

按 `CODE / POINTNUM` 粗分：

| 类型                 | 数量 | 特征                               | 判断                |
| -------------------- | ---: | ---------------------------------- | ------------------- |
| CODE/POINTNUM 点线型 |  315 | 存在 `CODE`、`POINTNUM`、`LINENUM` | 点线几何 / 拓扑候选 |
| 未分类文本型         | 1492 | 未发现 `CODE`、`POINTNUM`          | 待进一步字段分析    |

CODE 分布：

| CODE | 数量 |
| ---- | ---: |
| 201  |  128 |
| 31   |   74 |
| 32   |   63 |
| 34   |   19 |
| 35   |   13 |
| 33   |   10 |
| 30   |    8 |

线路 MOD key Top 观察：

| key                                              |    数量 | 观察              |
| ------------------------------------------------ | ------: | ----------------- |
| `Bolt1` ~ `Bolt4`                                | 各 1300 | 螺栓 / 金具类参数 |
| `BoltNum`                                        |    1300 | 螺栓数量          |
| `CODE`                                           |     315 | 点线型 MOD 类型码 |
| `POINTNUM`                                       |     315 | 点数量            |
| `LINENUM`                                        |     315 | 线数量            |
| `POINT1..N`                                      |    多组 | 点坐标 / 点参数   |
| `LINE1..N`                                       |    多组 | 线段连接关系      |
| `OUTSIDEDIAMETER`、`SECTIONALAREA`、`WIREWEIGHT` |    各 9 | 疑似导线物理参数  |

当前判断：

- demo-line 的 MOD 不是统一 XML。
- 部分 MOD 是 key-value 点线描述。
- 大量 MOD 与 `Bolt*` 字段相关，可能描述线路金具 / 塔材局部构件。
- 暂不进入几何解析，只做字段分型与引用链分析。

### 4.2 变电工程

变电 MOD 共 4179 个。

当前未发现 `CODE / POINTNUM` 模式。

变电 MOD key Top 观察：

| key / 标签特征           |  数量 | 观察                              |
| ------------------------ | ----: | --------------------------------- |
| `<?xml version`          |  4179 | 所有变电 MOD 都疑似 XML-like 文本 |
| `<TransformMatrix Value` | 46250 | 大量变换矩阵                      |
| `<Entity ID`             | 46250 | 大量几何实体                      |
| `<Color R`               | 46250 | 实体颜色                          |
| `<Cylinder R`            | 20421 | 圆柱体图元                        |
| `<Cuboid L`              | 12401 | 长方体图元                        |
| `<StretchedBody Array`   | 10263 | 拉伸体图元                        |
| `<PorcelainBushing R`    |  1506 | 套管 / 绝缘类专用图元候选         |
| `<TruncatedCone TR`      |   730 | 截锥体                            |
| `<Ring DR`               |   235 | 环形图元                          |
| `<Sphere R`              |   141 | 球体                              |
| `<ChannelSteel Model`    |   129 | 槽钢图元候选                      |

当前判断：

- demo-substation 的 MOD 与线路 CODE/POINTNUM 型 MOD 不同。
- demo-substation 的 MOD 更接近 XML-like 基本图元组合。
- 变电 MOD 中确实存在基础图元、颜色、变换矩阵等几何表达。
- 但当前变电 3D 查看已有 IFC 主路径，MOD 暂不进入渲染或解析实现。

---

## 5. PHM 引用链观察

```powershell
cd D:\vibe-coding\gim_viewer

function Export-KeySurvey {
  param(
    [string]$Root,
    [string]$Sample,
    [string]$Pattern,
    [string]$Output
  )

  Get-ChildItem $Root -Recurse -File -Filter $Pattern |
    ForEach-Object {
      $file = $_
      $rel = $file.FullName.Replace((Resolve-Path $Root).Path + "\", "")

      try {
        Get-Content $file.FullName | ForEach-Object {
          $line = $_.Trim()
          if (-not $line) { return }

          if ($line -match "^([^=]+)=") {
            [PSCustomObject]@{
              sample = $Sample
              relativePath = $rel
              extension = $file.Extension.ToLower()
              key = $Matches[1].Trim()
              line = $line
            }
          } else {
            [PSCustomObject]@{
              sample = $Sample
              relativePath = $rel
              extension = $file.Extension.ToLower()
              key = "__CONTINUATION_OR_RAW__"
              line = $line
            }
          }
        }
      } catch {
      }
    } |
    Export-Csv $Output -NoTypeInformation -Encoding UTF8
}

Export-KeySurvey ".\demo\demo-line\Phm" "demo-line" "*.phm" ".\docs\schema\_generated\demo-line-phm-key-survey.csv"
Export-KeySurvey ".\demo\demo-substation\PHM" "demo-substation" "*.phm" ".\docs\schema\_generated\demo-substation-phm-key-survey.csv"

Import-Csv ".\docs\schema\_generated\demo-line-phm-key-survey.csv" |
  Group-Object key |
  Sort-Object Count -Descending |
  Select-Object -First 50 Count, Name |
  Format-Table -AutoSize

Import-Csv ".\docs\schema\_generated\demo-substation-phm-key-survey.csv" |
  Group-Object key |
  Sort-Object Count -Descending |
  Select-Object -First 50 Count, Name |
  Format-Table -AutoSize

Select-String -Path ".\demo\demo-line\Phm\*.phm" -Pattern "MOD|STL|PHM|MODEL|POINTER|\.mod|\.stl|\.phm" -CaseSensitive:$false |
  Select-Object -First 80 Path, LineNumber, Line |
  Format-Table -AutoSize

Select-String -Path ".\demo\demo-substation\PHM\*.phm" -Pattern "MOD|STL|PHM|MODEL|POINTER|\.mod|\.stl|\.phm" -CaseSensitive:$false |
  Select-Object -First 80 Path, LineNumber, Line |
  Format-Table -AutoSize
```

### 5.1 PHM 字段结构

当前两个 demo 的 `.phm` 文件均为 plain text key-value 格式。

PHM 的核心字段模式为：

```text
SOLIDMODELS.NUM=N
SOLIDMODEL0=xxx.mod / xxx.stl
TRANSFORMMATRIX0=...
COLOR0=...
SOLIDMODEL1=xxx.mod / xxx.stl
TRANSFORMMATRIX1=...
COLOR1=...
...
```

字段含义初步判断：

| 字段               | 含义候选                                     | 当前可信度 |
| ------------------ | -------------------------------------------- | ---------- |
| `SOLIDMODELS.NUM`  | 当前 PHM 引用的实体模型数量                  | 高         |
| `SOLIDMODELn`      | 第 n 个实体模型引用，目标为 `.mod` 或 `.stl` | 高         |
| `TRANSFORMMATRIXn` | 第 n 个实体模型的空间变换矩阵                | 高         |
| `COLORn`           | 第 n 个实体模型的颜色                        | 高         |

当前只确认字段角色，不解析矩阵语义，不进行几何渲染。

### 5.2 demo-line PHM

线路 PHM 共 1836 个。

字段统计：

| 字段               | 数量 | 观察                           |
| ------------------ | ---: | ------------------------------ |
| `SOLIDMODELS.NUM`  | 1836 | 每个 PHM 均有实体模型数量      |
| `SOLIDMODEL0`      | 1836 | 每个 PHM 至少引用 1 个实体模型 |
| `TRANSFORMMATRIX0` | 1836 | 每个 PHM 至少有 1 个变换矩阵   |
| `COLOR0`           | 1836 | 每个 PHM 至少有 1 个颜色字段   |
| `SOLIDMODEL1`      | 1300 | 部分 PHM 引用第 2 个实体模型   |
| `TRANSFORMMATRIX1` | 1300 | 第 2 个实体模型对应变换矩阵    |
| `COLOR1`           | 1300 | 第 2 个实体模型对应颜色        |

引用样例显示：

```text
SOLIDMODELS.NUM=2
SOLIDMODEL0=7c6cf87e-9d8c-443f-af96-ad0f81d83291.mod
SOLIDMODEL1=66d18b7e-0a1c-456a-b150-8d3d09288d24.mod
```

也存在引用 STL 的 PHM：

```text
SOLIDMODELS.NUM=1
SOLIDMODEL0=83ebec7e-7e02-4154-9807-1c59d7f7af45.stl
```

当前判断：

- 线路 PHM 稳定承担 `PHM -> MOD/STL` 的组合模型引用角色。
- 大部分线路 PHM 引用 1 到 2 个实体模型。
- `SOLIDMODELn` 的目标可以是 `.mod`，也可以是 `.stl`。
- 当前只记录引用链，不解析 MOD/STL 几何。

### 5.3 demo-substation PHM

变电 PHM 共 4179 个。

字段统计：

| 字段               | 数量 | 观察                                |
| ------------------ | ---: | ----------------------------------- |
| `SOLIDMODELS.NUM`  | 4179 | 每个 PHM 均有实体模型数量           |
| `SOLIDMODEL0`      | 4165 | 绝大多数 PHM 至少引用 1 个实体模型  |
| `TRANSFORMMATRIX0` | 4165 | 绝大多数 PHM 至少有 1 个变换矩阵    |
| `COLOR0`           | 4165 | 绝大多数 PHM 至少有 1 个颜色字段    |
| `SOLIDMODEL1`      |   86 | 少量 PHM 引用第 2 个实体模型        |
| `SOLIDMODEL2+`     | 少量 | 部分 PHM 是多实体组合模型           |
| `SOLIDMODEL16`     |   38 | 少量复杂 PHM 至少包含 17 个实体模型 |

引用样例显示，普通 PHM 通常引用单个 `.mod`：

```text
SOLIDMODELS.NUM=1
SOLIDMODEL0=f0da98cf-841b-4a14-937c-56d9b1e08303.mod
```

复杂 PHM 可同时引用 `.mod` 和多个 `.stl`：

```text
SOLIDMODELS.NUM=17
SOLIDMODEL0=8ae3ef56-4616-4570-95a5-2464124788f9.mod
SOLIDMODEL1=1b09376b-7b7c-4ba1-80a9-6edfe52ea6c6.stl
SOLIDMODEL2=a30a6c55-0c28-4e24-9c07-fa35da9adeeb.stl
...
SOLIDMODEL16=aff58f93-a3bb-4b95-befe-3d16a6b5e89a.stl
```

当前判断：

- 变电 PHM 同样稳定承担 `PHM -> MOD/STL` 的组合模型引用角色。
- 变电 PHM 以单实体 `.mod` 引用为主。
- 少量复杂 PHM 会组合 1 个 `.mod` 与多个 `.stl`。
- `TRANSFORMMATRIXn` 与 `COLORn` 和 `SOLIDMODELn` 成组出现。
- 当前变电 3D 查看已有 IFC 主路径，PHM/MOD/STL 暂不进入渲染实现。

### 5.4 当前引用链结论

基于两个 demo，PHM 层的引用链可以暂定为：

```text
DEV -> PHM -> MOD/STL
```

当前结论：

- PHM 是组合模型 / 装配体层。
- PHM 通过 `SOLIDMODELn` 引用底层 `.mod` 或 `.stl`。
- PHM 通过 `TRANSFORMMATRIXn` 描述各实体模型的空间变换。
- PHM 通过 `COLORn` 描述各实体模型的颜色。
- MOD/STL 是 PHM 的下游几何资源。
- 当前阶段只做 schema analysis，不进入 MOD/STL 几何解析。

## 6. DEV 引用链观察

```powershell
Select-String -Path ".\demo\demo-line\Dev\*.dev" -Pattern "PHM|MODEL|POINTER|\.phm|\.dev" -CaseSensitive:$false |
  Select-Object -First 80 Path, LineNumber, Line |
  Format-Table -AutoSize

Select-String -Path ".\demo\demo-substation\DEV\*.dev" -Pattern "PHM|MODEL|POINTER|\.phm|\.dev" -CaseSensitive:$false |
  Select-Object -First 80 Path, LineNumber, Line |
  Format-Table -AutoSize
```

### 6.1 DEV 字段结构

当前两个 demo 的 `.dev` 文件均为 plain text key-value 格式。

DEV 中出现两类组合字段：

```text
SOLIDMODELS.NUM=N
SOLIDMODEL0=xxx.phm / xxx.dev
SOLIDMODEL1=xxx.phm / xxx.dev
...

SUBDEVICE0=xxx.dev
SUBDEVICE1=xxx.dev
...
```

字段含义初步判断：

| 字段              | 含义候选                                       | 当前可信度 |
| ----------------- | ---------------------------------------------- | ---------- |
| `SOLIDMODELS.NUM` | 当前 DEV 引用的实体模型数量                    | 高         |
| `SOLIDMODELn`     | 第 n 个实体模型引用，目标可为 `.phm` 或 `.dev` | 高         |
| `SUBDEVICEn`      | 第 n 个子设备引用，目标为 `.dev`               | 高         |

当前只确认引用关系，不解释设备专业语义，不递归展开设备组合。

### 6.2 DEV 引用链全量统计

基于 `demo-line` 与 `demo-substation` 的全量 `.dev` 文件统计：

| 样本            | DEV 总数 | 引用 PHM | SOLIDMODEL 引用 DEV | 存在 SUBDEVICE | PHM + SOLIDMODEL DEV 混合 | PHM + SUBDEVICE 混合 | 其他 SOLIDMODEL 目标 |
| --------------- | -------: | -------: | ------------------: | -------------: | ------------------------: | -------------------: | -------------------: |
| demo-line       |     4518 |     1836 |                2682 |              0 |                         0 |                    0 |                    0 |
| demo-substation |     4179 |     4179 |                   0 |            258 |                         0 |                  258 |                    0 |

当前观察：

- demo-line 中，DEV 分为两类：一类直接引用 PHM，一类通过 `SOLIDMODELn` 引用其他 DEV。
- demo-line 中，`SOLIDMODELn=*.phm` 与 `SOLIDMODELn=*.dev` 没有在同一个 DEV 文件中混合出现。
- demo-line 中未发现 `SUBDEVICEn` 字段。
- demo-substation 中，所有 DEV 都直接引用 PHM。
- demo-substation 中，258 个 DEV 同时存在 `SUBDEVICEn=*.dev`，说明部分设备存在子设备组合。
- demo-substation 中未发现 `SOLIDMODELn=*.dev`。
- 两个 demo 中均未发现 `.phm` / `.dev` 之外的 `SOLIDMODELn` 目标。

当前结论：

```text
demo-line:
DEV -> PHM
DEV -> DEV

demo-substation:
DEV -> PHM
DEV -> SUBDEVICE -> DEV
```

因此，DEV 层不能简单建模为单一路径 `DEV -> PHM`。更准确的表达是：

```text
DEV -> PHM -> MOD/STL
DEV -> DEV/SUBDEVICE -> ...
```

当前只确认引用关系，不递归展开设备树，不进入 PHM/MOD/STL 几何解析。

### 6.3 demo-line DEV

线路 DEV 中观察到两类引用：

```text
DEV -> PHM
DEV -> DEV
```

直接引用 PHM 的样例：

```text
SOLIDMODELS.NUM=1
SOLIDMODEL0=c66d61fe-a264-41ea-aa69-844dec863b0b.phm
```

引用多个 DEV 的样例：

```text
SOLIDMODELS.NUM=42
SOLIDMODEL0=bcf219cd-37ec-4cd4-95d9-4bb86e1570e3.dev
SOLIDMODEL1=599e49bd-32e6-4b0d-a17e-2ceb8aa829cb.dev
...
SOLIDMODEL41=782f183f-6242-456b-aba6-ff95000cbd62.dev
```

当前判断：

- 线路 DEV 可以直接引用 PHM。
- 线路 DEV 也可以引用多个子 DEV。
- `SOLIDMODELn` 在线路 DEV 中不只表示 PHM 引用，也可能表示 DEV 子模型引用。
- 因此不能简单写成 `DEV -> PHM` 单一路径。
- 更准确的线路链路是：

```text
DEV -> PHM -> MOD/STL
DEV -> DEV -> ...
```

### 6.4 demo-substation DEV

变电 DEV 中观察到两类引用：

```text
DEV -> PHM
DEV -> SUBDEVICE -> DEV
```

直接引用 PHM 的样例：

```text
SOLIDMODELS.NUM=1
SOLIDMODEL0=43cc25d5-c095-427a-9f0d-9074ab5bf41c.phm
```

子设备引用样例：

```text
SUBDEVICE0=e5071d89-1e66-41ed-bde9-0622fdc6d59f.dev
SUBDEVICE1=c5c9f5e1-d911-409d-9b74-2dd581ff479e.dev
...
SUBDEVICE29=ae3b1d1c-3c4c-49cb-818b-4f9d0f9dff4d.dev
SOLIDMODELS.NUM=1
SOLIDMODEL0=1e90f88c-f2c4-4a98-9e67-88e78a68ef2e.phm
```

当前判断：

- 变电 DEV 可以通过 `SOLIDMODELn` 引用 PHM。
- 变电 DEV 可以通过 `SUBDEVICEn` 引用子 DEV。
- `SUBDEVICEn` 比线路中的 `SOLIDMODELn=xxx.dev` 更明确地表达子设备组合。
- 更准确的变电链路是：

```text
DEV -> PHM -> MOD/STL
DEV -> SUBDEVICE -> DEV -> ...
```

### 6.5 当前引用链结论

基于当前两个 demo，CBM 层当前观察到三类下游引用：

```text
CBM -> DEV -> PHM -> MOD/STL
CBM -> IFCFILE + IFCGUID -> IFC
CBM -> SUBDEVICE -> CBM -> ...

CBM
 ├─ OBJECTMODELPOINTER -> DEV
 │   ├─ SOLIDMODEL -> PHM -> SOLIDMODEL -> MOD/STL
 │   └─ SOLIDMODEL/SUBDEVICE -> DEV
 ├─ BASEFAMILY -> FAM
 ├─ SUBDEVICE -> CBM
 └─ IFCFILE + IFCGUID -> IFC
```

其中：

- `CBM -> DEV`：通过 `OBJECTMODELPOINTER=*.dev` 建立。
- `CBM -> FAM`：通过 `BASEFAMILY=*.fam` 建立。
- `CBM -> IFC`：通过 `IFCFILE + IFCGUID` 建立，当前只在 demo-substation 中观察到。
- `CBM -> CBM`：通过 `SUBDEVICEn=*.cbm` 建立递归层级。
- `DEV -> PHM`：当前 demo 已观察到。
- `DEV -> DEV`：当前 demo 已观察到。
- `PHM -> MOD/STL`：当前 demo 已观察到。
- `MOD/STL`：当前作为底层几何资源，不进入当前 MVP 解析。

当前阶段只记录引用链，不实现递归物理模型展开，不渲染 PHM/MOD/STL。

## 当前结论

- `.cbm / .fam / .dev / .phm / .mod` 均可作为文本或准文本文件进入 analysis。
- `.stl` 当前按 binary-like 三角网格资源处理。
- `.ifc` 当前只在 demo-substation 中出现，且位于 DEV 目录。
- MOD 不能统一定义为 XML，也不能统一定义为 CODE/POINTNUM 点线格式。
- MOD 在变电与线路中表现出不同表层格式。
- 当前阶段只做格式分型、字段分布、引用链分析，不进入几何解析。
- PHM 通过 `SOLIDMODELn` 引用 `.mod` 或 `.stl`，承担组合模型 / 装配体角色。
- DEV 可以通过 `SOLIDMODELn` 引用 `.phm` 或 `.dev`。
- DEV 可以通过 `SUBDEVICEn` 引用子 `.dev`，说明设备物理模型存在递归组合关系。
- DEV / PHM 层文件级引用完整性已完成校验，当前两个 demo 中 `DEV -> PHM/DEV`、`PHM -> MOD/STL` 的引用目标均存在。
- CBM 通过 `OBJECTMODELPOINTER` 指向 `.dev`，并已完成当前两个 demo 的文件存在性校验。
- CBM 通过 `BASEFAMILY`、`SUBDEVICEn`、`IFCFILE` 建立 FAM / CBM / IFC 引用，当前两个 demo 中引用目标均存在。
- 当前完整静态链路已可闭合到文件存在性层面，但尚未进入 MOD/STL 几何解析和 IFCGUID 内部构件命中校验。

## 脚本
### Step 1：运行 MOD 静态分型脚本
```powershell
cd D:\vibe-coding\gim_viewer

$sampleId = "demo-line1"
$sampleRoot = ".\demo\$sampleId"
$outDir = ".\docs\schema\_generated\$sampleId"

New-Item -ItemType Directory -Force $outDir | Out-Null

function Get-GimDir($root, $name) {
  $dir = Get-ChildItem $root -Directory |
    Where-Object { $_.Name -ieq $name } |
    Select-Object -First 1

  if (-not $dir) {
    throw "Cannot find directory: $name under $root"
  }

  return $dir.FullName
}

$modRoot = Get-GimDir $sampleRoot "Mod"

function Read-TextFileLoose($path) {
  $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $path))

  if ($bytes.Length -eq 0) {
    return ""
  }

  try {
    return [System.Text.Encoding]::UTF8.GetString($bytes)
  } catch {
    return [System.Text.Encoding]::Default.GetString($bytes)
  }
}

function Classify-ModText($text) {
  if ($null -eq $text -or $text.Trim().Length -eq 0) {
    return "EMPTY"
  }

  $trimmed = $text.TrimStart()

  if ($trimmed -match "^<\?xml" -or $trimmed -match "^<Device") {
    if ($trimmed -match "<Entities\s*/>") {
      return "XML_EMPTY_DEVICE"
    }

    if ($trimmed -match "<Entity") {
      return "XML_WITH_ENTITIES"
    }

    return "XML_OTHER"
  }

  if (
    $text -match "(?m)^CODE\s*=" -and
    $text -match "(?m)^POINTNUM\s*=" -and
    $text -match "(?m)^LINENUM\s*="
  ) {
    return "TEXT_POINT_LINE"
  }

  if ($text -match "(?m)^HNum\s*,") {
    return "TEXT_HNUM_COMMA_RECORD"
  }

  $lines = $text -split "`r?`n" |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -ne "" }

  if ($lines.Count -eq 0) {
    return "EMPTY"
  }

  $firstLine = $lines[0]
  $kvLineCount = ($lines | Where-Object { $_ -match "^[A-Za-z0-9_.-]+\s*=" }).Count

  if ($firstLine -notmatch "=" -and $kvLineCount -gt 0) {
    return "TEXT_SECTION_KV_RECORD"
  }

  if ($kvLineCount -gt 0) {
    return "TEXT_KEY_VALUE"
  }

  if ($text -match "," -and $text -match "[0-9]") {
    return "TEXT_COMMA_NUMERIC"
  }

  return "TEXT_UNKNOWN"
}

$modProfileCsv = "$outDir\$sampleId-mod-static-profile.csv"

Get-ChildItem $modRoot -File -Filter *.mod |
  ForEach-Object {
    $file = $_
    $text = Read-TextFileLoose $file.FullName
    $kind = Classify-ModText $text

    $firstNonEmptyLine = (
      $text -split "`r?`n" |
      ForEach-Object { $_.Trim() } |
      Where-Object { $_ -ne "" } |
      Select-Object -First 1
    )

    [PSCustomObject]@{
      sample = $sampleId
      relativePath = $file.FullName.Replace((Resolve-Path $sampleRoot).Path + "\", "")
      fileName = $file.Name
      length = $file.Length
      kind = $kind
      firstLine = $firstNonEmptyLine
    }
  } |
  Export-Csv $modProfileCsv -NoTypeInformation -Encoding UTF8

$mods = Import-Csv $modProfileCsv

"=== MOD STATIC PROFILE ==="
$mods |
  Group-Object kind |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize

"=== MOD SAMPLE BY KIND ==="
$mods |
  Group-Object kind |
  ForEach-Object {
    $_.Group |
      Select-Object -First 3 kind, relativePath, length, firstLine
  } |
  Format-Table -AutoSize
```

### Step 2：如果出现 TEXT_UNKNOWN，再看样本内容
```powershell
$unknownMods = $mods | Where-Object { $_.kind -eq "TEXT_UNKNOWN" }

"=== UNKNOWN MOD COUNT ==="
$unknownMods.Count

$unknownMods |
  Select-Object -First 20 relativePath, length, firstLine |
  Format-Table -AutoSize

# 如果 TEXT_UNKNOWN > 0，再随机打开几个：
$unknownMods |
  Select-Object -First 5 |
  ForEach-Object {
    "===== $($_.relativePath) ====="
    Get-Content ".\demo\$sampleId\$($_.relativePath)" -Encoding UTF8 -TotalCount 40
  }  
```