# 手动验收清单

> 线路 GIM 可视化 MVP + 变电 IFC 回归验收。
> 每个 PR/版本发布前按此清单逐项验证。

## 环境

- [ ] `npm run tauri:dev` 启动成功，窗口无白屏
- [ ] 准备 `demo/demo-line.gim`（线路工程）
- [ ] 准备 `demo/demo-substation.gim`（变电工程）
- [ ] 打开浏览器 DevTools Console（F12）观察日志

---

## 线路首次打开

1. [ ] 点击"打开 GIM" → 选择 `demo-line.gim`
2. [ ] 控制台显示 `[GIM] project type: { type: 'transmission_line' }`（仅 dev 模式可见）
3. [ ] 加载提示依次显示：解压 → 识别工程类型 → 解析 CBM → 解析 FAM/DEV → 写入缓存 → 渲染
4. [ ] 主视口显示 Canvas 地图（塔位 + 导线 + 跨越点 + 图例）
5. [ ] 左侧层级树显示线路 CBM 层级（F1→F2→F3→F4→Tower_Device/WIRE/CROSS）
6. [ ] 右侧文件设备面板显示文件摘要 + 地图数据统计
7. [ ] 图层开关 7 个均可用（勾选/取消即时刷新）
8. [ ] 鼠标悬停塔位显示 tooltip（塔位编号、类型、呼高、转角、坐标、FAM/DEV 命中）
9. [ ] 鼠标滚轮缩放、拖拽平移、双击/fit 按钮复位
10. [ ] 点击左侧树节点 → 地图定位到对应塔位或 bbox
11. [ ] 点击地图塔位 → 左侧树行高亮 + 右侧属性面板显示

---

## 线路二次打开（缓存命中）

1. [ ] 关闭并重新打开同一 `demo-line.gim`
2. [ ] 加载提示显示：从本地缓存恢复（不显示"解压"）
3. [ ] 控制台无解压/解析日志（仅 dev 模式可见缓存恢复日志）
4. [ ] 地图、树、统计、属性与首次打开一致
5. [ ] tooltip 字段完整（FAM/DEV 属性已从缓存恢复）

---

## 变电首次打开

1. [ ] 点击"打开 GIM" → 选择 `demo-substation.gim`
2. [ ] 控制台显示 `[GIM] project type: { type: 'substation' }`（仅 dev 模式）
3. [ ] 加载提示依次显示：解压 → 识别 → 解析 CBM → 缓存 IFC → 写入索引 → IFC 选择框
4. [ ] IFC 选择弹窗正常显示，列出可加载的 IFC 文件
5. [ ] 勾选 IFC → 加载 → 3D 模型显示在视口中
6. [ ] 左侧 CBM 层级树正常显示
7. [ ] 右侧文件设备面板正常显示
8. [ ] 点击 3D 构件 → 高亮 + 属性面板显示
9. [ ] 点击树节点 → 高亮对应 IFC 构件 + 相机定位

---

## 变电二次打开（缓存命中）

1. [ ] 关闭并重新打开同一 `demo-substation.gim`
2. [ ] 加载提示显示：从本地缓存恢复（不显示"解压"）
3. [ ] CBM 层级树和文件设备面板立即渲染
4. [ ] IFC 选择弹窗自动弹出
5. [ ] 选择 IFC → 从本地缓存加载（不重新解压 GIM）
6. [ ] 3D 模型正常显示，属性正常

---

## 工程切换

1. [ ] 打开 `demo-line.gim` → 地图正常显示
2. [ ] 再打开 `demo-substation.gim` → 地图 canvas 消失，IFC 选择框弹出
3. [ ] 无残留 canvas 覆盖 3D 视口
4. [ ] 再打开 `demo-line.gim` → 地图正常显示，无 3D 模型残留
5. [ ] UI 面板（树/属性/模型列表）正确切换

---

## 清空场景

1. [ ] 打开任一 GIM 后点击"清空场景"
2. [ ] 视口清空（无地图、无 3D 模型）
3. [ ] 左侧树、右侧面板、模型列表均清空
4. [ ] 可重新打开 GIM（无异常）

---

## 异常场景

1. [ ] IFC 加载报错时（如缓存损坏）→ 控制台 console.error，不红屏
2. [ ] 部分加载失败 → 提示"部分 IFC 加载失败"，已成功的模型正常显示
3. [ ] Fragments "Malformed tile" → 被 catch，不出现 Uncaught (in promise)
4. [ ] 生产模式（tauri:build）→ 控制台无 debug 日志刷屏

---

## 诊断快捷键

1. [ ] Tauri 模式下按 `Ctrl+Shift+D`
2. [ ] 数据库诊断 JSON 复制到剪贴板
3. [ ] 控制台输出诊断信息
4. [ ] 粘贴验证 JSON 包含 project_type / line_cbm_node_count / ifc_models_count 等字段

---

## 构建验证

```bash
# 前端构建（TypeScript 编译 + Vite 打包）
npm run build

# Rust 编译检查
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] `npm run build` 无 TypeScript 错误
- [ ] `cargo check` 无 Rust 编译错误
