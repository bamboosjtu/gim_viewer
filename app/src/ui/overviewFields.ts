import type { BusinessObject, PowerlineProject } from "@gim/powerline-core";
export function overviewFields(
  o: BusinessObject,
  objects: ReadonlyMap<string, BusinessObject>,
  project: PowerlineProject,
): [string, unknown][] {
  const coordinate = o.coordinate;
  const location: [string, unknown][] = coordinate
    ? [
        ["纬度", coordinate[1].toFixed(7) + "°"],
        ["经度", coordinate[0].toFixed(7) + "°"],
        [
          "高程",
          coordinate[2] != null ? coordinate[2].toFixed(2) + " m" : undefined,
        ],
      ]
    : [];
  let fields: [string, unknown][] = [];
  if (o.kind === "tower")
    fields = [
      ["塔型", o.type],
      ["呼称高", o.height != null ? `${o.height} m` : undefined],
      ...location,
      [
        "方位角",
        Number.isFinite(o.azimuth) ? o.azimuth!.toFixed(2) + "°" : undefined,
      ],
      ["所属线路", o.lineIds.map((id) => objects.get(id)?.name).join(" / ")],
      ["耐张段", o.strainIds.map((id) => objects.get(id)?.name).join(" / ")],
    ];
  else if (o.kind === "span")
    fields = [
      ["起始塔", objects.get(o.startTowerId ?? "")?.name],
      ["终止塔", objects.get(o.endTowerId ?? "")?.name],
      [
        "水平档距",
        o.horizontalMeters != null
          ? o.horizontalMeters.toFixed(2) + " m"
          : undefined,
      ],
      [
        "三维直线距离",
        o.spatialMeters != null ? o.spatialMeters.toFixed(2) + " m" : undefined,
      ],
      ["原始导线记录", o.rawWireIds?.length],
      ...Object.entries(o.wireCounts ?? {}).map(
        ([key, value]): [string, unknown] => [key, value],
      ),
      ["耐张段", o.strainIds.map((id) => objects.get(id)?.name).join(" / ")],
    ];
  else if (o.kind === "cross")
    fields = [
      ["跨越类型", o.crossing?.label ?? "未分类跨越物"],
      ...(o.crossing?.details ?? []).map(
        (a) => [a.label, a.value || "未提供"] as [string, unknown],
      ),
      ...(o.businessCode
        ? [["原始业务码", o.businessCode] as [string, unknown]]
        : []),
      ...location,
      ["几何点数", o.geometry?.length ?? 0],
      ["所属线路", o.lineIds.map((id) => objects.get(id)?.name).join(" / ")],
      ["耐张段", o.strainIds.map((id) => objects.get(id)?.name).join(" / ")],
    ];
  else {
    const members =
      o.kind === "project"
        ? project.objects
        : project.objects.filter(
            (v) => v.lineIds.includes(o.id) || v.strainIds.includes(o.id),
          );
    fields = [
      ["杆塔", members.filter((v) => v.kind === "tower").length + " 基"],
      ["物理档", members.filter((v) => v.kind === "span").length + " 档"],
      ["跨越物", members.filter((v) => v.kind === "cross").length + " 处"],
      [
        "去重档水平长度",
        (
          members
            .filter((v) => v.kind === "span")
            .reduce((s, v) => s + (v.horizontalMeters ?? 0), 0) / 1000
        ).toFixed(3) + " km",
      ],
      [
        "源线路长度",
        o.attributes
          .filter((a) => a.key.toUpperCase() === "LINELENGTH")
          .map((a) => a.value + " km")
          .join(" / ") || "参见各线路属性",
      ],
    ];
  }
  return fields;
}
