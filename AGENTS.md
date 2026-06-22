# AGENTS.md — 项目上下文

> 本文件为 AI 编码助手提供项目上下文，帮助理解项目结构和约定。

## 项目定位

GIM（Grid Information Model，电网信息模型）文件浏览器。国家电网的 GIM 标准基于 IFC 扩展而来，`.gim` 文件是电力行业专有的工程信息模型格式。

- **Tauri 2 桌面应用**（Rust 后端 + Vite 前端），离线运行，portable ZIP 发布
- **两类工程**：变电（CBM 层级树 + IFC 3D + MOD/STL 几何）与线路（地图 + 塔位/导线/跨越点）
- **SQLite 缓存**：首次解压解析入库，二次打开缓存命中秒开

## 核心概念

### GIM 文件结构

`.gim` 文件不是标准 ZIP，而是自定义格式：

```
偏移 0:    GIMPKG* 头部（变长，含项目编号和名称，零填充；GIMPKGS=变电 / GIMPKGT=线路）
偏移 N:    7z 或 ZIP 压缩数据（1MB 窗口内搜索签名定位）
```

- 7z 签名：`37 7A BC AF 27 1C`
- ZIP 签名：`50 4B 03 04`

解压后四个目录：CBM/（工程骨架）、DEV/（设备，含 IFC）、PHM/（装配体）、MOD/（几何图元）。
变电目录全大写（CBM/DEV/MOD/PHM），线路为 PascalCase（Cbm/Dev/Mod/Phm），路径处理必须大小写不敏感。

### CBM 层级

CBM 文件构成树形层级，入口为 `project.cbm`：
- 变电站工程：F1System → F2System → F3System → F4System/PARTINDEX → 设备
- 线路工程：F1-F3System → F4System(GROUPTYPE=TOWER) → TOWER/WIRE/CROSS

### 文件格式

所有文本格式文件（.cbm, .dev, .phm, .fam, .sch, .mod 文本族）使用 `KEY=VALUE` 变体格式。
.mod 变电侧为 XML、线路侧为四类文本格式族；.sld 为 SVG；.std 为 XML。
详细格式说明见 `docs/schema/`（22 号文档为十样本复核结论）。

## 技术栈与架构

| 层 | 技术 |
|---|---|
| 桌面框架 | Tauri 2（Rust：SQLite rusqlite / sha256 / 原生 7z+ZIP 解压） |
| 3D 渲染 | @thatopen/components (OBC) + web-ifc + Three.js + three-bvh-csg |
| 压缩包解压 | Tauri 原生命令（首选，带资源配额）/ libarchive.js WASM（回退） |
| 地图 | MapLibre GL JS + OSM 在线（Canvas-only 兜底）；天地图卫星/地形/矢量 |
| 本地数据库 | SQLite（表名前缀：变电 `substation_*`、线路 `powerline_*`，共享 `gim_project`） |

### 分层结构（强制边界）

```
desktop/src/                    # 前端代码（桌面端专属）
├─ app/        启动 + AppState（geometryLoadToken 防竞态）
├─ gim/        纯解析层：容器/parser/索引/地图数据提取（无 UI/Viewer 依赖）
├─ viewer/     3D 渲染层（仅变电使用；IFC 加载/高亮/相机/xml-mod 几何）
├─ ui/         纯 DOM UI（shell/ AppShell + 层级树/属性检查器/线路地图/搜索框）
├─ services/   业务编排（openGimService 打开流程/渐进式 DEV GLB 管线/SQLite 缓存）
└─ config/     功能开关（features.ts）与 debug 分类开关
desktop/                      # 桌面端
├─ bridge/                     # Tauri IPC 桥接层（TS，原 src/desktop/）
└─ src-tauri/src/
   ├─ db.rs                    SQLite 全部操作（PARSER_VERSION v16 失效机制）
   ├─ gim_extract.rs           原生解压（配额防压缩炸弹）
   ├─ gim_extract_command.rs   解压 Tauri 命令
   └─ lib.rs                   命令注册
app/                           # 手机端（预留）
```

分层规则：`gim/` 不依赖 services/viewer/ui；`viewer/` 不依赖 services/ui；
`ui/` 不直接碰数据库；`services/` 编排全部。重依赖按需动态 import——
入口与 openGimService 不静态引用 three/web-ifc/maplibre（P2 评审 #6）。

## 关键设计

- **打开流程**：sha256 → validate_gim_cache → 命中短路恢复渲染 / 未命中 → 解压（原生或 WASM）→ 类型识别 → 分支处理
- **变电首开**：loadAllIfcFiles 自动加载全部 IFC → 渐进式 DEV GLB 管线后台任务（serializeDevToGlb → 落盘 → 渐进渲染；token 防竞态；失败不写版本标记）
- **线路首开**：buildLineGimGraph → parseLineAttributes → 三阶段分块入库（begin/chunks/finish，finish 才提交 parser_version）→ Canvas/MapLibre 地图
- **性能埋点**：utils/perfTimings.ts，Ctrl+Shift+D 诊断 JSON 含 timings 字段

## 已实现功能

- **GIM 文件解析**：GIMPKGS/GIMPKGT 头部检测 + 原生/WASM 双路径解压（资源配额防护）
- **变电工程**：CBM 层级树 + 搜索定位 + IFC 全量自动加载 + 渐进式 MOD/STL 几何 +
  属性抽屉 CSV 导出 + SLD 单线图（白名单净化后 img 沙箱渲染）
- **线路工程**：地图（塔位/导线悬链线/跨越点）+ 树↔图联动 + 截图/CSV 导出 + 搜索定位
- **缓存体系**：SQLite 索引/属性/几何引用链/GLB 快速路径 + PARSER_VERSION 失效
- **安全加固**：SLD 白名单净化、解压资源配额、几何 token 竞态防护、GLB 完成标记门控

## 开发命令

```bash
cd desktop            # 所有 npm 命令在 desktop/ 下执行
npm install
npm run dev           # Vite 开发服务器（浏览器模式）
npm run tauri:dev     # Tauri 开发模式（桌面应用）
npm test              # 单元测试（快速，不含样本回归）
npm run test:sample   # 真实样本集成回归（需 demo/ 下解压样本，缺失自动跳过）
npm run build         # TypeScript 编译 + Vite 构建
cargo check --manifest-path src-tauri/Cargo.toml   # Rust 检查（desktop/ 内）
```

## 注意事项

- `demo/` 目录包含大型二进制文件（.gim 及解压目录），已在 .gitignore 中排除；
  `npm run test:sample` 依赖 demo-substation 与 line02 解压目录
- `desktop/public/worker-bundle.js`、`desktop/public/libarchive.wasm`、`desktop/public/wasm/web-ifc*.wasm`
  是运行时资产，由 scripts/copy-web-ifc-wasm.mjs 维护，需随项目提交
- 修改解析逻辑时须 bump `PARSER_VERSION`（desktop/src-tauri/src/db.rs）使旧缓存失效；
  Fragments 缓存键已绑定 @thatopen/fragments 与 web-ifc 实际安装版本
- 写入 docs/schema/ 的内容不得包含真实工程名与地理归属（匿名化约定）
