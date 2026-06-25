# DEV 文件格式

## 文件概述

DEV（Device）文件是 GIM 工程中描述物理设备的文件，采用键值对文本格式。DEV 文件定义了设备的基本信息、符号类型、子设备以及关联的三维几何模型。一个 DEV 文件可以包含多个几何模型引用，每个模型通过变换矩阵定义其在空间中的位置、旋转和缩放。

## 文件格式

- **编码**：UTF-8
- **行分隔符**：换行符
- **键值分隔符**：`=`
- **列表索引**：从 0 开始（如 `SUBDEVICES0`、`SOLIDMODEL0`）

## 字段说明

| 字段 | 格式 | 说明 |
|------|------|------|
| `BASEFAMILY` | `<uuid>.fam` | 引用对应的属性文件 |
| `SYMBOLNAME` | `<名称>` | 设备符号名称，如 `空开`、`柜体` |
| `TYPE` | `<类型>` | 设备类型，如 `OTHERS` |
| `SUBDEVICES.NUM` | `<N>` | 子设备数量 |
| `SUBDEVICES0` ~ `SUBDEVICESN` | `<uuid>.dev` | 引用子设备 DEV 文件 |
| `SOLIDMODELS.NUM` | `<N>` | 组合模型引用数量 |
| `SOLIDMODEL0` ~ `SOLIDMODELN` | `<uuid>.phm` | 引用组合模型（PHM 文件） |
| `TRANSFORMMATRIX0` ~ `TRANSFORMMATRIXN` | `<16个浮点数>` | 对应模型的 4×4 变换矩阵 |

### 变换矩阵格式

4×4 变换矩阵按**行优先**展开为 16 个浮点数，以英文逗号分隔：

```
M00,M01,M02,M03,M10,M11,M12,M13,M20,M21,M22,M23,M30,M31,M32,M33
```

对应矩阵：

```
| M00  M01  M02  M03 |
| M10  M11  M12  M13 |
| M20  M21  M22  M23 |
| M30  M31  M32  M33 |
```

其中：
- 左上角 3×3 子矩阵（M00~M22）控制旋转和缩放
- 最后一列（M03, M13, M23）控制平移（X, Y, Z 方向）
- 最后一行固定为 `0,0,0,1`

**单位矩阵**：`1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1`

`SOLIDMODELS.NUM`、`SOLIDMODEL<i>` 和 `TRANSFORMMATRIX<i>` 三者通过索引 `i` 一一对应。

## 引用关系

```
DEV 文件
├── BASEFAMILY → <uuid>.fam     → 属性文件
├── SUBDEVICES0 → <uuid>.dev    → 子设备（递归结构）
├── SOLIDMODEL0 → <uuid>.phm    → 组合模型
│   └── PHM 文件
│       └── <uuid>.mod          → 几何模型
└── TRANSFORMMATRIX0            → 定义 SOLIDMODEL0 的空间变换
```

## 示例

### 简单设备

```
BASEFAMILY=a1b2c3d4-e5f6-7890-abcd-ef1234567890.fam
SYMBOLNAME=空开
TYPE=OTHERS
SOLIDMODELS.NUM=1
SOLIDMODEL0=b2c3d4e5-f6a7-8901-bcde-f12345678901.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
```

### 含子设备和多个模型的设备

```
BASEFAMILY=c3d4e5f6-a7b8-9012-cdef-123456789012.fam
SYMBOLNAME=柜体
TYPE=OTHERS
SUBDEVICES.NUM=2
SUBDEVICES0=d4e5f6a7-b8c9-0123-defa-234567890123.dev
SUBDEVICES1=e5f6a7b8-c9d0-1234-efab-345678901234.dev
SOLIDMODELS.NUM=2
SOLIDMODEL0=f6a7b8c9-d0e1-2345-fabc-456789012345.phm
TRANSFORMMATRIX0=1,0,0,100,0,1,0,200,0,0,1,0,0,0,0,1
SOLIDMODEL1=a7b8c9d0-e1f2-3456-abcd-567890123456.phm
TRANSFORMMATRIX1=0.7071,0.7071,0,0,-0.7071,0.7071,0,0,0,0,1,500,0,0,0,1
```
