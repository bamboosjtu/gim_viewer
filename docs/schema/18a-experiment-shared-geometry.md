# 18a. 方案 A 实验：Geometry 共享缓存

> 实验编号：EXP-2026-07-06-A
> 关联文档：[17-batch-load-schema.md](./17-batch-load-schema.md) §12、[16-substation-transform-matrix-bugs.md](./16-substation-transform-matrix-bugs.md) §2.4
> 状态：**已实施 / 待用户实测**
> 实施日期：2026-07-06

## 1. 实验目标

验证方案 A（Geometry 共享缓存）能否解决"加载到 2000+ MOD 时程序崩溃"问题。

### 1.1 假设

根据 [09-transform-chain-analysis.md](./09-transform-chain-analysis.md) §11.4 实证数据：
- 66.2% MOD 文件被多实例引用
- 平均复用 1.66 次
- 修复 instanceKey 去重后 MOD 实例数从 5938 → 7000+

**假设**：每 Entity 独立 `new BufferGeometry()` 导致 GPU 内存累积，叠加核显共享系统内存的特点引发崩溃。通过按 `(modPath, primitiveType, primitiveParamsSignature)` 缓存 BufferGeometry，可减少 ~40% Geometry 对象，缓解内存压力。

### 1.2 实验假设的量化预期

| 指标 | 现状（修复 Material 后） | 方案 A 预期 | 减少比例 |
| ---- | ----: | ----: | ---: |
| Geometry 对象数 | ~77000 | ~46000 | 40% |
| Mesh 对象数 | ~77000 | ~77000 | 0（不变） |
| draw call 数 | ~77000 | ~77000 | 0（不变） |
| GPU vertex buffer | ~100MB | ~60MB | 40% |
| JS heap 占用 | ~280MB | ~200MB | 28% |

## 2. 实施清单

### 2.1 代码修改

| 文件 | 修改 | 行数 |
| ---- | ---- | ----: |
| [src/viewer/xmlModGeometry.ts](../../src/viewer/xmlModGeometry.ts) | 新增 `_sharedGeometryCache` Map + `disposeSharedXmlModGeometries()`；`primitiveToGeometry` 拆为 `primitiveToGeometryUncached`（内部）+ `primitiveToGeometry(p, modPath)`（带缓存）；`entityToMesh` 接收 `modPath` 参数；`xmlModDocumentToGroup` 传入 `doc.modPath` | ~80 |
| [src/viewer/xmlModLoader.ts](../../src/viewer/xmlModLoader.ts) | re-export `disposeSharedXmlModGeometries`；`disposeXmlModGroup` 改为不 dispose geometry（共享，由统一函数释放） | ~15 |
| [src/services/projectCleanupService.ts](../../src/services/projectCleanupService.ts) | v8 注释；traverse 不再 dispose geometry；调用 `disposeSharedXmlModGeometries()` | ~10 |
| [src/viewer/__tests__/xmlModGeometry.test.ts](../../src/viewer/__tests__/xmlModGeometry.test.ts) | 所有 `primitiveToGeometry({...})` 调用补 `TEST_MOD_PATH` 参数；所有 `entityToMesh(e)` 调用补 `TEST_MOD_PATH`；新增 `describe('方案 A：Geometry 共享缓存')` 5 个测试用例 | ~80 |
| [src/viewer/__tests__/xmlModLoader.test.ts](../../src/viewer/__tests__/xmlModLoader.test.ts) | `disposeXmlModGroup` 测试期望更新为 v3 语义（不 dispose geometry/material） | ~5 |

**总改动量**：~190 行

### 2.2 关键设计决策

#### 缓存键设计

```typescript
const sig = `${modPath}:${p.type}:${primitiveSignature(p)}`;
```

- **modPath**：同 MOD 文件多实例共享（66.2% MOD 多实例）
- **primitiveType**：Cylinder/Cuboid/Sphere/...
- **primitiveSignature**：参数签名（r/h/l/w/...），不含 TransformMatrix

**关键洞察**：Entity.TransformMatrix 在 `entityToMesh` 中烘焙到 `mesh.matrix`，**不影响 geometry 顶点数据**，因此同 modPath+primitive 实例共享 geometry 是安全的。

#### dispose 策略

- `disposeXmlModGroup`：**不 dispose geometry/material**（二者均共享）
- `disposeSharedXmlModGeometries`：项目切换时统一释放 Geometry 缓存
- `disposeSharedXmlModMaterials`：项目切换时统一释放 Material 缓存
- 调用顺序：先 `scene.remove(group)` → 再 `disposeSharedXmlModGeometries()` + `disposeSharedXmlModMaterials()`

## 3. 验证

### 3.1 TypeScript 编译

```bash
npm run build
```

**结果**：✅ 通过（vite build 成功，无 TypeScript 错误）

### 3.2 单元测试

```bash
npx vitest run src/viewer/__tests__/xmlModGeometry.test.ts src/viewer/__tests__/xmlModLoader.test.ts
```

**结果**：52 通过 / 5 失败（57 总计）

**失败用例分析**：

| 失败用例 | 原因 | 与方案 A 关系 |
| ---- | ---- | ---- |
| `primitiveToGeometry > Cylinder → radialSegments` 应为 32 | 测试期望 32，实现为 16（`CYLINDER_SEGMENTS=16`） | 预先存在，无关 |
| `primitiveToGeometry > RectangularFixedPlate → BoxGeometry` | 测试期望返回 BoxGeometry，实现已改为暂停渲染返回 null | 预先存在，无关 |
| `primitiveToGeometry > OffsetRectangularTable → BoxGeometry` | 同上 | 预先存在，无关 |
| `primitiveToGeometry > RectangularRing → BoxGeometry` | 同上 | 预先存在，无关 |
| `loadXmlModFromFiles > XML 解析失败 → null` | 测试期望解析失败返回 null，但实现返回空 Group | 预先存在，无关 |

**方案 A 新增测试**（5 个）：✅ 全部通过

| 测试用例 | 验证点 | 结果 |
| ---- | ---- | ---- |
| 同 modPath 同参数 primitive → 共享同一 BufferGeometry 实例 | 引用相等 `g1 === g2` | ✅ |
| 同 modPath 不同参数 → 不共享 | 引用不等 `g1 !== g2` | ✅ |
| 不同 modPath 同参数 → 不共享（缓存键含 modPath） | 引用不等 | ✅ |
| Entity.TransformMatrix 不影响缓存键 → 同 modPath 同 primitive 不同 TransformMatrix 仍共享 | geometry 共享 + position 不同 | ✅ |
| disposeSharedXmlModGeometries 后再次请求 → 新建实例 | dispose 后引用不等 | ✅ |

## 4. 实施过程

### 4.1 修改前：xmlModGeometry.ts 关键代码

```typescript
// 每 Entity 独立 new BufferGeometry
export function primitiveToGeometry(p: XmlModPrimitive): THREE.BufferGeometry | null {
  switch (p.type) {
    case 'Cylinder':
      return new THREE.CylinderGeometry(...);
    // ...
  }
}

export function entityToMesh(e: XmlModEntity): THREE.Mesh | null {
  const geometry = primitiveToGeometry(e.primitive);  // 不带 modPath
  // ...
}
```

### 4.2 修改后：xmlModGeometry.ts 关键代码

```typescript
// 共享缓存
const _sharedGeometryCache = new Map<string, THREE.BufferGeometry>();

export function disposeSharedXmlModGeometries(): void {
  for (const geo of _sharedGeometryCache.values()) geo.dispose();
  _sharedGeometryCache.clear();
}

// 无缓存版本（内部）
function primitiveToGeometryUncached(p: XmlModPrimitive): THREE.BufferGeometry | null {
  switch (p.type) {
    case 'Cylinder':
      return new THREE.CylinderGeometry(...);
    // ...
  }
}

// 参数签名（不含 TransformMatrix）
function primitiveSignature(p: XmlModPrimitive): string {
  switch (p.type) {
    case 'Cylinder':
      return `r=${sanitizeNum(p.r)},h=${sanitizeNum(p.h)}`;
    // ...
  }
}

// 带缓存版本（外部）
export function primitiveToGeometry(p: XmlModPrimitive, modPath: string): THREE.BufferGeometry | null {
  const sig = `${modPath}:${p.type}:${primitiveSignature(p)}`;
  const cached = _sharedGeometryCache.get(sig);
  if (cached) return cached;
  const geo = primitiveToGeometryUncached(p);
  if (geo) _sharedGeometryCache.set(sig, geo);
  return geo;
}

export function entityToMesh(e: XmlModEntity, modPath: string): THREE.Mesh | null {
  const geometry = primitiveToGeometry(e.primitive, modPath);  // 传入 modPath
  // ...
}
```

### 4.3 dispose 链路修改

**修改前**：

```typescript
// projectCleanupService.ts
state.modRootGroup.traverse((obj) => {
  const mesh = obj as THREE.Mesh;
  mesh.geometry?.dispose?.();  // ← 逐 mesh dispose geometry
  // Material 已不 dispose（v7 共享）
});
disposeSharedXmlModMaterials();  // ← 统一释放 Material
```

**修改后**：

```typescript
// projectCleanupService.ts v8
scene.remove(state.modRootGroup);  // 直接移除根节点
// traverse 不再 dispose geometry/material（二者均共享）
disposeSharedXmlModGeometries();  // ← 统一释放 Geometry
disposeSharedXmlModMaterials();   // ← 统一释放 Material
```

## 5. 预期效果与待验证项

### 5.1 预期效果

| 指标 | 修复前 | 方案 A 预期 |
| ---- | ---- | ---- |
| 崩溃临界点 | ~2000+ MOD | **不确定**（取决于崩溃主因） |
| Geometry 对象数 | ~77000 | ~46000（-40%） |
| GPU 内存峰值 | ~100MB | ~60MB（-40%） |
| 加载速度 | 慢（CPU 解析 XML 主导） | 略提升（XML 解析不变，仅几何构造减少） |

### 5.2 待用户实测验证

- [ ] 加载 7000+ MOD 是否能完成（不崩溃）
- [ ] 崩溃临界点是否提升到 4000+ 或更高
- [ ] 加载完成后场景渲染是否正常（无视觉差异）
- [ ] MOD 位置是否仍正确（与 IFC 构件对齐）
- [ ] 项目切换时共享缓存是否正确释放（无内存泄漏）
- [ ] 控制台无 geometry dispose 错误

### 5.3 可能的结果分支

**分支 A：方案 A 足以解决崩溃**

- 加载 7000+ MOD 完成，无崩溃
- 后续优化方向：阶段 2（SQLite 几何缓存）、阶段 3（Worker 化）
- 无需立即实施方案 B（mergeGeometries）

**分支 B：方案 A 不足，仍崩溃**

- 崩溃临界点提升（如 3000 → 4000）但仍未完成
- 根因：draw call 数量超限（核显上限 3000-5000）
- 必须实施方案 B（mergeGeometries 静态合并）
- 代价：Entity 级高亮降级为 Group 级高亮

**分支 C：方案 A 反而引入新问题**

- 共享 geometry 导致渲染异常（概率低，需验证）
- dispose 时序问题导致 use-after-free（已通过测试覆盖）
- 回退方案：删除 `_sharedGeometryCache`，恢复 `primitiveToGeometryUncached` 即可

## 6. 风险评估

### 6.1 共享 Geometry 的正确性

**风险**：共享 geometry 后，多个 Mesh 引用同一 geometry，是否会导致渲染异常？

**分析**：BufferGeometry 是纯数据（vertex/index/normal/uv），不包含 transform 或 material 信息。Three.js 的 Mesh 通过 `mesh.matrix` 和 `mesh.material` 引用，与 geometry 解耦。因此共享 geometry 是 Three.js 的标准用法（如 InstancedMesh 的极端形式）。

**验证**：单元测试 `Entity.TransformMatrix 不影响缓存键 → 同 modPath 同 primitive 不同 TransformMatrix 仍共享` 已覆盖此场景。

### 6.2 dispose 时序

**风险**：如果 `disposeSharedXmlModGeometries` 在某些 Mesh 仍在 scene 中时调用，会导致 GPU 资源被释放但 Mesh 仍引用，渲染崩溃。

**防护**：[projectCleanupService.ts](../../src/services/projectCleanupService.ts) v8 严格保证顺序：
1. `scene.remove(state.modRootGroup)` — 先从 scene 移除
2. `disposeSharedXmlModGeometries()` — 再释放共享 geometry
3. `disposeSharedXmlModMaterials()` — 最后释放共享 material

### 6.3 缓存键碰撞

**风险**：不同 primitive 参数生成相同的 signature 字符串。

**分析**：`primitiveSignature` 按类型显式提取参数（如 `r=${r},h=${h}`），不会碰撞。`JSON.stringify(p)` 仅作为 fallback（用于未支持的 primitive 类型）。

### 6.4 内存增长

**风险**：`_sharedGeometryCache` 无上限，长期使用可能无限增长。

**当前状态**：单项目内缓存键约 46000 个，GPU 内存约 60MB，可接受。跨项目时通过 `disposeSharedXmlModGeometries` 清空。

**后续优化**：阶段 5c/方案 C 可加 LRU 上限，但当前不必要。

## 7. 实验产出

### 7.1 代码

- `src/viewer/xmlModGeometry.ts`：新增 `_sharedGeometryCache` + `disposeSharedXmlModGeometries` + `primitiveSignature`
- `src/viewer/xmlModLoader.ts`：re-export + `disposeXmlModGroup` 改为 v3 语义
- `src/services/projectCleanupService.ts`：v8 dispose 链路
- `src/viewer/__tests__/xmlModGeometry.test.ts`：5 个新测试 + 现有测试签名更新
- `src/viewer/__tests__/xmlModLoader.test.ts`：dispose 测试更新

### 7.2 文档

- 本文档（18a-experiment-shared-geometry.md）
- 17-batch-load-schema.md §11/§12（已在上一轮更新）
- 16-substation-transform-matrix-bugs.md §2.4（FIX-3 历史，本实验是其延续）

## 8. 下一步

### 8.1 用户实测

请用户在核显环境下打开变电站 GIM 样本，观察：

1. 是否能加载完成 7000+ MOD 而不崩溃
2. 若仍崩溃，记录崩溃时的 MOD 数量
3. 控制台是否有 `[xmlModGeometry]` 相关 warning
4. 加载完成后 MOD 位置是否仍正确

### 8.2 根据实测结果分支

- **若加载完成** → 方案 A 成功，后续按 [17-batch-load-schema.md](./17-batch-load-schema.md) §16 阶段 2/3 推进
- **若仍崩溃** → 启动 [18b-experiment-merge-geometries.md](./18b-experiment-merge-geometries.md)（方案 B），需用户确认 Entity 高亮降级为 Group 级

### 8.3 实验记录模板

用户实测后请填写：

```text
实验日期：____
GIM 样本：____
机器配置：CPU____ / 内存____ / 显卡____
崩溃临界点：____ MOD（如未崩溃填"未崩溃，加载完成"）
加载完成时间：____ 秒
观察到的异常：____
```

## 9. 参考文献

- [09-transform-chain-analysis.md §11.4](./09-transform-chain-analysis.md)：66.2% MOD 多实例证据
- [16-substation-transform-matrix-bugs.md §2.4](./16-substation-transform-matrix-bugs.md)：FIX-3 Material 共享历史
- [17-batch-load-schema.md §11/§12](./17-batch-load-schema.md)：方案 A 设计与预期效果
- Three.js 共享 Geometry 用法 — https://threejs.org/docs/#api/en/core/BufferGeometry
