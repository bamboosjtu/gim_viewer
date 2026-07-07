# AGENTS.md — 项目上下文

> 本文件为 AI 编码助手提供项目上下文，帮助理解项目结构和约定。

## 项目定位

GIM（Grid Information Model，电网信息模型）文件浏览器。国家电网的 GIM 标准基于 IFC 扩展而来，`.gim` 文件是电力行业专有的工程信息模型格式。桌面版基于 Tauri 2，支持离线运行、本地 SQLite 缓存、节点级 IFC 懒加载。

## 核心概念

### GIM 文件结构

`.gim` 文件不是标准 ZIP，而是自定义格式：

```
偏移 0:    GIMPKG* 头部（变长，含项目编号和名称，零填充）
偏移 N:    7z 或 ZIP 压缩数据（在头部之后 1MB 窗口内搜索签名定位）
```

- 包头魔数：`GIMPKG`（6 字节前缀），后缀因工程类型而异：`GIMPKGS`（变电）/ `GIMPKGT`（线路）
- 7z 签名：`37 7A BC AF 27 1C`
- ZIP 签名：`50 4B 03 04`

解压后四个目录：CBM/（工程骨架）、DEV/（设备，含 IFC）、PHM/（装配体）、MOD/（几何图元）。

### CBM 层级

CBM 文件构成树形层级，入口为 `CBM/project.cbm`：
- 变电站工程：全站级 → 区域级 → 子区域级 → 设备级
- IFC 文件通过 `IFC.NUM` / `IFC0..N` 键值引用

### 文件格式

所有文本格式文件（.cbm, .dev, .phm, .fam, .sch）使用 `KEY=VALUE` 键值对格式。
.mod 文件使用 XML 格式，.sld 文件使用 SVG 格式，.std 文件使用 XML 格式。
详细格式说明见 `docs/schema/` 目录。

## 技术栈

- **桌面框架**：Tauri 2（Rust 后端 + Vite 前端）
- **3D 渲染**：@thatopen/components (OBC) + web-ifc + Three.js
- **压缩包解压**：libarchive.js（WebAssembly，支持 7z/ZIP/RAR）
- **本地数据库**：rusqlite（bundled SQLite，Rust 侧管理）
- **构建**：Vite + TypeScript

## 关键依赖版本

- `@thatopen/components`: ^3.4.x
- `web-ifc`: ^0.0.77（WASM 在 `public/` 目录，离线运行）
- `libarchive.js`: ^2.0.2（Worker 和 WASM 在 `public/` 目录）
- `tauri`: 2.x + `tauri-plugin-dialog` 2.x
- `rusqlite`: 0.31（bundled feature）

## 项目结构

```
src/
├─ app/           # 应用入口与全局状态
│  ├─ main.ts         # 入口（调用 bootstrap）
│  ├─ bootstrap.ts    # 轻量启动（懒加载 Viewer，绑定按钮事件）
│  └─ state.ts        # AppState 全局状态
├─ gim/           # GIM 解析层（纯逻辑，无 UI/Viewer 依赖）
│  ├─ gimExtractor.ts # GIMPKG* 头部检测 + 7z/ZIP 解压
│  ├─ cbmParser.ts    # CBM 层级树解析 + parseKeyValue
│  ├─ famParser.ts    # FAM 分节属性解析
│  ├─ fileDevParser.ts# FileDevRelation 解析
│  ├─ gimIndexer.ts   # IFC 发现 + GUID 索引 + 名称查询
│  └─ types.ts        # 统一类型定义
├─ viewer/        # 3D 渲染层
│  ├─ viewerEngine.ts # OBC 引擎初始化
│  ├─ viewerRuntime.ts# Viewer 单例懒加载
│  ├─ ifcLoader.ts    # IFC 加载 + Fragments 转换
│  ├─ ifcNameIndex.ts # GUID→Name 批量查询
│  ├─ highlight.ts    # 构件高亮 + 拾取
│  ├─ camera.ts       # 相机定位
│  └─ selection.ts    # 点击拾取事件
├─ ui/            # 纯 UI 层（不直接碰数据库和 IFC Loader）
│  ├─ dom.ts          # DOM 元素引用
│  ├─ tabs.ts         # 标签页切换
│  ├─ cbmTreeView.ts  # CBM 层级树渲染
│  ├─ fileDevView.ts  # 文件设备面板渲染
│  ├─ propsDrawer.ts  # 属性面板（基础版 + 完整版）
│  └─ ifcSelectModal.ts # IFC 文件选择弹窗
├─ services/      # 业务编排层
│  ├─ openGimService.ts          # GIM 打开流程（含缓存短路）
│  ├─ openIfcService.ts          # IFC 文件打开
│  ├─ nodeInteractionService.ts  # 节点点击懒加载 IFC
│  ├─ gimIndexPersistenceService.ts # 索引入库 payload 构建
│  ├─ gimIndexRestoreService.ts  # 索引恢复到 AppState
│  └─ gimExtractedCacheService.ts# IFC 文件本地缓存
├─ desktop/       # Tauri 桥接层
│  ├─ runtime.ts      # isTauri() 环境检测
│  ├─ fileDialog.ts   # 文件选择对话框
│  ├─ fileReader.ts   # 文件读取（getFileInfo/readFileBytes）
│  └─ database.ts     # SQLite 命令前端包装
└─ shared/
   └─ html.ts         # HTML 转义工具

src-tauri/
├─ Cargo.toml
├─ tauri.conf.json    # CSP + 窗口配置（visible:false 消除白屏）
└─ src/
   ├─ lib.rs          # Tauri setup + invoke_handler 注册
   ├─ main.rs         # 入口
   └─ db.rs           # SQLite 全部操作（表结构 + 命令）
```

## 代码约定

- 语言：TypeScript strict 模式
- 入口：`src/main.ts` → `bootstrap.ts`（轻量启动，3D 引擎懒加载）
- UI：原生 DOM 操作，无框架
- 样式：内联在 `index.html` 的 `<style>` 中
- 分层边界：`gim/` 纯解析、`viewer/` 纯 3D、`ui/` 纯 DOM、`services/` 编排、`desktop/` Tauri 桥接
- GIM 解析流程：读取文件 → 检测 GIMPKG* 头部 → 定位压缩数据偏移 → libarchive.js 解压 → 展平为 `Map<path, File>` → CBM 遍历发现 IFC → 用户选择 → 加载渲染

## 缓存架构

### SQLite 表结构（src-tauri/src/db.rs）

- `gim_project`：项目记录（path, sha256, size, parser_version）
- `gim_entry`：GIM 内部文件清单（entry_path, entry_type, local_cache_path）
- `cbm_node`：CBM 层级节点（树形结构，含 ifc_file/ifc_guid 引用）
- `ifc_model`：IFC 文件索引（model_id, name, entry_path）
- `file_dev_entry`：IFC 文件↔设备 CBM 映射
- `fam_property`：FAM 分节属性缓存（source_path, section_name, key, value）
- `dev_property`：DEV 关键属性缓存（dev_path, key, value）

### 缓存命中流程

1. 用户选择 GIM → Rust 计算 sha256 + file_size
2. `validate_gim_cache`：检查 parser_version + file_size + IFC 缓存文件存在性
3. 命中 → `get_gim_index` 读取全部索引 → `restoreGimIndexToState` 恢复到 AppState → 直接渲染树和面板（不读取原始 GIM、不解压、不创建 Viewer）
4. 未命中 → 完整解压 → 解析 → 入库 → 缓存 IFC 文件到本地磁盘

### 节点级 IFC 懒加载

- 缓存命中或首次打开后，CBM 树和文件设备面板均绑定 `handleNodeClick`
- 点击节点 → 显示基础属性（CBM/FAM/DEV，优先 currentFiles 回退缓存）→ 懒加载对应 IFC → 高亮 + 完整属性
- IFC 文件来源：优先 `currentFiles`（内存），回退 `cachedIfcPaths` + `readCachedIfc`（本地磁盘）

### parser_version 失效机制

- `PARSER_VERSION` 常量（当前 `gim-parser-v13`）
- `validate_gim_cache` 检查 `parser_version_match`
- 版本不匹配 → 缓存无效 → 完整解压 → `save_gim_index` 先删后插全部表

## 已实现功能

- **GIM 文件解析**：GIMPKG* 头部检测 + 7z/ZIP 解压 + 文件展平
- **Tauri 桌面应用**：离线运行、portable exe、CSP 安全策略
- **SQLite 索引缓存**：项目记录 + GIM 文件清单 + CBM 树 + IFC 索引 + FAM/DEV 属性
- **缓存命中短路**：二次打开同一 GIM 时跳过解压，秒开层级树
- **IFC 本地缓存**：IFC 文件写入 app_data_dir，路径遍历防护
- **节点级 IFC 懒加载**：点击节点按需加载 IFC，不一次性加载全部
- **CBM 层级树**：递归解析 CBM 文件构建树形 UI，支持展开/折叠
- **文件设备面板**：基于 FileDevRelation.cbm 的 IFC 文件↔设备双向浏览
- **3D 点击拾取**：raycast 高亮构件 + 展示 IFC 原生属性 + 关联 GIM 设备
- **层级树→3D 联动**：选中设备节点 → 高亮对应 IFC 构件 + 相机定位
- **IFC 名称索引**：模型加载后批量查询 GUID→Name，替代 CBM 中的 `&其他` 占位符
- **属性面板**：右侧可折叠抽屉，展示 FAM 设计参数、DEV 设备信息、IFC 属性集
- **缓存属性面板**：缓存命中时（currentFiles=null）仍可显示 CBM/FAM/DEV 基础属性
- **诊断快捷键**：Ctrl+Shift+D 复制数据库诊断 JSON 到剪贴板

## 开发命令

```bash
npm run dev          # 启动 Vite 开发服务器（浏览器模式）
npm run tauri:dev    # 启动 Tauri 开发模式（桌面应用）
npm run build        # TypeScript 编译 + Vite 构建
npm run tauri:build  # 构建桌面 portable exe
```

## 注意事项

- `demo/` 目录包含大型二进制文件（.gim, .ifc），已在 .gitignore 中排除
- `public/worker-bundle.js` 和 `public/libarchive.wasm` 是 libarchive.js 的运行时文件，需随项目提交
- web-ifc 的 WASM 文件在 `public/web-ifc.wasm` 和 `public/web-ifc-mt.wasm`，从 `node_modules/web-ifc/` 复制而来，需随项目提交
- Tauri 窗口配置 `visible: false`，启动后由 `getCurrentWindow().show()` 显示，消除白屏
- CSP 策略：`script-src 'self' 'wasm-unsafe-eval'`（WebAssembly）、`connect-src 'self' ipc: http://ipc.localhost`（Tauri IPC）
- `PARSER_VERSION` 变更时所有旧缓存自动失效，用户需重新解压 GIM
