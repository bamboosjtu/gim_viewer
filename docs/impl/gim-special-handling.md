# GIM 特殊格式处理

本文说明 GIM 容器、归档解压、语义/几何缓存和 XML MOD primitive 的处理策略。格式字段与样本统计见 [Schema](../schema/README.md)，样本证据见 [sample-corpus](../schema/sample-corpus.md)。

## 1. 为什么需要特殊处理

`.gim` 不是标准 ZIP/7z 文件：

- 文件开头是 `GIMPKGS`（变电）或 `GIMPKGT`（线路）自定义头，含工程身份与零填充；
- 压缩数据从头部之后的某个偏移开始，需在 1 MiB 窗口内搜索 7z/zip 签名定位；
- 内部路径大小写不统一，线路常用 PascalCase、变电常用大写目录；
- 文件之间的引用是 GUID 裸名，不能按目录或数组序号硬编码；
- MOD 有 XML（变电）与多种文本格式（线路），同一 primitive 的标签大小写/别名不统一。

## 2. 容器与解压

### 2.1 头部与偏移

1. 读取文件头，识别 `GIMPKGS`/`GIMPKGT`，解析工程编号/名称；
2. 在固定窗口内搜索 `37 7A BC AF 27 1C`（7z）或 `50 4B 03 04`（zip）；
3. 校验归档偏移、条目路径、重复路径、声明的解压大小与配额；
4. 只把偏移后的归档载荷交给解码器，GIM 头不进入解压器。

### 2.2 流式解压（桌面）

- 发布版只有一个 `GIM-Reader.exe`；7-Zip 的 `7z.exe`/`7z.dll` 以字节资源嵌入主程序。
- 首次使用时释放到系统临时目录（`%TEMP%\gim-viewer-7zip/<版本>/`）。
- 解压时把归档载荷切片写入临时 `.7z`，运行 `7z e -so`，按归档顺序把连续字节流切成条目，再交给现有 sink：
  - IFC 独立文件；
  - 其余变电源条目写入连续 semantic pack；
  - 线路语义条目写入线路 pack。
- 7z 不可用时回退纯 Rust `sevenz-rust`；失败必须显式报错，不能把部分结果当完整缓存。
- 所有条目先做大小/配额/路径安全校验；解压结果通过 staging 目录原子提交。

### 2.3 缓存布局与校验

- 解压后写 `.gim-extract-manifest.json`，记录条目、大小、pack 偏移/独立路径。
- 暖启动校验源 SHA、项目身份、parser 版本、manifest 结构、pack/IFC 可读性；
- 截断/损坏 manifest 或 pack 视为 miss 并重建，不能静默接受坏缓存；
- 工程切换时清理旧 staging；中断发布保留第一阶段索引，下次补齐。

## 3. 语义与几何引用

### 3.1 CBM 树

- 变电入口 `project.cbm`：F1 → F2 → F3 → F4/PARTINDEX → 设备；
- 线路入口：F1–F3 → F4（TOWER/WIRE/CROSS）→ TOWER/WIRE/CROSS；
- 子节点通过 `SUBSYSTEM(S)`、`SUBDEVICE(S)`、`GROUPS` 等引用；不能按数组序号解释为身份。

### 3.2 DEV / PHM / MOD / STL / GL

- CBM 的 `OBJECTMODELPOINTER` → DEV；
- DEV 的 `SOLIDMODELn` → PHM；
- PHM 的 `SOLIDMODELn` → MOD/STL（可嵌套 PHM）；
- `TRANSFORMMATRIXn` 逐边相乘，递归防环；
- 同 UUID `.gl` 是可选辅助来源，不自动加入 SOLIDMODEL 主链；
- PARTINDEX → child DEV 按 `OBJECTMODELPOINTER` 身份关联，不按序号；
- 缓存命中、冷读、raw 回退共用同一引用语义。

### 3.3 查询与路径

- 引用值通常是 GUID 裸名；目录前缀由引用类型决定，但查找必须大小写不敏感；
- 文件发现与 IFC GUID 关联是独立能力，不能写死 `DEV/` 或 `CBM/`；
- 禁止路径穿越、重复路径、符号链接/reparse point；解压与读取均做配额与边界检查。

## 4. XML MOD primitive

变电 MOD 为 XML。解析器先把标签转小写并做 canonical 映射，再走强类型几何。未知标签保留为 `Unsupported`，不伪造几何。

### 4.1 强类型与浏览近似

| 来源标签 | 处理 | 忽略/近似 |
|---|---|---|
| Cuboid / Cylinder / Sphere / TruncatedCone / Ring / CircularGasket | 直接几何 | — |
| `Insulator` / `VTypeInsulator` | 映射 `PorcelainBushing`（H1×N1，R1/R2） | V 串按单串处理 |
| `ConePorcelainBushing` | 映射 `PorcelainBushing`（BR2/TR2/TR1） | — |
| `EccentricTruncatedCone` | 映射 `TruncatedCone` | 偏心量 |
| `SquareGasket` / `TableGasket` | 矩形框（4 块板） | 圆角/孔洞 |
| `EllipticRing` | 映射 `Ring`（LR/WR 平均半径） | 椭圆截面 |
| `BendingCylindrical` | 映射 `Cylinder`（R×L） | 弯曲半径/角度 |
| `CircularFixedPlate` | 圆盘（L/D 为直径，T 为厚） | 螺栓孔 |
| `RectangularFixedPlate` | 矩形板 | 孔洞 |
| `RectangularRing` | 4 块板组成的矩形框 | 孔洞/圆角 |
| `ChannelSteel` / `Table` | 外廓盒体 | 截面细节 |
| `H` / `h-beam` | H 型钢 | 圆角/坡口 |
| `Wire` / `Cable` | 拟合点/拐点样条圆管 | 远景 LOD0 最小半径 150 mm、LOD1 50 mm；LOD2 用真实 D，不把浏览半径当线径 |
| `DoubleChannelSteel` | 映射 `ChannelSteel` | 双拼细节 |
| `Boolean` | union/intersection/difference | 复杂开洞可能计入 simplifiedBooleans |

规则：

- 标签大小写不敏感；`h-beam`、`DoubleChannelSteel` 等别名统一映射。
- 无法稳定解释的字段（偏心、弯曲、孔洞、螺栓孔）**不参与几何**，并在诊断中按可见根记录；
- 所有映射都是**浏览近似**，不能用于尺寸复核、安装或工程量计算；
- 未知 primitive 不生成占位体，返回 `Unsupported` 并在属性面板/诊断中可检索。

### 4.2 弱 schema

`RectangularFixedPlate`、`OffsetRectangularTable`、`RectangularRing` 在部分样本中没有强 schema，按属性名读取；缺字段时宁可降级为板/框，不构造不可信复杂体。

### 4.3 线路 MOD

线路 MOD 不是 XML，存在四类文本格式族（HNum/节段/点线/其他）。线路使用专门的文本解析器，不能套用变电 XML 映射；HNum 预览只做局部骨架投影，不代表完整实体。

## 5. 源几何异常与失败语义

- 源矩阵/包围盒超出合理范围（如 10¹⁴ mm 级平移）时标记 `source-invalid`，不渲染、不局部保留，保留源值与证据供追溯；
- 依赖缺失、解析失败、空 DEV、PHM 无 SOLIDMODEL、parser 不支持分别记录原因，冷/暖/raw 路径尽量一致；
- 临时 I/O 失败不能被持久化为 `source-invalid`；缓存写入失败只影响缓存完整性，不伪造几何；
- 失败隔离到 DEV/对象，不能因为一个坏源丢弃整个工程。

## 6. 代码索引（新人先看这里）

| 关注点 | 入口 |
|---|---|
| GIM 头/归档偏移 | `crates/gim-native-core/src/lib.rs`（`parse_archive_prefix`、`inspect_archive_entries`） |
| 桌面解压命令/配额/缓存提交 | `desktop/src-tauri/src/gim_extract_command.rs` |
| 7-Zip CLI 流式解压 | `desktop/src-tauri/src/seven_zip_cli.rs` |
| 缓存数据库/manifest/pack | `desktop/src-tauri/src/db.rs`、`gim_extract.rs` |
| CBM 解析/树 | `desktop/src/gim/cbmParser.ts` |
| DEV/PHM 引用发现 | `desktop/src/services/modGeometryDiscovery.ts` |
| XML MOD 解析 | `desktop/src/gim/geometry/xmlModParser.ts` |
| XML primitive → 几何 | `desktop/src/viewer/xmlModGeometry.ts`、`xmlModLoader.ts` |
| 线路文本 MOD | `desktop/src/gim/geometry/lineModParser.ts` |

## 7. 解压与 manifest 机制

### 7.1 头解析

1. 读取文件前 1 MiB；搜索 7z/zip 签名，得到归档偏移；
2. 解析 `GIMPKGS`/`GIMPKGT` 及工程编号/名称；
3. 用 `OffsetReader` 把归档偏移包装成从 0 开始的 Read+Seek 流，7z 解码器不需要知道 GIM 头；
4. 对 ZIP 使用同样偏移处理，走 zip 分支。

### 7.2 条目校验顺序

每个条目在写入前依次检查：

- 路径规范化与目录穿越；
- 重复路径（大小写不敏感）；
- 声明大小/累计大小/归档大小配额；
- 输出路径安全检查（符号链接/reparse point、staging 根边界）。

任一失败即终止整次解压，不能留下“部分有效”的缓存。

### 7.3 staging 与 manifest

- 解压写入 `staging` 目录，完成后原子 rename 到正式缓存根；
- manifest 记录条目路径、大小、pack 偏移或独立 IFC 路径；
- commit 前写 receipt/索引；中断时保留 staging 或已发布第一阶段；
- 暖启动校验 manifest 与 pack，不通过则重建，不静默跳过。

### 7.4 semantic pack

- 变电：非 IFC 条目（CBM/DEV/FAM/PHM/MOD/STL 等）顺序写入一个 pack；IFC 独立文件；
- 线路：语义条目写线路 pack；大 MOD/STL 可仅记录 metadata；
- 读取时按索引区间懒读，避免数万次 open；路径仍按大小写不敏感查找。

## 8. XML MOD 解析机制

### 8.1 解析步骤

1. 轻量 XML tokenizer 读取节点与属性，保留原始属性名；
2. `tagName` 转小写，查 `PRIMITIVE_CANONICAL_NAMES` 得到规范名；未知标签保留原名；
3. 按规范名进入强类型 parse 分支；弱 schema 类型保留 raw attrs，由几何层按属性名读取；
4. 数值字段用 `firstNumericAttr` 依次尝试别名（如 R1/R、H1/H、L/D），缺省时用保守默认值；
5. 产出的 `XmlModPrimitive` 进入几何烘焙；无法解释的标签变成 `Unsupported`。

### 8.2 为什么用 canonical map

不同导出器会写 `Rectangularfixedplate`、`H-beam`、`DoubleChannelSteel` 等变体。统一转小写并映射，避免每个 parse 分支重复大小写判断；别名只影响标签识别，不改变属性单位。

### 8.3 弱 schema 与近似

- `RectangularFixedPlate`/`RectangularRing`/`OffsetRectangularTable` 在部分样本无强 schema；
- 宁可用板/框近似，也不构造无法验证的复杂体；
- 所有近似都保留原始 attrs，属性面板/诊断可回溯；
- `Boolean` 只接受 union/intersection/difference；其他 op 降级为 Unsupported，简化布尔计入 `simplifiedBooleans`。

### 8.4 单位与矩阵

- XML/PHM 的变换矩阵是逐边累积，不是最终世界矩阵；
- 几何烘焙把 mm→m 和 DEV×PHM placement 烘焙到顶点；
- 不要在读取层预乘父矩阵，否则会在 scene commit 时重复变换。

### 8.5 新增 primitive 的步骤

1. 在 `PRIMITIVE_CANONICAL_NAMES` 注册规范名/别名；
2. 在 `xmlModParser` 增加 parse 分支，明确必填/可选属性与单位；
3. 在 `xmlModGeometry` 增加几何构造；若近似，写清忽略字段；
4. 加 parser + geometry 测试（至少一个真实样本属性形状）；
5. 更新本文件映射表与 [schema/README](../schema/README.md)（如格式定义变化）。

## 9. 常见坑

- **路径大小写**：不能用 `includes('DEV/')` 判断，必须大小写不敏感查找。
- **数组序号不是身份**：PARTINDEX/SUBDEVICE 必须按指针/身份关联；同 DEV 可多次实例化。
- **父矩阵**：每个 occurrence 的 placement 独立，模板不烘焙 occurrence 变换。
- **单位**：CBM/DEV 常见 mm，场景为 m；只在烘焙边界换算一次。
- **失败不要伪装**：缺依赖、空 DEV、未知 primitive、source-invalid 是不同原因，不能统一成“空”。
- **近似不是测量**：XML primitive 映射仅用于浏览。

## 10. 验证入口

- 样本与格式统计：[sample-corpus](../schema/sample-corpus.md)
- CBM/DEV/PHM/MOD 引用与 XML 字段：[geometry-model](../schema/geometry-model.md)、[semantic-model](../schema/semantic-model.md)
- 解压/缓存验证：[validation](../validation.md)
- 近景/IFC LOD 策略：[performance-lod](performance-lod.md)
