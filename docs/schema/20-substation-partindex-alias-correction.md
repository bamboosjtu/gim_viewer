# 20. demo-substation PARTINDEX 几何别名更正

## 结论

`demo-substation` 的 CBM `PARTINDEX` 不是第二个物理几何实例。它是父 F4 设备
DEV `SUBDEVICEi` 的 CBM 语义节点，二者按索引一一对应；几何位置必须使用父设备
累计矩阵乘以 `SUBDEVICEi.TRANSFORMMATRIXi`。

因此全量渲染只能从根 DEV 递归一次。PARTINDEX 用于层级树、属性与点击，不可作为
第二个全量几何 seed。

## 样本证据

| 项目 | 数量 |
| --- | ---: |
| F4 根 DEV | 285 |
| F4 DEV SUBDEVICE 引用 | 3894 |
| 对应 CBM PARTINDEX | 3894 |
| 索引顺序或 DEV 路径不匹配 | 0 |
| SUBDEVICE 变换矩阵缺失 | 0 |
| 物理 MOD 引用 | 4135 |
| 物理 STL 引用 | 1803 |
| 物理几何引用合计 | 5938 |

`07-dev-phm-geometry-reachability.md` 已记录 PARTINDEX 与 child DEV 的同路径关系，
同时也记录 demo-substation 的 `maxGeometryReuse = 1`。此前 09/16/17 将根 DEV 的
递归结果与 PARTINDEX 入口同时累加，得到 9866；这只是重复遍历路径数。

## 对渲染的影响

错误路径会遗漏 SUBDEVICE 局部矩阵。例如 F4 `00e83cfc-...` 的子设备 0：

```text
PARTINDEX 错误位置: (22155.22, 7260.26, 5720.00) mm
DEV 链正确位置:    (22505.17, 3920.26, 5720.00) mm
偏差:               (349.95, -3340.00, 0.00) mm
```

在当前样本中，该错误额外产生 3418 个错位 MOD placement，因此界面中的
`4135 + 3418 = 7553` 个 MOD 正好是该 bug 的可观测结果。

## 实现规则

1. 自动加载和 SQLite 可达几何查询跳过 `PARTINDEX` 与 `DEV_SUBDEVICE` seed。
2. 从 F4 根 DEV 沿 SUBDEVICE 递归，保留其完整矩阵链。
3. 点击 PARTINDEX 时改用最近的带 DEV 的祖先加载，避免生成缺局部矩阵的副本。
4. 缓存解析版本升级，防止旧索引继续走旧入口策略。
