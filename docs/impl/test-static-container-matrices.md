# 静态容器的逐帧矩阵开销

## 判定

保留场景根与 MOD/STL 图层容器的固定局部矩阵设置。四站真实 L0 子集的稳定帧世界矩阵乘法从 1,156–4,975 次降至 2 次，矩阵更新单项的三轮中位数汇总下降约 64%–69%。几何、对象/资源身份、世界矩阵、12 个视角的像素及真实三角形目标拾取均一致。

整帧 CPU 提交多数轮次改善，但 p95 不稳定，substation01 第二轮、substation02 第三轮有明显回退，不能宣称整帧长尾已改善或达到流畅度目标。保留依据是可以直接归因的矩阵工作减少与单项计时收益，改动不增加新的逐帧工作。绘制调用和三角形数量完全相同。

本轮只落地这一项默认浏览路径优化，不启用有启动回退记录的 DEV 实例化试点。完整原生 IFC/DEV 场景、实际交互路线和 33/50 ms 目标仍沿用 [L-06](../open-issues.md) 的未完成状态。

## 原因与实现

`DevGlbTemplate` 已对模板及其克隆关闭 `matrixAutoUpdate`，但 Three.js 0.184.0 的 `Object3D.updateMatrixWorld()` 在父节点需要更新时，会把 `force` 传给所有后代。默认 Scene 每帧 `updateMatrix()`，即使其变换始终为单位阵，也会触发整棵静态树重复进行世界矩阵乘法。只修改 Scene 也不足够，默认 Group 图层仍会强制更新其整个子树。

[固定容器设置](../../desktop/src/viewer/staticContainer.ts)在场景创建及两处 MOD/STL 图层创建入口调用：保存当前局部矩阵，关闭容器的局部自动重算。只应用于这些固定坐标容器，不递归冻结其他对象，不关闭 `matrixWorldAutoUpdate`。已有手动仿射矩阵不被 TRS 分解/重组覆盖。

动态对象仍自动更新自己的分支；DEV 坐标锚点刷新沿用 `matrix.copy(...)` 加 `updateMatrixWorld(true)`。首次脏状态、显式强制刷新和动态父节点仍正常传播。本项目不对 Scene 或 MOD/STL 容器做交互式移动；未来若修改这些容器的 position/rotation/scale，必须显式 `updateMatrix()`，直接写局部矩阵则需标脏或强制刷新。该设置不承诺任意手动矩阵写入都会自动被发现。

场景、模板、placement 的所有权及资源释放流程保持原契约，没有持久化格式或缓存版本变化。

入口：[引擎](../../desktop/src/viewer/viewerEngine.ts)、[自动加载图层](../../desktop/src/services/modAutoLoadService.ts)、[按需加载图层](../../desktop/src/services/nodeInteractionService.ts)。

## 输入与可比条件

基线源码为 `f6aa29f`。该源码中的 Scene、MOD/STL Group 使用默认局部自动更新。对照在同一浏览器、同一 Scene 和对象上交替切换基线设置与生产候选函数；没有重新加载或复制一份不同对象的场景。候选生产文件的 SHA-256：

| 文件（相对 desktop/） | SHA-256 |
|---|---|
| src/viewer/staticContainer.ts | `38aa0da81a181eaf07d73999b7c5fde606345d8998957e4ff8d7c0d5943b7173` |
| src/viewer/viewerEngine.ts | `c4fcfbea2dd4dac1c9d997a5ecb984d5cd588f7cdb0ac3250cc1c1536ec550e9` |
| src/services/modAutoLoadService.ts | `04bd664ea32b286e768d954ab3313aa124bdfe20fbfc2b4b39cbd6c23542a214` |
| src/services/nodeInteractionService.ts | `d01f283ce6c7e02608dc84920f1cfae895c9cdc89d6949dcf458808745252adb` |

Windows、i7-8700（12 逻辑核）、约 64 GiB 内存，Node 22.23.1，headless Edge 156，WebGL 实际返回 `ANGLE (NVIDIA, NVIDIA Quadro P4000 (0x00001BB1) Direct3D11 vs_5_0 ps_5_0, D3D11)`，未使用软件光栅器。逐站运行独立 Edge/profile，测量期间没有并行执行构建、测试或其他基准，日常应用缓存未操作。

复用前两轮生成的真实 L0 缓存产物和 CBM occurrence 清单；相关解析/几何源码及缓存契约在这些轮次没有改变。运行前重新核对原包 SHA 与解包标记，逐记录核对 artifact 哈希、缓存键及 GLB SHA，调用当前 `parseDevGlbAsset`、`DevGlbTemplate.createPlacement`。同一 cohort 的所有真实 occurrence 都加入场景，没有复制对象扩大规模。

| 样本 | 原包 SHA-256 | L0 记录 / 有 GLB | placement / 网格 / DEV 层节点 |
|---|---|---:|---:|
| substation01 | `711259814db95999f5282af1871da9cb50db4548b71626637b33038b062fc390` | 63 / 63 | 63 / 2,461 / 4,973 |
| substation02 | `a1c0990162e769f678f2fe5eeb275b1266fb8640776399289197d1998d372f29` | 64 / 38 | 231 / 2,124 / 4,243 |
| substation03 | `3197c03ef2c6c423cbb85447f71491a4112db0f9a8cea0c9f72f0b410b8175ab` | 58 / 58 | 58 / 1,023 / 2,113 |
| substation04 | `00b7746d5ea6ab3b92c215c1e42ffc7eec5a9f0517c1c555fa27a596d4d800dc` | 60 / 60 | 164 / 384 / 1,154 |

共 245 条记录、219 个 GLB。substation02 保留 17 个 partial 和 26 个 empty 的原诊断，不把这 64 条记录表述为全部完整。cohort 沿用较大 DEV 的 16 个及路径均匀抽取最多 48 个的去重选择，唯一物理根覆盖为 63/285、64/976、58/162、60/207，不代表全站几何完成。

CBM 累积矩阵采用产品列主序和毫米平移换米规则，镜像/仿射变换保留。工程 source-to-viewer 矩阵在装置中为单位阵，未加载真实 IFC 锚点；非单位父变换、镜像、仿射及锚点刷新由单元回归覆盖，不能替代原生跨来源坐标验收。

## 方法与正确性

[页面](../../desktop/scripts/benchmarks/static-container.html)使用真实 WebGLRenderer、MeshStandardMaterial、一盏方向光和一盏环境光，960×640、像素比 1、关闭抗锯齿和阴影。依据当前子集包围盒生成 12 个固定环绕视角，先预热两个模式的 shader 与路线，再检查：

1. 同一场景的 UUID、几何/材质 UUID、来源/装配引用路径、世界矩阵和顶点/索引缓冲区哈希完全一致。
2. 12 个视角逐像素 SHA、draw calls、triangles 和 lines 完全一致。
3. 每站选 12 个分布于真实网格中的非退化三角形，以其法向建立射线，强制确认目标对象确实在命中集合中，再对照前八个命中的对象、距离和交点。四站 48 个目标均通过；中心射线也记录，但它们全部落在稀疏布局的空白处，不作为拾取成功证据。这是渲染几何拾取检查，不是完整业务选择/属性 UI 验收。
4. 另行计数一次稳定更新的 Matrix4 世界乘法；计数包装在计时前恢复，计时阶段不启用乘法埋点。

每站三轮，每轮 20 个块，每块两个模式各走 12 帧，AB/BA 交替；每模式每轮 240 帧，四站合计 5,760 个计时帧。切换模式的首次脏状态刷新在稳定帧计时外。

`cpuMs` 是 `renderer.render()` 主线程调用耗时，包含场景更新；`worldMs` 是其内部 Scene 世界矩阵更新耗时。每帧在计时外 `gl.finish()` 排空 GPU 工作，控制提交积压；因此这些数值不等同于实际异步流水线的帧间隔、GPU 时间或 FPS。没有执行强制 GC。

矩阵单项另外做每模式 20 个批次、每批连续更新 200 次，批次平均到每次，避免单帧 0.1 ms 时钟量化；不包括渲染、相机更新、首次加载和模式切换。

## 结果

下表的矩阵计时为三轮各自 p50 的中位数，单位 ms/次；不是整帧降幅。稳定帧计数中的候选 2 次来自两盏仍自动更新的灯，遍历本身仍存在。

| 样本 | 世界乘法，基线 → 候选 | 矩阵单项，基线 → 候选 | 单项降幅 | 每视角 draw calls 范围，双方相同 |
|---|---:|---:|---:|---:|
| substation01 | 4,975 → 2 | 0.3865 → 0.1205 | 68.8% | 2,197–2,461 |
| substation02 | 4,245 → 2 | 0.3330 → 0.1090 | 67.3% | 2,134 |
| substation03 | 2,115 → 2 | 0.1555 → 0.0560 | 64.0% | 959–1,028 |
| substation04 | 1,156 → 2 | 0.0940 → 0.0335 | 64.4% | 408 |

全部最终轮次如下，箭头为基线 → 候选，单位 ms。单项表是未插入计时钩子的批量测量；这里的 world p50 是真实 render 内单帧计时，不与前表混用。

| 样本 / 轮 | CPU render p50 | CPU render p95 | world p50 | 矩阵批次 p50 |
|---|---:|---:|---:|---:|
| 01 / 1 | 9.1 → 8.9 | 14.0 → 12.7 | 1.0 → 0.6 | 0.3865 → 0.1205 |
| 01 / 2 | 9.0 → 8.5 | 20.7 → 30.2 | 1.0 → 0.6 | 0.5570 → 0.1435 |
| 01 / 3 | 10.2 → 9.7 | 15.2 → 12.4 | 0.9 → 0.5 | 0.3800 → 0.1195 |
| 02 / 1 | 6.3 → 5.6 | 10.2 → 9.5 | 1.0 → 0.5 | 0.3330 → 0.1100 |
| 02 / 2 | 4.4 → 4.1 | 5.4 → 5.1 | 0.7 → 0.3 | 0.3410 → 0.1090 |
| 02 / 3 | 7.2 → 7.3 | 12.9 → 21.1 | 0.9 → 0.6 | 0.3290 → 0.1085 |
| 03 / 1 | 3.6 → 3.5 | 6.6 → 5.7 | 0.5 → 0.3 | 0.1580 → 0.0565 |
| 03 / 2 | 3.4 → 3.1 | 5.4 → 5.1 | 0.4 → 0.3 | 0.1555 → 0.0555 |
| 03 / 3 | 2.6 → 2.5 | 3.2 → 3.1 | 0.3 → 0.1 | 0.1550 → 0.0560 |
| 04 / 1 | 1.3 → 1.2 | 2.7 → 2.6 | 0.2 → 0.1 | 0.0940 → 0.0325 |
| 04 / 2 | 1.2 → 1.1 | 2.5 → 2.4 | 0.2 → 0.1 | 0.1005 → 0.0380 |
| 04 / 3 | 1.3 → 1.3 | 2.3 → 2.2 | 0.2 → 0.1 | 0.0910 → 0.0335 |

没有删除长尾：01 第二轮 CPU 最大值 95.9 → 53.2 ms，02 第三轮为 29.8 → 59.8 ms；02 第三轮候选 world 最大值也达到 14.3 ms。没有足够证据区分浏览器调度、GC、驱动或其他原因，不把波动一律归因于外部噪声，也不声称所有路径无回退。矩阵乘法计数和各轮批量单项均下降，支持局部 CPU 收益；总体长尾收益仍未证实。

## 复现与记录

先按 [基准说明](../../desktop/scripts/benchmarks/README.md)准备两组输入，再保持 Vite `127.0.0.1:14317` 运行，从 `desktop/` 逐站执行：

```powershell
node scripts/benchmarks/static-container-browser.mjs substation01
node scripts/benchmarks/static-container-browser.mjs substation02
node scripts/benchmarks/static-container-browser.mjs substation03
node scripts/benchmarks/static-container-browser.mjs substation04
```

输出在忽略目录 `output/static-container/`，含输入 SHA、逐记录诊断、文件 SHA、显示指纹、每视角像素/绘制/拾取、逐帧原始时间及 PNG。最终记录文件：

- `substation01-2026-10-25T04-40-21-728Z.json`
- `substation02-2026-10-25T04-40-49-095Z.json`
- `substation03-2026-10-25T04-41-07-604Z.json`
- `substation04-2026-10-25T04-41-18-195Z.json`

最终页面 SHA 为 `012f084b16b26dec3de7f7436c9a73b063db2c7e916081bf233dca26376f8fe3`，驱动 SHA 为 `f0bca6cfc14f476d291c5402903235479f64e210a1373b2e4da7e61897c9de49`。之前 04:37–04:39 UTC 的四站初跑记录也保留；它们只有空白中心射线，不能支持拾取成功结论。补真实目标后重新跑全部四站，以以上最终记录为主表，生产代码在两次运行间未变。

各自结束时 placement 和 template 计数为 0，WebGL 资源按当前所有权释放，所属独立浏览器树被终止；不以这些逻辑计数宣称原生工程关闭内存达标。

## 回归与剩余边界

[单元测试](../../desktop/src/viewer/__tests__/staticContainer.test.ts)覆盖静态分支不重复乘法、动态子节点、首次挂接、显式锚点更新、负行列式、动态父节点重挂接、已有手动仿射矩阵和容器显式 TRS 刷新。

已完成以下检查：

- `npm test`：129 个文件、1,114 项通过，3 项既有跳过。
- `npm run test:sample`：3 个文件、11 项通过；2 项线路用例因缺少解包目录而跳过，变电四站检查已执行。
- `npm run build`：TypeScript 与 Vite 构建通过，保留已有大 chunk 和混合动态/静态 import 提示。
- `git diff --check`、新增报告/导航的本地链接以及四份最终记录与当前源码 SHA 对照通过；本轮独立 Edge 进程树无残留。

此次没有 Rust 或 SQLite 契约改动，不重复运行对应专项检查。

未执行打包原生 Release 的整站冷暖/输入响应矩阵；没有测全量 IFC/DEV 混合、真实工程锚点或长期交互后的 GPU 驻留。没有降低 draw calls、改变 LOD、扩大缓存、裁掉几何或改动 UI 刷新策略，本轮结果仅支持固定容器的主线程矩阵优化。
