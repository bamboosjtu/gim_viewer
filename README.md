# GIM BIM 浏览器

面向电网工程信息模型（GIM）的 BIM 浏览工作台：**变电工程**（IFC 3D + 设备属性）与**线路工程**（地图 + 塔位/导线/跨越物）。

## 目录结构

| 目录 | 说明 |
|---|---|
| [`desktop/`](desktop/) | **桌面端**（当前唯一实现）：Tauri 2 应用，独立维护 Node.js 构建环境（package.json / vite / vitest）与 Rust 后端 |
| [`app/`](app/) | **手机端**（预留）：技术栈待定，不强制 Node.js |
| [`docs/`](docs/) | 技术文档 + [`design/`](docs/design/) 设计稿 |
| [`demo/`](demo/) | 样本数据（大型二进制，gitignored） |

## 快速开始（桌面端）

```bash
cd desktop
npm install          # 安装前端依赖
npm run tauri:dev    # Tauri 开发模式（需 Rust 工具链）
# 或
npm run dev          # 纯浏览器模式
```

构建与打包：

```bash
cd desktop
npm run build        # TS 编译 + Vite 构建
npm run tauri:build  # NSIS 安装版 + portable ZIP
```

### 天地图 Key（线路工程可选）

在仓库根目录创建 `.env`（不要提交真实 Key）：

```dotenv
VITE_TIANDITU_KEY=你的天地图 tk
```

Vite 会在启动或构建时读取该文件；修改后需要重启 `npm run dev` / `npm run tauri:dev`。
线路工程未配置或服务不可用时会自动回退为 Canvas-only 地图。旧版 `desktop/.env` 中的
`TIANDITU_APIKEY` 也会被兼容读取，但推荐迁移到上面的 `VITE_TIANDITU_KEY`。

## 文档

- [技术架构](docs/architecture.md)
- [变电 GIM](docs/gim_substation.md)
- [线路 GIM](docs/gim_powerline.md)
- [开发者日志](docs/dev-log.md)
- [UI 设计系统](docs/design/design_system.md)
