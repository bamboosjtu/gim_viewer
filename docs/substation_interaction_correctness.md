# 变电交互正确性收口验收

验收日期：2026-10-05（Asia/Shanghai）。开始时 HEAD 为
`c1e582fb37f0dc9b1a0c39578201734a86ee5807`，与指定基线一致，工作区干净。
本报告对应基线上的未提交修改。上一轮 FAM sourceLine、SQLite 真实往返、DEV occurrence、
PARTINDEX identity join、分域缓存及严格样本门禁均予以保留。

## 修改前复现

新增生产链测试先在修改前运行，三个测试失败，日志为本地 `demo/selection-before.log`：

1. A 的 FAM 读取由 deferred Promise 暂停，B 的属性先完成，再释放 A，真实属性 DOM 的
   `.props-header` 最终变回 A。`showNodePropertiesBasic()` 在 await 后没有选择提交检查。
2. A 的 DEV 字节读取暂停，B 的几何、高亮和相机先完成，再释放 A，A 重新获得高亮和相机。
   两个请求属于同一 ProjectLoadSession，因此工程检查不能阻止覆盖。
3. 可显示 A → 已知 unsupported B，原来的空 group 提前返回保留了 A 的高亮。
   B 的语义选择与场景中的选择效果不一致。

复现不使用固定 sleep。测试保留实际属性 DOM、Three.js 几何、材质克隆和生产处理链；
仅在 Viewer/Fragments 引擎边界提供可控外部依赖。

## 提交权与资源有效性的边界

| 机制 | 判断内容 | 失效条件 | 允许旧任务继续做什么 |
|---|---|---|---|
| ProjectLoadSession | generation、projectId、sourceSha256 是否仍属于当前工程 | 切换/关闭工程 | 同工程的资源读取、解析、模板缓存和实例资源提交 |
| geometryLoadToken | 后台几何批次是否仍有效 | 原有批次取消或工程切换 | 延续原有后台管线规则；选择对象不会递增它 |
| SelectionRequest | 工程仍有效、request id 当前、signal 未 abort | 新的用户选择、取消选择、工程切换 | 可以完成资源工作；不能提交属性、树/SLD 选中、高亮、相机和选择消息 |

真实入口在动态 import 或 raycast 前同步创建 request。同一选择的属性、资源和最终刷新复用
该 request。功能树、搜索、空间树、来源关系入口、已实现的 SLD 拓扑点击和 IFC viewport
选择使用这一规则。现有 3D picking 支持 IFC，没有新增 MOD picking 产品能力。

后台树/名称刷新只同步当前 request 对应的行，不创建用户选择。后台首次全场景 fit 在
已有语义选择时不再覆盖用户视点。同 root 的在途加载 Promise 继续合并，内部不包含选择
消息、高亮或相机副作用，每个等待者独立检查选择提交权。

属性函数在异步读取完成后、真正 render 前检查 request；空间 IFC 详情的第二次 render
同样检查。IFC reset/apply 使用每 AppState 一个短提交队列，以应对已启动、不能取消的外部
高亮操作：旧 apply 完成后仍登记其已发生的效果，最新提交随后清除它。读取和几何加载
不进入该队列。项目 cleanup 使用同一队列及现有工程有效性检查。

相机使用已有 setLookAt 默认的即时定位行为，显式传入 `false`，拒绝空/非有限包围盒。
request abort 时先用 controls 的当前 pose/target 冻结，再 stop；安装的 camera-controls
单独 stop 会跳到旧动画终点，因而不能只在完成后检查 token。viewer 只消费 guard/signal，
不反向依赖 services/ui。

## 无几何和不完整对象的实际行为

所有有效选择立即更新语义对象标题和底栏。无可显示几何时清除上一个对象的选择高亮，
保留场景几何、可见性和相机位置。不进行全站同 DEV 匹配，不伪造 IFC GUID。

| 已有证据 | 属性/消息 | 高亮与相机 |
|---|---|---|
| not-loaded | 尚未加载/正在读取 | 清旧高亮；资源完成后由同 request 提交 |
| empty | 引用遍历或 manifest 的确定性空结果 | 清旧高亮；保留相机 |
| unsupported | 当前解析器不支持，并保留已有类型/原因诊断 | 清旧高亮；保留相机 |
| partial | 部分可渲染及具体原因 | 只选择当前 root/装配候选中可显示的几何 |
| failed | 缺失引用、读取或解析失败 | 无可显示几何则保留相机；不标成 unsupported/empty |
| available / unknown | 可显示但完整性未知 / 没有确定性诊断 | 有实际几何才 frame；未知无几何不猜 empty |
| PARTINDEX 无候选 | 未关联真实装配路径 | 清旧高亮，保留相机，无全站 fallback |
| PARTINDEX 多候选 | 显示全部候选数量，完整性另据已有诊断 | 限定所属 root，保留候选集合，不选第一个 |
| file-only IFC / 无对象关联 | 只有文件来源、缺少直接对象 GUID / 无定位关联 | 更新对象属性，清旧高亮，保留相机 |

raw 零叶子路径额外执行现有严格引用展开以隔离缺失引用，不能把宽松发现的空数组直接
判为 empty。MOD 加载使用现有 parser diagnostics 识别 unsupported/partial。DEV 声明了
SOLIDMODEL、但所引用 PHM 为空时，保留“引用遍历完成，无可达 MOD/STL”这一事实，不
错误附加“DEV 没有 SOLIDMODEL”原因。桌面空 PHM 截图采于这项原因措辞修正前，状态、
选择、几何保留和相机行为不变，最终自动测试另覆盖其正确措辞。

## 修改文件

| 文件 | 最小职责变化 |
|---|---|
| `desktop/src/app/state.ts` | request、abort、提交 guard 和当前选择状态；工程重置使其失效 |
| `desktop/src/services/nodeInteractionService.ts` | 资源与选择提交分离、同 root 合并、实际状态诊断、无几何清旧高亮 |
| `desktop/src/services/substationRuntime.ts` | 同步捕获真实树/SLD 选择；保护后台全场景 fit |
| `desktop/src/services/viewerUIBinding.ts` | 3D request 传入属性及导航；空点击清 inspector |
| `desktop/src/services/projectCleanupService.ts` | 既有 cleanup guard 传入高亮短队列 |
| `desktop/src/ui/propsDrawer.ts` | await 后及 IFC 详情第二次 render 的提交检查，状态/底栏文字 |
| `desktop/src/ui/cbmTreeView.ts` | 空间/来源入口捕获 request，刷新树保持当前行 |
| `desktop/src/ui/shell/statusBar.ts` | 统一更新/重置语义选择底栏 |
| `desktop/src/viewer/highlight.ts` | 外部 reset/apply 短提交队列，最新 guard 和实际效果 bookkeeping |
| `desktop/src/viewer/camera.ts` | 合法包围盒检查、当前 request 定位及中断 |
| `desktop/src/viewer/selection.ts` | raycast 前创建 request，IFC apply 和空点击受保护 |
| `desktop/src/services/__tests__/selectionInteraction.test.ts` | 23 个生产交互链测试 |
| `docs/gim_substation.md`、本文件 | 当前 contract 与可复核验收证据 |

## 自动回归

| 命令 | 结果 |
|---|---|
| `npm test` | 73 文件、775 测试通过，包含原 SQLite、occurrence 和线路测试 |
| 交互测试文件单独执行 | 23/23 通过；最后的断言补强后再次执行 |
| `npm run test:substation:strict` | 01/02/03 必需样本与可选 04 全部通过，零跳过 |
| `npm run build` | 通过；既有 Vite chunk-size warning 保留 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 34 通过，0 failed、0 ignored |

交互测试覆盖 slow A/fast B 的 FAM 与资源读取、旧工程 FAM/IFC 详情、同 root 反序 PARTINDEX
共享读取、取消选择、旧 IFC reset/apply、可中断相机、可显示到 empty/unsupported/failed/
partial/file-only/unlinked 的转换、功能树→空间树、搜索→慢 3D raycast、SLD→3D、重复实例
点击及共享材质恢复、旧资源完成仍可复用而不能夺回选择。实际 render、DOM 行选择和
MOD 材质没有全部 mock。相机/Fragments 外部延迟由 deferred Promise 控制。

严格样本门禁继续执行原始解析、落盘 SQLite save/query/restore、Rust/TS 逐叶子 instance
key/16 元矩阵/颜色、GLB 落盘读取恢复、单设备损坏缓存 raw fallback 和重复加载检查。
01 对应 `demo-substation`；全 SHA 见前一轮正确性报告和本地 JSON，原始文件本轮重新哈希。

| 样本 | SHA-256 前 16 位 | FAM 原始行 | root / unique DEV | PARTINDEX / 未关联 / 歧义 | SQLite / 引用展开 / GLB / raw fallback |
|---|---|---:|---:|---:|---|
| 01 | `711259814db95999` | 40867 | 285 / 285 | 3894 / 0 / 0 | 全部通过，0 skip |
| 02 | `a1c0990162e769f6` | 22887 | 3326 / 976 | 1349 / 0 / 0 | 全部通过，0 skip |
| 03 | `3197c03ef2c6c423` | 26395 | 162 / 162 | 224 / 0 / 0 | 全部通过，0 skip |
| 04 | `00b7746d5ea6ab3b` | 6376 | 532 / 207 | 137 / 0 / 60 | 全部通过，0 skip，保留歧义 |

本地日志在 `demo/interaction-unit-final3.log`、`interaction-focused-final.log`、
`interaction-strict-final.log`、`interaction-build-final3.log`、
`interaction-cargo-check-final2.log`、`interaction-rust-test-final2.log`。
样本逐项 JSON 是 `demo/runtime-correctness-gate.json`，其中 visual 字段表示这套自动门禁
不执行视觉验收；下面的独立桌面记录不能改写为自动测试的视觉证明。

## 实际桌面验收及限制

使用仓库已有 Tauri dev 授权打开入口和 Playwright CLI 的 CDP 连接，不新增测试平台。
运行实际 Tauri debug executable、Vite 前端和 WebView2 154.0.4258.53；Windows 11
10.0.26200 x64，
WebGL 为 ANGLE NVIDIA GeForce RTX 2060 / D3D11。截图、操作脚本与 request/root/assembly
诊断保存在忽略的 `demo/desktop*` 文件中，未提交原始 GIM 或解包目录。

02 默认整工程冷开在读取/处理约 390 MB 的 `CBM/0302-钢结构.ifc` 后 CDP 和界面响应超时，
未完成默认整工程冷暖视觉验收。为检查本轮交互，本次仅在测试 WebView 运行时暂停
>100 MB 的 disk-backed IFC arrayBuffer Promise，其他 IFC、DEV、PHM、MOD、FAM 使用真实
数据并通过真实 GPU 渲染。03 同样暂停了大 IFC。没有改变生产加载规则、Fragments 默认
开关、缓存完成标记或用户持久化配置；实验结束恢复读取方法并在关闭工程后取消等待。

| 项目 | 路径、实际操作和结果 | 桌面验收状态 |
|---|---|---|
| A / B：02 两个同 DEV 的 F4，raw | A 的第一次 DEV 读取暂停，点击 B 并完成，再释放 A；request 6 仍为 B，高亮仅 B，两 root 资源均完成，camera target 释放前后完全相同 | 受控条件下通过；整工程加载未验收通过 |
| B：02 单 DEV GLB 磁盘恢复 | 用生产 compiler/writeGlbFile 写实际单 DEV GLB；移除测试两 root 的 raw placements 后从磁盘恢复。A 的第一次共享 FAM 读取暂停，点击 B，再释放 A；request 9 仍为 B。两个 placement root 分离，重复 B 点击数量仍为 2 | 受控条件下通过；不是全工程 warm 完成证明 |
| C：03 部件顺序不同 | 语义第 0 项 `F2B6047C…` 指向 `25E4F816…dev`，真实 DEV 边是 `sub:1`；实际点击、高亮仅该 root 的 `sub:1`，request 15、属性和树行一致 | 受控条件下通过；仅证明引用/装配对应 |
| D：02 确定性空 PHM | 从 B 切到 `9feab04d…cbm`；属性/底栏变为新对象、statusempty、高亮清除、两柜几何仍在，camera target 数值不变 | 受控条件下通过；unsupported-only 桌面项未执行 |
| E：04 多候选，正常冷/暖打开 | `f3fb56ea…cbm` 的 `sub:2/sub:3/sub:4` 全部在 `048872d3…cbm` root 下；明确提示 3 候选，冷/暖均没有默选唯一对象 | 通过所测案例；不覆盖全部 60 歧义 |

02 的完整路径：A 为 `CBM/215de1c9-3171-4a47-b324-ed4303a57743.cbm`，B 为
`CBM/1bd26bb4-2896-4a7d-824d-e64eee24ef09.cbm`，模板为
`DEV/3eb53480-871e-4f33-830d-95c51d364d89.dev`。两路径结果均为 partial，未隐藏已知降级。

03 的 root 是 `CBM/976E4AA2-62DB-4009-AAF0-35BE6A468FE7.cbm`，PARTINDEX 是
`CBM/F2B6047C-E753-48C5-A9EA-C8FFE0FE9090.cbm`，DEV 为
`DEV/25E4F816-40CB-4FAD-B6F9-7EDF58728E46.dev`。其语义名称“接线端子板”和 DEV
名称“支柱绝缘子_2”在截图中同时保留，没有用名称推断或替换文件引用。

主证据：`desktop02-cold-latest-b.png` / `desktop02-cold-result.log`，
`desktop02-glb-latest-b.png` / `desktop02-glb-result.log`，
`desktop02-empty-selection.png` / `desktop02-empty-result.log`，
`desktop03-reversed-part.png` / `desktop03-reversed-result.log`，
`desktop04-ambiguous-top.png`、`desktop04-warm-ambiguous.png` / `desktop04-warm-result.log`。
独立摘要为 `demo/desktop-interaction-evidence.json`，包含样本 SHA、运行环境和源码摘要。

另观察到 04 的一个嵌套语义 PARTINDEX（`85401e77…cbm`）有 8 个装配候选，既有 alias
索引的 owner 为另一个 PARTINDEX（`9a92e50d…cbm`），该语义 owner 不对应已加载的 F4
placement root，因此这次没有可显示候选几何。当前保留候选提示、无确定性完整性诊断、
新语义选择和原相机，不退化为全站 DEV 匹配。本轮没有重做 occurrence 模型或猜唯一对象；
该嵌套 owner 案例的实际几何定位仍待后续证据与修复。

截图只证明所测对象在这次操作中的观察结果，没有原厂对照或独立几何证据，不能据此
声称全站几何完整还原。01 桌面视觉未执行；02/03 默认完整工程冷暖流程、unsupported-only
对象的桌面行为也没有标为通过。

## 可直接执行的人工补验

1. 正常启动 Tauri、打开 02，等待正常交互就绪；在功能树定位上述 A/B，快速交替点击。
   检查最后一项的标题、树行、底栏、高亮和相机，慢任务完成后不跳回前项。
2. 正常关闭并重新打开 02，重复 A/B；记录是 raw 还是 GLB 恢复，并确认每 root 一份。
3. 打开 03，点击上述 PARTINDEX，检查来源 DEV UUID 与高亮的 root/sub:1，而非部件数组
   第 0 项。仅根据真实引用评估，不用名称相似推断对象。
4. 从可显示设备点击 02 的 `CBM/9feab04d-a1fb-4477-8a0b-d2c7f7ce3c26.cbm`，确认空状态、
   旧高亮消失、几何仍在、相机不移动；再另选已知 unsupported 对象，记录其具体诊断。
5. 打开 04，选择 `CBM/f3fb56ea-7347-45ef-a8ba-8545bf399941.cbm`，确认三个候选都属于
   `CBM/048872d3-0c79-4f0a-aa91-979a4255d019.cbm`，没有被默选成唯一候选。

每次记录实际 commit/工作区状态、样本 SHA、冷暖路径、request/root/assembly、截图和
失败/未执行项。遇到完整工程加载无响应时记录该限制，不把受控延迟实验替代为默认流程。

## 缓存与本轮边界

未改变 SQLite schema、FAM 行身份、DEV/GLB 序列化 identity、manifest 或缓存持久化含义，
因此无 schema migration、无 cache bump、无缓存清空。保持变电语义 v25、geometry
v8-occurrence、Spatial parser v23/snapshot v2、Fragments v6 和默认关闭值；线路版本不变。
选择状态和补充 raw 诊断只属于当前运行会话。

没有新增 primitive、推断 GL sidecar 的连接空间语义、引入 InstancedMesh、选择厂商分支，
也没有为 04 歧义制造唯一关联。大型 IFC 完整打开、04 上述嵌套语义 owner 定位、原厂几何
对照均未由本轮关闭，不扩展为性能或架构专项。
