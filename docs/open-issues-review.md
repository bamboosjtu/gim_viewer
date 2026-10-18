# open-issues 逐项复核

复核版本：v0.0.18（提交 `5d71fe2` 之后的工作树）。
判定规则：当前代码/实测仍能复现条目描述的风险或缺口为“有效”；已被新路径替代或不再作为发布目标为“关闭”。

| ID | 判定 | 证据 | 处置 |
|---|---|---|---|
| D-01 | 有效 | `docs/performance.md` 只有 01/03/04/B1-4 的单点数据，没有四包完整加载矩阵与 heartbeat/输入延迟门禁 | 下一轮补四包冷/暖矩阵 |
| D-02 | 有效 | `geometryDiagnostics.ts` 定义 9 种 reason，但 DEV 级只写入 4 种；IR 的 empty-device-xml/assembly/phm 未映射 | 实现 IR→DEV 诊断映射 |
| D-04 | 有效 | 杆塔 HNum 预览没有 read/parse/render 拆分数据 | 需补测 |
| D-05 | 有效 | 线路 warm 内存没有独立进程归因 | 需补测 |
| D-06 | 有效 | 内嵌 7-Zip 只接在 GIMPKGS；线路 GIMPKGT 仍走 sevenz-rust | 复用内嵌 7z 到线路路径 |
| D-11 | 有效 | substation02 摄像头 10¹⁴ mm 矩阵仍按 source-invalid 拒绝，局部保留未决策 | 保持现状并记录 |
| D-12 | 有效 | WASM 回退/截断索引/写入失败闭环无新证据 | 需补测 |
| D-13 | 有效 | validation 仍逐文件 reparse；未见 fail-closed 去重证据 | 需补测后再优化 |
| D-14 | 有效 | `modAutoLoadService.ts` 仍有 geometry manifest 失效时重建整域的分支 | 评估适用范围 |
| D-17 | 有效 | IFC 近景区域子集仍不覆盖所有类型/回退路径 | 后续扩展 |
| D-21 | 有效 | DEV Worker 池已改为逻辑核数 60%（2–8），长尾/内存仍未验收 | 需补测 |
| D-22 | 有效 | 全量 105 文件/925 用例：2 个 selection 失败；单文件 25/25 通过；devLodLoading 夹具已修正并通过 | 继续定位并行 flake |
| D-23 | 有效 | 大规模相机交互没有固定路线 p95/p99 数据 | 需补测 |
| D-24 | 有效 | 属性面板第一层已实现；Pset 提升、冲突提示、虚拟化未完成 | 后续实现 |
| D-25 | 有效 | 452 MB IFC 真冷未在本轮复测（IndexedDB 未清） | 后续验收 |
| D-26 | 有效 | spatial span 仍未拆分 Worker/finalize/commit | 后续埋点 |
| D-27 | 有效 | 同进程关闭重开与 poisoned 首次 panic 证据仍缺 | 需补测 |
| D-28 | 有效 | 别名/排序已修，任意层级分类与装配歧义仍待业务复核 | 后续复核 |
| D-29 | 有效 | IFC Spatial 仍逐文件扫描；SHA 跨阶段复用未完成 | 后续优化 |
| D-30 | 有效 | B1-4 解压 13.7 s、首屏 74 s；29 s 空档未消除；设备范围目录仍串行 | 继续优化 |

已关闭：

- D-16（early semantic 默认策略）：保留为调试开关，不再作为默认发布目标；解压提速由内嵌 7-Zip 流式路径承担，见 `docs/architecture.md`。
