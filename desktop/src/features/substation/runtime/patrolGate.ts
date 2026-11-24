import { Box3, Vector3 } from 'three';

export type GateRank = 'main' | 'gate';
export function stationGateRank(label: string): GateRank | undefined {
  if (
    /楼|厂房|泵房|仓库|车库|建筑大门|门[柱杆框卫]|矩形柱|门禁|柜门|箱门|building entrance|gate\s*(post|frame|house)/i.test(
      label,
    )
  )
    return;
  if (
    /全站大门|整站大门|站区主(?:大门|入口)|站区正门|主大门|\bmain (?:station |site )?gate\b/i.test(
      label,
    )
  )
    return 'main';
  if (
    /站区大门|变电站大门|平开大门|推拉大门|伸缩大?门|(?:^|[\s:：])(?:大门|正门)(?=$|[\s:：（(])|\b(?:station|site) gate\b/i.test(
      label,
    )
  )
    return 'gate';
}

export interface GateBounds {
  rank: GateRank;
  bounds: Box3;
}
export interface GateApproach {
  point: Vector3;
  yaw: number;
}

export function gateApproaches(gates: GateBounds[], site: Box3): GateApproach[] {
  const main = gates.filter((g) => g.rank === 'main');
  const choices = main.length ? main : gates;
  if (!choices.length || site.isEmpty()) return [];
  // Adjacent source leaves can describe one entrance. Disjoint gates of equal
  // priority need a user choice; their combined midpoint could be in a wall.
  const box = choices[0].bounds.clone();
  const rest = choices.slice(1);
  while (rest.length) {
    const nearby = box.clone().expandByScalar(0.8);
    const i = rest.findIndex((g) => nearby.intersectsBox(g.bounds));
    if (i < 0) return [];
    box.union(rest.splice(i, 1)[0].bounds);
  }
  const center = box.getCenter(new Vector3());
  const span = box.getSize(new Vector3());
  if (choices.length > 1 && Math.max(span.x, span.y) > 30) return [];
  const outward = center.clone().sub(site.getCenter(new Vector3())).setZ(0);
  if (span.x > span.y * 2) outward.x = 0;
  else if (span.y > span.x * 2) outward.y = 0;
  if (outward.lengthSq() < 1e-6) return [];
  outward.normalize();
  const tangent = new Vector3(-outward.y, outward.x, 0);
  const lane = Math.min(2, Math.max(span.x, span.y) / 4);
  const yaw = Math.atan2(-outward.x, -outward.y);
  const result: GateApproach[] = [];
  for (const distance of [9, 4, 1.5, -1.5, -4]) {
    for (const shift of [0, lane, -lane]) {
      const point = center
        .clone()
        .addScaledVector(outward, distance)
        .addScaledVector(tangent, shift);
      result.push({ point: point.setZ(box.min.z), yaw });
    }
  }
  return result;
}
