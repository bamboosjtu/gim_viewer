# PHM 文件格式

## 文件概述

PHM（Physical Model / Assembly）文件是 GIM 工程中描述组合模型的文件，采用键值对文本格式。PHM 文件将多个基础几何模型（MOD 文件）或 STL 网格模型组装在一起，每个引用的模型通过独立的变换矩阵定义其在组合体中的空间位置，并可指定颜色。

PHM 是 DEV 与 MOD 之间的中间层，实现了模型的组合复用。

## 文件格式

- **编码**：UTF-8
- **行分隔符**：换行符
- **键值分隔符**：`=`
- **列表索引**：从 0 开始

## 字段说明

| 字段 | 格式 | 说明 |
|------|------|------|
| `SOLIDMODELS.NUM` | `<N>` | 引用的几何模型数量 |
| `SOLIDMODEL0` ~ `SOLIDMODELN` | `<uuid>.mod` 或 `<uuid>.stl` | 引用几何模型文件（MOD 或 STL） |
| `TRANSFORMMATRIX0` ~ `TRANSFORMMATRIXN` | `<16个浮点数>` | 对应模型的 4×4 变换矩阵（行优先，逗号分隔） |
| `COLOR0` ~ `COLORN` | `<颜色值>` | 对应模型的颜色值（可为空） |

`SOLIDMODEL<i>`、`TRANSFORMMATRIX<i>` 和 `COLOR<i>` 三者通过索引 `i` 一一对应。

### 变换矩阵格式

与 DEV 文件中的变换矩阵格式相同，4×4 矩阵按行优先展开为 16 个浮点数，逗号分隔。单位矩阵为 `1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1`。

## 引用关系

```
PHM 文件
├── SOLIDMODEL0 → <uuid>.mod    → 几何模型（MOD 文件）
│   └── MOD 文件
│       └── Entity 列表（几何图元）
├── SOLIDMODEL1 → <uuid>.stl    → STL 网格模型
├── SOLIDMODEL2 → <uuid>.phm    → 同级 PHM 文件（组合嵌套）
└── ...
```

PHM 可引用以下类型：
- **MOD 文件**：基础几何模型，包含几何图元定义
- **STL 文件**：标准三角网格模型
- **同级 PHM 文件**：实现组合模型的嵌套复用

## 示例

### 单模型组合

```
SOLIDMODELS.NUM=1
SOLIDMODEL0=a1b2c3d4-e5f6-7890-abcd-ef1234567890.mod
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
COLOR0=
```

### 多模型组合

```
SOLIDMODELS.NUM=3
SOLIDMODEL0=a1b2c3d4-e5f6-7890-abcd-ef1234567890.mod
TRANSFORMMATRIX0=1,0,0,100,0,1,0,0,0,0,1,0,0,0,0,1
COLOR0=128,128,128
SOLIDMODEL1=b2c3d4e5-f6a7-8901-bcde-f12345678901.mod
TRANSFORMMATRIX1=1,0,0,0,0,1,0,200,0,0,1,0,0,0,0,1
COLOR1=200,50,50
SOLIDMODEL2=c3d4e5f6-a7b8-9012-cdef-123456789012.stl
TRANSFORMMATRIX2=1,0,0,0,0,1,0,0,0,0,1,500,0,0,0,1
COLOR2=
```

### 嵌套组合（引用同级 PHM）

```
SOLIDMODELS.NUM=2
SOLIDMODEL0=d4e5f6a7-b8c9-0123-defa-234567890123.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
COLOR0=
SOLIDMODEL1=e5f6a7b8-c9d0-1234-efab-345678901234.mod
TRANSFORMMATRIX1=1,0,0,1000,0,1,0,0,0,0,1,0,0,0,0,1
COLOR1=100,100,200
```
