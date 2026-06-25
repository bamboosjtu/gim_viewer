/**
 * 线路工程解析验证脚本（不依赖浏览器/Tauri 环境）。
 *
 * 用途：
 * 1. 验证 detectGimProjectType 对 demo-line 识别为 transmission_line
 * 2. 验证 buildLineGimGraph 能正确构建 CBM 层级树
 * 3. 输出统计、引用键命中情况、WIRE 节点参数
 *
 * 运行：npx tsx scripts/verify-line-graph.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// 复制 projectType/lineCbmParser 的核心逻辑（避免引入浏览器 File API）
// 也可以直接 import，因为这两个文件不依赖 DOM。我们试试直接 import。

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// 全局 polyfill：让 Node 的 Buffer/Uint8Array 表现得像 Blob
// 项目源码使用 File.text() / File.size，需要 polyfill
class NodeFile extends Blob {
  readonly path: string;
  readonly _buffer: Buffer;

  constructor(path: string, buffer: Buffer) {
    super([buffer]);
    this.path = path;
    this._buffer = buffer;
  }

  get size(): number {
    return this._buffer.length;
  }

  async text(): Promise<string> {
    return this._buffer.toString('utf8');
  }
}

/** 递归收集指定目录下所有文件，构造 Map<relativePath, File-like> */
function loadDemoFiles(subDir: 'demo-line' | 'demo-substation'): Map<string, File> {
  const root = join(projectRoot, 'demo', subDir);
  const files = new Map<string, File>();
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        stack.push(full);
      } else {
        // 相对路径用正斜杠
        const rel = full.slice(root.length + 1).split(sep).join('/');
        const buf = readFileSync(full);
        files.set(rel, new NodeFile(rel, buf) as unknown as File);
      }
    }
  }
  return files;
}

async function main() {
  console.log('=== 加载 demo-line 文件 ===');
  const files = loadDemoFiles('demo-line');
  console.log('总文件数:', files.size);

  // 按扩展名统计
  const extCount = new Map<string, number>();
  for (const path of files.keys()) {
    const ext = extname(path).toLowerCase();
    extCount.set(ext, (extCount.get(ext) || 0) + 1);
  }
  console.log('扩展名统计:', Object.fromEntries(extCount));

  console.log('\n=== 测试 detectGimProjectType ===');
  const { detectGimProjectType } = await import('../src/gim/projectType.ts');
  const result = await detectGimProjectType(files);
  console.log('识别结果:', {
    type: result.type,
    hasIfc: result.details.hasIfc,
    hasLineArtifacts: result.details.hasLineArtifacts,
    ifcCount: result.details.ifcCount,
    cbmCount: result.details.cbmCount,
    devCount: result.details.devCount,
    famCount: result.details.famCount,
    phmCount: result.details.phmCount,
    modCount: result.details.modCount,
    stlCount: result.details.stlCount,
    lineSignalsCount: result.details.lineSignals.length,
  });
  console.log('lineSignals 命中:', result.details.lineSignals);

  if (result.type !== 'transmission_line') {
    console.error('❌ 识别失败：期望 transmission_line，实际', result.type);
    process.exit(1);
  }
  console.log('✓ 工程类型识别正确：transmission_line');

  console.log('\n=== 测试 buildLineGimGraph ===');
  const { buildLineGimGraph } = await import('../src/gim/lineCbmParser.ts');
  const graph = await buildLineGimGraph(files);
  console.log('图构建结果:', {
    projectType: graph.projectType,
    rootPath: graph.root?.path || null,
    rootName: graph.root?.name || null,
    rootEntity: graph.root?.entityName || null,
    nodesByPathSize: graph.nodesByPath.size,
    stats: graph.stats,
    filesByType: {
      cbm: graph.filesByType.cbm.length,
      dev: graph.filesByType.dev.length,
      fam: graph.filesByType.fam.length,
      phm: graph.filesByType.phm.length,
      mod: graph.filesByType.mod.length,
      stl: graph.filesByType.stl.length,
      ifc: graph.filesByType.ifc.length,
      other: graph.filesByType.other.length,
    },
  });

  if (!graph.root) {
    console.error('❌ 图根节点为 null');
    process.exit(1);
  }
  console.log('✓ 图根节点存在');

  // 校验：树深度应该是 project → F1 → F2 → F3 → F4 → 设备
  console.log('\n=== 校验层级树结构 ===');
  const root = graph.root;
  console.log('L0 root:', { entity: root.entityName, classify: root.classifyName, children: root.children.length, refs: root.refs.cbmFiles });

  if (root.children.length === 0) {
    console.error('❌ 根节点无子节点（SUBSYSTEM 递归失败）');
    process.exit(1);
  }
  console.log('✓ 根节点有子节点（SUBSYSTEM 递归成功）');

  // 遍历到 F1
  const f1 = root.children[0];
  console.log('L1 F1:', { entity: f1.entityName, classify: f1.classifyName, children: f1.children.length, sections: f1.refs.cbmFiles.length });

  if (f1.entityName !== 'F1System') {
    console.error('❌ L1 不是 F1System，实际', f1.entityName);
    process.exit(1);
  }
  console.log('✓ L1 为 F1System（SECTIONS.NUM + SECTION<i> 解析成功）');

  // 遍历到 F2
  if (f1.children.length === 0) {
    console.error('❌ F1 无子节点');
    process.exit(1);
  }
  const f2 = f1.children[0];
  console.log('L2 F2:', { entity: f2.entityName, classify: f2.classifyName, children: f2.children.length, strainSections: f2.refs.cbmFiles.length });

  if (f2.entityName !== 'F2System') {
    console.error('❌ L2 不是 F2System，实际', f2.entityName);
    process.exit(1);
  }
  console.log('✓ L2 为 F2System（STRAINSECTIONS.NUM + STRAINSECTION<i> 解析成功）');

  // 遍历到 F3
  if (f2.children.length === 0) {
    console.error('❌ F2 无子节点');
    process.exit(1);
  }
  const f3 = f2.children[0];
  console.log('L3 F3:', { entity: f3.entityName, classify: f3.classifyName, children: f3.children.length, groups: f3.refs.cbmFiles.length });

  if (f3.entityName !== 'F3System') {
    console.error('❌ L3 不是 F3System，实际', f3.entityName);
    process.exit(1);
  }
  console.log('✓ L3 为 F3System（GROUPS.NUM + GROUP<i> 解析成功）');

  // 遍历到 F4
  if (f3.children.length === 0) {
    console.error('❌ F3 无子节点');
    process.exit(1);
  }
  const f4 = f3.children[0];
  console.log('L4 F4:', { entity: f4.entityName, classify: f4.classifyName, children: f4.children.length, towers: f4.refs.cbmFiles.length });

  if (f4.entityName !== 'F4System') {
    console.error('❌ L4 不是 F4System，实际', f4.entityName);
    process.exit(1);
  }
  console.log('✓ L4 为 F4System（GROUPTYPE=' + f4.classifyName + '，TOWERS.NUM + TOWER<i> 解析成功）');

  // 检查 stats 是否有各类节点
  console.log('\n=== 校验 stats 统计 ===');
  const requiredEntities = ['F1System', 'F2System', 'F3System', 'F4System', 'Tower_Device', 'Wire_Device', 'WIRE', 'CROSS'];
  for (const en of requiredEntities) {
    const cnt = graph.stats[en] || 0;
    const mark = cnt > 0 ? '✓' : '⚠';
    console.log(`${mark} ${en}: ${cnt}`);
  }
  console.log('节点总数:', graph.stats.total);

  // 找一个 WIRE 节点检查悬链线参数
  console.log('\n=== 校验 WIRE 节点悬链线参数 ===');
  let wireNode: typeof root | null = null;
  for (const node of graph.nodesByPath.values()) {
    if (node.entityName === 'WIRE') { wireNode = node; break; }
  }
  if (!wireNode) {
    console.warn('⚠ 未找到 WIRE 节点');
  } else {
    console.log('WIRE 节点:', wireNode.path);
    const wireKeys = ['KVALUE', 'SPLIT', 'POINT0.BLHA', 'POINT1.BLHA', 'POINT0.MATRIX0', 'POINT1.MATRIX0'];
    for (const k of wireKeys) {
      const v = wireNode.rawProps[k];
      if (v) console.log(`  ✓ ${k} = ${v.slice(0, 80)}${v.length > 80 ? '...' : ''}`);
      else console.log(`  ✗ ${k} 缺失`);
    }
    console.log('  BASEFAMILY:', wireNode.refs.famFiles);
    console.log('  OBJECTMODELPOINTER:', wireNode.refs.devFiles);
  }

  // 找一个 Tower_Device 检查
  console.log('\n=== 校验 Tower_Device 节点 ===');
  let towerNode: typeof root | null = null;
  for (const node of graph.nodesByPath.values()) {
    if (node.entityName === 'Tower_Device') { towerNode = node; break; }
  }
  if (!towerNode) {
    console.warn('⚠ 未找到 Tower_Device 节点');
  } else {
    console.log('Tower_Device 节点:', towerNode.path);
    console.log('  DEV 引用:', towerNode.refs.devFiles);
    console.log('  FAM 引用:', towerNode.refs.famFiles);
    console.log('  MOD 引用:', towerNode.refs.modFiles);
    console.log('  STL 引用:', towerNode.refs.stlFiles);
  }

  // 检查 F4(WIRE) 的 BACKSTRING/FRONTSTRING
  console.log('\n=== 校验 F4(WIRE) BACKSTRING/FRONTSTRING ===');
  let f4WireNode: typeof root | null = null;
  for (const node of graph.nodesByPath.values()) {
    if (node.entityName === 'F4System' && node.classifyName === 'WIRE') { f4WireNode = node; break; }
  }
  if (!f4WireNode) {
    console.warn('⚠ 未找到 F4System(WIRE) 节点');
  } else {
    console.log('F4(WIRE) 节点:', f4WireNode.path);
    console.log('  rawProps.BACKSTRING:', f4WireNode.rawProps.BACKSTRING);
    console.log('  rawProps.FRONTSTRING:', f4WireNode.rawProps.FRONTSTRING);
    console.log('  refs.rawRefs.BACKSTRING:', f4WireNode.refs.rawRefs.BACKSTRING);
    console.log('  refs.rawRefs.FRONTSTRING:', f4WireNode.refs.rawRefs.FRONTSTRING);
    console.log('  refs.cbmFiles:', f4WireNode.refs.cbmFiles);
    console.log('  children count:', f4WireNode.children.length);
  }

  // 检查 F4(TOWER) 的 STRINGS/GPOINT
  console.log('\n=== 校验 F4(TOWER) STRINGS/GPOINT ===');
  let f4TowerNode: typeof root | null = null;
  for (const node of graph.nodesByPath.values()) {
    if (node.entityName === 'F4System' && node.classifyName === 'TOWER') { f4TowerNode = node; break; }
  }
  if (!f4TowerNode) {
    console.warn('⚠ 未找到 F4System(TOWER) 节点');
  } else {
    console.log('F4(TOWER) 节点:', f4TowerNode.path);
    console.log('  STRINGS.NUM:', f4TowerNode.rawProps['STRINGS.NUM']);
    console.log('  STRING0.STRING:', f4TowerNode.rawProps['STRING0.STRING']);
    console.log('  STRING0.GPOINT:', f4TowerNode.rawProps['STRING0.GPOINT']);
    console.log('  refs.rawRefs.STRING0.GPOINT:', f4TowerNode.refs.rawRefs['STRING0.GPOINT']);
    console.log('  TOWERS.NUM:', f4TowerNode.rawProps['TOWERS.NUM']);
    console.log('  BASES.NUM:', f4TowerNode.rawProps['BASES.NUM']);
    console.log('  SUBDEVICES.NUM:', f4TowerNode.rawProps['SUBDEVICES.NUM']);
  }

  console.log('\n=== 验证全部通过（线路工程） ===');

  // ============================================================
  // Line-2 持久化/恢复往返测试：
  // buildLineGimGraph → buildLineGraphPayload → 模拟 SQLite 读取 → restoreLineGraphToState
  // 校验 flatten/restore 序列化无损（nodes/children/refs/stats）
  // ============================================================
  console.log('\n=== Line-2 持久化/恢复往返测试 ===');
  const { buildLineGraphPayload } = await import('../src/services/lineGraphPersistenceService.ts');
  const { restoreLineGraphToState } = await import('../src/services/lineGraphRestoreService.ts');
  const { AppState } = await import('../src/app/state.ts');

  const payload = buildLineGraphPayload(1, graph);
  console.log('payload 统计:', {
    nodes: payload.nodes.length,
    children: payload.children.length,
    refs: payload.refs.length,
    file_stats: payload.file_stats.length,
    project_type: payload.project_type,
  });

  // 模拟 get_line_gim_graph 返回（payload 与 record 结构同构）
  const simulatedResult = {
    project_type: payload.project_type,
    nodes: payload.nodes,
    children: payload.children,
    refs: payload.refs,
    file_stats: payload.file_stats,
  };

  const restoreState = new AppState();
  const graph2 = restoreLineGraphToState(restoreState, simulatedResult as any);

  // 校验 1：节点总数一致
  if (graph2.nodesByPath.size !== graph.nodesByPath.size) {
    console.error(`❌ 节点数不一致：原 ${graph.nodesByPath.size}，恢复 ${graph2.nodesByPath.size}`);
    process.exit(1);
  }
  console.log(`✓ 节点总数一致：${graph2.nodesByPath.size}`);

  // 校验 2：根节点路径一致
  if (graph2.root?.path !== graph.root?.path) {
    console.error(`❌ 根节点不一致：原 ${graph.root?.path}，恢复 ${graph2.root?.path}`);
    process.exit(1);
  }
  console.log(`✓ 根节点一致：${graph2.root?.path}`);

  // 校验 3：children 结构一致（递归对比每个节点的子节点路径序列）
  let childrenMismatch = 0;
  for (const [path, node1] of graph.nodesByPath) {
    const node2 = graph2.nodesByPath.get(path);
    if (!node2) { childrenMismatch++; continue; }
    const c1 = node1.children.map((c) => c.path).join(',');
    const c2 = node2.children.map((c) => c.path).join(',');
    if (c1 !== c2) {
      childrenMismatch++;
      if (childrenMismatch <= 3) {
        console.error(`❌ children 不一致 ${path}：原[${c1}] 恢复[${c2}]`);
      }
    }
  }
  if (childrenMismatch > 0) {
    console.error(`❌ children 结构不一致节点数：${childrenMismatch}`);
    process.exit(1);
  }
  console.log('✓ children 结构完全一致');

  // 校验 4：refs 数组字段一致（抽样 cbmFiles/devFiles/famFiles/modFiles）
  let refsMismatch = 0;
  const refFields = ['cbmFiles', 'devFiles', 'famFiles', 'phmFiles', 'modFiles', 'stlFiles', 'wireFiles', 'ifcFiles'] as const;
  for (const [path, node1] of graph.nodesByPath) {
    const node2 = graph2.nodesByPath.get(path);
    if (!node2) { refsMismatch++; continue; }
    for (const f of refFields) {
      const a1 = node1.refs[f].slice().sort().join('|');
      const a2 = node2.refs[f].slice().sort().join('|');
      if (a1 !== a2) {
        refsMismatch++;
        if (refsMismatch <= 3) {
          console.error(`❌ refs.${f} 不一致 ${path}：原[${a1}] 恢复[${a2}]`);
        }
      }
    }
  }
  if (refsMismatch > 0) {
    console.error(`❌ refs 不一致节点数：${refsMismatch}`);
    process.exit(1);
  }
  console.log('✓ refs 数组字段完全一致');

  // 校验 5：rawRefs 一致
  let rawRefsMismatch = 0;
  for (const [path, node1] of graph.nodesByPath) {
    const node2 = graph2.nodesByPath.get(path);
    if (!node2) { rawRefsMismatch++; continue; }
    const k1 = Object.keys(node1.refs.rawRefs).sort().join(',');
    const k2 = Object.keys(node2.refs.rawRefs).sort().join(',');
    if (k1 !== k2) {
      rawRefsMismatch++;
      if (rawRefsMismatch <= 3) console.error(`❌ rawRefs 键不一致 ${path}：原[${k1}] 恢复[${k2}]`);
      continue;
    }
    for (const key of Object.keys(node1.refs.rawRefs)) {
      const v1 = node1.refs.rawRefs[key].slice().sort().join('|');
      const v2 = node2.refs.rawRefs[key].slice().sort().join('|');
      if (v1 !== v2) {
        rawRefsMismatch++;
        if (rawRefsMismatch <= 3) console.error(`❌ rawRefs[${key}] 值不一致 ${path}`);
      }
    }
  }
  if (rawRefsMismatch > 0) {
    console.error(`❌ rawRefs 不一致节点数：${rawRefsMismatch}`);
    process.exit(1);
  }
  console.log('✓ rawRefs 完全一致');

  // 校验 6：rawProps 一致（抽样第一个节点）
  const samplePath = graph.root!.path;
  const sample1 = graph.nodesByPath.get(samplePath)!;
  const sample2 = graph2.nodesByPath.get(samplePath)!;
  const props1 = Object.keys(sample1.rawProps).sort();
  const props2 = Object.keys(sample2.rawProps).sort();
  if (props1.join(',') !== props2.join(',')) {
    console.error(`❌ rawProps 键不一致 ${samplePath}`);
    process.exit(1);
  }
  console.log(`✓ rawProps 一致（${props1.length} 键，抽样 ${samplePath}）`);

  // 校验 7：stats 实体计数一致
  const entityKeys = ['total', 'F1System', 'F2System', 'F3System', 'F4System', 'Tower_Device', 'Wire_Device', 'WIRE', 'CROSS'];
  let statsMismatch = 0;
  for (const k of entityKeys) {
    if (graph.stats[k] !== graph2.stats[k]) {
      statsMismatch++;
      console.error(`❌ stats.${k} 不一致：原 ${graph.stats[k]} 恢复 ${graph2.stats[k]}`);
    }
  }
  // 文件统计（CBM/DEV/FAM/PHM/MOD/STL/IFC）应从 line_file_stat 恢复
  const fileKeys = ['CBM', 'DEV', 'FAM', 'PHM', 'MOD', 'STL', 'IFC'];
  for (const k of fileKeys) {
    if (graph.stats[k] !== graph2.stats[k]) {
      statsMismatch++;
      console.error(`❌ stats.${k} 不一致：原 ${graph.stats[k]} 恢复 ${graph2.stats[k]}`);
    }
  }
  if (statsMismatch > 0) {
    console.error(`❌ stats 不一致项数：${statsMismatch}`);
    process.exit(1);
  }
  console.log('✓ stats 完全一致（实体计数 + 文件统计）');

  // 校验 8：state 已正确写入
  if (restoreState.currentGimGraph !== graph2) {
    console.error('❌ state.currentGimGraph 未正确写入');
    process.exit(1);
  }
  if (restoreState.currentProjectType !== 'transmission_line') {
    console.error('❌ state.currentProjectType 不正确');
    process.exit(1);
  }
  if (restoreState.currentFiles !== null) {
    console.error('❌ state.currentFiles 应为 null（缓存命中）');
    process.exit(1);
  }
  console.log('✓ AppState 已正确写入（currentGimGraph/currentProjectType/currentFiles=null）');

  console.log('\n=== Line-2 持久化/恢复往返测试通过 ===');

  // ============================================================
  // 变电工程回归测试：demo-substation 必须识别为 substation（不能是 hybrid）
  // ============================================================
  console.log('\n=== 变电工程回归测试 ===');
  const subFiles = loadDemoFiles('demo-substation');
  console.log('demo-substation 总文件数:', subFiles.size);

  const subExtCount = new Map<string, number>();
  for (const path of subFiles.keys()) {
    const ext = extname(path).toLowerCase();
    subExtCount.set(ext, (subExtCount.get(ext) || 0) + 1);
  }
  console.log('demo-substation 扩展名统计:', Object.fromEntries(subExtCount));

  const subResult = await detectGimProjectType(subFiles);
  console.log('demo-substation 识别结果:', {
    type: subResult.type,
    hasIfc: subResult.details.hasIfc,
    hasLineArtifacts: subResult.details.hasLineArtifacts,
    ifcCount: subResult.details.ifcCount,
    modCount: subResult.details.modCount,
    stlCount: subResult.details.stlCount,
    lineSignals: subResult.details.lineSignals,
  });

  if (subResult.type !== 'substation') {
    console.error(`❌ 变电工程识别失败：期望 substation，实际 ${subResult.type}`);
    if (subResult.type === 'hybrid') {
      console.error('   原因：hasLineArtifacts=true，.mod/.stl 被误判为线路特征');
    }
    process.exit(1);
  }
  console.log('✓ 变电工程识别正确：substation（IFC 流程不受影响）');
  console.log('\n=== 变电工程回归测试通过 ===');
}

main().catch((err) => {
  console.error('验证脚本异常:', err);
  process.exit(1);
});
