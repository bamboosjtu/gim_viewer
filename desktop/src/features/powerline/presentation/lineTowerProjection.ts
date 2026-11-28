import { resolveTowerTopology } from '@gim/powerline-core/towerTopology.js';
import type { HNumModFile } from '../../../gim/geometry/ir.js';
export function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return value
    .toFixed(digits)
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1');
}

/**
 * 为 SVG 点标记做按高度分层的自适应抽样。
 *
 * 杆塔 MOD 的 P 记录通常是按构件输出的，文件前缀并不等于塔脚到塔顶。
 * 因此不能再使用 points.slice(0, N)。先按 Z 高度分桶，再在每个桶内均匀
 * 取样，并显式保留最低/中部/最高点，保证预览覆盖完整高度层级。
 */
function sampleTowerPointsByHeight(
  points: HNumModFile['bodySections'][number]['points'],
  maxMarkers: number,
): typeof points {
  const valid = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
  if (valid.length <= maxMarkers) return valid;

  const sorted = valid.slice().sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y || a.id - b.id);
  const target = Math.max(3, Math.min(maxMarkers, sorted.length));
  const minZ = sorted[0].z;
  const maxZ = sorted[sorted.length - 1].z;
  const range = Math.max(maxZ - minZ, 1);
  const bucketCount = Math.max(3, Math.min(target, Math.ceil(Math.sqrt(sorted.length))));
  const buckets: (typeof sorted)[] = Array.from({ length: bucketCount }, () => []);
  for (const point of sorted) {
    const index = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor(((point.z - minZ) / range) * bucketCount)),
    );
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

export function renderHNumPreview(source: HNumModFile): string {
  const sections = resolveTowerTopology(source);
  const points = sections
    .flatMap((body) => body.points)
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z));
  if (points.length === 0)
    return '<div class="props-note">MOD 未提供 P 节点，无法生成骨架预览。</div>';
  const width = 280;
  // 使用正方形视口，并对 X/Z 使用同一缩放因子；此前分别拉伸 X、Z
  // 造成塔身比例失真，尤其是窄高塔型难以阅读。
  const height = 280;
  const pad = 14;
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const sx = Math.max(maxX - minX, 1);
  const sz = Math.max(maxZ - minZ, 1);
  const scale = Math.min((width - pad * 2) / sx, (height - pad * 2) / sz);
  const offsetX = (width - sx * scale) / 2;
  const offsetY = (height - sz * scale) / 2;
  const project = (p: { x: number; z: number }) => [
    offsetX + (p.x - minX) * scale,
    height - offsetY - (p.z - minZ) * scale,
  ];
  const sampledPoints = sampleTowerPointsByHeight(points, 1800);
  const pointPath = sampledPoints
    .map((point) => {
      const [x, y] = project(point);
      // 小十字比 1800 个 circle 节点更轻量，同时在缩放后仍可辨认。
      return `M${formatNumber(x - 0.7, 1)} ${formatNumber(y, 1)}h1.4M${formatNumber(x, 1)} ${formatNumber(y - 0.7, 1)}v1.4`;
    })
    .join('');
  const rodPathParts: string[] = [];
  let drawnRodCount = 0;
  let skippedRodCount = 0;
  let unknownRodCount = 0;
  let unknownDrawnRodCount = 0;
  for (const section of sections)
    for (const { record: rod, start, end } of section.rods) {
      if (rod.kind === 'unknown') unknownRodCount++;
      if (!start || !end || ![start.x, start.z, end.x, end.z].every(Number.isFinite)) {
        skippedRodCount++;
        continue;
      }
      const a = project(start),
        b = project(end);
      rodPathParts.push(
        `M${formatNumber(a[0], 1)} ${formatNumber(a[1], 1)}L${formatNumber(b[0], 1)} ${formatNumber(b[1], 1)}`,
      );
      drawnRodCount += 1;
      if (rod.kind === 'unknown') unknownDrawnRodCount += 1;
    }
  const rodPath = rodPathParts.join('');
  const skippedNote = skippedRodCount > 0 ? `，${skippedRodCount} 根杆件因端点/变体异常未绘制` : '';
  const unknownNote =
    unknownRodCount > 0 ? `，未知变体 ${unknownDrawnRodCount}/${unknownRodCount} 已按端点绘制` : '';
  return `<div class="line-mod-preview" aria-label="杆塔形状（局部骨架预览）"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img"><g class="line-mod-rods"><path d="${rodPath}" vector-effect="non-scaling-stroke" /></g><g class="line-mod-points"><path d="${pointPath}" vector-effect="non-scaling-stroke" /></g></svg><span>局部骨架预览 · X/Z 投影（等比例，单位：mm） · P ${points.length}（点标记 ${sampledPoints.length}） · R ${drawnRodCount}${unknownNote}${skippedNote}</span></div>`;
}
