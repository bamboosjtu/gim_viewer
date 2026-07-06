# 变电工程变换链实现问题与改进建议

> 本文档不重复分析内容（已全部归入 [09-transform-chain-analysis.md](./09-transform-chain-analysis.md)），仅记录由 09 号文档初版错误结论引发的程序实现问题、修复方案与改进方向。
>
> 关联分析详见：
> - [09-transform-chain-analysis.md](./09-transform-chain-analysis.md) §6.6 / §13.4 / §14 / §15：变换链分析与结论修正
> - [09-transform-chain-analysis.md](./09-transform-chain-analysis.md) §11.4 / §12：实例多样性证据与单位处理分析

## 1. 背景与根因

### 1.1 09 号文档初版的错误结论

09 号文档初版仅覆盖 PHM × MOD Entity 两层变换，得出：

```text
"PHM placement + MOD local transform"的两级变换假设在三个样本中均不成立。
实际为单级变换（变电）或无变换（线路）。
```

此结论在 PHM 层面成立（PHM 矩阵 100% 单位），但被错误推广为"整个外部装配链路无变换"，导致后续渲染管线开发出现两个错位：

1. **装配矩阵缺失**：渲染时跳过 CBM/DEV/SUBDEVICE 矩阵累乘，仅应用 MOD Entity 局部变换
2. **实例位置丢失**：用 modPath 去重，丢失同 MOD 文件的多实例 placement

### 1.2 错误结论的实证反驳

09 号文档修订版（§8-§11）补充的实证数据：

| 维度 | 初版假设 | 实证结果 |
| ---- | -------- | -------- |
| CBM TRANSFORMMATRIX | 未分析 | 53.4% 节点含矩阵，6.1% 非单位 |
| DEV SOLIDMODELS 矩阵 | 未分析 | 95.5% 单位（贡献低） |
| DEV SUBDEVICES 矩阵 | 未分析 | **87.8% 非单位（主变换源）** |
| 完整链路实例 placement | 未分析 | **100% 非 IDENTITY** |
| 同 MOD 多实例 | 未分析 | **66.2% MOD 文件被多实例引用** |

完整链路重建后总实例 9866 个，但唯一 MOD 文件仅 5938 个，差值 3928 个实例（40%）被错误去重逻辑丢弃。

---

## 2. 程序问题清单

### 2.1 问题 1：modPath 去重丢失实例（高优先级）

#### 问题位置

[modAutoLoadService.ts:633](../../src/services/modAutoLoadService.ts#L633)：

```typescript
// 全局去重集合：key = modPath/stlPath
const modMap = new Map<string, DiscoveredModGeometry>();
// ...
for (const modGeo of result.mods) {
  if (!modMap.has(modGeo.modPath)) {       // ← BUG: 用 modPath 去重
    modMap.set(modGeo.modPath, modGeo);    // ← 同 MOD 文件多实例只保留第一个
  }
}
```

STL 同理（[modAutoLoadService.ts:638 附近](../../src/services/modAutoLoadService.ts#L638)）：`stlMap.has(geo.stlPath)`。

#### 后果量化

| 指标 | 期望（链路重建总数） | 实际（modPath 去重后） | 丢失 |
| ---- | ------------------: | --------------------: | ---: |
| MOD/STL 实例数 | 9866 | 5938 | 3928（39.8%） |
| 多实例文件数 | 3928 | 0（被压缩为单实例） | 3928 |

#### 与加载阶段的逻辑矛盾

加载阶段 [modAutoLoadService.ts:526, 532, 550, 556, 691, 698](../../src/services/modAutoLoadService.ts#L526) 使用 `instanceKey` 作为去重 key：

```typescript
if (state.loadedXmlModGroups.has(geo.instanceKey)) { loadedMods++; continue; }
// ...
state.loadedXmlModGroups.set(geo.instanceKey, group);
```

`DiscoveredModGeometry` 数据结构同时包含 `modPath` 与 `instanceKey`（[modAutoLoadService.ts:486](../../src/services/modAutoLoadService.ts#L486)），`instanceKey` 是含 placement 的实例标识。但发现阶段的 `modMap` 用 `modPath`，造成"发现去重 key 与加载去重 key 不一致"——加载阶段已准备好处理多实例，发现阶段却把多实例丢弃了。

#### 修复方案

```diff
- if (!modMap.has(modGeo.modPath)) {
-   modMap.set(modGeo.modPath, modGeo);
- }
+ // 同 MOD 文件可被多 CBM 节点以不同 placement 引用，
+ // 用 instanceKey 去重保证实例级不丢失。
+ if (!modMap.has(modGeo.instanceKey)) {
+   modMap.set(modGeo.instanceKey, modGeo);
+ }
```

STL 同理（`stlMap.has(geo.stlPath)` → `stlMap.has(geo.instanceKey)`）。

#### 预期效果

实例数从 5938 恢复到 9866，多实例文件位置正确填充，"MOD 完全覆盖 IFC"现象消失。

---

### 2.2 问题 2：applyExternalTransforms 单位隐患（中优先级）

#### 问题位置

[xmlModLoader.ts:102-111](../../src/viewer/xmlModLoader.ts#L102-L111)：

```typescript
export function applyExternalTransforms(
  group: THREE.Group,
  devTransformMatrix: number[],
  phmTransformMatrix: number[],
): void {
  // 先应用 PHM 矩阵（MOD local → PHM/assembly space）
  group.applyMatrix4(rowMajorToMatrix4(phmTransformMatrix));
  // 再应用 DEV 矩阵（PHM/assembly → device space）
  group.applyMatrix4(rowMajorToMatrix4(devTransformMatrix));
}
```

#### 问题分析

- **直接 applyMatrix4 不缩放平移**：MOD Group 内部已缩放 0.001（mm → m），但外部矩阵的平移分量仍是 mm，直接应用会导致平移放大 1000 倍
- **参数不完整**：仅含 `devTransformMatrix` 与 `phmTransformMatrix`，缺少 CBM 与 SUBDEVICE 累积，无法表达完整 placement
- **与正确路径并存**：同文件中的 `applyPlacementTransformToSceneUnits`（[xmlModLoader.ts:120-130](../../src/viewer/xmlModLoader.ts#L120-L130)）已正确缩放平移

#### 飘移场景示例

DEV 矩阵含平移 45758 mm：

- 路径 A（`applyPlacementTransformToSceneUnits`）：平移变成 45.758 米（正确）
- 路径 B（`applyExternalTransforms`）：平移保持 45758 单位（错误，相当于 45.758 公里，触发 BBOX_MAX_DIM_M=50 阈值被丢弃，或落在场景外造成"巨大飘移"）

#### 当前调用情况

grep 显示 `applyExternalTransforms` 仅在以下位置被引用：

- [src/viewer/__tests__/xmlModLoader.test.ts](../../src/viewer/__tests__/xmlModLoader.test.ts)（单元测试）
- [src/viewer/stlLoader.ts:18](../../src/viewer/stlLoader.ts#L18)（注释）
- [docs/schema/10-substation-mod-grammar.md](./10-substation-mod-grammar.md)、[docs/schema/phm.md](./phm.md)、[docs/gim_substation.md](../gim_substation.md)、[docs/plans/substation-geometry-impl.md](../plans/substation-geometry-impl.md)（旧文档）

**生产代码无调用**。当前 `modAutoLoadService.ts` 与 `nodeInteractionService.ts` 均使用 `applyPlacementTransformToSceneUnits`，飘移问题在最新代码中已规避，但隐患仍存。

#### 修复方案

```diff
+ /**
+  * @deprecated 使用 applyPlacementTransformToSceneUnits 替代。
+  * 此函数不缩放平移分量（MOD Group 已缩放 0.001），且参数仅含 DEV/PHM
+  * 缺少 CBM/SUBDEVICE 累积，无法表达完整 placement。
+  * 保留仅供向后兼容，后续版本将删除。
+  */
  export function applyExternalTransforms(
    group: THREE.Group,
    devTransformMatrix: number[],
    phmTransformMatrix: number[],
  ): void {
    // 先应用 PHM 矩阵（MOD local → PHM/assembly space）
    group.applyMatrix4(rowMajorToMatrix4(phmTransformMatrix));
    // 再应用 DEV 矩阵（PHM/assembly → device space）
    group.applyMatrix4(rowMajorToMatrix4(devTransformMatrix));
  }
```

中长期：迁移测试到 `applyPlacementTransformToSceneUnits`，删除 `applyExternalTransforms`。

---

### 2.3 问题 3：09 号文档初版结论导致的渲染管线错位（中优先级）

#### 问题表现

09 号初版"实际为单级变换 = MOD Entity.TransformMatrix"的结论被渲染管线采纳，导致：

1. `modGeometryDiscovery.ts` 累积了完整 placement 矩阵，但部分调用路径未应用
2. 渲染时仅应用 MOD Entity 本地变换，未应用装配矩阵，导致 MOD 几何偏离工程原点
3. 同 MOD 文件多实例被当作"文件唯一"处理（详见 §2.1）

#### 修复方案

09 号文档修订版 §15 已给出修正方向：

```text
渲染管线必须应用完整装配矩阵：
  placementTransform = CBM × DEV_SOLID × SUBDEVICE × PHM
  finalTransform = placementTransform × MOD_Entity_TransformMatrix
不可跳过装配矩阵乘法（与初版建议相反）。
```

具体实现需在 `modAutoLoadService.ts` 与 `nodeInteractionService.ts` 中：

1. 确保 `geo.placementTransformMatrix`（含 CBM×DEV×SUBDEVICE×PHM 累积）传入 `applyPlacementTransformToSceneUnits`
2. MOD Group 加载时已烘焙 Entity.TransformMatrix（局部变换），无需再次应用
3. 应用顺序：Entity local（已烘焙）→ placement（装配）→ projectSourceToViewer（项目坐标对齐）

当前代码已按此顺序实现（`prepareModGroupForScene` 函数），但需验证 `placementTransformMatrix` 是否完整包含 CBM 与 SUBDEVICE 累积，而非仅含 DEV/PHM。

---

## 3. 改进方向

### 3.1 短期修复（高优先级）

| 编号 | 问题 | 修复位置 | 验证方法 |
| ---- | ---- | -------- | -------- |
| FIX-1 | modPath 去重 bug | [modAutoLoadService.ts:633](../../src/services/modAutoLoadService.ts#L633) + STL 同理 | 加载后实例数应为 9866（非 5938）；多实例 MOD 文件位置正确填充；"MOD 完全覆盖 IFC"现象消失 |
| FIX-2 | applyExternalTransforms 隐患 | [xmlModLoader.ts:102](../../src/viewer/xmlModLoader.ts#L102) | 标记 @deprecated；测试迁移到 applyPlacementTransformToSceneUnits；最终删除 |

### 3.2 中期改进

| 编号 | 改进项 | 目标 |
| ---- | ------ | ---- |
| IMP-1 | 验证 placement 矩阵完整性 | 检查 `geo.placementTransformMatrix` 是否包含 CBM 与 SUBDEVICE 累积，而非仅含 DEV/PHM |
| IMP-2 | 修正 dev.md / phm.md 矩阵描述 | "行优先、平移在最后一列" → "列主序、平移在 m[12..14]" |
| IMP-3 | 修正 devParser.ts / phmParser.ts 注释 | 统一为"列主序、平移在 m[12..14]"；澄清 `rowMajorToMatrix4` 函数命名歧义 |

### 3.3 长期演进

| 编号 | 演进方向 | 说明 |
| ---- | -------- | ---- |
| EVO-1 | instanceKey 构造规则文档化 | 明确 `instanceKey` 与 `(modPath, placementTransform)` 的对应关系，指导去重逻辑与缓存键设计 |
| EVO-2 | 跨样本验证 | 使用 gim-sample-verification skill 验证新样本：CBM 矩阵命中率、DEV SUBDEVICES 非单位占比、多实例 MOD 文件比例 |
| EVO-3 | SUBDEVICE 嵌套深度分析 | 按 SUBDEVICE 嵌套层数分组统计每层对最终 placement 的贡献比例 |

---

## 4. 验证清单

修复后应通过以下验证：

### 4.1 实例数验证

- [ ] 加载 demo-substation 后，MOD/STL 实例数为 9866（非 5938）
- [ ] 多实例文件（如 `72c8865f-*.mod`）在场景中出现 2 次，位于不同位置
- [ ] "MOD 完全覆盖 IFC"现象消失

### 4.2 单位处理验证

- [ ] 应用 placement 后，MOD Group bbox 中心位于工程原点附近（数十米范围内）
- [ ] 不出现 45 公里量级的飘移
- [ ] `applyExternalTransforms` 标记 @deprecated，无生产代码调用

### 4.3 矩阵链路验证

- [ ] `geo.placementTransformMatrix` 包含 CBM×DEV×SUBDEVICE×PHM 累积
- [ ] 应用顺序为 Entity local → placement → projectSourceToViewer
- [ ] 非 IDENTITY 实例平移分量范围与 09 号 §10.3 一致（Tx/Ty ≈ 100m、Tz ≈ 43m）

### 4.4 文档一致性验证

- [ ] 09 号文档初版结论已修正（§6.6 / §13.4 / §14 / §15）
- [ ] dev.md / phm.md 矩阵描述已修正
- [ ] devParser.ts / phmParser.ts 注释已统一

---

## 5. 参考

- [09-transform-chain-analysis.md](./09-transform-chain-analysis.md)：完整变换链分析（含 CBM/DEV/SUBDEVICE/PHM/MOD 各层矩阵分布、实例多样性证据、单位处理分析）
- [10-substation-mod-grammar.md](./10-substation-mod-grammar.md)：变电 MOD XML 语法
- [dev.md](./dev.md)：DEV 文件格式
- [phm.md](./phm.md)：PHM 文件格式
- [_generated/transform-matrix-instance-analysis.ps1](./_generated/transform-matrix-instance-analysis.ps1)：实例级链路分析脚本
- [_generated/transform-matrix-instance-analysis-demo-substation.json](./_generated/transform-matrix-instance-analysis-demo-substation.json)：分析 JSON 输出
