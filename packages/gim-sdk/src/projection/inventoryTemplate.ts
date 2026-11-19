import type { EngineeringSnapshot } from "../semantic/types.js";
import {
  categoryLabel,
  MODEL_CATALOG_CATEGORIES,
  catalogLocation,
} from "../semantic/catalog/catalogLabels.js";
const directoryOrder = new Map(
  MODEL_CATALOG_CATEGORIES.map((row) => [
    `${row.kind}:${row.label}`,
    row.order,
  ]),
);
const compareTitles = new Intl.Collator("zh-CN", { numeric: true }).compare;

export const INVENTORY_TEMPLATE_VERSION = "engineering-inventory-v1";
export const INVENTORY_TEMPLATE = Object.freeze({
  version: INVENTORY_TEMPLATE_VERSION,
  groups: Object.freeze(["设备", "材料", "构件", "其他"]),
  levels: Object.freeze(["group", "category", "subtype", "template", "entity"]),
  secondaryCabinets: "category-template-entity",
  members: "inspector",
  pending: "quality-and-export",
});
export interface InventoryNode {
  key: string;
  title: string;
  kind: "project" | "group" | "template" | "entity";
  parent?: string;
  children: string[];
  targetId?: string;
  entityCount: number;
  evidence: string[];
  category?: string;
  sourceCount?: number;
  confirmedCount?: number;
  subtype?: string;
  subtypeLabel?: string;
  template?: string;
  classificationStatus?: string;
  boundaryStatus?: string;
  unknownReason?: string;
  grain?: string;
  attachmentCount?: number;
}
export interface EngineeringInventory {
  version: string;
  rootKey: string;
  nodes: Map<string, InventoryNode>;
  rowsByEntity: Map<string, string[]>;
  /** Source selections reveal their whole; members have no separate inventory row. */
  rowsBySource: Map<string, string>;
}

/** gim_element-style name template: dimensions, voltage and instance numbers
 * never split one catalog type into many rows. The real instance name remains
 * on the selectable entity row. */
export function inventoryNameTemplate(name: string): string {
  const text = name
    .normalize("NFKC")
    .replace(/&(?:nbsp|#(?:x0*a0|0*160));/gi, " ")
    .replace(/\d+(?:\.\d+)?\s*(?:kv|千伏|mm|cm|毫米)/gi, "")
    .replace(/\d+(?:\.\d+)?(?:[x×*]\d+(?:\.\d+)?)+/gi, "")
    .replace(/\d+/g, "")
    .replace(/^[#号第]+/, "")
    .replace(/[_\-—.。、,，:：/\\()（）\s]+/g, "");
  return text || name.trim() || "未命名";
}

/** A catalog view of existing wholes. Grouping never normalizes identities or
 * turns a member into an entity; every real instance keeps its own selectable row. */
export function projectInventoryTemplate(
  snapshot: EngineeringSnapshot,
): EngineeringInventory {
  const order = new Map<string, number>();
  const rootKey = "inventory:root",
    nodes = new Map<string, InventoryNode>(),
    rowsByEntity = new Map<string, string[]>(),
    rowsBySource = new Map<string, string>();
  nodes.set(rootKey, {
    key: rootKey,
    title: "设备材料清册",
    kind: "project",
    children: [],
    entityCount: 0,
    confirmedCount: 0,
    evidence: [],
  });
  const add = (node: InventoryNode) => {
    nodes.set(node.key, node);
    if (node.parent) nodes.get(node.parent)!.children.push(node.key);
  };
  const group = (parent: string, id: string, title: string) => {
    const key = `${parent}/${id}`;
    if (!nodes.has(key))
      add({
        key,
        title,
        parent,
        kind: "group",
        children: [],
        entityCount: 0,
        confirmedCount: 0,
        evidence: [],
      });
    return key;
  };
  for (const title of INVENTORY_TEMPLATE.groups) group(rootKey, title, title);
  const catalogParent = (
    entity: Parameters<typeof catalogLocation>[0],
    functionalSubtype = false,
  ) => {
    const row = catalogLocation(entity);
    let parent = group(rootKey, row.group, row.group);
    parent = group(
      parent,
      `catalog:${encodeURIComponent(row.category)}`,
      row.category,
    );
    order.set(parent, directoryOrder.get(`${row.kind}:${row.category}`) ?? 999);
    if (
      entity.category !== "E17" &&
      row.label !== row.category &&
      !(functionalSubtype && row.label === "类型待确认")
    ) {
      parent = group(parent, `model:${encodeURIComponent(row.id)}`, row.label);
      order.set(parent, row.order);
    }
    return parent;
  };
  for (const entity of snapshot.entities) {
    const subtype =
      entity.category !== "E17" &&
      entity.subtypeStatus === "confirmed" &&
      entity.subtype &&
      entity.subtypeLabel
        ? { id: entity.subtype, label: entity.subtypeLabel }
        : undefined;
    let parent = catalogParent(entity, !!subtype);
    if (subtype) parent = group(parent, `subtype:${subtype.id}`, subtype.label);
    const template = inventoryNameTemplate(
      entity.name || categoryLabel(entity.category),
    );
    const location = catalogLocation(entity);
    if (
      template !== inventoryNameTemplate(location.category) &&
      template !== inventoryNameTemplate(nodes.get(parent)!.title)
    ) {
      parent = group(
        parent,
        `template:${encodeURIComponent(template)}`,
        template,
      );
      nodes.get(parent)!.kind = "template";
      nodes.get(parent)!.template = template;
    }
    const key = `inventory:entity:${entity.id}`,
      confirmed =
        entity.classificationStatus === "confirmed" &&
        entity.boundaryStatus === "confirmed" &&
        entity.standardClass?.status !== "candidate"
          ? 1
          : 0;
    add({
      key,
      parent,
      title: entity.name || categoryLabel(entity.category),
      kind: "entity",
      targetId: entity.id,
      category: entity.category,
      sourceCount: entity.sourceIds.length,
      entityCount: 1,
      confirmedCount: confirmed,
      evidence: [entity.boundaryEvidence],
      children: [],
      subtype: entity.subtype,
      subtypeLabel: entity.subtypeLabel,
      classificationStatus: entity.classificationStatus,
      boundaryStatus: entity.boundaryStatus,
      unknownReason: entity.unknownReason,
      grain: entity.grain,
    });
    rowsByEntity.set(entity.id, [key]);
    for (
      let cursor: string | undefined = parent;
      cursor;
      cursor = nodes.get(cursor)?.parent
    ) {
      nodes.get(cursor)!.entityCount++;
      nodes.get(cursor)!.confirmedCount! += confirmed;
    }
  }
  for (const member of snapshot.memberships) {
    const row = member.ownerId
      ? rowsByEntity.get(member.ownerId)?.[0]
      : undefined;
    if (!row) continue;
    rowsBySource.set(member.sourceId, row);
    if (member.interpretation.meaning === "neutral_set")
      for (
        let cursor: string | undefined = row;
        cursor;
        cursor = nodes.get(cursor)?.parent
      ) {
        const node = nodes.get(cursor)!;
        node.attachmentCount = (node.attachmentCount ?? 0) + 1;
      }
  }
  for (const node of nodes.values())
    if (node.key !== rootKey && node.kind === "group")
      node.children.sort((a, b) => {
        const left = nodes.get(a)!,
          right = nodes.get(b)!;
        if (order.has(a) || order.has(b)) {
          const rank = (order.get(a) ?? 999) - (order.get(b) ?? 999);
          if (rank) return rank;
        }
        return compareTitles(left.title, right.title) || a.localeCompare(b);
      });
  return {
    version: INVENTORY_TEMPLATE_VERSION,
    rootKey,
    nodes,
    rowsByEntity,
    rowsBySource,
  };
}
