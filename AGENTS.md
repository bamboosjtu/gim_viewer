# AGENTS.md — 项目上下文

> 本文件为 AI 编码助手提供项目上下文，帮助理解项目结构和约定。

## 项目定位

GIM（Grid Information Model，电网信息模型）文件浏览器。国家电网的 GIM 标准基于 IFC 扩展而来，`.gim` 文件是电力行业专有的工程信息模型格式。

## 核心概念

### GIM 文件结构

`.gim` 文件不是标准 ZIP，而是自定义格式：

```
偏移 0:    GIMPKGS 头部（变长，含项目编号和名称，零填充）
偏移 N:    7z 或 ZIP 压缩数据（通过搜索签名定位）
```

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
详细格式说明见 `doc/schema/` 目录。

## 技术栈

- **3D 渲染**：@thatopen/components (OBC) + web-ifc + Three.js
- **压缩包解压**：libarchive.js（WebAssembly，支持 7z/ZIP/RAR）
- **构建**：Vite + TypeScript

## 关键依赖版本

- `@thatopen/components`: ^3.4.x
- `web-ifc`: ^0.0.77（WASM 在 `public/` 目录，离线运行）
- `libarchive.js`: ^2.0.2（Worker 和 WASM 在 `public/` 目录）

## 代码约定

- 语言：TypeScript strict 模式
- 入口：`src/main.ts`（单文件，包含 GIM 解析、3D 引擎、UI 逻辑）
- UI：原生 DOM 操作，无框架
- 样式：内联在 `index.html` 的 `<style>` 中
- GIM 解析流程：读取文件 → 检测 GIMPKGS 头部 → 定位压缩数据偏移 → libarchive.js 解压 → 展平为 `Map<path, File>` → CBM 遍历发现 IFC → 用户选择 → 加载渲染

## 已实现功能

- **GIM 文件解析**：GIMPKGS 头部检测 + 7z/ZIP 解压 + 文件展平
- **IFC 模型加载**：通过模态框选择 IFC 文件，web-ifc 解析渲染
- **CBM 层级树**：递归解析 CBM 文件构建树形 UI，支持展开/折叠
- **文件设备面板**：基于 FileDevRelation.cbm 的 IFC 文件↔设备双向浏览
- **3D 点击拾取**：raycast 高亮构件 + 展示 IFC 原生属性 + 关联 GIM 设备
- **层级树→3D 联动**：选中设备节点 → 高亮对应 IFC 构件 + 相机定位
- **IFC 名称索引**：模型加载后批量查询 GUID→Name，替代 CBM 中的 `&其他` 占位符
- **属性面板**：右侧可折叠抽屉，展示 FAM 设计参数、DEV 设备信息、IFC 属性集

## 开发命令

```bash
npm run dev      # 启动 Vite 开发服务器
npm run build    # TypeScript 编译 + Vite 构建
```

## 注意事项

- `demo/` 目录包含大型二进制文件（.gim, .ifc），已在 .gitignore 中排除
- `public/worker-bundle.js` 和 `public/libarchive.wasm` 是 libarchive.js 的运行时文件，需随项目提交
- web-ifc 的 WASM 文件在 `public/web-ifc.wasm` 和 `public/web-ifc-mt.wasm`，从 `node_modules/web-ifc/` 复制而来，需随项目提交
