# Source Core

Source Core 在 Parser 的无损字段之上建立来源文档、引用、组成和 occurrence 图。Source Adapter 将来源证据传入 Semantic，Geometry 用来源 occurrence 建立物理表示与实例关系，Projection 保留来源视图。[SDK 架构图](../sdk架构图.png)

| 模块 | 职责 |
|---|---|
| `sourceGraph.ts` | 建立提取上下文，定位唯一的 `project.cbm`，调度遍历并完成结果。公开入口继续由 `source.ts` 提供。 |
| `graph/sourceGraphContext.ts` | 每次提取共用一个文档读取器、条目索引、引用解析器、FAM 索引、物理作用域索引及 occurrence 预算。引用和诊断直接写入本次结果。 |
| `graph/cbmOccurrenceTraversal.ts` | 按来源顺序访问 CBM 引用，保留组织及组成节点、PARTINDEX 证据和 IFC 引用。通过物理作用域匹配真实 DEV 后代。 |
| `graph/devOccurrenceExpansion.ts` | 按实际 DEV 子装配边展开物理 occurrence，记录直接父件、装配地址和分支环。 |
| `graph/physicalScopeIndex.ts` | 按需索引当前装配子树，并复用已匹配的子作用域。 |
| `sourceFamilyIndex.ts` | 管理 FAM 引用、occurrence 分配与延迟物化。 |

同一会话的文档请求按解析后的路径共享 Promise。读取拒绝保留在本次提取的缓存中，新会话可以重新读取。FAM 引用路径和聚合结果按拥有引用的文档路径缓存。多个 Owner 引用同一个 FAM 时，底层读取和解析按实际 FAM 路径共享，各 Owner 按自身引用顺序聚合属性。

开启 `deferFamilies` 时，遍历仅记录 FAM 分配。识别请求到达后，`materializeEngineeringFamilies` 按路径复用已经获得的 FAM 文档和字段，并向各 occurrence 补充属性。再次物化已取得的文档时，读取数、属性和图修订保持稳定。

缓存单元测试验证并发请求、失败和会话重试。来源图测试验证跨遍历的读取次数、延迟物化、引用顺序、歧义、物理 occurrence 身份及共享预算。验证入口及消费者测试范围见[测试组织](../validation.md#测试组织)。

桌面工程 Worker 从 SDK Source 能力入口建图。物理目录和来源图在同一提取会话共享 `SourceDocuments` 和条目索引，完成提取后释放临时文档。宿主导航的 IFC 发现与 CBM 树共用 `cbmDocument` 的文件级文档缓存。主线程导航和工程 Worker 各持有自己的解析结果。[Worker 读取次数测试](../../desktop/src/services/engineering/__tests__/engineeringSourceBatches.test.ts)
