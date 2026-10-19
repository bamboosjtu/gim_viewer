# 性能基线

测量对象：桌面版变电 substation01–04、线路 line01–06。  
测量环境：Windows、12 逻辑核、32 GB 内存、Release 构建、WebView2 固定运行时。  
下列整站表格是现有测量记录，每项为一次冷/暖启动，不是统计中位数。DEV 轮廓策略与几何缓存版本已更新，当前 Release 的三次冷/暖启动验收尚未完成，不能用这些记录推定新版本已达标。

## 1. 口径

- **冷启动**：清空 `%APPDATA%\com.bamboosjtu.gimviewer`，重新打开 `.gim`。
- **暖启动**：冷启动达到 Full fidelity 后关闭进程，仅重启应用并重新打开同一工程；不删除缓存。
- **First usable**：应用可交互、项目基本信息已显示。
- **Current view**：当前相机范围所需的 DEV 基础表示完成，状态栏显示“当前视图已完成”。
- **Full fidelity**：当前工程的 DEV 几何与目录工作全部 settled；不是“首屏可见”。
- 线路工程没有分阶段几何，First/Current/Full 相同。
- 超时记为 `>N s`，不以超时值推算完成时间。

## 2. 冷启动

| 样本 | First usable | Current view | Full fidelity |
|---|---:|---:|---:|
| line01 | 6.5 s | 6.5 s | 6.5 s |
| line02 | 9.4 s | 9.4 s | 9.4 s |
| line03 | 7.6 s | 7.6 s | 7.6 s |
| line04 | 3.8 s | 3.8 s | 3.8 s |
| line05 | 7.2 s | 7.2 s | 7.2 s |
| line06 | 4.1 s | 4.1 s | 4.1 s |
| substation01 | 22.4 s | 55.0 s | 55.0 s |
| substation02 | 11.5 s | >60 s | >60 s（60 s 时 DEV 2178/3326） |
| substation03 | 14.5 s | 43.4 s | >60 s（452 MB `设备接线.ifc` 仍在转换） |
| substation04 | 7.4 s | 22.2 s | 22.8 s |

## 3. 暖启动

| 样本 | First usable | Current view | Full fidelity |
|---|---:|---:|---:|
| line01 | 6.6 s | 6.6 s | 6.6 s |
| line02 | 9.9 s | 9.9 s | 9.9 s |
| line03 | 7.8 s | 7.8 s | 7.8 s |
| line04 | 1.6 s | 1.6 s | 1.6 s |
| line05 | 7.5 s | 7.5 s | 7.5 s |
| line06 | 1.8 s | 1.8 s | 1.8 s |
| substation01 | 5.0 s | 18.9 s* | >20 s |
| substation02 | 2.2 s | >25 s | >25 s（25 s 时 DEV 1540/3326） |
| substation03 | 2.6 s | 5.8 s | >25 s（IFC 仍转换） |
| substation04 | 3.1 s | 16.2 s | 17.6 s |

\* substation01 暖启动在 18.9 s 达到 `currentViewReady`（285/285 已显示），但状态栏的 `currentViewSettled` 还要等最后一批 catalog，因此不能算严格的 Current view SLO。

## 4. 当前实现的性能相关事实

- **DEV Worker 池**：按逻辑核 60% 创建，2–8 个；IFC 期间最多 2 个编译，IFC 完成后放开到全池。实测把池提高到 90% 会使 sub01 从 225/285 掉到 81/285，已回退。
- **目录任务**：catalog 按 DEV 流式消费（并发 32），单个慢 DEV 不再阻塞下一批；compile gate 满时，空闲 Worker 继续跑 bounds。
- **缓存**：
  - TS/Rust 统一 `geometry-cache-v14-outline-lod01`；
  - 并发创建同一缓存目录时 `AlreadyExists` 视为成功；
  - catalog 命中预取每批 64，模板/catalog 批读 16→64。
- **LOD**：
  - L0 覆盖全部 DEV，不隐藏整台设备；
  - L0/L1 省略浏览级紧固件、小环及圆形垫片（最大尺寸 ≤100 mm）和 ≤50 mm 的 Cuboid；装配缩放参与尺寸计算，整台 DEV 全部被过滤时保留最大有效轮廓；
  - L0/L1 不执行 CSG：差集与交集显示第一操作数，并集组合操作数轮廓；简化属于该 LOD 的正常结果，精确布尔保留在 L2；
  - Wire/Cable 永不省略；
  - L2 保留精确 CSG。
- **连接线**：substation01/03 的设备连接线主要来自 IFC `IfcBuildingElementProxy`（“导线/软导体”），不在 DEV/MOD 中；substation04 的部分备用出线间隔在源数据中没有任何连接线 DEV。见 [open issues](open-issues.md)。

## 5. 已知未达标项

1. **substation02 全站 settled >60 s**：1265 个 unique DEV 的 catalog bounds 与 L0 编译仍是长尾；当前只保证 First usable。
2. **substation03 Full fidelity >60 s**：452 MB `设备接线.ifc` 仍需整文件转换后提交连接线；转换未完成时当前视图可以先完成，但 IFC 连接线不出现。
3. **substation01 暖启动严格 Current settled >20 s**：视觉上 285/285 在 18.9 s 完成，但 catalog 最后一批拖到 20 s 之后。
4. 以上数据是单次记录；需要多次取中位数时按同一冷/暖口径重复测量，不得混合缓存状态。

## 6. 复现

1. Release 构建：`desktop/` 下 `npm run build`，再执行 Tauri release 构建。
2. 冷启动前删除 `%APPDATA%\com.bamboosjtu.gimviewer`。
3. 使用 SLO harness 记录 First usable、Current view、Full fidelity 和阶段 DEV 计数。
4. 暖启动必须在冷启动达到 Full fidelity 后仅重启进程；冷启动未完成时不得把下一次打开标为暖启动。


## 7. DEV 轮廓策略的验证边界

substation02 的 8 个含至少 300 个布尔节点的 MOD，L0/L1 共 16 次局部烘焙检查均未调用 CSG，耗时约 5–20 ms。该检查只覆盖解析后的 MOD 烘焙，不含全站 IFC、GLB 序列化、缓存读写与场景提交，不能代替桌面整站验收。

当前 Release 已构建，但本机独立验收实例遇到 Tauri 初始化访问拒绝/调试端口未就绪，原生三次冷启动及对应暖启动仍未验收。浏览器补充检查与原生口径分开；已有源几何异常仍保留失败诊断，不能用 processed 总数作为完整显示成功的证明。


生产前端的无头 Chromium 补充运行已到达基础表示 settled：3326 个实例中显示 2731、合法空源 561、失败 34，模板 pending 和场景提交等待均归零，IFC 最终 17/17。该运行的 First usable 约 22.2 s，Current view/base settled 约 458.2 s；运行时存在其它检查并行，不能作为独占性能基线，也没有达到 60 s 目标。34 个几何范围超限实例仍保留失败诊断；该结果不等同于全站完整显示成功。
