/** Pure line inspector projection: no DOM, AppState or platform IO. */
import type { GimGraphNode } from '../gim/gimGraphTypes.js';
import { escHtml } from '../shared/html.js';
import { getFileNameLower, normalizeGimPath } from '../gim/linePathNormalize.js';
import { fileReferenceValue, getPropertyDefinition, getPropertyReferenceKind, renderPropertySection, renderTechnicalSection,
  type FileReferenceValue, type PropertyComponent, type PropertyDefinition, type PropertyRow } from './propertyPresentation.js';
import type { LineModRuntimeEntry } from './lineModRuntimeService.js';
import type { BoltModFile, HNumModFile, KeyValueModFile, PointLineModFile, RRecord, LineTextModGeometrySource, TowerDeviceModFile, UnknownKvModFile, WireModFile } from '../gim/geometry/ir.js';
import type { LineAttributeIndex } from '../gim/lineAttributeTypes.js';
import type { LineFamPropertyRecord, LineDevPropertyRecord } from '../gim/lineAttributeRecords.js';

export function nodeDisplayName(node: GimGraphNode): string {
  const fn = node.path.split('/').pop() || node.path;
  return node.classifyName || node.entityName || fn.replace(/\.(cbm|dev|fam)$/i, '');
}

/** 渲染文件设备面板摘要（线路工程无 FileDevRelation，改为文件统计摘要） */
export function pathMatchesReference(candidate: string, reference: string): boolean {
  const a = normalizeGimPath(candidate).toLowerCase();
  const b = normalizeGimPath(reference).toLowerCase();
  if (!a || !b) return false;
  return a === b || getFileNameLower(a) === getFileNameLower(b);
}

function lineComponentForNode(node: GimGraphNode): PropertyComponent {
  switch (node.entityName.toUpperCase()) {
    case 'WIRE': return 'line-wire';
    case 'CROSS': return 'line-point-line';
    case 'TOWER_DEVICE': return 'line-tower-device';
    case 'WIRE_DEVICE': return 'line-wire-params';
    default: return 'line-node';
  }
}

/** 判断线路业务树中的杆塔节点（F4System/TOWER 及其设备别名）。 */
function isLineTowerNode(node: GimGraphNode): boolean {
  const entity = node.entityName.trim().toUpperCase();
  const classify = node.classifyName.trim().toUpperCase();
  const groupType = (node.rawProps['GROUPTYPE'] || '').trim().toUpperCase();
  return groupType === 'TOWER'
    || classify === 'TOWER'
    || entity === 'TOWER'
    || entity === 'TOWER_DEVICE';
}

/** 键值对 → 字典渲染的属性分节；来源值可由 fileReferenceValue 提供按钮。 */
function sectionHtml(
  title: string,
  pairs: Array<[string, string | FileReferenceValue]>,
  monoValue = false,
  component: PropertyComponent = 'line-node',
): string {
  const rows: PropertyRow[] = pairs
    .filter(([, value]) => typeof value === 'string' ? Boolean(value) : Boolean(value?.text))
    .map(([key, value]) => typeof value === 'string'
      ? { key, value, mono: monoValue }
      : { key, value: value.text, valueHtml: value.html, valueText: value.text, mono: monoValue });
  // 关系/来源字段本身可能不是工程字典键（如“DEV 1”“来源文件”），
  // 不能按未知键的 P2 默认级别过滤，否则可读来源按钮会整段消失。
  return renderPropertySection(title, component, rows);
}

function rawRows(
  component: PropertyComponent,
  raw: Record<string, string>,
  excluded: Set<string> = new Set(),
  options: { excludeReferences?: boolean } = {},
): { primary: PropertyRow[]; technical: PropertyRow[] } {
  const rows = Object.entries(raw)
    .filter(([key, value]) => Boolean(value)
      && !excluded.has(key)
      && !(options.excludeReferences && Boolean(getPropertyReferenceKind(component, key, value))))
    .map(([key, value]) => ({
      key,
      value,
      mono: key.includes('MATRIX') || key.includes('BLHA'),
    }));
  return {
    primary: rows.filter((row) => (getPropertyDefinition(component, row.key)?.priority ?? 2) < 2),
    technical: rows.filter((row) => (getPropertyDefinition(component, row.key)?.priority ?? 2) >= 2),
  };
}

export function renderLineRawProperties(node: GimGraphNode, component = lineComponentForNode(node)): string {
  const excluded = new Set(['ENTITYNAME', 'GROUPTYPE', 'WIRETYPE', 'DEVICETYPE', 'SYSCLASSIFYNAME', 'PARTNAME']);
  const { primary, technical } = rawRows(component, node.rawProps, excluded, { excludeReferences: true });
  return renderPropertySection('工程字段', component, primary, { includeTechnical: false, allowReferences: false })
    + renderTechnicalSection('技术字段', component, technical, { allowReferences: false });
}

function sourceRecordsForRef<T extends { source_path: string; normalized_path: string; file_name_lower: string }>(
  refs: string[],
  bySource: Map<string, Map<string, T[]>>,
  byFile: Map<string, Map<string, T[]>>,
): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  const add = (records: T[] | undefined): void => {
    for (const rec of records ?? []) {
      const key = `${rec.source_path}|${rec.normalized_path}|${rec.file_name_lower}|${(rec as unknown as { sort_order?: number }).sort_order ?? ''}|${(rec as unknown as { prop_key?: string }).prop_key ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(rec);
    }
  };
  // Enumerate every property bucket for a matched source so no FAM/DEV key is lost.
  const enumerate = (map: Map<string, Map<string, T[]>>, key: string): void => {
    const bucket = map.get(key);
    if (!bucket) return;
    for (const records of bucket.values()) add(records);
  };
  for (const ref of refs) {
    enumerate(bySource, normalizeGimPath(ref));
    enumerate(byFile, getFileNameLower(ref));
  }
  return result.sort((a, b) => a.source_path.localeCompare(b.source_path));
}

function definitionWithDisplayLabel(
  component: PropertyComponent,
  key: string,
  label?: string | null,
): PropertyDefinition {
  const base = getPropertyDefinition(component, key);
  if (base && !label) return base;
  return {
    key,
    label: label || base?.label || key,
    description: base?.description || '来源文件属性；具体工程含义待规范确认',
    group: base?.group || '属性',
    priority: base?.priority ?? (label ? 1 : 2),
    dataType: base?.dataType || 'text',
    unit: base?.unit,
  };
}

interface LineAttributeScope {
  label: string;
  famRefs: string[];
  devRefs: string[];
}

/** 从 F4System 的业务键找到对应子节点；不把文件名泄漏到 UI。 */
function childForReference(node: GimGraphNode, reference: string): GimGraphNode | undefined {
  return node.children.find((child) => pathMatchesReference(child.path, reference));
}

function indexedRawReferences(node: GimGraphNode, pattern: RegExp): Array<{ index: number; value: string }> {
  return Object.entries(node.rawProps)
    .map(([key, value]) => {
      const match = key.match(pattern);
      return match && value ? { index: Number(match[1]), value } : null;
    })
    .filter((item): item is { index: number; value: string } => Boolean(item))
    .sort((a, b) => a.index - b.index);
}

/**
 * 属性参数按“关联对象”分组：塔位 F4 下只展开塔身、基础和导线串的
 * FAM/DEV；不会把同一 F4 下数十个来源文件各自生成一整块“查看引用”。
 */
function lineAttributeScopes(node: GimGraphNode): LineAttributeScope[] {
  const scopes: LineAttributeScope[] = [{
    label: '当前对象',
    famRefs: node.refs.famFiles,
    devRefs: node.refs.devFiles,
  }];
  const entity = node.entityName.trim().toUpperCase();
  const groupType = (node.rawProps['GROUPTYPE'] || '').trim().toUpperCase();
  if (entity !== 'F4SYSTEM' || groupType !== 'TOWER') return scopes;

  const addScope = (label: string, child: GimGraphNode | undefined): void => {
    if (!child) return;
    scopes.push({
      label,
      famRefs: child.refs.famFiles,
      devRefs: child.refs.devFiles,
    });
  };
  for (const { index, value } of indexedRawReferences(node, /^TOWER(\d+)$/i)) {
    addScope(`杆塔实例 ${index + 1}`, childForReference(node, value));
  }
  for (const { index, value } of indexedRawReferences(node, /^BASE(\d+)$/i)) {
    addScope(`基础 ${index + 1}`, childForReference(node, value));
  }
  for (const { index, value } of indexedRawReferences(node, /^STRING(\d+)\.STRING$/i)) {
    addScope(`导线串 ${index + 1}`, childForReference(node, value));
  }
  return scopes;
}

function renderAttributeBucket(
  title: string,
  component: PropertyComponent,
  records: Array<LineFamPropertyRecord | LineDevPropertyRecord>,
): string {
  const seen = new Set<string>();
  const primaryByGroup = new Map<string, PropertyRow[]>();
  const technicalByGroup = new Map<string, PropertyRow[]>();
  for (const record of records) {
    if (record.prop_value === null || record.prop_value === '') continue;
    // 属性值偶尔也会携带 BASEFAMILY/SOLIDMODEL 等引用键；引用统一放到来源页。
    if (getPropertyReferenceKind(component, record.prop_key, record.prop_value)) continue;
    const dedupeKey = `${record.source_path}|${record.prop_key}|${record.prop_value}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const definition = definitionWithDisplayLabel(
      component,
      record.prop_key,
      'display_key' in record ? record.display_key : undefined,
    );
    const row: PropertyRow = {
      key: record.prop_key,
      value: record.prop_value,
      definition,
    };
    const target = definition.priority >= 2 ? technicalByGroup : primaryByGroup;
    const group = definition.group || '属性';
    const list = target.get(group);
    if (list) list.push(row);
    else target.set(group, [row]);
  }

  let html = '';
  for (const [group, rows] of primaryByGroup) {
    html += renderPropertySection(`${title} · ${group}`, component, rows, {
      includeTechnical: false,
      allowReferences: false,
    });
  }
  for (const [group, rows] of technicalByGroup) {
    html += renderTechnicalSection(`${title} · ${group}`, component, rows, { allowReferences: false });
  }
  return html;
}

export function renderLineAttributeRecords(
  node: GimGraphNode,
  attrs: LineAttributeIndex | undefined,
): string {
  if (!attrs) return '';
  let html = '';
  for (const scope of lineAttributeScopes(node)) {
    const fam = sourceRecordsForRef<LineFamPropertyRecord>(scope.famRefs, attrs.famBySourcePath, attrs.famByFileNameLower);
    const dev = sourceRecordsForRef<LineDevPropertyRecord>(scope.devRefs, attrs.devBySourcePath, attrs.devByFileNameLower);
    html += renderAttributeBucket(`${scope.label} · 属性族`, 'line-node', fam);
    html += renderAttributeBucket(`${scope.label} · 设备`, 'line-node', dev);
  }
  return html;
}

export function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/**
 * 为 SVG 点标记做按高度分层的自适应抽样。
 *
 * 杆塔 MOD 的 P 记录通常是按构件输出的，文件前缀并不等于塔脚到塔顶。
 * 因此不能再使用 points.slice(0, N)。先按 Z 高度分桶，再在每个桶内均匀
 * 取样，并显式保留最低/中部/最高点，保证预览覆盖完整高度层级。
 */
function sampleTowerPointsByHeight(points: HNumModFile['bodySections'][number]['points'], maxMarkers: number): typeof points {
  const valid = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
  if (valid.length <= maxMarkers) return valid;

  const sorted = valid.slice().sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y || a.id - b.id);
  const target = Math.max(3, Math.min(maxMarkers, sorted.length));
  const minZ = sorted[0].z;
  const maxZ = sorted[sorted.length - 1].z;
  const range = Math.max(maxZ - minZ, 1);
  const bucketCount = Math.max(3, Math.min(target, Math.ceil(Math.sqrt(sorted.length))));
  const buckets: typeof sorted[] = Array.from({ length: bucketCount }, () => []);
  for (const point of sorted) {
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor(((point.z - minZ) / range) * bucketCount)));
    buckets[index].push(point);
  }

  const result: typeof points = [];
  const seen = new Set<string>();
  const add = (point: (typeof sorted)[number]): void => {
    // ID 在异常导出器中可能跨 Body 重复，坐标也参与 key，避免错误去重。
    const key = `${point.id}|${point.x}|${point.y}|${point.z}`;
    if (seen.has(key) || result.length >= target) return;
    seen.add(key);
    result.push(point);
  };

  // 三个锚点是硬约束：塔脚、塔身中部、塔顶必须有可见点标记。
  add(sorted[0]);
  add(sorted[Math.floor((sorted.length - 1) / 2)]);
  add(sorted[sorted.length - 1]);

  // 每个高度桶至少取一个；余量在桶内均匀分配，避免只看到某一段。
  const perBucket = Math.max(1, Math.floor((target - result.length) / bucketCount));
  for (const bucket of buckets) {
    if (bucket.length === 0) continue;
    const count = Math.min(bucket.length, perBucket);
    for (let i = 0; i < count; i += 1) {
      add(bucket[Math.round((i * (bucket.length - 1)) / Math.max(count - 1, 1))]);
    }
  }

  // 由于桶内点数可能很少，继续用全高度等距索引填满剩余额度。
  for (let i = 0; result.length < target && i < target * 2; i += 1) {
    add(sorted[Math.round((i * (sorted.length - 1)) / Math.max(target * 2 - 1, 1))]);
  }
  return result;
}

function renderHNumPreview(source: HNumModFile): string {
  const points = source.bodySections.flatMap((body) => body.points);
  if (points.length === 0) return '<div class="props-note">MOD 未提供 P 节点，无法生成骨架预览。</div>';
  const width = 280;
  // 使用正方形视口，并对 X/Z 使用同一缩放因子；此前分别拉伸 X、Z
  // 造成塔身比例失真，尤其是窄高塔型难以阅读。
  const height = 280;
  const pad = 14;
  const xs = points.map((point) => point.x);
  const zs = points.map((point) => point.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const sx = Math.max(maxX - minX, 1);
  const sz = Math.max(maxZ - minZ, 1);
  const scale = Math.min((width - pad * 2) / sx, (height - pad * 2) / sz);
  const offsetX = (width - sx * scale) / 2;
  const offsetY = (height - sz * scale) / 2;
  const pointMap = new Map<number, [number, number]>();
  // pointMap 必须建立在全量 P 上；否则后半段 R 的端点无法连接，表现为塔身
  // 被“截断”。点标记本身采用按高度抽样，杆件则使用一个 SVG path 全量绘制。
  for (const point of points) {
    const x = offsetX + (point.x - minX) * scale;
    const y = height - offsetY - (point.z - minZ) * scale;
    pointMap.set(point.id, [x, y]);
  }
  const sampledPoints = sampleTowerPointsByHeight(points, 1800);
  const pointPath = sampledPoints.map((point) => {
    const projected = pointMap.get(point.id);
    if (!projected) return '';
    const [x, y] = projected;
    // 小十字比 1800 个 circle 节点更轻量，同时在缩放后仍可辨认。
    return `M${formatNumber(x - 0.7, 1)} ${formatNumber(y, 1)}h1.4M${formatNumber(x, 1)} ${formatNumber(y - 0.7, 1)}v1.4`;
  }).join('');
  const rodPathParts: string[] = [];
  let drawnRodCount = 0;
  let skippedRodCount = 0;
  let unknownRodCount = 0;
  let unknownDrawnRodCount = 0;
  for (const rod of source.bodySections.flatMap((body) => body.rods) as RRecord[]) {
    if (rod.kind === 'unknown') unknownRodCount += 1;
    const id1 = 'id1' in rod ? rod.id1 : undefined;
    const id2 = 'id2' in rod ? rod.id2 : undefined;
    if (id1 == null || id2 == null) {
      skippedRodCount += 1;
      continue;
    }
    const a = pointMap.get(id1);
    const b = pointMap.get(id2);
    if (!a || !b) {
      skippedRodCount += 1;
      continue;
    }
    rodPathParts.push(`M${formatNumber(a[0], 1)} ${formatNumber(a[1], 1)}L${formatNumber(b[0], 1)} ${formatNumber(b[1], 1)}`);
    drawnRodCount += 1;
    if (rod.kind === 'unknown') unknownDrawnRodCount += 1;
  }
  const rodPath = rodPathParts.join('');
  const skippedNote = skippedRodCount > 0 ? `，${skippedRodCount} 根杆件因端点/变体异常未绘制` : '';
  const unknownNote = unknownRodCount > 0 ? `，未知变体 ${unknownDrawnRodCount}/${unknownRodCount} 已按端点绘制` : '';
  return `<div class="line-mod-preview" aria-label="杆塔形状（局部骨架预览）"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img"><g class="line-mod-rods"><path d="${rodPath}" vector-effect="non-scaling-stroke" /></g><g class="line-mod-points"><path d="${pointPath}" vector-effect="non-scaling-stroke" /></g></svg><span>局部骨架预览 · X/Z 投影（等比例，单位：mm） · P ${points.length}（点标记 ${sampledPoints.length}） · R ${drawnRodCount}${unknownNote}${skippedNote}</span></div>`;
}

interface LineModRenderOptions {
  /** 参数页不显示来源按钮；来源页统一渲染所有文件入口。 */
  includeSourceLink?: boolean;
}

function appendLineModSource(html: string, entry: LineModRuntimeEntry, options: LineModRenderOptions): string {
  return options.includeSourceLink === false
    ? html
    : html + sectionHtml('来源', [['MOD 文件', fileReferenceValue('mod', entry.path, '查看 MOD')]]);
}

export function renderLineModSource(entry: LineModRuntimeEntry, options: LineModRenderOptions = {}): string {
  if (!entry.source) {
    return appendLineModSource(
      `<div class="props-section"><div class="props-section-title">线路 MOD</div><div class="props-note warning">${escHtml(entry.error || 'MOD 解析失败')}</div></div>`,
      entry,
      options,
    );
  }
  const source: LineTextModGeometrySource = entry.source;
  const records = source.records;
  if ('hNum' in records) {
    const hnum = records as HNumModFile;
    const rows: PropertyRow[] = [
      { key: 'hNum', value: hnum.hNum },
      { key: 'hRecords', value: hnum.hRecords.length },
      { key: 'bodySections', value: hnum.bodySections.length },
      { key: 'points', value: hnum.bodySections.reduce((sum, body) => sum + body.points.length, 0) },
      { key: 'rods', value: hnum.bodySections.reduce((sum, body) => sum + body.rods.length, 0) },
      { key: 'groundPoints', value: hnum.bodySections.reduce((sum, body) => sum + body.groundPoints.length, 0) },
      { key: 'hSubLegs', value: hnum.hSubLegs.length },
      { key: 'hLegs', value: hnum.hLegs.length },
    ];
    return appendLineModSource(renderPropertySection('杆塔骨架', 'line-hnum', rows, { allowReferences: false }), entry, options);
  }
  if ('boltNum' in records) {
    const bolt = records as BoltModFile;
    let html = renderPropertySection(
      '连接件摘要',
      'line-bolt',
      [{ key: 'boltNum', value: bolt.boltNum }, { key: 'count', value: bolt.bolts.length }],
      { allowReferences: false },
    );
    const visibleBolts = bolt.bolts.slice(0, 64);
    if (visibleBolts.length > 0) {
      const rows = visibleBolts.map((item) => `<tr><td class="prop-key">${item.index}</td><td>${escHtml(item.spec || '—')}</td><td>${escHtml(formatNumber(item.length))} mm</td><td>${escHtml(item.restFields[0] || '—')}</td><td>${escHtml(String(item.position.code))}</td><td>${escHtml(formatNumber(item.position.x))} mm</td><td>${escHtml(formatNumber(item.position.y))} mm</td><td>${escHtml(formatNumber(item.position.z))} mm</td></tr>`).join('');
      html += `<div class="props-section"><div class="props-section-title">螺栓明细（表格）</div><table class="props-table props-bolt-table"><thead><tr><th>序号</th><th>规格</th><th>长度</th><th>材质/等级</th><th>方位码</th><th>X</th><th>Y</th><th>Z</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }
    const extraRows: PropertyRow[] = visibleBolts.flatMap((item) => item.restFields.slice(1).map((value, index) => ({
      key: `螺栓 ${item.index} · 字段 ${index + 2}`,
      value,
    })));
    if (extraRows.length > 0) html += renderTechnicalSection('螺栓 · 未确认字段', 'line-bolt', extraRows, { allowReferences: false });
    if (bolt.bolts.length > 64) html += '<div class="props-note">螺栓记录较多，仅显示前 64 条；完整来源仍可通过“查看 MOD”打开。</div>';
    return appendLineModSource(html, entry, options);
  }
  if ('pointNum' in records) {
    const pointLine = records as PointLineModFile;
    let html = renderPropertySection('跨越物点线摘要', 'line-point-line', [
      { key: 'code', value: pointLine.code },
      { key: 'pointNum', value: pointLine.pointNum },
      { key: 'lineNum', value: pointLine.lineNum },
    ]);
    const pointSections = pointLine.points.slice(0, 64).map((point) => renderPropertySection(
      `跨越点 ${point.id}`,
      'line-point-line',
      [
        { key: 'id', value: point.id },
        {
          key: 'BLHA',
          value: [formatNumber(point.lat, 8), formatNumber(point.lon, 8), formatNumber(point.alt, 3), '—'].join(','),
          definition: {
            key: 'BLHA', label: '坐标', description: '跨越点纬度、经度、高程', group: '跨越点',
            priority: 0, dataType: 'coordinate',
          },
        },
        { key: 'type', value: point.type },
      ],
    )).join('');
    if (pointSections) html += `<div class="props-note">跨越点（前 ${Math.min(pointLine.points.length, 64)} 个）</div>${pointSections}`;
    const lineRows = pointLine.lines.slice(0, 64).map((line, index) => `<tr><td class="prop-key">LINE${index + 1}</td><td class="prop-val">${line.fromId} → ${line.toId}</td></tr>`).join('');
    if (lineRows) html += `<div class="props-section"><div class="props-section-title">跨越边（前 ${Math.min(pointLine.lines.length, 64)} 条）</div><table class="props-table">${lineRows}</table></div>`;
    return appendLineModSource(html, entry, options);
  }
  const kv = records as KeyValueModFile;
  if ('signature' in kv && kv.signature === 'unknown') {
    const unknown = kv as UnknownKvModFile;
    const rows = Object.entries(unknown.raw).map(([key, value]) => ({ key, value }));
    return appendLineModSource(
      renderTechnicalSection('未识别 MOD 字段', 'line-node', rows, { allowReferences: false })
        + '<div class="props-note warning">此 MOD 的键集合尚未纳入属性字典，已保留原值，未推断工程含义。</div>',
      entry,
      options,
    );
  }
  if ('TYPE' in kv) {
    const wire = kv as WireModFile;
    const rows: PropertyRow[] = Object.entries(wire)
      .filter(([key]) => key !== 'signature')
      .map(([key, value]) => ({ key, value: value as string }));
    return appendLineModSource(
      renderPropertySection('导线参数', 'line-wire-params', rows, { includeTechnical: false, allowReferences: false })
        + renderTechnicalSection('导线技术字段', 'line-wire-params', rows, { allowReferences: false }),
      entry,
      options,
    );
  }
  if ('type' in kv) {
    const tower = kv as TowerDeviceModFile;
    const rows: PropertyRow[] = Object.entries(tower)
      .filter(([key]) => key !== 'signature')
      .map(([key, value]) => ({ key, value: value as string }));
    return appendLineModSource(
      renderPropertySection('塔基参数', 'line-tower-device', rows, { includeTechnical: false, allowReferences: false })
        + renderTechnicalSection('塔基技术字段', 'line-tower-device', rows, { allowReferences: false }),
      entry,
      options,
    );
  }
  return appendLineModSource('', entry, options);
}

export function renderLineModSources(entries: LineModRuntimeEntry[], options: LineModRenderOptions = {}): string {
  if (entries.length === 0) return '<div class="props-note">当前节点没有可解析的线路 MOD 引用。</div>';
  return entries.slice(0, 32).map((entry) => renderLineModSource(entry, options)).join('')
    + (entries.length > 32 ? '<div class="props-note">MOD 来源较多，仅展示前 32 个；请通过来源按钮逐个打开原文件。</div>' : '');
}

/**
 * 将杆塔 HNum 来源渲染到“来源”页签。
 *
 * 杆塔形状是来源文件中的可视证据，不应和业务参数混在一起；这里只
 * 显示轻量 X/Z 投影，并保留可读的 MOD 来源按钮。首次点击塔位时来源
 * 尚在异步读取，先显示等待提示，读取完成后由检查器增量刷新。
 */
export function renderLineTowerShapeSource(
  node: GimGraphNode,
  entries: LineModRuntimeEntry[],
  options: LineModRenderOptions = {},
): string {
  if (!isLineTowerNode(node)) return '';
  const hnumEntries = entries.filter((entry) => entry.source && 'hNum' in entry.source.records);
  if (hnumEntries.length === 0) {
    const note = entries.length === 0
      ? '正在读取塔型来源…'
      : '当前塔位未找到可预览的 HNum 杆塔形状。';
    return `<div class="props-section"><div class="props-section-title">杆塔形状</div><div class="props-note">${note}</div></div>`;
  }

  let html = '';
  for (const [index, entry] of hnumEntries.slice(0, 3).entries()) {
    const source = entry.source!;
    if (!('hNum' in source.records)) continue;
    const title = index === 0 ? '杆塔形状（局部骨架预览）' : `杆塔形状 ${index + 1}（局部骨架预览）`;
    html += `<div class="props-section"><div class="props-section-title">${title}</div>`
      + renderHNumPreview(source.records as HNumModFile)
      + (options.includeSourceLink === false
        ? ''
        : sectionHtml('形状来源', [['HNum MOD', fileReferenceValue('mod', entry.path, '查看塔型 MOD')]]))
      + '</div>';
  }
  if (hnumEntries.length > 3) {
    html += `<div class="props-note">检测到 ${hnumEntries.length} 个塔型来源，仅预览前 3 个。</div>`;
  }
  return html;
}

// GL is a substation-only source kind. Keep the line source contract narrow so
// adding the shared property-dictionary kind does not alter line behavior.
type LineSourceKind = Exclude<Parameters<typeof fileReferenceValue>[0], 'gl'>;

interface LineSourceEntry {
  kind: LineSourceKind;
  path: string;
  context: string;
}

const LINE_SOURCE_KINDS: Array<{ kind: LineSourceKind; label: string }> = [
  { kind: 'cbm', label: 'CBM' },
  { kind: 'dev', label: 'DEV' },
  { kind: 'fam', label: 'FAM' },
  { kind: 'phm', label: 'PHM' },
  { kind: 'mod', label: 'MOD' },
  { kind: 'stl', label: 'STL' },
  { kind: 'file', label: 'WIRE' },
  { kind: 'ifc', label: 'IFC' },
];

/** 来源页按类型折叠，并限制每类首批预览，避免工程节点生成超长 DOM。 */
const SOURCE_PREVIEW_LIMIT_PER_KIND = 120;

function lineSourceContext(node: GimGraphNode, fallback = '当前对象'): string {
  const entity = node.entityName.trim().toUpperCase();
  const groupType = (node.rawProps['GROUPTYPE'] || '').trim().toUpperCase();
  if (entity === 'F4SYSTEM' && groupType === 'TOWER') return '杆塔';
  if (entity === 'F4SYSTEM' && groupType === 'WIRE') return '导线';
  if (entity === 'WIRE') return '导线';
  if (entity === 'CROSS') return '跨越物';
  const name = node.classifyName.trim() || node.name.trim();
  return name && !/^(?:F[1-4]SYSTEM|TOWER_DEVICE|WIRE_DEVICE)$/i.test(name) ? name : fallback;
}

function childSourceContext(parent: GimGraphNode, child: GimGraphNode, inherited: string): string {
  const tower = indexedRawReferences(parent, /^TOWER(\d+)$/i).find(({ value }) => pathMatchesReference(child.path, value));
  if (tower) return `杆塔实例 ${tower.index + 1}`;
  const base = indexedRawReferences(parent, /^BASE(\d+)$/i).find(({ value }) => pathMatchesReference(child.path, value));
  if (base) return `基础 ${base.index + 1}`;
  const string = indexedRawReferences(parent, /^STRING(\d+)\.STRING$/i).find(({ value }) => pathMatchesReference(child.path, value));
  if (string) return `导线串 ${string.index + 1}`;
  return inherited;
}

/** 收集当前业务节点及其子树的全部来源，供“来源”页签集中展示。 */
function collectLineSourceEntries(node: GimGraphNode, modEntries: LineModRuntimeEntry[] = []): LineSourceEntry[] {
  const entries: LineSourceEntry[] = [];
  const seen = new Set<string>();
  const add = (kind: LineSourceKind, path: string, context: string): void => {
    if (!path) return;
    const normalized = normalizeGimPath(path);
    const key = `${kind}|${normalized.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, path: normalized || path, context });
  };
  const walk = (current: GimGraphNode, inheritedContext: string): void => {
    const context = lineSourceContext(current, inheritedContext);
    add('cbm', current.path, context);
    for (const path of current.refs.cbmFiles) {
      const child = current.children.find((candidate) => pathMatchesReference(candidate.path, path));
      add('cbm', path, child ? childSourceContext(current, child, context) : context);
    }
    for (const path of current.refs.devFiles) add('dev', path, context);
    for (const path of current.refs.famFiles) add('fam', path, context);
    for (const path of current.refs.phmFiles) add('phm', path, context);
    for (const path of current.refs.modFiles) add('mod', path, context);
    for (const path of current.refs.stlFiles) add('stl', path, context);
    for (const path of current.refs.wireFiles) add('file', path, context);
    for (const path of current.refs.ifcFiles) add('ifc', path, context);
    for (const child of current.children) walk(child, childSourceContext(current, child, context));
  };
  walk(node, '当前对象');
  for (const entry of modEntries) add('mod', entry.path, '几何来源');
  return entries.sort((a, b) => {
    const ai = LINE_SOURCE_KINDS.findIndex((item) => item.kind === a.kind);
    const bi = LINE_SOURCE_KINDS.findIndex((item) => item.kind === b.kind);
    return ai - bi || a.context.localeCompare(b.context) || a.path.localeCompare(b.path);
  });
}

/** 文件引用只在来源页签显示，正文使用关联对象名称而非 GUID 文件名。 */
export function renderLineSourceRefs(node: GimGraphNode, modEntries: LineModRuntimeEntry[] = []): string {
  const entries = collectLineSourceEntries(node, modEntries);
  if (entries.length === 0) return '';
  const labels: Record<LineSourceKind, string> = {
    cbm: '定位 CBM',
    dev: '查看 DEV',
    fam: '查看属性族',
    phm: '查看 PHM',
    mod: '查看 MOD',
    stl: '查看 STL',
    file: '查看源文件',
    ifc: '切换 IFC',
    sld: '打开电气图纸',
  };
  const groups = new Map<LineSourceKind, LineSourceEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.kind);
    if (group) group.push(entry);
    else groups.set(entry.kind, [entry]);
  }

  let html = `<div class="props-section"><div class="props-section-title">文件来源</div><div class="props-note">共 ${entries.length} 个来源，按类型折叠显示。</div></div>`;
  for (const { kind, label } of LINE_SOURCE_KINDS) {
    const group = groups.get(kind);
    if (!group || group.length === 0) continue;
    const visible = group.slice(0, SOURCE_PREVIEW_LIMIT_PER_KIND);
    const rows: PropertyRow[] = visible.map((entry, index) => {
      const reference = fileReferenceValue(kind, entry.path, labels[kind]);
      const context = entry.context || '当前对象';
      return {
        key: `source-${kind}-${index}`,
        value: reference.text,
        valueHtml: reference.html,
        valueText: reference.text,
        definition: definitionWithDisplayLabel('line-node', `source-${kind}-${index}`, context),
      };
    });
    html += renderPropertySection(`${label}（${group.length}）`, 'line-node', rows, {
      details: true,
      includeTechnical: true,
    });
    if (group.length > visible.length) {
      html += `<div class="props-note">${escHtml(label)} 其余 ${group.length - visible.length} 个来源未在此处展开，请选择更具体的业务对象继续查看。</div>`;
    }
  }
  return html;
}

export function relationSection(title: string, pairs: Array<[string, string]>): string {
  const rows: PropertyRow[] = pairs
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => ({
      key,
      value,
      definition: definitionWithDisplayLabel('line-node', key, key),
    }));
  return renderPropertySection(title, 'line-node', rows, { includeTechnical: false, allowReferences: false });
}

function relationTargetStatus(node: GimGraphNode, reference: string): string {
  return childForReference(node, reference) ? '已关联' : '未找到对象';
}

function relationCount(node: GimGraphNode, key: string, fallback: number): string {
  const raw = node.rawProps[key];
  return raw && /^\d+$/.test(raw.trim()) ? raw.trim() : String(fallback);
}

/** 按杆塔、基础、导线、导线挂点四个业务组渲染 F4/TOWER 关系。 */
function renderTowerRelationGroups(node: GimGraphNode): string {
  const towerRefs = indexedRawReferences(node, /^TOWER(\d+)$/i);
  const baseRefs = indexedRawReferences(node, /^BASE(\d+)$/i);
  const stringRefs = indexedRawReferences(node, /^STRING(\d+)\.STRING$/i);
  const gpoints = Object.entries(node.rawProps)
    .map(([key, value]) => {
      const match = key.match(/^STRING(\d+)\.GPOINT$/i);
      return match && value ? { index: Number(match[1]), value } : null;
    })
    .filter((item): item is { index: number; value: string } => Boolean(item))
    .sort((a, b) => a.index - b.index);
  let html = '';
  if (towerRefs.length > 0 || node.rawProps['TOWERS.NUM']) {
    html += relationSection('杆塔', [
      ['数量', `${relationCount(node, 'TOWERS.NUM', towerRefs.length)} 个`],
      ...towerRefs.map(({ index, value }) => [`塔身 ${index + 1}`, relationTargetStatus(node, value)] as [string, string]),
    ]);
  }
  if (baseRefs.length > 0 || node.rawProps['BASES.NUM']) {
    html += relationSection('基础', [
      ['数量', `${relationCount(node, 'BASES.NUM', baseRefs.length)} 个`],
      ...baseRefs.map(({ index, value }) => [`基础 ${index + 1}`, relationTargetStatus(node, value)] as [string, string]),
    ]);
  }
  if (stringRefs.length > 0 || node.rawProps['STRINGS.NUM']) {
    html += relationSection('导线', [
      ['导线串数量', `${relationCount(node, 'STRINGS.NUM', stringRefs.length)} 个`],
      ...stringRefs.map(({ index, value }) => [`导线串 ${index + 1}`, relationTargetStatus(node, value)] as [string, string]),
    ]);
  }
  if (gpoints.length > 0) {
    html += relationSection('导线挂点', gpoints.map(({ index, value }) => [`挂点 ${index + 1}`, value] as [string, string]));
  }
  return html;
}

export function renderLineRelationGroups(node: GimGraphNode): string {
  const groupType = (node.rawProps['GROUPTYPE'] || '').trim().toUpperCase();
  if (node.entityName.trim().toUpperCase() === 'F4SYSTEM' && groupType === 'TOWER') {
    const grouped = renderTowerRelationGroups(node);
    if (grouped) return grouped;
  }
  let html = '';
  const subdeviceRefs = indexedRawReferences(node, /^SUBDEVICE(\d+)$/i);
  if (subdeviceRefs.length > 0 || node.rawProps['SUBDEVICES.NUM']) {
    html += relationSection('导线', [
      ['子设备数量', `${relationCount(node, 'SUBDEVICES.NUM', subdeviceRefs.length)} 个`],
      ...subdeviceRefs.map(({ index, value }) => [`导线设备 ${index + 1}`, relationTargetStatus(node, value)] as [string, string]),
    ]);
  }
  const endpointRows: Array<[string, string]> = [];
  for (const [key, label] of [['BACKSTRING', '后侧挂点'], ['FRONTSTRING', '前侧挂点']] as const) {
    if (node.rawProps[key]) endpointRows.push([label, childForReference(node, node.rawProps[key]) ? '已关联' : '已记录']);
  }
  if (endpointRows.length > 0) html += relationSection('导线挂点', endpointRows);
  if (!html && node.children.length > 0) html = relationSection('子对象', [['数量', `${node.children.length} 个`]]);
  return html || '<div class="props-note">暂无可读关系。</div>';
}

export function buildLineNodeBuckets(
  node: GimGraphNode,
  attrs: LineAttributeIndex | undefined,
  modEntries: LineModRuntimeEntry[] = [],
): { overview: string; params: string; relations: string; source: string } {
  const component = lineComponentForNode(node);
  const overviewRows: PropertyRow[] = [
    { key: 'ENTITYNAME', value: node.entityName },
    ...(node.classifyName ? [{ key: 'SYSCLASSIFYNAME', value: node.classifyName, definition: definitionWithDisplayLabel(component, 'SYSCLASSIFYNAME', '分类') }] : []),
    ...(node.name && node.name !== node.entityName ? [{ key: 'PARTNAME', value: node.name, definition: definitionWithDisplayLabel(component, 'PARTNAME', '名称') }] : []),
    { key: 'NUM', value: node.children.length, definition: definitionWithDisplayLabel(component, 'NUM', '子节点数') },
  ];
  const overview = renderPropertySection('基本信息', component, overviewRows, { includeTechnical: false })
    + renderPropertySection('关键业务字段', component, rawRows(component, node.rawProps, new Set(), { excludeReferences: true }).primary, { includeTechnical: false, allowReferences: false });
  const params = renderLineRawProperties(node, component)
    + renderLineAttributeRecords(node, attrs)
    + (modEntries.length > 0 ? renderLineModSources(modEntries, { includeSourceLink: false }) : '<div class="props-note">正在读取可达的 MOD 参数…</div>');
  const relations = renderLineRelationGroups(node);
  const source = renderLineSourceRefs(node, modEntries)
    + renderLineTowerShapeSource(node, modEntries, { includeSourceLink: false });
  return { overview, params, relations, source };
}

