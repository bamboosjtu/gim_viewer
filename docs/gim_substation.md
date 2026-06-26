# 变电 GIM 文件格式与可视化

> 变电站工程（GIMPKGS）的文件结构、解析流程与 3D 可视化。

---

## 1. GIM 文件容器

`.gim` 文件是自定义格式（非标准 ZIP）：

```
偏移 0:    GIMPKG* 头部（变长，含项目编号和名称，零填充）
偏移 N:    7z 或 ZIP 压缩数据（在头部之后 1MB 窗口内搜索签名定位）
```

| 头部魔数 | 工程类型 |
|---|---|
| `GIMPKGS` | 变电站（Transformer Substation） |

**压缩数据定位**：在 GIMPKG* 头部之后 1MB 窗口内搜索：

- 7z 签名：`37 7A BC AF 27 1C`
- ZIP 签名：`50 4B 03 04`

**解压**：libarchive.js（WebAssembly）解压后展平为 `Map<path, File>`。

---

## 2. 解压后目录结构

```
XX变电站新建.gim/
├── CBM/     # 工程层级结构文件（.cbm / .fam）
├── DEV/     # 设备定义与IFC文件（.dev / .fam / .ifc）
├── PHM/     # 组合模型文件（.phm）
└── MOD/     # 基础几何模型文件（.mod）
```

| 目录 | 文件类型 | 职责 |
|---|---|---|
| CBM/ | `.cbm`, `.fam` | 构建工程层级树，从工程根到设备级 |
| DEV/ | `.dev`, `.fam`, `.ifc` | 设备属性与参数，IFC 承载三维建筑信息模型 |
| PHM/ | `.phm` | 组合模型，将多个 MOD 组装为可复用设备模型 |
| MOD/ | `.mod` | 基础几何模型（XML 格式），定义最底层几何形状与材质 |

---

## 3. CBM 层级结构

入口文件：`CBM/project.cbm`

```
BLHA=<纬度>,<经度>,<海拔>,<方向角>
SUBSYSTEM=<UUID>.cbm
SCH=project.sch
TYPE=TS
```

### 层级树

```
project.cbm（工程根）
└── 一级子系统.cbm（F1System）
    ├── 二级子系统.cbm
    │   └── 三级子系统.cbm → ... → 设备级.cbm
    ├── IFC0~N → *.ifc（DEV目录）
    └── SCH → project.sch → *.std + *.sld
```

### 引用键

| 键 | 含义 |
|---|---|
| `SUBSYSTEMS.NUM` / `SUBSYSTEM0~N` | 子系统 CBM 文件引用 |
| `IFC.NUM` / `IFC0~N` | IFC 文件引用（位于 DEV 目录） |
| `OBJECTMODELPOINTER` | 设备到 DEV 文件的引用 |
| `BASEFAMILY` | 基础族文件引用（.fam） |
| `SCH` | 逻辑模型引用（.sch） |

---

## 4. IFC 文件

变电工程包含 12 个 IFC 文件（示例工程），按专业分组：

| 专业 | 示例 IFC 文件 |
|---|---|
| 电气 | 电气二次、动力照明、接地、一次设备 |
| 建筑 | 建筑部分、警卫室建筑 |
| 结构 | 基础、结构 |
| 给排水 | 给排水消防、室内给排水 |
| 暖通 | 暖通布置 |
| 总图 | 总图 |

### FileDevRelation

`FileDevRelation.cbm` 记录 IFC 文件与设备的映射关系（示例工程共 24 条映射）。

---

## 5. 逻辑模型

```
project.cbm → SCH=project.sch → zjx.std + zjx.sld
```

| 文件 | 格式 | 职责 |
|---|---|---|
| `project.sch` | 文本 | 逻辑模型入口，引用 std 和 sld |
| `zjx.std` | XML | 变电站逻辑模型定义（电压等级、间隔、设备） |
| `zjx.sld` | SVG | 主接线图（电气元件符号和连接关系） |

---

## 6. 解析与可视化流程

```
读取 .gim 文件
  ↓
检测 GIMPKGS 头部
  ↓
定位 7z/ZIP 压缩数据偏移
  ↓
libarchive.js 解压 → Map<path, File>
  ↓
遍历 CBM 树 → 发现 IFC 文件
  ↓
用户选择 IFC
  ↓
web-ifc 解析 IFC → OBC Fragments 转换 → Three.js 渲染
  ↓
点击拾取 → 高亮构件 + 展示 IFC 属性 + 关联 GIM 设备
```

### 3D 渲染栈

| 层 | 模块 | 职责 |
|---|---|---|
| 引擎 | `viewer/viewerEngine.ts` | OBC Components 初始化 |
| 单例 | `viewer/viewerRuntime.ts` | Viewer 懒加载（首次加载 IFC 时创建） |
| 加载 | `viewer/ifcLoader.ts` | IFC → Fragments 转换 |
| 懒加载 | `viewer/ifcEntryLoader.ts` | 节点级按需加载（含 Fragments 缓存休眠分支） |
| 拾取 | `viewer/selection.ts` + `viewer/highlight.ts` | raycast 高亮 + 构件选中 |
| 相机 | `viewer/camera.ts` | 构件定位 |
| 名称索引 | `viewer/ifcNameIndex.ts` | GUID→Name 批量查询 |

### 层级树↔3D 联动

选中设备节点 → 高亮对应 IFC 构件 + 相机定位。

---

## 7. SQLite 缓存

### 变电工程表（7 张）

| 表 | 用途 |
|---|---|
| `gim_project` | 项目记录（path, sha256, size, parser_version, project_type） |
| `gim_entry` | GIM 内部文件清单 |
| `cbm_node` | CBM 层级节点（树形结构，含 ifc_file/ifc_guid 引用） |
| `ifc_model` | IFC 文件索引 |
| `file_dev_entry` | IFC↔设备 CBM 映射 |
| `fam_property` | FAM 分节属性缓存 |
| `dev_property` | DEV 关键属性缓存 |

### 缓存命中流程

1. 用户选择 GIM → Rust 计算 sha256 + file_size
2. `validate_gim_cache`：检查 parser_version + file_size + IFC 缓存文件存在性
3. 命中 → 读取全部索引 → 恢复到 AppState → 直接渲染树和面板
4. 未命中 → 完整解压 → 解析 → 入库 → 缓存 IFC 文件到本地磁盘

### IFC 本地缓存

IFC 文件写入 `app_data_dir/extracted/{id}/`，路径遍历防护。

---

## 8. 属性面板

右侧可折叠抽屉，展示：

- **FAM 设计参数**：分节属性（从 fam_property 缓存或 currentFiles 读取）
- **DEV 设备信息**：关键属性（从 dev_property 缓存或 currentFiles 读取）
- **IFC 属性集**：web-ifc 原生属性

缓存命中时（currentFiles=null）仍可显示 CBM/FAM/DEV 基础属性。
