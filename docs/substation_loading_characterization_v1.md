# 变电加载性能特征化 v1

> 生成时间：2026-09-02T18:02:21.4398670Z；真实 Tauri 记录：13 次。冷启动定义为删除项目缓存后打开，热启动定义为保留缓存后二次打开；每组以 median/P95 汇总。P95 使用 nearest-rank（n=3 时等于该组最大观测值）。

## 结论状态

已采集 13 次 Tauri 运行。下表只使用诊断 JSON 中的真实运行值；Vitest/Node 测试不混入统计。下一轮决策应以表中占主导的阶段为准。

## 测量边界与证据链

- Evidence：`perfSnapshot()` 的 `spans`、`substation.ifcReads/ifcParses/finalize`、`productMoments`、`memory`、`invokes`，以及采集脚本的 Tauri 进程树 RSS。
- Finding：每个阶段的真实 duration/计数/对象数量按 sample × cold/warm 汇总；IFC 逐文件 profile 保留原始 entry path。
- Path：`desktop/src/utils/perfTimings.ts` → `desktop/src/services/openGimService.ts` → `desktop/src/gim/ifcSpatialParser.ts` → Ctrl+Shift+D 诊断 JSON；采集入口为 `tmp/collect-tauri-substation-perf.ps1`。
- RSS 是后端 Tauri 进程或外部进程树工作集，不等同 JS heap；JS heap 缺失时显示为 `-`，不能用 RSS 代替。

## 真实样本

| 样本 | GIM 字节 | GIM MiB |
|---|---:|---:|
| substation01 | 14,381,403 | 13.72 |
| substation02 | 34,176,631 | 32.59 |
| substation03 | 71,831,575 | 68.50 |
| substation04 | 11,789,608 | 11.24 |

## 采集覆盖与限制

| 样本 | 模式 | 完整记录数 | 状态 |
|---|---|---:|---|
| substation01 | cold | 1 | 仅 1 条；不能计算目标 n=3 统计 |
| substation01 | warm | 0 | 未完成（无真实记录） |
| substation02 | cold | 3 | 完成 n=3 |
| substation02 | warm | 3 | 完成 n=3 |
| substation03 | cold | 0 | 未完成（无真实记录） |
| substation03 | warm | 0 | 未完成（无真实记录） |
| substation04 | cold | 3 | 完成 n=3 |
| substation04 | warm | 3 | 完成 n=3 |

> 仅将 `fullModelReady` 成功且诊断 JSON 完整写入的运行计入统计；超时、工程错误或中途退出不补模拟数据。若某样本未达到 n=3，报告中的 median/P95 仅对实际记录展示，并明确标注覆盖不足。

## 产品时刻与峰值内存

| 样本 | 模式 | n | semanticReady median/P95 ms | firstGeometryReady median/P95 ms | fullModelReady median/P95 ms | 外部进程树 RSS median/P95 MB | 后端 RSS median/P95 MB | Long Task median/blocking/max ms | Fragments cache enabled/hit |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| substation01 | cold | 1 | 349802/349802 | 350967/350967 | 2867646/2867646 | 4005.5/4005.5 | 27.9/27.9 | 11430/95214/1856 | False/0 |
| substation02 | cold | 3 | 246629/269817 | 248079/273878 | 1283502/2758839 | 5016.5/5470.5 | 34.0/38.0 | 4288/154213/34046 | False/0 |
| substation02 | warm | 3 | 49478/51918 | 50071/52499 | 1549684/1577238 | 7380.6/7770.0 | 16.7/22.1 | 9560/229954/29632 | False/0 |
| substation04 | cold | 3 | 73767/89550 | 77833/96798 | 351345/421074 | 2531.7/2578.6 | 39.6/39.8 | 38/8891/5484 | False/0 |
| substation04 | warm | 3 | 7860/8835 | 9369/10539 | 44531/45871 | 2279.9/2324.6 | 38.0/38.0 | 12/4696/3101 | False/0 |

## 分阶段 duration

| 样本 | 模式 | 阶段 | n | median ms | P95 ms |
|---|---|---|---:|---:|---:|
| substation01 | cold | CBM/FAM/DEV/FileDevRelation | 1 | 111971.9 | 111971.9 |
| substation01 | cold | coordinate alignment | 1 | 1.7 | 1.7 |
| substation01 | cold | IFC discovery | 1 | 24939.3 | 24939.3 |
| substation01 | cold | IFC read/decode | 1 | 1322.2 | 1322.2 |
| substation01 | cold | IFC Spatial Semantic | 1 | 5954.9 | 5954.9 |
| substation01 | cold | MOD/STL | 1 | 2498119.8 | 2498119.8 |
| substation01 | cold | native extract | 1 | 67100.1 | 67100.1 |
| substation01 | cold | native extract · archive decode | 1 | 11010.3 | 11010.3 |
| substation01 | cold | native extract · commit | 1 | 71.9 | 71.9 |
| substation01 | cold | native extract · header | 1 | 1.2 | 1.2 |
| substation01 | cold | native extract · manifest | 1 | 342.6 | 342.6 |
| substation01 | cold | native extract · write | 1 | 52265.4 | 52265.4 |
| substation01 | cold | navigation/UI | 1 | 275.7 | 275.7 |
| substation01 | cold | spatial finalize / CBM linkage | 1 | 152.4 | 152.4 |
| substation01 | cold | web-ifc / Fragments engine | 1 | - | - |
| substation01 | cold | web-ifc / Fragments load | 1 | 18904.6 | 18904.6 |
| substation02 | cold | CBM/FAM/DEV/FileDevRelation | 3 | 62363.0 | 71216.9 |
| substation02 | cold | coordinate alignment | 3 | 10.7 | 52.3 |
| substation02 | cold | IFC discovery | 3 | 16605.5 | 25284.5 |
| substation02 | cold | IFC read/decode | 3 | 10047.4 | 10661.5 |
| substation02 | cold | IFC Spatial Semantic | 3 | 53486.9 | 70781.5 |
| substation02 | cold | MOD/STL | 3 | 781594.8 | 2121276.8 |
| substation02 | cold | native extract | 3 | 46961.4 | 70723.3 |
| substation02 | cold | native extract · archive decode | 3 | 25098.4 | 28574.6 |
| substation02 | cold | native extract · commit | 3 | 23.5 | 32.2 |
| substation02 | cold | native extract · header | 3 | 1.0 | 1.1 |
| substation02 | cold | native extract · manifest | 3 | 82.6 | 84.6 |
| substation02 | cold | native extract · write | 3 | 22926.4 | 43549.6 |
| substation02 | cold | navigation/UI | 3 | 406.8 | 593.9 |
| substation02 | cold | spatial finalize / CBM linkage | 3 | 185.4 | 246.8 |
| substation02 | cold | web-ifc / Fragments engine | 3 | 11.0 | 11.0 |
| substation02 | cold | web-ifc / Fragments load | 3 | 254789.5 | 365172.0 |
| substation02 | warm | CBM/FAM/DEV/FileDevRelation | 3 | 865.7 | 887.0 |
| substation02 | warm | coordinate alignment | 3 | 1.4 | 1.4 |
| substation02 | warm | IFC read/decode | 3 | 7016.5 | 7487.5 |
| substation02 | warm | IFC Spatial Semantic | 3 | 44735.7 | 45449.2 |
| substation02 | warm | MOD/STL | 3 | 1250548.8 | 1274497.7 |
| substation02 | warm | navigation/UI | 3 | 210.3 | 223.2 |
| substation02 | warm | spatial finalize / CBM linkage | 3 | 172.5 | 180.3 |
| substation02 | warm | web-ifc / Fragments engine | 3 | - | - |
| substation02 | warm | web-ifc / Fragments load | 3 | 253090.6 | 255059.4 |
| substation04 | cold | CBM/FAM/DEV/FileDevRelation | 3 | 16638.0 | 24976.2 |
| substation04 | cold | coordinate alignment | 3 | 0.8 | 2.0 |
| substation04 | cold | IFC discovery | 3 | 4909.7 | 7384.0 |
| substation04 | cold | IFC read/decode | 3 | 3332.4 | 5382.3 |
| substation04 | cold | IFC Spatial Semantic | 3 | 11437.5 | 15642.7 |
| substation04 | cold | MOD/STL | 3 | 247675.2 | 282407.9 |
| substation04 | cold | native extract | 3 | 23918.1 | 24194.6 |
| substation04 | cold | native extract · archive decode | 3 | 9867.2 | 12873.3 |
| substation04 | cold | native extract · commit | 3 | 13.3 | 16.8 |
| substation04 | cold | native extract · header | 3 | 2.6 | 7.3 |
| substation04 | cold | native extract · manifest | 3 | 44.4 | 62.7 |
| substation04 | cold | native extract · write | 3 | 12815.8 | 13705.6 |
| substation04 | cold | navigation/UI | 3 | 99.5 | 121.6 |
| substation04 | cold | spatial finalize / CBM linkage | 3 | 33.6 | 35.9 |
| substation04 | cold | web-ifc / Fragments engine | 3 | 0.1 | 0.1 |
| substation04 | cold | web-ifc / Fragments load | 3 | 32101.0 | 48745.3 |
| substation04 | warm | CBM/FAM/DEV/FileDevRelation | 3 | 248.7 | 280.5 |
| substation04 | warm | coordinate alignment | 3 | 1.4 | 1.5 |
| substation04 | warm | IFC read/decode | 3 | 1653.0 | 1805.5 |
| substation04 | warm | IFC Spatial Semantic | 3 | 6184.8 | 6816.6 |
| substation04 | warm | MOD/STL | 3 | 16144.3 | 19499.4 |
| substation04 | warm | navigation/UI | 3 | 23.5 | 33.0 |
| substation04 | warm | spatial finalize / CBM linkage | 3 | 20.7 | 33.5 |
| substation04 | warm | web-ifc / Fragments engine | 3 | 0.1 | 6.8 |
| substation04 | warm | web-ifc / Fragments load | 3 | 19488.2 | 19611.9 |

> 阶段表中的 `-` 表示该路径未执行或没有可分离的独立 span，不表示耗时为 0。热启动不会重新执行 native extract；IFC discovery 在缓存命中时由 SQLite GIM 索引恢复，计入“CBM/FAM/DEV/FileDevRelation（缓存命中）”阶段；已存在的 Fragments 引擎也不会重复记录初始化阶段。

## 每个 IFC 的 Spatial Semantic profile

| 样本 | 模式 | IFC entry | MiB | read/decode median/P95 ms | raw | detail | placement | spatial | objects/contained | total median/P95 ms | STEP median/P95 | placement/detail median/P95 | spatial entity median/P95 | property/quantity/material/classification median/P95 | relationships median/P95 | finalize median/P95 | parse errors |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| substation01 | cold | DEV/电气二次0317其他.ifc | 0.07 | r 11.3/11.3; d 0.1/0.1 | 842 | 626 | 127 | 4 | 6/6 | 13.3/13.3 | 2.6/2.6 | 0.6/0.6 | 2.5/2.5 | 462/-/13/1; 3.4/3.4 | 74/66; 3.2/3.2 | 0.1/0.1 | 0 |
| substation01 | cold | DEV/动力照明0317.ifc | 0.91 | r 29.1/29.1; d 0.3/0.3 | 18167 | 4822 | 3737 | 5 | 46/46 | 114.7/114.7 | 28.4/28.4 | 7.0/7.0 | 24.7/24.7 | 948/-/48/25; 18.7/18.7 | 494/550; 33.5/33.5 | 0.1/0.1 | 0 |
| substation01 | cold | DEV/给排水消防及排油添加主变水喷淋0401.ifc | 5.62 | r 106.5/106.5; d 7.0/7.0 | 82307 | 40187 | 12829 | 5 | 1345/1345 | 810.7/810.7 | 204.0/204.0 | 24.3/24.3 | 222.1/222.1 | 27147/-/42/74; 157.8/157.8 | 9067/12912; 273.0/273.0 | 1.2/1.2 | 0 |
| substation01 | cold | DEV/基础0317.ifc | 0.33 | r 51.7/51.7; d 0.2/0.2 | 4234 | 3152 | 407 | 4 | 77/77 | 85.2/85.2 | 15.1/15.1 | 1.6/1.6 | 21.0/21.0 | 2632/-/81/1; 25.5/25.5 | 583/747; 25.7/25.7 | 0.1/0.1 | 0 |
| substation01 | cold | DEV/建筑部分0317.ifc | 11.15 | r 262.1/262.1; d 9.4/9.4 | 209323 | 65116 | 49421 | 10 | 1078/1078 | 801.4/801.4 | 382.6/382.6 | 71.8/71.8 | 101.6/101.6 | 14958/-/596/3; 97.7/97.7 | 6733/9733; 141.4/141.4 | 0.8/0.8 | 0 |
| substation01 | cold | DEV/接地0317其他.ifc | 0.31 | r 50.0/50.0; d 0.1/0.1 | 4232 | 2852 | 1386 | 6 | 55/55 | 27.0/27.0 | 5.7/5.7 | 1.4/1.4 | 7.7/7.7 | 1440/-/2/1; 7.1/7.1 | 488/770; 9.0/9.0 | 0.1/0.1 | 0 |
| substation01 | cold | DEV/结构0317.ifc | 0.98 | r 29.5/29.5; d 0.4/0.4 | 13717 | 7939 | 3332 | 4 | 258/258 | 110.8/110.8 | 20.4/20.4 | 2.9/2.9 | 33.6/33.6 | 4423/-/2/1; 26.6/26.6 | 2303/3419; 40.5/40.5 | 0.3/0.3 | 0 |
| substation01 | cold | DEV/警卫室建筑0317.ifc | 0.51 | r 44.9/44.9; d 0.2/0.2 | 9020 | 3561 | 2182 | 5 | 97/97 | 57.9/57.9 | 15.8/15.8 | 4.0/4.0 | 9.9/9.9 | 1239/-/110/1; 13.1/13.1 | 695/983; 13.3/13.3 | -/- | 0 |
| substation01 | cold | DEV/暖通布置0317.ifc | 2.32 | r 59.3/59.3; d 1.5/1.5 | 46405 | 12833 | 11009 | 4 | 64/64 | 137.2/137.2 | 61.8/61.8 | 15.4/15.4 | 13.7/13.7 | 1704/-/58/14; 20.3/20.3 | 718/852; 16.5/16.5 | 0.1/0.1 | 0 |
| substation01 | cold | DEV/室内给排水0317.ifc | 4.49 | r 87.1/87.1; d 4.0/4.0 | 77855 | 27236 | 13507 | 8 | 839/839 | 327.8/327.8 | 99.4/99.4 | 14.7/14.7 | 75.7/75.7 | 13541/-/56/1; 66.7/66.7 | 4820/7036; 86.9/86.9 | 0.6/0.6 | 0 |
| substation01 | cold | DEV/一次设备0402其他.ifc | 46.52 | r 481.4/481.4; d 36.4/36.4 | 943232 | 180351 | 165023 | 9 | 705/705 | 1807.5/1807.5 | 1017.2/1017.2 | 108.0/108.0 | 176.5/176.5 | 14943/-/125/69; 250.5/250.5 | 5982/7768; 219.8/219.8 | 0.7/0.7 | 0 |
| substation01 | cold | DEV/总图0317.ifc | 3.30 | r 47.2/47.2; d 2.5/2.5 | 65228 | 18254 | 13415 | 6 | 144/144 | 129.4/129.4 | 68.0/68.0 | 7.8/7.8 | 20.8/20.8 | 4517/-/181/1; 13.4/13.4 | 1170/1357; 23.7/23.7 | 0.2/0.2 | 0 |
| substation02 | cold | CBM/02 场地-围墙.ifc | 2.20 | r 36.0/50.9; d 1.1/1.5 | 39941 | 12458 | 10642 | 4 | 734/734 | 184.9/227.9 | 53.7/70.9 | 9.1/16.2 | 58.2/62.1 | 1759/-/12/-; 26.0/30.6 | 2058/3233; 70.9/75.4 | 0.5/0.5 | 0 |
| substation02 | cold | CBM/02-场坪、道路.ifc | 2.68 | r 52.9/61.8; d 1.0/1.1 | 57572 | 17890 | 17719 | 4 | 10/10 | 137.0/190.4 | 65.7/74.0 | 16.8/17.9 | 16.0/35.3 | 122/-/6/-; 9.2/15.5 | 68/66; 20.1/39.9 | 0.1/0.2 | 0 |
| substation02 | cold | CBM/02-电子围栏.ifc | 22.17 | r 294.5/296.3; d 10.6/15.9 | 461618 | 109497 | 106244 | 4 | 1260/1260 | 1381.5/1414.5 | 602.2/832.4 | 93.0/130.8 | 162.3/203.7 | 3212/-/2/-; 68.0/92.5 | 4355/6856; 211.0/294.2 | 0.8/1.0 | 0 |
| substation02 | cold | CBM/02-夹层支架.ifc | 5.79 | r 81.2/128.3; d 4.1/8.6 | 69955 | 24493 | 10145 | 4 | 3243/3243 | 547.6/1109.3 | 111.3/208.0 | 9.3/14.8 | 132.4/277.1 | 14314/-/1/-; 100.8/199.2 | 16605/22203; 271.7/556.7 | 1.1/2.9 | 0 |
| substation02 | cold | CBM/02-警传室.ifc | 0.55 | r 18.8/24.7; d 0.1/0.2 | 9047 | 3281 | 2249 | 4 | 293/293 | 56.6/111.1 | 20.5/55.5 | 3.4/4.0 | 12.3/21.2 | 879/-/77/-; 9.7/13.7 | 869/1354; 17.2/26.4 | 0.3/0.3 | 0 |
| substation02 | cold | CBM/02-消防喷雾支架.ifc | 7.78 | r 106.0/171.5; d 4.2/10.4 | 151659 | 45929 | 40512 | 2 | 422/422 | 445.3/508.1 | 269.7/298.3 | 27.3/29.7 | 53.7/63.2 | 5387/-/4/-; 16.6/35.2 | 478/1187; 74.5/77.8 | 0.1/0.2 | 0 |
| substation02 | cold | CBM/0301-地下夹层及基础.ifc | 2.97 | r 51.7/79.3; d 1.1/4.4 | 53432 | 19563 | 16957 | 4 | 759/759 | 208.7/265.0 | 62.2/109.7 | 11.2/11.4 | 51.5/56.5 | 2517/-/24/-; 36.0/38.3 | 2699/4267; 66.2/77.0 | 0.5/1.4 | 0 |
| substation02 | cold | CBM/0302-钢结构.ifc | 372.63 | r 6349.8/6350.0; d 294.1/294.9 | 6160057 | 2505585 | 2132613 | 2 | 34232/34232 | 33657.7/47665.4 | 9135.9/12201.1 | 1741.0/2357.8 | 2251.3/4090.9 | 372166/-/5/-; 813.5/1042.0 | 35028/96695; 19948.9/28349.6 | 11.3/11.8 | 0 |
| substation02 | cold | CBM/0303-檩条系统.ifc | 97.13 | r 1329.0/1596.5; d 62.8/70.6 | 1415372 | 1338458 | 1182816 | 2 | 8479/8479 | 5030.4/6680.3 | 2013.5/2798.6 | 546.7/658.7 | 506.7/673.7 | 155629/-/1/-; 329.6/430.7 | 8482/25149; 1495.9/2007.5 | 1.3/3.3 | 0 |
| substation02 | cold | CBM/04-建筑配电楼.ifc | 14.77 | r 491.1/554.1; d 10.6/14.5 | 229747 | 80224 | 67846 | 4 | 7602/7602 | 1184.9/1574.7 | 289.4/338.5 | 32.1/33.3 | 201.8/349.8 | 12217/-/70/-; 128.0/144.9 | 20619/36084; 677.1/958.5 | 1.8/2.3 | 0 |
| substation02 | cold | CBM/06-暖通部分.ifc | 1.49 | r 174.2/192.5; d 1.3/1.3 | 29960 | 10259 | 9289 | 4 | 309/309 | 77.3/104.1 | 29.6/37.7 | 5.9/9.1 | 13.8/20.5 | 904/-/4/-; 7.2/11.9 | 785/1203; 22.2/26.1 | 0.2/0.2 | 0 |
| substation02 | cold | CBM/场地-电缆隧道、电缆沟.ifc | 0.70 | r 74.9/85.7; d 0.5/0.8 | 9614 | 3607 | 2117 | 4 | 372/372 | 51.1/138.8 | 17.7/18.7 | 1.5/3.1 | 15.7/35.9 | 1441/-/6/-; 11.7/12.8 | 1740/2467; 18.3/46.1 | 0.1/0.1 | 0 |
| substation02 | cold | CBM/场地-化粪池.ifc | 0.09 | r 44.7/48.6; d 0.1/0.1 | 1793 | 701 | 575 | 4 | 7/7 | 5.8/6.0 | 2.4/2.7 | 0.8/0.9 | 1.2/1.5 | 90/-/1/-; 0.5/0.5 | 37/35; 1.4/1.7 | -/- | 0 |
| substation02 | cold | CBM/场地-事故油池.ifc | 0.19 | r 33.5/45.4; d 0.1/0.1 | 3921 | 1228 | 943 | 4 | 29/29 | 11.2/16.0 | 4.8/7.0 | 0.6/1.3 | 2.7/2.8 | 236/-/6/-; 1.3/1.5 | 94/120; 3.0/3.4 | -/- | 0 |
| substation02 | cold | CBM/场地-消防泵房.ifc | 0.61 | r 60.3/94.5; d 0.1/0.2 | 9970 | 3463 | 2246 | 4 | 257/257 | 45.9/58.6 | 18.5/21.1 | 1.9/2.6 | 13.7/17.6 | 1092/-/50/-; 8.8/9.6 | 936/1399; 15.5/20.3 | 0.2/0.2 | 0 |
| substation02 | cold | CBM/场地-主变、散热基础.ifc | 0.38 | r 68.7/71.4; d 0.2/0.3 | 4796 | 1949 | 864 | 4 | 200/200 | 33.9/37.5 | 7.3/8.5 | 0.9/0.9 | 9.7/14.5 | 1042/-/4/-; 8.8/9.4 | 1130/1512; 11.4/17.3 | 0.1/0.1 | 0 |
| substation02 | cold | CBM/消防给排水.ifc | 12.61 | r 483.8/593.3; d 8.8/11.9 | 246766 | 65936 | 60693 | 4 | 3968/3968 | 584.9/670.6 | 286.3/326.8 | 28.7/53.0 | 109.9/124.1 | 5149/-/11/-; 44.8/46.2 | 7104/12565; 169.8/231.1 | 0.7/1.1 | 0 |
| substation02 | warm | CBM/02 场地-围墙.ifc | 2.20 | r 44.2/47.0; d 2.1/3.9 | 39941 | 12458 | 10642 | 4 | 734/734 | 98.5/105.9 | 44.0/48.6 | 4.2/4.2 | 25.5/27.4 | 1759/-/12/-; 9.4/9.8 | 2058/3233; 31.0/33.2 | 0.1/0.1 | 0 |
| substation02 | warm | CBM/02-场坪、道路.ifc | 2.68 | r 60.6/66.0; d 4.4/4.9 | 57572 | 17890 | 17719 | 4 | 10/10 | 92.1/111.3 | 62.3/72.0 | 7.8/8.8 | 7.1/10.9 | 122/-/6/-; 2.0/2.5 | 68/66; 9.4/14.3 | -/- | 0 |
| substation02 | warm | CBM/02-电子围栏.ifc | 22.17 | r 212.6/220.0; d 20.2/39.0 | 461618 | 109497 | 106244 | 4 | 1260/1260 | 722.5/722.6 | 425.3/458.1 | 52.7/75.2 | 79.9/83.8 | 3212/-/2/-; 34.6/37.5 | 4355/6856; 109.3/118.3 | 0.2/0.2 | 0 |
| substation02 | warm | CBM/02-夹层支架.ifc | 5.79 | r 78.5/80.4; d 6.9/11.2 | 69955 | 24493 | 10145 | 4 | 3243/3243 | 484.6/504.7 | 112.5/121.1 | 7.1/7.6 | 108.9/122.3 | 14314/-/1/-; 79.3/81.6 | 16605/22203; 252.8/254.8 | 0.4/0.6 | 0 |
| substation02 | warm | CBM/02-警传室.ifc | 0.55 | r 25.0/32.1; d 0.4/0.7 | 9047 | 3281 | 2249 | 4 | 293/293 | 36.0/40.9 | 11.0/14.2 | 2.2/2.8 | 7.9/8.2 | 879/-/77/-; 8.0/8.0 | 869/1354; 9.9/11.1 | 0.1/0.1 | 0 |
| substation02 | warm | CBM/02-消防喷雾支架.ifc | 7.78 | r 107.5/115.1; d 7.6/10.9 | 151659 | 45929 | 40512 | 2 | 422/422 | 242.5/253.0 | 145.0/156.8 | 16.2/16.9 | 25.1/25.4 | 5387/-/4/-; 9.9/11.3 | 478/1187; 37.4/37.6 | 0.1/0.1 | 0 |
| substation02 | warm | CBM/0301-地下夹层及基础.ifc | 2.97 | r 57.5/62.1; d 3.4/5.0 | 53432 | 19563 | 16957 | 4 | 759/759 | 140.0/167.0 | 50.8/52.8 | 6.9/10.8 | 35.3/39.8 | 2517/-/24/-; 17.5/25.3 | 2699/4267; 43.3/49.0 | 0.1/0.1 | 0 |
| substation02 | warm | CBM/0302-钢结构.ifc | 372.63 | r 4224.2/4619.4; d 389.0/579.4 | 6160057 | 2505585 | 2132613 | 2 | 34232/34232 | 29181.1/29643.3 | 7391.3/7547.4 | 1316.4/1365.2 | 1808.7/1865.3 | 372166/-/5/-; 745.1/912.9 | 35028/96695; 17756.5/18062.3 | 11.5/12.0 | 0 |
| substation02 | warm | CBM/0303-檩条系统.ifc | 97.13 | r 1035.9/1179.5; d 101.7/182.9 | 1415372 | 1338458 | 1182816 | 2 | 8479/8479 | 4528.8/4670.0 | 1809.6/1862.6 | 484.2/495.2 | 478.3/495.2 | 155629/-/1/-; 234.4/246.2 | 8482/25149; 1518.2/1666.8 | 1.3/1.5 | 0 |
| substation02 | warm | CBM/04-建筑配电楼.ifc | 14.77 | r 179.8/187.3; d 14.4/20.4 | 229747 | 80224 | 67846 | 4 | 7602/7602 | 1041.1/1076.8 | 272.9/276.1 | 27.0/29.6 | 193.9/194.7 | 12217/-/70/-; 91.1/99.6 | 20619/36084; 563.3/587.7 | 1.0/1.1 | 0 |
| substation02 | warm | CBM/06-暖通部分.ifc | 1.49 | r 38.2/40.5; d 4.9/5.7 | 29960 | 10259 | 9289 | 4 | 309/309 | 120.1/144.7 | 53.8/58.1 | 9.6/9.8 | 15.1/24.0 | 904/-/4/-; 18.2/22.2 | 785/1203; 22.7/30.1 | 0.2/0.2 | 0 |
| substation02 | warm | CBM/场地-电缆隧道、电缆沟.ifc | 0.70 | r 29.9/31.5; d 1.0/1.2 | 9614 | 3607 | 2117 | 4 | 372/372 | 48.2/51.7 | 15.8/16.5 | 0.8/2.0 | 13.0/16.2 | 1441/-/6/-; 8.0/8.4 | 1740/2467; 15.3/19.4 | 0.1/0.1 | 0 |
| substation02 | warm | CBM/场地-化粪池.ifc | 0.09 | r 21.9/26.2; d 0.1/0.2 | 1793 | 701 | 575 | 4 | 7/7 | 4.1/5.5 | 2.0/2.3 | 0.4/0.8 | 0.8/1.2 | 90/-/1/-; 0.3/0.5 | 37/35; 0.9/1.4 | 0.1/0.1 | 0 |
| substation02 | warm | CBM/场地-事故油池.ifc | 0.19 | r 12.5/14.2; d 1.1/1.1 | 3921 | 1228 | 943 | 4 | 29/29 | 19.7/21.7 | 5.4/6.4 | 1.5/2.0 | 4.6/4.6 | 236/-/6/-; 2.6/3.5 | 94/120; 6.1/6.3 | 0.1/0.1 | 0 |
| substation02 | warm | CBM/场地-消防泵房.ifc | 0.61 | r 28.5/35.1; d 2.4/2.6 | 9970 | 3463 | 2246 | 4 | 257/257 | 61.3/104.6 | 18.4/28.8 | 2.6/3.1 | 16.1/23.2 | 1092/-/50/-; 12.7/28.3 | 936/1399; 24.7/32.8 | 0.1/0.3 | 0 |
| substation02 | warm | CBM/场地-主变、散热基础.ifc | 0.38 | r 18.6/26.0; d 0.2/0.5 | 4796 | 1949 | 864 | 4 | 200/200 | 36.1/36.5 | 7.5/8.1 | 0.9/1.1 | 10.9/11.8 | 1042/-/4/-; 8.3/8.5 | 1130/1512; 13.7/14.3 | -/- | 0 |
| substation02 | warm | CBM/消防给排水.ifc | 12.61 | r 159.7/170.2; d 9.4/21.4 | 246766 | 65936 | 60693 | 4 | 3968/3968 | 501.8/510.4 | 232.4/234.9 | 29.5/37.0 | 99.6/106.9 | 5149/-/11/-; 46.0/48.1 | 7104/12565; 140.6/147.7 | 0.5/0.5 | 0 |
| substation04 | cold | DEV/1-版本1.ifc | 13.71 | r 396.5/755.1; d 19.7/19.8 | 251688 | 79546 | 75495 | 5 | 3361/3361 | 1585.9/1905.4 | 670.0/786.9 | 143.8/145.2 | 249.3/264.3 | 3533/-/265/13; 58.3/119.3 | 3841/13585; 510.9/599.8 | 3.1/4.1 | 0 |
| substation04 | cold | DEV/110区域构架-版本1.ifc | 0.95 | r 65.3/82.7; d 1.7/1.9 | 19707 | 7108 | 6985 | 5 | 51/51 | 86.9/100.4 | 52.4/54.7 | 9.0/11.1 | 9.5/11.5 | 63/-/4/1; 2.7/4.2 | 78/204; 12.7/15.1 | 0.1/0.1 | 0 |
| substation04 | cold | DEV/110kv配电装置-其他.ifc | 0.02 | r 17.3/27.0; d 0.1/0.1 | 378 | 186 | 113 | 4 | 2/2 | 3.6/4.1 | 1.2/1.2 | 0.2/0.2 | 1.0/1.3 | 52/-/-/-; 0.4/0.4 | 18/2; 1.3/1.8 | -/- | 0 |
| substation04 | cold | DEV/35kV配电室通风及空调-版本1.ifc | 0.36 | r 28.9/30.7; d 0.2/0.3 | 7494 | 2130 | 1993 | 4 | 158/158 | 41.7/51.7 | 18.1/20.6 | 4.6/5.5 | 8.7/9.1 | 92/-/-/1; 1.3/2.2 | 233/617; 12.3/16.5 | 0.1/0.2 | 0 |
| substation04 | cold | DEV/独立避雷针-版本1.ifc | 0.36 | r 22.9/26.2; d 0.9/1.2 | 8527 | 1686 | 1642 | 4 | 6/6 | 36.8/46.8 | 18.6/25.8 | 3.9/5.6 | 4.9/5.9 | 14/-/4/1; 1.2/1.2 | 16/22; 7.2/8.1 | 0.1/0.1 | 0 |
| substation04 | cold | DEV/二次屏柜-其他.ifc | 0.01 | r 18.3/38.8; d 0.1/0.1 | 113 | 65 | 21 | 3 | -/- | 1.2/1.7 | 0.4/0.9 | 0.1/0.1 | 0.3/0.3 | 23/-/-/-; 0.2/0.2 | 7/-; 0.3/0.3 | -/- | 0 |
| substation04 | cold | DEV/辅助用房-版本1.ifc | 0.45 | r 28.9/33.9; d 0.6/2.4 | 8677 | 3375 | 2987 | 6 | 128/128 | 54.4/77.9 | 22.4/36.2 | 3.9/5.5 | 12.7/13.2 | 225/-/42/1; 2.8/3.9 | 345/595; 17.1/17.8 | 0.1/0.1 | 0 |
| substation04 | cold | DEV/辅助用房结构-版本1.ifc | 0.04 | r 17.6/21.2; d 0.1/0.1 | 630 | 319 | 242 | 5 | 26/26 | 6.0/6.1 | 1.9/2.0 | 0.2/0.3 | 1.7/1.8 | 29/-/24/1; 0.5/0.5 | 68/112; 2.4/2.5 | 0.1/0.1 | 0 |
| substation04 | cold | DEV/构架基础-版本1.ifc | 0.06 | r 14.1/18.5; d 0.1/0.1 | 979 | 462 | 385 | 4 | 44/44 | 8.1/10.7 | 2.7/2.9 | 0.5/0.5 | 2.4/3.6 | 53/-/2/1; 0.8/0.9 | 51/132; 3.0/5.0 | -/- | 0 |
| substation04 | cold | DEV/配电楼-版本1.ifc | 0.97 | r 47.3/69.0; d 2.6/2.8 | 18088 | 6829 | 5944 | 11 | 322/322 | 123.1/128.8 | 49.2/49.3 | 8.9/9.1 | 24.6/26.6 | 559/-/39/1; 8.1/8.8 | 851/1464; 34.9/37.7 | 0.3/0.4 | 0 |
| substation04 | cold | DEV/配电楼结构-版本1.ifc | 0.44 | r 33.8/42.6; d 0.3/0.3 | 7996 | 3470 | 2815 | 4 | 214/214 | 65.6/66.4 | 23.1/24.1 | 4.6/5.1 | 14.5/14.6 | 516/-/11/1; 7.3/7.8 | 278/810; 18.9/19.2 | 0.2/0.3 | 0 |
| substation04 | cold | DEV/设备基础-版本1.ifc | 0.37 | r 25.4/37.5; d 0.3/1.0 | 7532 | 2643 | 2393 | 4 | 183/183 | 54.9/61.4 | 18.7/28.8 | 4.1/5.1 | 11.4/17.4 | 196/-/26/1; 3.9/3.9 | 214/555; 16.4/21.2 | 0.1/0.2 | 0 |
| substation04 | cold | DEV/设备支架-版本1.ifc | 92.53 | r 2163.7/3512.3; d 107.8/134.3 | 1780745 | 426363 | 425553 | 4 | 519/519 | 5328.2/6811.1 | 3754.4/4642.6 | 535.3/684.1 | 311.0/410.6 | 550/-/143/1; 81.5/133.3 | 676/2076; 389.3/551.3 | 0.1/0.3 | 0 |
| substation04 | cold | DEV/室内电缆沟施工图-版本1.ifc | 1.38 | r 48.2/83.7; d 1.9/2.8 | 23054 | 10356 | 9036 | 4 | 1142/1142 | 143.7/152.0 | 42.1/45.8 | 8.5/10.8 | 30.7/41.9 | 1001/-/218/1; 11.1/12.9 | 1499/3779; 50.4/60.8 | 0.5/0.6 | 0 |
| substation04 | cold | DEV/站区水工布置图-版本1.ifc | 4.22 | r 99.5/130.9; d 5.7/6.0 | 91297 | 19306 | 18917 | 4 | 234/234 | 205.4/248.3 | 129.4/130.2 | 15.8/18.6 | 24.6/33.4 | 191/-/103/1; 5.7/9.2 | 415/930; 30.5/44.9 | 0.1/0.2 | 0 |
| substation04 | cold | DEV/主变基础及防火墙-版本1.ifc | 2.67 | r 63.9/116.2; d 2.9/4.9 | 54529 | 16806 | 15557 | 7 | 915/915 | 164.5/231.1 | 63.4/90.3 | 11.6/15.8 | 30.0/47.3 | 989/-/80/1; 9.0/12.2 | 1113/3685; 52.9/77.2 | 0.6/1.0 | 0 |
| substation04 | cold | DEV/主变区域构架-版本1.ifc | 0.89 | r 54.5/60.0; d 1.2/3.0 | 18932 | 6657 | 6594 | 5 | 18/18 | 68.6/72.3 | 29.4/31.2 | 6.0/8.8 | 4.9/10.5 | 27/-/2/1; 3.8/4.7 | 33/72; 10.5/12.8 | -/- | 0 |
| substation04 | cold | DEV/主变区域配电装置-其他.ifc | 0.02 | r 14.7/17.0; d -/- | 248 | 130 | 57 | 4 | 4/4 | 1.7/3.4 | 0.5/0.6 | 0.3/0.5 | 0.5/1.0 | 52/-/-/-; 0.3/0.5 | 18/4; 0.5/1.2 | 0.1/0.1 | 0 |
| substation04 | cold | DEV/总图-版本1.ifc | 2.58 | r 67.7/107.8; d 3.5/3.6 | 53464 | 14888 | 14112 | 4 | 393/393 | 153.7/193.0 | 91.4/98.7 | 10.7/13.4 | 19.0/35.0 | 452/-/170/1; 6.9/7.9 | 605/1285; 30.1/42.1 | 0.2/0.2 | 0 |
| substation04 | warm | DEV/1-版本1.ifc | 13.71 | r 186.7/200.0; d 16.2/16.6 | 251688 | 79546 | 75495 | 5 | 3361/3361 | 651.2/733.7 | 317.4/330.3 | 31.7/37.7 | 94.0/120.6 | 3533/-/265/13; 22.4/25.3 | 3841/13585; 233.5/262.2 | 1.2/1.4 | 0 |
| substation04 | warm | DEV/110区域构架-版本1.ifc | 0.95 | r 17.0/19.9; d 0.9/1.1 | 19707 | 7108 | 6985 | 5 | 51/51 | 59.9/70.0 | 26.2/28.4 | 6.5/7.3 | 7.3/7.8 | 63/-/4/1; 2.7/8.4 | 78/204; 10.5/11.3 | -/- | 0 |
| substation04 | warm | DEV/110kv配电装置-其他.ifc | 0.02 | r 6.8/10.9; d -/- | 378 | 186 | 113 | 4 | 2/2 | 1.5/1.9 | 0.6/0.6 | 0.2/0.2 | 0.3/0.3 | 52/-/-/-; 0.2/0.3 | 18/2; 0.3/0.5 | -/- | 0 |
| substation04 | warm | DEV/35kV配电室通风及空调-版本1.ifc | 0.36 | r 13.4/13.6; d 0.1/0.1 | 7494 | 2130 | 1993 | 4 | 158/158 | 19.6/25.6 | 6.6/9.6 | 2.0/3.1 | 3.4/5.3 | 92/-/-/1; 0.8/0.8 | 233/617; 4.8/8.1 | 0.1/0.1 | 0 |
| substation04 | warm | DEV/独立避雷针-版本1.ifc | 0.36 | r 12.8/17.2; d 0.2/0.2 | 8527 | 1686 | 1642 | 4 | 6/6 | 20.3/30.8 | 9.7/15.3 | 2.7/3.0 | 2.8/3.0 | 14/-/4/1; 0.9/0.9 | 16/22; 4.2/4.3 | 0.1/0.1 | 0 |
| substation04 | warm | DEV/二次屏柜-其他.ifc | 0.01 | r 6.3/12.4; d 0.1/0.1 | 113 | 65 | 21 | 3 | -/- | 0.6/1.5 | 0.2/0.7 | 0.1/0.1 | 0.2/0.3 | 23/-/-/-; 0.1/0.1 | 7/-; 0.3/0.4 | 0.1/0.1 | 0 |
| substation04 | warm | DEV/辅助用房-版本1.ifc | 0.45 | r 18.7/26.6; d 0.2/0.2 | 8677 | 3375 | 2987 | 6 | 128/128 | 28.3/36.2 | 11.4/11.7 | 2.7/2.8 | 5.4/7.5 | 225/-/42/1; 2.0/3.0 | 345/595; 7.9/11.2 | 0.1/0.1 | 0 |
| substation04 | warm | DEV/辅助用房结构-版本1.ifc | 0.04 | r 9.5/11.9; d -/- | 630 | 319 | 242 | 5 | 26/26 | 2.4/2.7 | 1.0/1.1 | 0.1/0.2 | 0.5/0.6 | 29/-/24/1; 0.2/0.3 | 68/112; 0.7/0.7 | -/- | 0 |
| substation04 | warm | DEV/构架基础-版本1.ifc | 0.06 | r 6.5/7.3; d -/- | 979 | 462 | 385 | 4 | 44/44 | 6.5/6.7 | 2.1/2.8 | 0.3/1.3 | 1.4/1.5 | 53/-/2/1; 0.6/0.8 | 51/132; 1.7/1.9 | 0.1/0.1 | 0 |
| substation04 | warm | DEV/配电楼-版本1.ifc | 0.97 | r 21.4/23.1; d 0.9/2.7 | 18088 | 6829 | 5944 | 11 | 322/322 | 69.5/79.2 | 22.9/25.0 | 4.7/6.6 | 13.4/15.7 | 559/-/39/1; 5.0/10.6 | 851/1464; 21.4/21.5 | 0.1/0.1 | 0 |
| substation04 | warm | DEV/配电楼结构-版本1.ifc | 0.44 | r 10.8/15.9; d 0.2/0.2 | 7996 | 3470 | 2815 | 4 | 214/214 | 29.9/35.1 | 12.7/17.0 | 2.2/2.6 | 5.7/7.6 | 516/-/11/1; 2.3/3.6 | 278/810; 7.6/9.3 | 0.1/0.1 | 0 |
| substation04 | warm | DEV/设备基础-版本1.ifc | 0.37 | r 15.6/43.8; d 0.2/0.3 | 7532 | 2643 | 2393 | 4 | 183/183 | 39.3/39.4 | 10.3/13.5 | 3.1/4.2 | 8.3/10.2 | 196/-/26/1; 4.9/5.0 | 214/555; 12.0/12.4 | 0.1/0.1 | 0 |
| substation04 | warm | DEV/设备支架-版本1.ifc | 92.53 | r 1002.0/1127.9; d 70.8/74.4 | 1780745 | 426363 | 425553 | 4 | 519/519 | 2998.4/3373.0 | 2026.3/2211.1 | 248.4/320.9 | 293.6/320.1 | 550/-/143/1; 47.8/68.9 | 676/2076; 363.3/397.1 | 0.1/0.3 | 0 |
| substation04 | warm | DEV/室内电缆沟施工图-版本1.ifc | 1.38 | r 29.3/34.5; d 1.0/1.0 | 23054 | 10356 | 9036 | 4 | 1142/1142 | 98.7/106.0 | 35.9/38.1 | 4.6/6.2 | 25.3/27.7 | 1001/-/218/1; 6.0/7.5 | 1499/3779; 41.6/44.5 | 0.4/0.4 | 0 |
| substation04 | warm | DEV/站区水工布置图-版本1.ifc | 4.22 | r 56.3/56.8; d 4.4/4.7 | 91297 | 19306 | 18917 | 4 | 234/234 | 194.9/209.1 | 89.7/98.9 | 18.2/19.5 | 22.8/31.1 | 191/-/103/1; 12.4/18.9 | 415/930; 31.9/40.0 | 0.1/0.2 | 0 |
| substation04 | warm | DEV/主变基础及防火墙-版本1.ifc | 2.67 | r 36.0/45.4; d 2.4/3.2 | 54529 | 16806 | 15557 | 7 | 915/915 | 206.0/217.5 | 73.3/74.3 | 13.1/16.2 | 38.8/42.0 | 989/-/80/1; 17.5/20.4 | 1113/3685; 64.6/68.6 | 0.4/0.6 | 0 |
| substation04 | warm | DEV/主变区域构架-版本1.ifc | 0.89 | r 26.6/27.2; d 0.3/0.7 | 18932 | 6657 | 6594 | 5 | 18/18 | 41.9/52.3 | 20.2/20.5 | 6.7/6.7 | 3.5/4.3 | 27/-/2/1; 1.8/3.5 | 33/72; 5.2/7.9 | -/- | 0 |
| substation04 | warm | DEV/主变区域配电装置-其他.ifc | 0.02 | r 9.6/15.7; d 0.1/0.1 | 248 | 130 | 57 | 4 | 4/4 | 1.5/1.5 | 0.5/0.5 | 0.1/0.1 | 0.4/0.5 | 52/-/-/-; 0.3/0.3 | 18/4; 0.4/0.5 | -/- | 0 |
| substation04 | warm | DEV/总图-版本1.ifc | 2.58 | r 34.1/39.2; d 2.4/2.5 | 53464 | 14888 | 14112 | 4 | 393/393 | 127.5/141.3 | 70.5/72.0 | 9.4/18.5 | 15.8/22.2 | 452/-/170/1; 4.9/10.0 | 605/1285; 21.4/28.6 | 0.1/0.2 | 0 |

> IFC duration 单元统一为 `median/P95`（ms）；`read/decode` 单元中 `r` 为磁盘读取、`d` 为 TextDecoder。`property/quantity/material/classification` 列依次为实体数量，随后为该阶段 median/P95；`relationships` 列为 record/reference 数量，随后为该阶段 median/P95。每次 run 的完整 `propertyValueCount`、`quantityValueCount` 等仍保存在同目录 `summary.json` 与 `raw/*.json`。

## 分阶段内存（RSS 与 JS heap 分列）

| 样本 | 模式 | 阶段 | 指标 | n | median MB | P95 MB | max MB |
|---|---|---|---|---:|---:|---:|---:|
| substation01 | cold | 第一个 Fragments model 后 | backend RSS | 1 | 21.2 | 21.2 | 21.2 |
| substation01 | cold | 第一个 Fragments model 后 | JS heap used | 1 | 862.9 | 862.9 | 862.9 |
| substation01 | cold | CBM/FAM/DEV/FileDevRelation 后 | backend RSS | 1 | 18.0 | 18.0 | 18.0 |
| substation01 | cold | CBM/FAM/DEV/FileDevRelation 后 | JS heap used | 1 | 794.9 | 794.9 | 794.9 |
| substation01 | cold | extraction 后 | backend RSS | 1 | 17.3 | 17.3 | 17.3 |
| substation01 | cold | extraction 后 | JS heap used | 1 | 1214.5 | 1214.5 | 1214.5 |
| substation01 | cold | full ready 后 | backend RSS | 1 | 27.9 | 27.9 | 27.9 |
| substation01 | cold | full ready 后 | JS heap used | 1 | 1179.7 | 1179.7 | 1179.7 |
| substation01 | cold | IFC discovery 后 | backend RSS | 1 | 17.3 | 17.3 | 17.3 |
| substation01 | cold | IFC discovery 后 | JS heap used | 1 | 783.9 | 783.9 | 783.9 |
| substation01 | cold | IFC text 读入后 | backend RSS | 1 | 18.2 | 18.2 | 18.2 |
| substation01 | cold | IFC text 读入后 | JS heap used | 1 | 794.9 | 794.9 | 794.9 |
| substation01 | cold | SpatialIndex finalize 后 | backend RSS | 1 | 21.1 | 21.1 | 21.1 |
| substation01 | cold | SpatialIndex finalize 后 | JS heap used | 1 | 1125.2 | 1125.2 | 1125.2 |
| substation01 | cold | STEP scan 后 | backend RSS | 1 | 18.2 | 18.2 | 18.2 |
| substation01 | cold | STEP scan 后 | JS heap used | 1 | 777.3 | 777.3 | 777.3 |
| substation02 | cold | 第一个 Fragments model 后 | backend RSS | 3 | 18.2 | 33.9 | 33.9 |
| substation02 | cold | 第一个 Fragments model 后 | JS heap used | 3 | 743.2 | 3171.9 | 3171.9 |
| substation02 | cold | CBM/FAM/DEV/FileDevRelation 后 | backend RSS | 3 | 34.0 | 38.0 | 38.0 |
| substation02 | cold | CBM/FAM/DEV/FileDevRelation 后 | JS heap used | 3 | 56.6 | 66.2 | 66.2 |
| substation02 | cold | extraction 后 | backend RSS | 3 | 33.9 | 37.2 | 37.2 |
| substation02 | cold | extraction 后 | JS heap used | 3 | 307.5 | 735.2 | 735.2 |
| substation02 | cold | full ready 后 | backend RSS | 3 | 14.1 | 18.5 | 18.5 |
| substation02 | cold | full ready 后 | JS heap used | 3 | 1262.9 | 1273.6 | 1273.6 |
| substation02 | cold | IFC discovery 后 | backend RSS | 3 | 34.0 | 37.5 | 37.5 |
| substation02 | cold | IFC discovery 后 | JS heap used | 3 | 65.2 | 76.2 | 76.2 |
| substation02 | cold | IFC text 读入后 | backend RSS | 3 | 34.0 | 38.0 | 38.0 |
| substation02 | cold | IFC text 读入后 | JS heap used | 3 | 55.2 | 75.3 | 75.3 |
| substation02 | cold | SpatialIndex finalize 后 | backend RSS | 3 | 17.9 | 33.8 | 33.8 |
| substation02 | cold | SpatialIndex finalize 后 | JS heap used | 3 | 3121.7 | 3153.7 | 3153.7 |
| substation02 | cold | STEP scan 后 | backend RSS | 3 | 34.0 | 38.0 | 38.0 |
| substation02 | cold | STEP scan 后 | JS heap used | 3 | 63.6 | 80.3 | 80.3 |
| substation02 | warm | 第一个 Fragments model 后 | backend RSS | 3 | 16.7 | 22.1 | 22.1 |
| substation02 | warm | 第一个 Fragments model 后 | JS heap used | 3 | 3525.7 | 3526.6 | 3526.6 |
| substation02 | warm | CBM/FAM/DEV/FileDevRelation 后（缓存命中） | backend RSS | 3 | 14.1 | 18.8 | 18.8 |
| substation02 | warm | CBM/FAM/DEV/FileDevRelation 后（缓存命中） | JS heap used | 3 | 1305.4 | 1355.4 | 1355.4 |
| substation02 | warm | full ready 后 | backend RSS | 3 | 13.3 | 14.8 | 14.8 |
| substation02 | warm | full ready 后 | JS heap used | 3 | 1280.9 | 1330.4 | 1330.4 |
| substation02 | warm | IFC text 读入后 | backend RSS | 3 | 14.6 | 19.3 | 19.3 |
| substation02 | warm | IFC text 读入后 | JS heap used | 3 | 1305.4 | 1355.4 | 1355.4 |
| substation02 | warm | SpatialIndex finalize 后（缓存命中） | backend RSS | 3 | 16.7 | 22.0 | 22.0 |
| substation02 | warm | SpatialIndex finalize 后（缓存命中） | JS heap used | 3 | 3509.5 | 3509.7 | 3509.7 |
| substation02 | warm | STEP scan 后 | backend RSS | 3 | 14.6 | 19.3 | 19.3 |
| substation02 | warm | STEP scan 后 | JS heap used | 3 | 1305.4 | 1355.4 | 1355.4 |
| substation04 | cold | 第一个 Fragments model 后 | backend RSS | 3 | 39.4 | 39.6 | 39.6 |
| substation04 | cold | 第一个 Fragments model 后 | JS heap used | 3 | 821.9 | 826.0 | 826.0 |
| substation04 | cold | CBM/FAM/DEV/FileDevRelation 后 | backend RSS | 3 | 38.5 | 38.6 | 38.6 |
| substation04 | cold | CBM/FAM/DEV/FileDevRelation 后 | JS heap used | 3 | 183.3 | 187.9 | 187.9 |
| substation04 | cold | extraction 后 | backend RSS | 3 | 38.3 | 38.4 | 38.4 |
| substation04 | cold | extraction 后 | JS heap used | 3 | 311.2 | 317.3 | 317.3 |
| substation04 | cold | full ready 后 | backend RSS | 3 | 37.5 | 37.9 | 37.9 |
| substation04 | cold | full ready 后 | JS heap used | 3 | 371.6 | 381.3 | 381.3 |
| substation04 | cold | IFC discovery 后 | backend RSS | 3 | 38.5 | 38.6 | 38.6 |
| substation04 | cold | IFC discovery 后 | JS heap used | 3 | 187.7 | 188.9 | 188.9 |
| substation04 | cold | IFC text 读入后 | backend RSS | 3 | 38.5 | 38.6 | 38.6 |
| substation04 | cold | IFC text 读入后 | JS heap used | 3 | 210.3 | 211.5 | 211.5 |
| substation04 | cold | SpatialIndex finalize 后 | backend RSS | 3 | 38.7 | 39.8 | 39.8 |
| substation04 | cold | SpatialIndex finalize 后 | JS heap used | 3 | 738.8 | 742.5 | 742.5 |
| substation04 | cold | STEP scan 后 | backend RSS | 3 | 38.5 | 38.6 | 38.6 |
| substation04 | cold | STEP scan 后 | JS heap used | 3 | 263.2 | 264.5 | 264.5 |
| substation04 | warm | 第一个 Fragments model 后 | backend RSS | 3 | 36.7 | 36.8 | 36.8 |
| substation04 | warm | 第一个 Fragments model 后 | JS heap used | 3 | 705.3 | 706.0 | 706.0 |
| substation04 | warm | CBM/FAM/DEV/FileDevRelation 后（缓存命中） | backend RSS | 3 | 36.6 | 36.6 | 36.6 |
| substation04 | warm | CBM/FAM/DEV/FileDevRelation 后（缓存命中） | JS heap used | 3 | 371.3 | 390.5 | 390.5 |
| substation04 | warm | full ready 后 | backend RSS | 3 | 37.9 | 38.0 | 38.0 |
| substation04 | warm | full ready 后 | JS heap used | 3 | 386.3 | 394.2 | 394.2 |
| substation04 | warm | IFC text 读入后 | backend RSS | 3 | 36.6 | 36.6 | 36.6 |
| substation04 | warm | IFC text 读入后 | JS heap used | 3 | 371.3 | 396.0 | 396.0 |
| substation04 | warm | SpatialIndex finalize 后（缓存命中） | backend RSS | 3 | 36.6 | 38.0 | 38.0 |
| substation04 | warm | SpatialIndex finalize 后（缓存命中） | JS heap used | 3 | 687.4 | 688.5 | 688.5 |
| substation04 | warm | STEP scan 后 | backend RSS | 3 | 36.6 | 36.6 | 36.6 |
| substation04 | warm | STEP scan 后 | JS heap used | 3 | 371.9 | 391.6 | 391.6 |

> RSS 为 Tauri 后端进程工作集采样；JS heap 为 WebView 可用时的 `performance.memory` 读数。两者不是同一指标，不能互相替代。

## 峰值内存所在阶段

| 样本 | 模式 | 指标 | 峰值检查点 | 峰值 MB | 归因边界 |
|---|---|---|---|---:|---|
| substation01 | cold | backend RSS | full ready 后 | 27.9 | 按 Tauri 后端 RSS 检查点；外部进程树 RSS 仅有 run-level 峰值 |
| substation01 | cold | JS heap used | extraction 后 | 1214.5 | 按 WebView heap 检查点 |
| substation02 | cold | backend RSS | CBM/FAM/DEV/FileDevRelation 后 | 38.0 | 按 Tauri 后端 RSS 检查点；外部进程树 RSS 仅有 run-level 峰值 |
| substation02 | cold | JS heap used | 第一个 Fragments model 后 | 3171.9 | 按 WebView heap 检查点 |
| substation02 | warm | backend RSS | 第一个 Fragments model 后 | 22.1 | 按 Tauri 后端 RSS 检查点；外部进程树 RSS 仅有 run-level 峰值 |
| substation02 | warm | JS heap used | 第一个 Fragments model 后 | 3526.6 | 按 WebView heap 检查点 |
| substation04 | cold | backend RSS | SpatialIndex finalize 后 | 39.8 | 按 Tauri 后端 RSS 检查点；外部进程树 RSS 仅有 run-level 峰值 |
| substation04 | cold | JS heap used | 第一个 Fragments model 后 | 826.0 | 按 WebView heap 检查点 |
| substation04 | warm | backend RSS | full ready 后 | 38.0 | 按 Tauri 后端 RSS 检查点；外部进程树 RSS 仅有 run-level 峰值 |
| substation04 | warm | JS heap used | 第一个 Fragments model 后 | 706.0 | 按 WebView heap 检查点 |

## 每次运行的主导阶段

| 样本 | 模式 | 主导阶段（median 最大） | median ms | P95 ms |
|---|---|---|---:|---:|
| substation01 | cold | MOD/STL | 2498119.8 | 2498119.8 |
| substation02 | cold | MOD/STL | 781594.8 | 2121276.8 |
| substation02 | warm | MOD/STL | 1250548.8 | 1274497.7 |
| substation04 | cold | MOD/STL | 247675.2 | 282407.9 |
| substation04 | warm | web-ifc / Fragments load | 19488.2 | 19611.9 |

## Tauri IPC

| 样本 | 模式 | command | 调用次数 | bytes | total ms | p50 median ms | p95 median ms | max ms | failures | bytes measured |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|:---:|
| substation01 | cold | delete_glb_cache | 1 | - | 9.8 | 9.8 | 9.8 | 9.8 | 0 | False |
| substation01 | cold | extract_gim_archive | 1 | 2808945 | 66935.4 | 66935.4 | 66935.4 | 66935.4 | 0 | False |
| substation01 | cold | get_db_path | 1 | 69 | 16.4 | 16.4 | 16.4 | 16.4 | 0 | True |
| substation01 | cold | get_file_info | 1 | - | 245.2 | 245.2 | 245.2 | 245.2 | 0 | False |
| substation01 | cold | get_process_memory | 8 | - | 114.2 | 9.1 | 37.9 | 37.9 | 0 | False |
| substation01 | cold | get_project_diagnostic | 1 | - | 198.7 | 198.7 | 198.7 | 198.7 | 0 | False |
| substation01 | cold | read_cached_entry | 91293 | 240872630 | 3877138.8 | 6.1 | 145.7 | 7004.2 | 0 | False |
| substation01 | cold | save_geometry_refs | 1 | - | 553.6 | 553.6 | 553.6 | 553.6 | 0 | False |
| substation01 | cold | save_gim_index | 1 | - | 9191.0 | 9191.0 | 9191.0 | 9191.0 | 0 | False |
| substation01 | cold | upsert_gim_project | 1 | - | 17.8 | 17.8 | 17.8 | 17.8 | 0 | False |
| substation01 | cold | validate_gim_cache | 1 | - | 12.0 | 12.0 | 12.0 | 12.0 | 0 | False |
| substation01 | cold | write_geometry_cache_manifest | 1 | 87 | 689.2 | 689.2 | 689.2 | 689.2 | 0 | False |
| substation01 | cold | write_geometry_cache_version | 1 | 81 | 10.4 | 10.4 | 10.4 | 10.4 | 0 | False |
| substation01 | cold | write_glb_file_binary | 285 | 179324555 | 46413.1 | 163.0 | 341.4 | 731.9 | 0 | True |
| substation02 | cold | delete_glb_cache | 3 | - | 67.9 | 9.5 | 9.5 | 53.6 | 0 | False |
| substation02 | cold | extract_gim_archive | 3 | 2498397 | 159258.2 | 46882.4 | 46882.4 | 70606.1 | 0 | False |
| substation02 | cold | get_db_path | 3 | 207 | 80.9 | 7.6 | 7.6 | 67.7 | 0 | True |
| substation02 | cold | get_file_info | 3 | - | 1976.1 | 569.0 | 569.0 | 855.8 | 0 | False |
| substation02 | cold | get_process_memory | 24 | - | 863.7 | 6.6 | 199.6 | 235.5 | 0 | False |
| substation02 | cold | get_project_diagnostic | 3 | - | 343.1 | 58.4 | 58.4 | 265.4 | 0 | False |
| substation02 | cold | read_cached_entry | 101535 | 3472778862 | 5393478.6 | 5.1 | 190.4 | 9396.9 | 0 | False |
| substation02 | cold | save_geometry_refs | 3 | - | 402.9 | 133.3 | 133.3 | 147.6 | 0 | False |
| substation02 | cold | save_gim_index | 3 | - | 7835.8 | 1996.8 | 1996.8 | 4097.3 | 0 | False |
| substation02 | cold | upsert_gim_project | 3 | - | 67.8 | 21.9 | 21.9 | 41.2 | 0 | False |
| substation02 | cold | validate_gim_cache | 3 | - | 88.5 | 12.2 | 12.2 | 70.4 | 0 | False |
| substation02 | cold | write_geometry_cache_manifest | 3 | 261 | 4797.0 | 1456.5 | 1456.5 | 2031.3 | 0 | False |
| substation02 | cold | write_geometry_cache_version | 3 | 243 | 291.5 | 19.2 | 19.2 | 263.4 | 0 | False |
| substation02 | cold | write_glb_file_binary | 1881 | 186759651 | 154097.2 | 36.5 | 222.3 | 730.9 | 0 | True |
| substation02 | warm | batch_read_cached_files | 3 | 12824031 | 1600.5 | 525.4 | 525.4 | 564.1 | 0 | True |
| substation02 | warm | get_db_path | 4 | 276 | 894.7 | 206.2 | 209.9 | 274.0 | 0 | True |
| substation02 | warm | get_file_info | 3 | - | 3812.2 | 1340.2 | 1340.2 | 1365.5 | 0 | False |
| substation02 | warm | get_gim_index | 3 | - | 2399.7 | 829.9 | 829.9 | 858.6 | 0 | False |
| substation02 | warm | get_process_memory | 18 | - | 765.1 | 9.9 | 197.1 | 205.6 | 0 | False |
| substation02 | warm | get_project_diagnostic | 4 | - | 774.7 | 197.9 | 197.9 | 198.7 | 0 | False |
| substation02 | warm | get_reachable_geometry | 3 | - | 2023.9 | 637.8 | 637.8 | 771.5 | 0 | False |
| substation02 | warm | read_cached_entry | 51 | 1713559920 | 18411.0 | 53.5 | 4140.8 | 4304.6 | 0 | False |
| substation02 | warm | read_cached_ifc | 60 | 1713559920 | 22583.7 | 34.6 | 1082.5 | 6125.7 | 9 | False |
| substation02 | warm | read_glb_file | 14025 | 1201839024 | 1178826.8 | 68.0 | 228.4 | 704.3 | 1683 | False |
| substation02 | warm | upsert_gim_project | 3 | - | 783.4 | 261.7 | 261.7 | 301.7 | 0 | False |
| substation02 | warm | validate_gim_cache | 3 | - | 4843.6 | 1787.4 | 1787.4 | 1837.0 | 0 | False |
| substation04 | cold | delete_glb_cache | 3 | - | 247.9 | 83.2 | 83.2 | 85.0 | 0 | False |
| substation04 | cold | extract_gim_archive | 3 | 690092 | 69432.7 | 23767.9 | 23767.9 | 24060.9 | 0 | False |
| substation04 | cold | get_db_path | 3 | 207 | 265.5 | 87.1 | 87.1 | 105.0 | 0 | True |
| substation04 | cold | get_file_info | 3 | - | 1675.9 | 606.1 | 606.1 | 668.6 | 0 | False |
| substation04 | cold | get_process_memory | 24 | - | 2086.0 | 13.9 | 211.7 | 895.9 | 0 | False |
| substation04 | cold | get_project_diagnostic | 3 | - | 349.9 | 104.2 | 104.2 | 155.6 | 0 | False |
| substation04 | cold | read_cached_entry | 20583 | 785187621 | 1273610.9 | 9.0 | 171.3 | 8881.4 | 0 | False |
| substation04 | cold | save_geometry_refs | 3 | - | 527.3 | 234.3 | 234.3 | 241.1 | 0 | False |
| substation04 | cold | save_gim_index | 3 | - | 4304.1 | 887.9 | 887.9 | 2593.4 | 0 | False |
| substation04 | cold | upsert_gim_project | 3 | - | 270.2 | 86.0 | 86.0 | 103.2 | 0 | False |
| substation04 | cold | validate_gim_cache | 3 | - | 251.5 | 93.3 | 93.3 | 98.5 | 0 | False |
| substation04 | cold | write_geometry_cache_manifest | 3 | 261 | 2720.1 | 931.3 | 931.3 | 988.5 | 0 | False |
| substation04 | cold | write_geometry_cache_version | 3 | 243 | 236.4 | 78.4 | 78.4 | 82.8 | 0 | False |
| substation04 | cold | write_glb_file_binary | 621 | 85271121 | 58539.2 | 79.0 | 120.2 | 902.0 | 0 | True |
| substation04 | warm | batch_read_cached_files | 3 | 4827117 | 97.6 | 28.3 | 28.3 | 47.4 | 0 | True |
| substation04 | warm | get_db_path | 4 | 276 | 257.4 | 58.0 | 69.3 | 73.5 | 0 | True |
| substation04 | warm | get_file_info | 3 | - | 862.7 | 310.0 | 310.0 | 361.6 | 0 | False |
| substation04 | warm | get_gim_index | 3 | - | 692.0 | 243.1 | 243.1 | 273.5 | 0 | False |
| substation04 | warm | get_process_memory | 18 | - | 368.3 | 5.6 | 63.8 | 175.8 | 0 | False |
| substation04 | warm | get_project_diagnostic | 4 | - | 269.3 | 52.0 | 52.0 | 91.9 | 0 | False |
| substation04 | warm | read_cached_entry | 57 | 383836983 | 4436.2 | 17.9 | 978.9 | 1102.4 | 0 | False |
| substation04 | warm | read_cached_ifc | 60 | 383837256 | 5074.1 | 11.5 | 192.8 | 1184.3 | 0 | False |
| substation04 | warm | read_glb_file | 1596 | 250729308 | 49566.4 | 18.6 | 59.9 | 127.2 | 0 | False |
| substation04 | warm | upsert_gim_project | 3 | - | 124.4 | 59.2 | 59.2 | 60.7 | 0 | False |
| substation04 | warm | validate_gim_cache | 3 | - | 1399.4 | 545.6 | 545.6 | 591.9 | 0 | False |

## Fragments Cache 与下一轮决策

真实记录中 Fragments Cache 为 disabled（13 个完整 run，cache hit=0）；因此本轮没有 cache-on 对照组，不能据此判断默认开启收益，保持默认关闭。
- 若 IFC Spatial Semantic 的 STEP/property/relationship 占据主要时间，下一轮优先评估 Semantic Core 瘦身；若重复读取成本明显且 RSS 可接受，再评估 Compact Spatial Cache；若 web-ifc/Fragments load 占主导，才单独评估 Fragments Cache。
- 本轮明确不做 IFC Semantic Worker、Compact Spatial Cache、线路优化、line03 7z decoder 或 Compact Line Runtime Cache。
当前仅有 4 个 sample×mode 组达到 n=3（目标 6 组），所以结论标记为“阶段性”，不把未完成样本补成统计值；Fragments Cache 默认开关保持关闭。
已完成组的观测主导阶段为 `MOD/STL`（2498119.8 / 2498119.8 ms）；下一轮先处理该“其它问题”（MOD/STL 几何编译与 web-ifc/Fragments 加载链路），再用 cache-on A/B 判断 Fragments Cache，暂不优先 Semantic Core 瘦身或 Spatial Cache。缺失组补齐后复核该排序。

## 已知技术债务（线路主加载冻结）

- P1：杆塔 HNum/MOD lazy preview 偶发几十秒。
本报告按本轮边界仅保留上述线路问题；其它线路债务仍在 `docs/gim_powerline.md` §13 维护，但不纳入本轮变电加载结论。

## 复测命令

```powershell
cd D:\vibe-coding\gim_viewer\desktop
npm run tauri:dev
# 另一个 PowerShell，保持 Tauri WebView 的 playwright-cli session 可用
cd D:\vibe-coding\gim_viewer
.\tmp\collect-tauri-substation-perf.ps1
.\tmp\summarize-tauri-substation-perf.ps1
```

## 实现验证

- `npm run test:sample`：4 个测试文件、30/30 测试通过（真实样本线路回归及 Tauri bridge 用例）。
- `npm test -- --run`：54 个测试文件、620/620 测试通过。
- `npm run build`：TypeScript/Vite 生产构建通过；仅有既有大 chunk warning。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过。
- `cargo test --manifest-path src-tauri/Cargo.toml`：22 个 Rust 单元测试通过。
- `git diff --check`：通过（仅提示工作树换行符规范化 warning）。
