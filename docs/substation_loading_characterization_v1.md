# 变电加载性能特征化 v1

> 生成时间：2026-09-03T04:05:34.3542998Z；真实 Tauri 记录：6 次。冷启动定义为删除项目缓存后打开，热启动定义为保留缓存后二次打开；每组以 median/P95 汇总。P95 使用 nearest-rank（n=3 时等于该组最大观测值）。

## 结论状态

已采集 6 次 Tauri 运行。下表只使用诊断 JSON 中的真实运行值；Vitest/Node 测试不混入统计。下一轮决策应以表中占主导的阶段为准。

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
| substation01 | cold | 0 | 未完成（无真实记录） |
| substation01 | warm | 0 | 未完成（无真实记录） |
| substation02 | cold | 0 | 未完成（无真实记录） |
| substation02 | warm | 3 | 完成 n=3 |
| substation03 | cold | 0 | 未完成（无真实记录） |
| substation03 | warm | 0 | 未完成（无真实记录） |
| substation04 | cold | 0 | 未完成（无真实记录） |
| substation04 | warm | 3 | 完成 n=3 |

> 仅将 `fullModelReady` 成功且诊断 JSON 完整写入的运行计入统计；超时、工程错误或中途退出不补模拟数据。若某样本未达到 n=3，报告中的 median/P95 仅对实际记录展示，并明确标注覆盖不足。

## 产品时刻与峰值内存

| 样本 | 模式 | n | semanticReady median/P95 ms | firstGeometryReady median/P95 ms | fullModelReady median/P95 ms | 外部进程树 RSS median/P95 MB | 后端 RSS median/P95 MB | Long Task median/blocking/max ms | Fragments cache enabled/hit |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| substation02 | warm | 3 | 55049/66981 | 55546/67520 | 350388/372672 | 7457.9/8059.5 | 36.8/37.3 | 76/49078/33539 | False/0 |
| substation04 | warm | 3 | 8769/12476 | 10254/14103 | 28312/32791 | 2909.3/4892.9 | 37.0/39.3 | 12/5223/3430 | False/0 |

## 分阶段 duration

| 样本 | 模式 | 阶段 | n | median ms | P95 ms |
|---|---|---|---:|---:|---:|
| substation02 | warm | CBM/FAM/DEV/FileDevRelation | 3 | 1250.1 | 1740.7 |
| substation02 | warm | coordinate alignment | 3 | 1.2 | 1.3 |
| substation02 | warm | IFC read/decode | 3 | 6775.2 | 7632.7 |
| substation02 | warm | IFC Spatial Semantic | 3 | 48740.6 | 59650.1 |
| substation02 | warm | MOD/STL | 3 | 6955.1 | 7332.4 |
| substation02 | warm | navigation/UI | 3 | 197.4 | 232.9 |
| substation02 | warm | spatial finalize / CBM linkage | 3 | 178.6 | 187.8 |
| substation02 | warm | web-ifc / Fragments engine | 3 | 0.0 | 7.5 |
| substation02 | warm | web-ifc / Fragments load | 3 | 288118.4 | 299282.6 |
| substation04 | warm | CBM/FAM/DEV/FileDevRelation | 3 | 409.0 | 455.4 |
| substation04 | warm | coordinate alignment | 3 | 1.2 | 1.5 |
| substation04 | warm | IFC read/decode | 3 | 1752.0 | 1918.6 |
| substation04 | warm | IFC Spatial Semantic | 3 | 6618.9 | 8770.0 |
| substation04 | warm | MOD/STL | 3 | 1582.9 | 1588.5 |
| substation04 | warm | navigation/UI | 3 | 22.3 | 29.6 |
| substation04 | warm | spatial finalize / CBM linkage | 3 | 21.6 | 23.9 |
| substation04 | warm | web-ifc / Fragments engine | 3 | 0.0 | 0.0 |
| substation04 | warm | web-ifc / Fragments load | 3 | 17903.7 | 18629.0 |

## 每个 IFC 的 Spatial Semantic profile

| 样本 | 模式 | IFC entry | MiB | read/decode median/P95 ms | raw | detail | placement | spatial | objects/contained | total median/P95 ms | STEP median/P95 | placement/detail median/P95 | spatial entity median/P95 | property/quantity/material/classification median/P95 | relationships median/P95 | finalize median/P95 | parse errors |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| substation02 | warm | CBM/02 场地-围墙.ifc | 2.20 | r 41.0/41.0; d 2.5/2.5 | 39941 | 12458 | 10642 | 4 | 734/734 | 119.9/180.1 | 52.2/61.3 | 5.1/8.4 | 31.7/52.7 | 1759/0/12/0; 12.3/21.3 | 2058/3233; 38.3/67.3 | 0.3/0.4 | 0 |
| substation02 | warm | CBM/02-场坪、道路.ifc | 2.68 | r 41.4/47.7; d 2.8/3.4 | 57572 | 17890 | 17719 | 4 | 10/10 | 133.1/139.0 | 70.9/75.8 | 8.9/9.8 | 16.2/34.7 | 122/0/6/0; 3.4/7.9 | 68/66; 20.5/38.0 | 0.0/0.1 | 0 |
| substation02 | warm | CBM/02-电子围栏.ifc | 22.17 | r 254.5/262.4; d 24.1/24.3 | 461618 | 109497 | 106244 | 4 | 1260/1260 | 772.3/888.4 | 447.4/541.7 | 58.4/59.1 | 101.7/102.8 | 3212/0/2/0; 31.3/45.4 | 4355/6856; 141.0/143.2 | 0.2/0.3 | 0 |
| substation02 | warm | CBM/02-夹层支架.ifc | 5.79 | r 85.7/120.6; d 7.3/8.9 | 69955 | 24493 | 10145 | 4 | 3243/3243 | 556.6/626.5 | 118.8/132.8 | 7.6/10.8 | 134.6/154.5 | 14314/0/1/0; 106.3/116.3 | 16605/22203; 273.4/299.1 | 0.7/1.0 | 0 |
| substation02 | warm | CBM/02-警传室.ifc | 0.55 | r 18.8/25.3; d 0.4/1.0 | 9047 | 3281 | 2249 | 4 | 293/293 | 38.8/45.4 | 12.4/17.5 | 1.9/3.9 | 9.5/11.2 | 879/0/77/0; 5.4/6.8 | 869/1354; 12.2/13.9 | 0.0/0.1 | 0 |
| substation02 | warm | CBM/02-消防喷雾支架.ifc | 7.78 | r 101.9/106.9; d 7.7/8.2 | 151659 | 45929 | 40512 | 2 | 422/422 | 253.5/298.9 | 147.4/173.0 | 16.3/20.4 | 37.3/41.6 | 5387/0/4/0; 9.7/16.9 | 478/1187; 44.7/49.6 | 0.0/0.0 | 0 |
| substation02 | warm | CBM/0301-地下夹层及基础.ifc | 2.97 | r 42.2/46.8; d 3.3/3.6 | 53432 | 19563 | 16957 | 4 | 759/759 | 162.3/178.8 | 65.8/71.2 | 6.7/7.6 | 37.6/54.1 | 2517/0/24/0; 19.8/20.5 | 2699/4267; 47.3/66.0 | 0.2/0.2 | 0 |
| substation02 | warm | CBM/0302-钢结构.ifc | 372.63 | r 4076.3/4690.1; d 405.4/474.5 | 6160057 | 2505585 | 2132613 | 2 | 34232/34232 | 33049.1/41722.1 | 12177.4/14185.4 | 1401.3/1563.7 | 1767.1/2135.5 | 372166/0/5/0; 674.2/873.3 | 35028/96695; 17128.6/22817.5 | 11.2/11.4 | 0 |
| substation02 | warm | CBM/0303-檩条系统.ifc | 97.13 | r 1014.3/1134.4; d 84.0/106.1 | 1415372 | 1338458 | 1182816 | 2 | 8479/8479 | 4402.5/5398.2 | 1765.8/2170.4 | 487.3/614.2 | 450.3/579.4 | 155629/0/1/0; 235.7/326.0 | 8482/25149; 1464.8/1737.5 | 1.6/2.8 | 0 |
| substation02 | warm | CBM/04-建筑配电楼.ifc | 14.77 | r 173.5/232.5; d 17.4/19.2 | 229747 | 80224 | 67846 | 4 | 7602/7602 | 1183.1/1317.9 | 305.7/313.7 | 29.8/34.0 | 191.8/231.3 | 12217/0/70/0; 110.2/114.8 | 20619/36084; 636.9/765.9 | 1.8/2.2 | 0 |
| substation02 | warm | CBM/06-暖通部分.ifc | 1.49 | r 35.4/41.8; d 2.6/2.7 | 29960 | 10259 | 9289 | 4 | 309/309 | 132.0/196.5 | 53.7/78.3 | 8.5/14.1 | 26.7/27.9 | 904/0/4/0; 12.5/21.0 | 785/1203; 41.4/47.7 | 0.2/0.3 | 0 |
| substation02 | warm | CBM/场地-电缆隧道、电缆沟.ifc | 0.70 | r 20.1/21.2; d 0.3/0.4 | 9614 | 3607 | 2117 | 4 | 372/372 | 52.4/53.1 | 14.9/16.1 | 1.4/1.5 | 15.7/16.8 | 1441/0/6/0; 10.0/10.2 | 1740/2467; 19.7/20.5 | 0.1/0.1 | 0 |
| substation02 | warm | CBM/场地-化粪池.ifc | 0.09 | r 12.2/14.5; d 0.1/0.1 | 1793 | 701 | 575 | 4 | 7/7 | 4.5/5.0 | 2.2/2.3 | 0.3/0.4 | 0.7/1.0 | 90/0/1/0; 0.2/0.4 | 37/35; 1.0/1.3 | 0.0/0.0 | 0 |
| substation02 | warm | CBM/场地-事故油池.ifc | 0.19 | r 11.7/14.4; d 0.1/0.1 | 3921 | 1228 | 943 | 4 | 29/29 | 31.8/37.2 | 13.1/16.3 | 2.1/2.3 | 5.1/5.7 | 236/0/6/0; 3.3/3.6 | 94/120; 6.5/7.7 | 0.1/0.1 | 0 |
| substation02 | warm | CBM/场地-消防泵房.ifc | 0.61 | r 18.3/26.1; d 0.3/0.4 | 9970 | 3463 | 2246 | 4 | 257/257 | 117.9/130.0 | 35.2/50.4 | 3.1/3.9 | 32.6/35.4 | 1092/0/50/0; 19.8/20.5 | 936/1399; 41.2/41.5 | 0.2/0.3 | 0 |
| substation02 | warm | CBM/场地-主变、散热基础.ifc | 0.38 | r 13.8/14.5; d 0.2/0.2 | 4796 | 1949 | 864 | 4 | 200/200 | 26.9/32.2 | 6.4/6.8 | 0.7/0.8 | 9.0/13.4 | 1042/0/4/0; 5.7/6.4 | 1130/1512; 10.6/15.0 | 0.0/0.1 | 0 |
| substation02 | warm | CBM/消防给排水.ifc | 12.61 | r 174.8/190.0; d 13.5/14.7 | 246766 | 65936 | 60693 | 4 | 3968/3968 | 615.6/695.1 | 259.3/285.8 | 30.0/32.2 | 89.0/101.4 | 5149/0/11/0; 37.2/42.4 | 7104/12565; 227.3/257.9 | 0.5/0.5 | 0 |
| substation04 | warm | DEV/1-版本1.ifc | 13.71 | r 187.8/230.8; d 16.1/17.1 | 251688 | 79546 | 75495 | 5 | 3361/3361 | 662.2/943.3 | 306.7/445.5 | 55.1/55.6 | 91.3/152.2 | 3533/0/265/13; 19.5/24.7 | 3841/13585; 209.2/294.9 | 0.8/1.4 | 0 |
| substation04 | warm | DEV/110区域构架-版本1.ifc | 0.95 | r 20.4/27.0; d 1.0/1.1 | 19707 | 7108 | 6985 | 5 | 51/51 | 48.3/51.0 | 21.2/21.2 | 5.5/6.1 | 5.3/8.0 | 63/0/4/1; 4.4/4.8 | 78/204; 8.3/9.1 | 0.1/0.1 | 0 |
| substation04 | warm | DEV/110kv配电装置-其他.ifc | 0.02 | r 9.9/12.8; d 0.1/0.1 | 378 | 186 | 113 | 4 | 2/2 | 2.0/3.5 | 0.8/1.4 | 0.0/0.2 | 0.4/0.6 | 52/0/0/0; 0.3/0.4 | 18/2; 0.6/0.8 | 0.0/0.0 | 0 |
| substation04 | warm | DEV/35kV配电室通风及空调-版本1.ifc | 0.36 | r 12.5/15.2; d 0.1/0.3 | 7494 | 2130 | 1993 | 4 | 158/158 | 20.0/21.3 | 7.0/7.1 | 1.7/1.9 | 4.9/5.8 | 92/0/0/1; 0.6/0.8 | 233/617; 7.3/8.3 | 0.1/0.1 | 0 |
| substation04 | warm | DEV/独立避雷针-版本1.ifc | 0.36 | r 16.0/17.3; d 0.2/0.4 | 8527 | 1686 | 1642 | 4 | 6/6 | 19.6/31.6 | 9.9/14.6 | 3.0/3.4 | 3.0/3.9 | 14/0/4/1; 0.8/1.3 | 16/22; 4.2/5.9 | 0.0/0.0 | 0 |
| substation04 | warm | DEV/二次屏柜-其他.ifc | 0.01 | r 9.5/10.4; d 0.0/0.0 | 113 | 65 | 21 | 3 | 0/0 | 0.8/1.7 | 0.3/0.6 | 0.0/0.1 | 0.3/0.3 | 23/0/0/0; 0.1/0.2 | 7/0; 0.3/0.6 | 0.0/0.0 | 0 |
| substation04 | warm | DEV/辅助用房-版本1.ifc | 0.45 | r 18.4/20.2; d 0.2/0.4 | 8677 | 3375 | 2987 | 6 | 128/128 | 34.5/66.8 | 12.7/32.9 | 3.4/4.6 | 5.4/11.4 | 225/0/42/1; 2.6/6.8 | 345/595; 7.4/15.6 | 0.2/0.2 | 0 |
| substation04 | warm | DEV/辅助用房结构-版本1.ifc | 0.04 | r 12.0/39.7; d 0.1/0.1 | 630 | 319 | 242 | 5 | 26/26 | 2.1/2.5 | 0.7/0.8 | 0.1/0.1 | 0.7/0.7 | 29/0/24/1; 0.2/0.2 | 68/112; 0.8/0.9 | 0.0/0.0 | 0 |
| substation04 | warm | DEV/构架基础-版本1.ifc | 0.06 | r 8.5/8.7; d 0.1/0.1 | 979 | 462 | 385 | 4 | 44/44 | 4.9/5.1 | 1.5/2.5 | 0.3/0.3 | 1.0/1.8 | 53/0/2/1; 0.4/0.4 | 51/132; 1.3/2.2 | 0.0/0.0 | 0 |
| substation04 | warm | DEV/配电楼-版本1.ifc | 0.97 | r 20.4/24.4; d 0.9/1.2 | 18088 | 6829 | 5944 | 11 | 322/322 | 50.2/63.5 | 19.5/25.4 | 4.0/4.8 | 11.2/12.0 | 559/0/39/1; 2.9/4.1 | 851/1464; 15.3/18.2 | 0.1/0.2 | 0 |
| substation04 | warm | DEV/配电楼结构-版本1.ifc | 0.44 | r 19.7/21.2; d 0.2/0.3 | 7996 | 3470 | 2815 | 4 | 214/214 | 26.5/30.2 | 8.9/10.3 | 2.4/4.2 | 5.8/8.9 | 516/0/11/1; 1.8/3.4 | 278/810; 7.5/10.3 | 0.0/0.0 | 0 |
| substation04 | warm | DEV/设备基础-版本1.ifc | 0.37 | r 20.1/30.7; d 0.1/0.2 | 7532 | 2643 | 2393 | 4 | 183/183 | 30.8/57.5 | 9.1/16.7 | 3.1/4.1 | 6.1/13.5 | 196/0/26/1; 6.7/8.3 | 214/555; 7.7/19.2 | 0.1/0.1 | 0 |
| substation04 | warm | DEV/设备支架-版本1.ifc | 92.53 | r 1044.9/1069.0; d 104.5/104.8 | 1780745 | 426363 | 425553 | 4 | 519/519 | 3300.7/4477.6 | 2349.3/3546.2 | 305.0/317.0 | 240.4/265.6 | 550/0/143/1; 43.9/47.2 | 676/2076; 301.0/327.9 | 0.1/0.1 | 0 |
| substation04 | warm | DEV/室内电缆沟施工图-版本1.ifc | 1.38 | r 26.6/36.7; d 1.3/1.6 | 23054 | 10356 | 9036 | 4 | 1142/1142 | 87.8/91.1 | 27.9/29.9 | 5.9/6.5 | 20.3/21.2 | 1001/0/218/1; 5.9/6.0 | 1499/3779; 35.8/36.3 | 0.3/0.4 | 0 |
| substation04 | warm | DEV/站区水工布置图-版本1.ifc | 4.22 | r 72.1/89.5; d 5.7/6.6 | 91297 | 19306 | 18917 | 4 | 234/234 | 198.0/406.7 | 112.5/290.7 | 22.9/23.0 | 23.1/29.9 | 191/0/103/1; 6.0/10.2 | 415/930; 32.1/41.2 | 0.1/0.1 | 0 |
| substation04 | warm | DEV/主变基础及防火墙-版本1.ifc | 2.67 | r 54.8/61.8; d 3.7/5.8 | 54529 | 16806 | 15557 | 7 | 915/915 | 214.4/346.4 | 79.0/117.0 | 15.3/24.9 | 38.4/71.4 | 989/0/80/1; 29.8/34.4 | 1113/3685; 63.2/105.1 | 0.4/0.7 | 0 |
| substation04 | warm | DEV/主变区域构架-版本1.ifc | 0.89 | r 37.3/37.9; d 0.6/0.8 | 18932 | 6657 | 6594 | 5 | 18/18 | 37.4/42.0 | 18.7/19.7 | 5.1/6.3 | 3.8/4.0 | 27/0/2/1; 1.4/1.6 | 33/72; 5.5/6.0 | 0.0/0.0 | 0 |
| substation04 | warm | DEV/主变区域配电装置-其他.ifc | 0.02 | r 12.2/21.0; d 0.0/0.1 | 248 | 130 | 57 | 4 | 4/4 | 1.3/1.5 | 0.4/0.5 | 0.1/0.1 | 0.3/0.5 | 52/0/0/0; 0.2/0.2 | 18/4; 0.5/0.5 | 0.0/0.0 | 0 |
| substation04 | warm | DEV/总图-版本1.ifc | 2.58 | r 41.2/46.4; d 3.1/4.1 | 53464 | 14888 | 14112 | 4 | 393/393 | 128.2/176.9 | 59.1/105.4 | 13.7/20.4 | 15.6/18.5 | 452/0/170/1; 5.2/8.9 | 605/1285; 20.6/24.2 | 0.1/0.2 | 0 |

> IFC duration 单元统一为 `median/P95`（ms）；`read/decode` 单元中 `r` 为磁盘读取、`d` 为 TextDecoder。`property/quantity/material/classification` 列依次为实体数量，随后为该阶段 median/P95；`relationships` 列为 record/reference 数量，随后为该阶段 median/P95。每次 run 的完整 `propertyValueCount`、`quantityValueCount` 等仍保存在同目录 `summary.json` 与 `raw/*.json`。

## 分阶段内存（RSS 与 JS heap 分列）

| 样本 | 模式 | 阶段 | 指标 | n | median MB | P95 MB | max MB |
|---|---|---|---|---:|---:|---:|---:|
| substation02 | warm | 第一个 Fragments model 后 | backend RSS | 3 | 36.5 | 36.5 | 36.5 |
| substation02 | warm | 第一个 Fragments model 后 | JS heap used | 3 | 3371.7 | 3488.1 | 3488.1 |
| substation02 | warm | CBM/FAM/DEV/FileDevRelation 后（缓存命中） | backend RSS | 3 | 36.4 | 36.5 | 36.5 |
| substation02 | warm | CBM/FAM/DEV/FileDevRelation 后（缓存命中） | JS heap used | 3 | 1201.4 | 1344.4 | 1344.4 |
| substation02 | warm | full ready 后 | backend RSS | 3 | 36.3 | 36.5 | 36.5 |
| substation02 | warm | full ready 后 | JS heap used | 3 | 1424.4 | 1440.6 | 1440.6 |
| substation02 | warm | IFC text 读入后 | backend RSS | 3 | 36.4 | 36.5 | 36.5 |
| substation02 | warm | IFC text 读入后 | JS heap used | 3 | 1201.4 | 1344.4 | 1344.4 |
| substation02 | warm | SpatialIndex finalize 后（缓存命中） | backend RSS | 3 | 36.8 | 37.3 | 37.3 |
| substation02 | warm | SpatialIndex finalize 后（缓存命中） | JS heap used | 3 | 3337.9 | 3496.3 | 3496.3 |
| substation02 | warm | STEP scan 后 | backend RSS | 3 | 36.4 | 36.5 | 36.5 |
| substation02 | warm | STEP scan 后 | JS heap used | 3 | 1201.4 | 1344.4 | 1344.4 |
| substation04 | warm | 第一个 Fragments model 后 | backend RSS | 3 | 36.8 | 37.2 | 37.2 |
| substation04 | warm | 第一个 Fragments model 后 | JS heap used | 3 | 696.3 | 864.6 | 864.6 |
| substation04 | warm | CBM/FAM/DEV/FileDevRelation 后（缓存命中） | backend RSS | 3 | 37.0 | 37.1 | 37.1 |
| substation04 | warm | CBM/FAM/DEV/FileDevRelation 后（缓存命中） | JS heap used | 3 | 1033.4 | 1437.6 | 1437.6 |
| substation04 | warm | full ready 后 | backend RSS | 3 | 36.8 | 37.0 | 37.0 |
| substation04 | warm | full ready 后 | JS heap used | 3 | 365.3 | 1039.4 | 1039.4 |
| substation04 | warm | IFC text 读入后 | backend RSS | 3 | 37.0 | 37.1 | 37.1 |
| substation04 | warm | IFC text 读入后 | JS heap used | 3 | 1038.9 | 1445.7 | 1445.7 |
| substation04 | warm | SpatialIndex finalize 后（缓存命中） | backend RSS | 3 | 36.7 | 39.3 | 39.3 |
| substation04 | warm | SpatialIndex finalize 后（缓存命中） | JS heap used | 3 | 692.2 | 1350.3 | 1350.3 |
| substation04 | warm | STEP scan 后 | backend RSS | 3 | 37.0 | 37.1 | 37.1 |
| substation04 | warm | STEP scan 后 | JS heap used | 3 | 1055.9 | 1466.2 | 1466.2 |

> RSS 为 Tauri 后端进程工作集采样；JS heap 为 WebView 可用时的 `performance.memory` 读数。两者不是同一指标，不能互相替代。

## 峰值内存所在阶段

| 样本 | 模式 | 指标 | 峰值检查点 | 峰值 MB | 归因边界 |
|---|---|---|---|---:|---|
| substation02 | warm | backend RSS | SpatialIndex finalize 后（缓存命中） | 37.3 | 按 Tauri 后端 RSS 检查点；外部进程树 RSS 仅有 run-level 峰值 |
| substation02 | warm | JS heap used | SpatialIndex finalize 后（缓存命中） | 3496.3 | 按 WebView heap 检查点 |
| substation04 | warm | backend RSS | SpatialIndex finalize 后（缓存命中） | 39.3 | 按 Tauri 后端 RSS 检查点；外部进程树 RSS 仅有 run-level 峰值 |
| substation04 | warm | JS heap used | STEP scan 后 | 1466.2 | 按 WebView heap 检查点 |

## 每次运行的主导阶段

| 样本 | 模式 | 主导阶段（median 最大） | median ms | P95 ms |
|---|---|---|---:|---:|
| substation02 | warm | web-ifc / Fragments load | 288118.4 | 299282.6 |
| substation04 | warm | web-ifc / Fragments load | 17903.7 | 18629.0 |

## Tauri IPC

| 样本 | 模式 | command | 调用次数 | bytes | total ms | p50 median ms | p95 median ms | max ms | failures | bytes measured |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|:---:|
| substation02 | warm | batch_read_glb_files | 9 | 186572370 | 7198.1 | 956.7 | 1055.0 | 1254.5 | 0 | True |
| substation02 | warm | get_db_path | 3 | 207 | 30.6 | 5.7 | 5.7 | 20.1 | 0 | True |
| substation02 | warm | get_file_info | 3 | - | 3032.5 | 1204.4 | 1204.4 | 1286.1 | 0 | False |
| substation02 | warm | get_gim_index | 3 | - | 3647.9 | 1219.7 | 1219.7 | 1712.5 | 0 | False |
| substation02 | warm | get_process_memory | 18 | - | 752.2 | 6.5 | 42.8 | 587.8 | 0 | False |
| substation02 | warm | get_project_diagnostic | 3 | - | 214.8 | 75.4 | 75.4 | 79.8 | 0 | False |
| substation02 | warm | read_cached_entry | 51 | - | 17460.1 | 38.7 | 3998.8 | 4602.0 | 0 | False |
| substation02 | warm | read_cached_ifc | 60 | - | 21355.6 | 27.1 | 1386.9 | 4727.2 | 9 | False |
| substation02 | warm | read_geometry_cache_manifest | 3 | - | 110.3 | 37.6 | 37.6 | 39.2 | 0 | False |
| substation02 | warm | upsert_gim_project | 3 | - | 267.5 | 6.3 | 6.3 | 256.3 | 0 | False |
| substation02 | warm | validate_gim_cache | 3 | - | 4711.5 | 1981.0 | 1981.0 | 2017.6 | 0 | False |
| substation04 | warm | batch_read_cached_files | 3 | 4827117 | 93.2 | 30.4 | 30.4 | 36.1 | 0 | True |
| substation04 | warm | batch_read_glb_files | 3 | 85209294 | 2109.5 | 722.9 | 722.9 | 724.6 | 0 | True |
| substation04 | warm | get_db_path | 3 | 207 | 154.0 | 57.5 | 57.5 | 61.2 | 0 | True |
| substation04 | warm | get_file_info | 3 | - | 1209.4 | 415.8 | 415.8 | 427.7 | 0 | False |
| substation04 | warm | get_gim_index | 3 | - | 1211.7 | 403.8 | 403.8 | 446.5 | 0 | False |
| substation04 | warm | get_process_memory | 18 | - | 154.5 | 5.8 | 19.1 | 22.1 | 0 | False |
| substation04 | warm | get_project_diagnostic | 3 | - | 173.5 | 50.5 | 50.5 | 74.6 | 0 | False |
| substation04 | warm | read_cached_entry | 57 | - | 4710.4 | 19.1 | 1022.0 | 1039.0 | 0 | False |
| substation04 | warm | read_cached_ifc | 60 | - | 4359.3 | 13.1 | 166.1 | 959.2 | 0 | False |
| substation04 | warm | read_geometry_cache_manifest | 3 | - | 27.9 | 9.8 | 9.8 | 10.5 | 0 | False |
| substation04 | warm | upsert_gim_project | 3 | - | 128.4 | 60.7 | 60.7 | 61.8 | 0 | False |
| substation04 | warm | validate_gim_cache | 3 | - | 2405.4 | 717.7 | 717.7 | 981.3 | 0 | False |

## DEV GLB warm fast path（geometry-cache-v5）

| 样本 | 模式 | n | CBM instances median/P95 | unique DEV median/P95 | glb DEV median/P95 | empty DEV median/P95 | batch read median/P95 ms | GLB bytes median/P95 | parse count median/P95 | parse ms median/P95 | read_glb calls | batch calls | raw MOD fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| substation02 | warm | 3 | 4675/4675 | 1174/1174 | 627/627 | 547/547 | 2363.9/2637.9 | 59.25/59.25 MiB | 4114/4114 | 967.3/1029.8 | 0 | 9 | 0/0 |
| substation04 | warm | 3 | 532/532 | 207/207 | 207/207 | 0/0 | 733.3/739.7 | 27.07/27.07 MiB | 532/532 | 175.0/191.5 | 0 | 3 | 0/0 |
> `read_glb calls` 应保持为 0；正常 v5 warm 命中使用 `batch_read_glb_files`，每个 unique DEV 的 GLB bytes 只读取一次，合法 `empty` 不读取。`raw MOD fallback` 为 profile 中的整体回退次数。

## Fragments Cache 与下一轮决策

真实记录中 Fragments Cache 为 disabled（6 个完整 run，cache hit=0）；因此本轮没有 cache-on 对照组，不能据此判断默认开启收益，保持默认关闭。
- 若 IFC Spatial Semantic 的 STEP/property/relationship 占据主要时间，下一轮优先评估 Semantic Core 瘦身；若重复读取成本明显且 RSS 可接受，再评估 Compact Spatial Cache；若 web-ifc/Fragments load 占主导，才单独评估 Fragments Cache。
- 本轮明确不做 IFC Semantic Worker、Compact Spatial Cache、线路优化、line03 7z decoder 或 Compact Line Runtime Cache。
当前仅有 2 个 sample×mode 组达到 n=3（目标 6 组），所以结论标记为“阶段性”，不把未完成样本补成统计值；Fragments Cache 默认开关保持关闭。
已完成组的观测主导阶段为 `web-ifc / Fragments load`（288118.4 / 299282.6 ms）；下一轮先处理该“其它问题”（MOD/STL 几何编译与 web-ifc/Fragments 加载链路），再用 cache-on A/B 判断 Fragments Cache，暂不优先 Semantic Core 瘦身或 Spatial Cache。缺失组补齐后复核该排序。

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
