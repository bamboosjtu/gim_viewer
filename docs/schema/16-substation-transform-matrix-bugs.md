# 变电工程变换链实现问题与改进建议

> 本文档不重复分析内容（已全部归入 [09-transform-chain-analysis.md](./09-transform-chain-analysis.md)），仅记录由 09 号文档初版错误结论引发的程序实现问题、修复方案与改进方向。
>
> 关联分析详见：
> - [09-transform-chain-analysis.md](./09-transform-chain-analysis.md) §6.6 / §13.4 / §14 / §15：变换链分析与结论修正
> - [09-transform-chain-analysis.md](./09-transform-chain-analysis.md) §11.4 / §12：实例多样性证据与单位处理分析
> - [20-substation-partindex-alias-correction.md](./20-substation-partindex-alias-correction.md)：PARTINDEX 与 DEV SUBDEVICE 的别名关系更正

> **2026-07-10 更正**：本文涉及“9866 实例 / modPath 去重丢失 3928 实例”的结论已被撤销。该数量混入了 CBM PARTINDEX 别名路径；应从根 DEV 递归一次，并将 PARTINDEX 用作树和属性语义，而非第二个几何入口。

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

> **状态**：✅ 已完成 — 已改用 `instanceKey` 去重

#### 历史问题

`modAutoLoadService.ts` 原先用 `modPath` 作为去重 key，导致同一 MOD 文件被多个不同 placement 引用时只保留第一个实例。STL 同理。

#### 修复

已改为 `instanceKey`（含 placement）去重，与加载阶段的去重 key 一致。详见 [09-transform-chain-analysis.md](./09-transform-chain-analysis.md) §15.3。

> 注：早期"9866 → 5938 丢失 40%"的数字已被 2026-07-10 更正撤销，正确基线为 4135 MOD + 1803 STL = 5938，详见 [20-substation-partindex-alias-correction.md](./20-substation-partindex-alias-correction.md)。

---

### 2.2 问题 2：applyExternalTransforms 单位隐患（中优先级）

> **状态**：✅ 已完成 — 函数已从源码中删除

#### 历史问题

`applyExternalTransforms` 函数原先存在于 [xmlModLoader.ts](../../src/viewer/xmlModLoader.ts)，直接 `group.applyMatrix4` 不缩放平移，且参数仅含 DEV/PHM 缺少 CBM/SUBDEVICE 累积。

#### 修复

函数已从源码中删除。生产路径全部走 `applyPlacementTransformToSceneUnits`（方案 B 后已改为顶点烘焙版，详见 [09-transform-chain-analysis.md](./09-transform-chain-analysis.md) §12.2.1）。

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

### 2.4 问题 4：每 Entity 独立 Material 导致 OOM 崩溃（高优先级）

> 本节为 FIX-1（modPath → instanceKey 去重修复）落地后暴露的次生问题。修复前实例数 5938（被错误去重），修复后实例数恢复到 7000+，但加载到约 3000 个 MOD 时程序直接崩溃。

#### 问题位置

[xmlModGeometry.ts:116-148](../../src/viewer/xmlModGeometry.ts#L116-L148)（修复前）：

```typescript
export function entityToMesh(e: XmlModEntity): THREE.Mesh | null {
  const geometry = primitiveToGeometry(e.primitive);
  if (!geometry) return null;
  const material = colorToMaterial(e.color);   // ← 每 Entity new 一个 Material
  const mesh = new THREE.Mesh(geometry, material);
  // ...
}

function colorToMaterial(color: XmlModColor | undefined): THREE.MeshStandardMaterial {
  if (!color) {
    return new THREE.MeshStandardMaterial({ color: 0x888888, transparent: false });
  }
  // ...
  const material = new THREE.MeshStandardMaterial({ color: hex, transparent, opacity });  // ← 每次都 new
  return material;
}
```

#### 后果量化

按 [09 号文档](./09-transform-chain-analysis.md) §5.1 真实样本数据：

| 维度 | 计算 | 数量 |
| ---- | ---- | ---- |
| MOD 实例数 | 链路重建后（FIX-1 修复） | 7000+（实测） |
| 平均 Entity/MOD | 46250 / 4135 | ~11.2 |
| 总 Mesh 数 | 7000 × 11.2 | **~78000** |
| 总 Material 数 | 与 Mesh 1:1 | **~78000** |
| 总 Geometry 数 | 与 Mesh 1:1 | **~78000** |

加载到 3000 个 MOD 时累积：
- ~33000 个 Mesh + Material + Geometry
- 每个 MeshStandardMaterial 约 1-2KB GPU 内存，加上 geometry buffer
- 累积 100-300MB GPU 内存，WebView2 子进程通常 1-2GB 上限
- 触发 OOM 崩溃

[modAutoLoadService.ts:53-66](../../src/services/modAutoLoadService.ts#L53-L66) 中 `state.loadedXmlModGroups` 是 `Map<instanceKey, Group>`，**无上限、无 LRU 驱逐策略**，所有 Group 永久驻留。

#### 修复方案

按 `(colorHex, opacity, transparent)` 聚类缓存 Material，从 78000 个降到几十个：

```typescript
// xmlModGeometry.ts
const _sharedMaterialCache = new Map<string, THREE.MeshStandardMaterial>();
let _sharedDefaultMaterial: THREE.MeshStandardMaterial | null = null;

export function disposeSharedXmlModMaterials(): void {
  for (const mat of _sharedMaterialCache.values()) mat.dispose();
  _sharedMaterialCache.clear();
  if (_sharedDefaultMaterial) {
    _sharedDefaultMaterial.dispose();
    _sharedDefaultMaterial = null;
  }
}

function colorToMaterial(color: XmlModColor | undefined): THREE.MeshStandardMaterial {
  if (!color) {
    if (!_sharedDefaultMaterial) {
      _sharedDefaultMaterial = new THREE.MeshStandardMaterial({ color: 0x888888, transparent: false });
    }
    return _sharedDefaultMaterial;
  }
  const hex = (clamp255(color.r) << 16) | (clamp255(color.g) << 8) | clamp255(color.b);
  const opacity = clamp100(color.a) / 100;
  const transparent = color.a < 100;
  const key = `${hex}_${opacity}_${transparent}`;
  let material = _sharedMaterialCache.get(key);
  if (!material) {
    material = new THREE.MeshStandardMaterial({ color: hex, transparent, opacity });
    _sharedMaterialCache.set(key, material);
  }
  return material;
}
```

#### 配套修改

1. **`disposeXmlModGroup` 不再 dispose Material**：共享 Material 不可逐 mesh dispose，否则会破坏其他仍在场景中的同色 Mesh。改为只 dispose geometry。
2. **新增 `disposeSharedXmlModMaterials`**：统一释放共享缓存，由 [projectCleanupService.ts](../../src/services/projectCleanupService.ts) 在所有 MOD Group 从 scene 移除后调用。
3. **`xmlModLoader.ts` re-export**：`export { disposeSharedXmlModMaterials } from './xmlModGeometry.js'`，统一入口。
4. **测试更新**：`disposeXmlModGroup` 测试期望从 "释放 geometry + material" 改为 "仅释放 geometry"，并验证 Material 未被 dispose。

#### 后续优化方向（未实施）

| 优化项 | 预期效果 | 优先级 |
| ---- | ---- | ---- |
| Geometry 缓存（按 modPath） | 同 MOD 多实例仅解析一次，减少 ~50% 解析压力 | P1 |
| LRU 上限（state.loadedXmlModGroups ≤ 1500） | 防止累积过多 Group 导致内存增长 | P1 |
| InstancedMesh（同 modPath + 同 placement） | 78000 Mesh → 数百 InstancedMesh，大幅减少 draw call | P2 |
| Worker 化 XML 解析 + 几何构造 | 主线程不阻塞，加载流畅度提升 | P3 |

详见 [17-batch-load-schema.md](./17-batch-load-schema.md)。

---

### 2.5 问题 5：GIM Z-up 与 viewer Y-up 坐标系不一致导致"屏柜横着放"（高优先级）

> 本节为 FIX-1 修复后实例位置恢复暴露的次生问题。修复前实例数 5938 时部分位置错误被去重掩盖，修复后实例数 7000+ 时方向错误变得明显。

#### 问题表现

用户反馈："先渲染的疑似是二次屏柜，但二次屏柜的位置和方向（看着像是屏柜横着放的）与 ifc 文件定义的构件套不上。"

#### 根因分析

**GIM 工程坐标系（Z-up）与 viewer 坐标系（Y-up）不一致**：

1. ThatOpen IfcLoader 默认 `coordinateToOrigin=true` + 内部做 Z-up → Y-up 转换，**IFC 加载后是 Y-up 坐标系**，屏柜直立显示
2. MOD/STL 保留 GIM 原始工程坐标（Z-up，电力行业惯例：Tz 是"高度"方向），未做坐标轴转换
3. [modAutoLoadService.ts:52-66](../../src/services/modAutoLoadService.ts#L52-L66) 创建的 `modRootGroup` 直接挂在 scene 下，**没有任何坐标轴转换**
4. 每个 MOD Group 的变换链：
   ```
   Group.scale = 0.001（mm→m）
     ↓
   mesh.applyMatrix4(Entity.TransformMatrix)  ← GIM Z-up 局部变换
     ↓
   applyPlacementTransformToSceneUnits(group, placementTransform)  ← GIM Z-up 工程坐标
     ↓
   applyProjectSourceToViewer(group, projectSourceToViewerMatrix)  ← IFC baseCoordinationMatrix（Y-up 平移）
   ```
5. 结果：MOD 几何在 Z-up 下放置正确，但被 IFC 的 Y-up 平移矩阵"拉"到 Y-up 空间，**Z 轴被当成水平方向** → 屏柜"横着放"

**实证依据**（[09 号文档 §8.4](./09-transform-chain-analysis.md#L538-L548)）：

```
[4883d8d8-*.cbm] TRANSLATION+ROTSCALE
  T=(45758.924, 7382.144, 5750.000)
  raw: 0,1,0,0, -1,0,0,0, 0,0,1,0, 45758.924,7382.144,5750,1
```

平移分量 Tz=5750mm（约 5.75 米）—— 变电站内设备的"高度"方向。如果 viewer 是 Y-up，这个高度应映射到 +Y（直立）；如果直接应用，会被当成 Z 方向水平放置。

#### 修复方案

在 `projectSourceToViewerMatrix` 中组合 Z-up→Y-up 旋转：

```typescript
// coordinateAlignmentService.ts
const Z_UP_TO_Y_UP = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

export async function syncProjectSourceToViewerFromFragments(
  state: AppState,
  fragments: OBC.FragmentsManager,
): Promise<boolean> {
  // ... 等待 baseCoordinationMatrix ...
  const base = fragments.baseCoordinationMatrix;
  if (!base) return false;

  // 组合：baseCoordinationMatrix（Y-up 平移）× ZUpToYUp（Z-up→Y-up 旋转）
  // 应用顺序：先旋转 GIM 几何到 Y-up，再用 baseCoordinationMatrix 平移到 viewer 原点
  const combined = base.clone().multiply(Z_UP_TO_Y_UP);
  state.projectSourceToViewerMatrix = combined;
  // ...
}
```

`makeTranslationAlignment` 同样组合（manual offset 视为 viewer Y-up 空间下的平移）：

```typescript
export function makeTranslationAlignment(dx: number, dy: number, dz: number): ProjectCoordinateAlignment {
  const translation = new THREE.Matrix4().makeTranslation(dx, dy, dz);
  const m = translation.multiply(Z_UP_TO_Y_UP);
  // ...
}
```

#### 矩阵乘法顺序说明

```
sourceToViewer = baseCoordinationMatrix × ZUpToYUp
应用到向量：v' = baseCoordinationMatrix × ZUpToYUp × v
```

1. **先应用 ZUpToYUp**：把 GIM Z-up 几何旋转到 Y-up
   - 原 +Z（GIM 高度方向）→ 新 +Y（viewer 上方向）
   - 原 +Y → 新 -Z
   - 原 +X 保持不变
2. **再应用 baseCoordinationMatrix**：把 Y-up 工程坐标平移到 viewer 原点

注意 Three.js `Matrix4.multiply(other)` 是 `this = this × other`，对应列主序矩阵的 `parent × child`，应用到向量是 `v' = parent × child × v`（先 child 后 parent），与上述语义一致。

#### 不修改的部分

- `modRootGroup` / `stlRootGroup` 不需要旋转（旋转已融合到 `projectSourceToViewerMatrix`）
- `applyPlacementTransformToSceneUnits` 函数签名不变，但实现已改为顶点烘焙（方案 B 后，详见 09 号文档 §12.2.1），仍在 GIM Z-up 下应用 placement
- `modGeometryDiscovery.ts` 的矩阵累乘逻辑不变（已验证 [09 号文档 §10](./09-transform-chain-analysis.md#L652)）

#### 验证方法

修复后：
- 二次屏柜直立显示（屏柜"高度"方向映射到 viewer +Y）
- 屏柜位置与 IFC 构件对齐
- CBM 矩阵样本 Tz=5750mm 旋转后映射到 viewer +Y 方向约 5.75 米

调试日志（DEBUG_IFC_LOAD=true 时输出）：
```
[CoordAlign] 已从 Fragments baseCoordinationMatrix 同步并组合 Z-up→Y-up 旋转
  baseCoordinationModel: ...
  baseIsIdentity: false
  baseMatrix: [...]
  combinedMatrix: [...]
```

#### 风险点

1. **baseCoordinationMatrix 实际形态未验证**：如果它不是纯平移（含旋转或缩放），组合后可能产生意外效果。建议修复前先加 `console.log(base.elements)` 确认。
2. **GIM X/Y 轴方向与 IFC 不一致**：本修复假设 GIM 是 Z-up 右手坐标系，IFC 是 Y-up 右手坐标系。如果 GIM X 轴方向与 IFC 相反，需要额外旋转。
3. **CBM 矩阵旋转方向**：样本中 CBM 含绕 Z 轴 ±90° 旋转（[09 号文档 §8.4](./09-transform-chain-analysis.md#L538-L548)），旋转后这些旋转会变成绕 Y 轴旋转，需验证设备朝向是否正确。

---

## 3. 改进方向

### 3.1 短期修复（高优先级）

> **状态**：FIX-1/2/3/4 均已完成

| 编号 | 问题 | 修复位置 | 状态 | 验证方法 |
| ---- | ---- | -------- | ---- | -------- |
| FIX-1 | modPath 去重 bug | [modAutoLoadService.ts](../../src/services/modAutoLoadService.ts) | ✅ 已完成 | 改用 instanceKey 去重；多实例 MOD 文件位置正确填充；"MOD 完全覆盖 IFC"现象消失 |
| FIX-2 | applyExternalTransforms 隐患 | [xmlModLoader.ts](../../src/viewer/xmlModLoader.ts) | ✅ 已删除 | 函数已从源码删除；生产路径全部走 applyPlacementTransformToSceneUnits（顶点烘焙版） |
| FIX-3 | 每 Entity 独立 Material 导致 OOM 崩溃 | [xmlModGeometry.ts](../../src/viewer/xmlModGeometry.ts) + [projectCleanupService.ts](../../src/services/projectCleanupService.ts) | ✅ 已完成 | 加载 7000+ MOD 不崩溃；Material 数从 78000+ 降到几十；项目切换时共享 Material 正确释放 |
| FIX-4 | GIM Z-up 与 viewer Y-up 坐标系不一致 | [coordinateAlignmentService.ts](../../src/services/coordinateAlignmentService.ts) `syncProjectSourceToViewerFromFragments` + `makeTranslationAlignment` | ✅ 已完成 | 二次屏柜直立显示（屏柜"高度"方向映射到 viewer +Y）；CBM 矩阵 Tz=5750mm 旋转后映射到 viewer +Y 约 5.75 米 |

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

> **状态**：FIX-1/2/3/4 均已完成，以下验证项标注实施状态。

### 4.1 实例数验证

- [x] 加载 demo-substation 后，MOD/STL 实例数与 20 号文档修正后基线一致（4135 MOD + 1803 STL = 5938）
- [x] 多实例文件（如 `72c8865f-*.mod`）在场景中出现多次，位于不同位置
- [x] "MOD 完全覆盖 IFC"现象消失

### 4.2 单位处理验证

- [x] 应用 placement 后，MOD Group bbox 中心位于工程原点附近（数十米范围内）
- [x] 不出现 45 公里量级的飘移
- [x] `applyExternalTransforms` 已删除，无生产代码调用

### 4.3 矩阵链路验证

- [x] `geo.placementTransformMatrix` 包含 CBM×DEV×SUBDEVICE×PHM 累积
- [x] 应用顺序为 Entity local（烘焙到顶点）→ placement（顶点烘焙）→ projectSourceToViewer
- [x] 非 IDENTITY 实例平移分量范围与 09 号 §10.3 一致（Tx/Ty ≈ 100m、Tz ≈ 43m）

### 4.4 文档一致性验证

- [x] 09 号文档初版结论已修正（§6.6 / §13.4 / §14 / §15）
- [ ] dev.md / phm.md 矩阵描述已修正（待完成）
- [ ] devParser.ts / phmParser.ts 注释已统一（待完成）

### 4.5 Material 共享验证（FIX-3）

- [x] 加载 7000+ MOD 不崩溃，加载完成不出现 OOM
- [x] `xmlModGeometry.ts` 的 `_sharedMaterialCache.size` 为几十个（非 78000+）
- [x] `disposeXmlModGroup` 不再 dispose Material（仅 dispose geometry）
- [x] `disposeSharedXmlModMaterials` 在项目切换时被调用，共享缓存清空
- [x] 同色 Mesh 共享同一 Material 实例（可通过 `mesh.material === mesh2.material` 验证）

### 4.6 坐标系对齐验证（FIX-4）

- [x] 二次屏柜直立显示（"高度"方向映射到 viewer +Y）
- [x] 屏柜位置与 IFC 构件对齐
- [x] CBM 矩阵 Tz=5750mm 旋转后映射到 viewer +Y 方向约 5.75 米
- [x] DEBUG_IFC_LOAD=true 时输出 `[CoordAlign] 已从 Fragments baseCoordinationMatrix 同步并组合 Z-up→Y-up 旋转` 日志
- [x] `projectSourceToViewerMatrix` 包含旋转分量（非纯平移）
- [ ] 设备朝向正确（CBM 矩阵含绕 Z 轴 ±90° 旋转的样本旋转后变成绕 Y 轴旋转，朝向应与 IFC 一致）

---

## 5. 参考

- [09-transform-chain-analysis.md](./09-transform-chain-analysis.md)：完整变换链分析（含 CBM/DEV/SUBDEVICE/PHM/MOD 各层矩阵分布、实例多样性证据、单位处理分析）
- [10-substation-mod-grammar.md](./10-substation-mod-grammar.md)：变电 MOD XML 语法
- [dev.md](./dev.md)：DEV 文件格式
- [phm.md](./phm.md)：PHM 文件格式
- [_generated/transform-matrix-instance-analysis.ps1](./_generated/transform-matrix-instance-analysis.ps1)：实例级链路分析脚本
- [_generated/transform-matrix-instance-analysis-demo-substation.json](./_generated/transform-matrix-instance-analysis-demo-substation.json)：分析 JSON 输出
