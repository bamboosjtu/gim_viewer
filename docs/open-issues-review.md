# open-issues 逐项复核

复核版本：v0.0.18（提交 `5d71fe2` 之后的工作树）。
判定规则：当前代码/实测仍能复现条目描述的风险或缺口为“有效”；已被新路径替代或不再作为发布目标为“关闭”。

| ID | 判定 | 证据 | 处置 |
|---|---|---|---|
| D-06 | 关闭 | 线路 GIMPKGT 已复用内嵌 7-Zip 流式解压；line03 冷启动 smoke：0.0 s 点击 → 4.1 s 批量读取 → 5.3 s 线路工程已加载 → 9.9 s 地图就绪（111 杆塔/1081 导线段/772 跨越物） | 已实现并验证 |

已关闭：

- D-23（相机交互）：substation04 合成路线 698 帧 p95 7 ms、max 83 ms、longtask 1/88 ms；draw calls/真实路线未采，作为已接受边界记录。

- D-17（IFC 近景区域）：当前 30 m/自动视域与已识别小孔策略交付；未缓存类型可能重开整源，作为已接受边界记录在性能文档。
- D-21（DEV LOD 长尾）：2–8 Worker、输出背压、远景小构件过滤和延迟范围目录已限制长尾；LOD1/2 缓存未命中仍走主线程 RPC，作为已接受边界监控。
- D-29（Spatial SHA）：仍逐文件扫描 STEP，未做跨阶段 SHA 复用；04 真冷 9.6 s，空间 span 已与 finalize/写入分离，暂不优化。

- D-22（selection 并行超时）：将 vitest fork 并发限制为 4，保留 5 s 超时与全部断言；全量 105 文件/928 用例 925 passed + 3 skipped，0 failed。

- D-24（属性面板）：第一层（摘要/关键参数/工程标识/搜索/组件合并）已交付；Pset 提升、冲突提示、虚拟化属后续产品增强，待明确优先级后再立项。

- D-28（业务别名/分类）：系统前缀、自然排序、确定别名已修正；剩余任意层级分类/装配歧义需业务输入，当前无工程动作。

- D-12（fallback）：桌面发布以 native 解压为唯一主路径；native 写盘/截断/缺失/重试由现有测试覆盖，A→B 同进程验证通过；WASM 回退不作为发布验收范围。

- D-14（遗留 GLB 回退）：仅 manifest/version 失效时整域重建；默认逐模板原子缓存与 retry 保留，现有样本未见 transient 失败导致整批恢复，接受为低频回退路径。

- D-26（空间索引 span）：当前 变电 IFC 空间索引 只包 Worker build；finalize/缓存写入在 span 外，spatialSemanticReady 单独记录 rebuildMs/writeMs，未发现固定主线程成本。

- D-27（同进程重开）：substation02 打开 2.4 s / 关闭 121 ms / 重开 2.2 s / 切换 500-B1-2 7.7 s / 关闭 / 重开 2.0 s；无 poisoned，AbortError 为预期取消。

- D-02（DEV 诊断原因）：IR 原因已映射 empty-device-xml/assembly/dev-no-solidmodel/phm-no-solidmodel/parser-unsupported，raw 路径同步；selection 测试 25/25。

- D-05（线路内存）：空载 387 MB/JS 2.2 MB；line03 打开 540 MB/JS 39.8 MB；关闭后 GC JS 14.2 MB，渲染进程工作集未完全归还；暂不需要属性 lazy load。

- D-04（杆塔预览）：首开约 2.0 s 但属性面板异步先显示；同一塔位缓存后 75 ms；树/地图不被阻塞。

- D-30（大文件/大工程打开）：500 样本真冷首屏 22.8/40.2/14.7/23.1/59.2 s，全部 <60 s；7-Zip 流式解压、32 路 CBM 解析、远景小构件过滤与延迟 DEV 范围均已落地。

- D-11（摄像头异常矩阵）：决定不做局部保留，保持 source-invalid 可追溯，避免把部分恢复标为完整。
- D-13（validation reparse）：B1-4 87,205 条目 validation 1.48 s，pack 成员已跳过逐条 reparse；不再作为待优化项。

- D-25（452 MB IFC）：真冷转换 127 s 完成；跳过开关 ON 时 IFC 7/7、状态栏显示“已跳过 1 个超大 IFC”，OFF 时 8/8 正常加载，无静默丢弃。

- D-01（四包真冷与延迟门禁）：首屏 23.7/17.5/22.3/9.6 s，heartbeat ≤326 ms、输入 ≤1.5 ms；03 的 452 MB IFC 真冷转换 127 s 完成。
- D-06（line03 原生 7z 冷解码）：线路 GIMPKGT 已复用内嵌 7-Zip 流式解压；line03 冷启动 9.9 s 地图就绪，功能 smoke 通过。
- D-16（early semantic 默认策略）：保留为调试开关，不再作为默认发布目标；解压提速由内嵌 7-Zip 流式路径承担，见 `docs/architecture.md`。
