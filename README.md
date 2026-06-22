# GIM 阅读器

基于 Web 的 GIM（Grid Information Model，电网信息模型）文件浏览器，支持从 `.gim` 压缩包中提取并可视化 IFC 模型。

## 技术栈

- **3D 渲染**：[That Open](https://thatopen.com/) + [web-ifc](https://ifcjs.github.io/ifcjs-crash-course/) + Three.js
- **压缩包解压**：[libarchive.js](https://github.com/nika-begiashvili/libarchivejs)（WebAssembly，支持 7z/ZIP/RAR 等）
- **构建工具**：Vite + TypeScript

## 功能

- 打开 `.gim` 文件，自动检测 GIMPKGS 头部并解压内部 7z/ZIP 数据
- 通过 CBM 层级结构发现 IFC 文件，或直接扫描 DEV 目录
- 选择性加载 IFC 文件（全选/取消/勾选指定文件）
- 已加载模型的显示/隐藏切换
- 加载本地 IFC 文件

## GIM 文件格式

`.gim` 文件是国家电网的工程信息模型标准格式，本质是自定义头部 + 压缩包：

```
┌──────────────────────┐
│ GIMPKGS 头部（变长）    │  自定义头部，含项目编号和名称
├──────────────────────┤
│ 7z 或 ZIP 压缩数据     │  标准压缩格式
└──────────────────────┘
```

解压后包含四个目录：

| 目录 | 说明 | 主要文件类型 |
|------|------|-------------|
| CBM/ | 工程模型（层级骨架） | .cbm, .fam, .sch, .sld, .std |
| DEV/ | 物理设备模型 | .dev, .fam, **.ifc** |
| PHM/ | 组合模型（装配体） | .phm |
| MOD/ | 几何模型（基本图元） | .mod, .stl |

详细格式说明见 [doc/schema/](doc/schema/)，Demo 工程分析见 [doc/gim_spec.md](doc/gim_spec.md)。

## 快速开始

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build
```

## 项目结构

```
gim_viewer/
├── public/                  # 静态资源
│   ├── worker-bundle.js     # libarchive.js Worker
│   └── libarchive.wasm      # libarchive WASM
├── src/
│   └── main.ts              # 应用入口
├── doc/
│   ├── gim_spec.md           # Demo GIM 工程分析
│   └── schema/               # 各文件格式说明
│       ├── cbm.md
│       ├── dev.md
│       ├── fam.md
│       ├── mod.md
│       ├── phm.md
│       ├── sch.md
│       ├── sld.md
│       └── std.md
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

## License

MIT
