/** Substation XML MOD grammar. DOM/worker parsing adapters live in the host. */
import type {
  XmlModColor,
  XmlModEntity,
  XmlModPrimitive,
} from "@gim/gim-primitives/geometry/ir.js";
import type { ParseDiagnostic, ParseStatus } from "./types.js";
import { decodeXmlModMatrix, parseXmlModEntityId } from "./xmlModValues.js";
import {
  parseRawXmlModRoot,
  type RawXmlModDocument,
  type XmlModReadContext,
} from "./rawXmlMod.js";
export type * from "./rawXmlMod.js";
export type { MatrixLayout } from "./xmlModValues.js";
export { parseXmlModEntityId };

/** MOD 文件解析结果 */
export interface XmlModDocument {
  /** MOD 文件路径（如 "MOD/abc.mod"） */
  modPath: string;
  /** Entity 列表 */
  entities: XmlModEntity[];
  /** EMPTY_DEVICE_XML（<Entities /> 为空）标识 */
  isEmpty: boolean;
  /** Entity 元素的实际数量；与 declaredEntityCount 相同或大于可解析实体数。 */
  declaredEntityCount: number;
  /** 因缺少 ID/primitive 等原因未能进入 entities 的 Entity 数量。 */
  malformedEntityCount: number;
  /**
   * 文件内 Color.A 的最大值（用于透明度刻度判定）。
   * 判定规则（docs/schema/substation-mod.md）：max(A) > 100 → 字节制(/255)，否则百分制(/100)。
   */
  colorMaxA: number;
  /** Parser facts that must remain visible to Geometry/Cache consumers. */
  diagnostics: readonly ParseDiagnostic[];
  status: ParseStatus;
}

export interface XmlModNode {
  tagName: string;
  attrs: Record<string, string>;
  children: XmlModNode[];
}

/** Geometry adapter supplied by the host; Parser never maps primitive aliases. */
export type XmlPrimitiveMapper = (
  tagName: string,
  attrs: Record<string, string>,
) => XmlModPrimitive | null;

/** Same geometry grammar for native DOM and the worker's XML reader. */
export function parseXmlModRoot(
  device: XmlModNode,
  context: XmlModReadContext,
): RawXmlModDocument;
export function parseXmlModRoot(
  device: XmlModNode,
  modPath: string,
  mapPrimitive: XmlPrimitiveMapper,
): XmlModDocument;
export function parseXmlModRoot(
  device: XmlModNode,
  context: string | XmlModReadContext,
  mapPrimitive?: XmlPrimitiveMapper,
): XmlModDocument | RawXmlModDocument {
  if (typeof context !== "string") return parseRawXmlModRoot(device, context);
  if (!mapPrimitive)
    throw new TypeError("The legacy MOD reader requires a primitive mapper");
  return parseLegacyXmlModRoot(device, context, mapPrimitive);
}

function parseLegacyXmlModRoot(
  device: XmlModNode,
  modPath: string,
  mapPrimitive: XmlPrimitiveMapper,
): XmlModDocument {
  if (!device || device.tagName !== "Device") {
    throw new Error(
      `Expected <Device> root in ${modPath}, got <${device?.tagName ?? "null"}>`,
    );
  }

  const entitiesNode = device.children.find((n) => n.tagName === "Entities");
  if (!entitiesNode) {
    return {
      modPath,
      entities: [],
      isEmpty: true,
      declaredEntityCount: 0,
      malformedEntityCount: 0,
      colorMaxA: 0,
      diagnostics: [],
      status: "empty",
    };
  }

  const entityNodes = entitiesNode.children.filter(
    (n) => n.tagName === "Entity",
  );
  if (entityNodes.length === 0) {
    return {
      modPath,
      entities: [],
      isEmpty: true,
      declaredEntityCount: 0,
      malformedEntityCount: 0,
      colorMaxA: 0,
      diagnostics: [],
      status: "empty",
    };
  }

  let entities: XmlModEntity[] = [];
  const diagnostics: ParseDiagnostic[] = [];
  const seenIds = new Set<number>();
  let duplicateIds: Set<number> | undefined;
  for (const entityNode of entityNodes) {
    const idText = (entityNode.attrs["ID"] ?? "").trim();
    const id = parseXmlModEntityId(idText);
    if (id === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "invalid-entity-id",
        message: "Entity ID must be a non-negative safe integer",
        path: modPath,
        ...(idText ? { rawValue: idText } : {}),
      });
      continue;
    }
    if (seenIds.has(id)) {
      duplicateIds ??= new Set<number>();
      if (!duplicateIds.has(id)) {
        diagnostics.push({
          severity: "warning",
          code: "duplicate-entity-id",
          message: `Entity ID ${id} is ambiguous`,
          path: modPath,
          rawValue: idText,
        });
        duplicateIds.add(id);
      }
      continue;
    }
    seenIds.add(id);
    const entity = parseEntity(
      entityNode,
      id,
      mapPrimitive,
      diagnostics,
      modPath,
    );
    if (entity) entities.push(entity);
  }
  // Boolean operands must never bind to one arbitrarily chosen declaration.
  if (duplicateIds) {
    entities = entities.filter((entity) => !duplicateIds.has(entity.id));
  }

  // 文件级 A 刻度判定依据：Bentley 产物含 A=255（字节制），JinQu/SDDP/BIMBase ≤100（百分制）
  let colorMaxA = 0;
  for (const e of entities) {
    if (e.color && e.color.a > colorMaxA) colorMaxA = e.color.a;
  }

  return {
    modPath,
    entities,
    // A non-empty Entities block is not an empty source merely because every
    // Entity is malformed/unsupported. The geometry/cache layer needs to
    // preserve that distinction for diagnostics and warm-cache recovery.
    isEmpty: false,
    declaredEntityCount: entityNodes.length,
    malformedEntityCount: entityNodes.length - entities.length,
    colorMaxA,
    diagnostics,
    status:
      diagnostics.length || entityNodes.length !== entities.length
        ? "partial"
        : "ok",
  };
}

/** 解析单个 <Entity> 节点 */
function parseEntity(
  node: XmlModNode,
  id: number,
  mapPrimitive: XmlPrimitiveMapper,
  diagnostics: ParseDiagnostic[],
  modPath: string,
): XmlModEntity | null {
  // 当前样本 Entity.Type 全部为 "simple"，XmlModEntity.type 字段类型亦锁为 "simple" 字面量。
  // Unknown Entity.Type remains a non-fatal source fact; the parser keeps the
  // established simple behavior and does not log or mutate global state.
  const visibleAttr = node.attrs["Visible"];
  const visible =
    visibleAttr === undefined ? true : visibleAttr.toLowerCase() === "true";

  const placement = parseTransformMatrix(node);
  if (placement.diagnostic)
    diagnostics.push({
      ...placement.diagnostic,
      path: modPath,
      rawValue: placement.rawValue,
    });
  const color = parseColor(node);
  const primitiveNode = node.children.find(
    (child) => child.tagName !== "TransformMatrix" && child.tagName !== "Color",
  );
  if (!primitiveNode) {
    diagnostics.push({
      severity: "warning",
      code: "missing-primitive",
      message: "Entity has no primitive child",
      path: modPath,
    });
    return null;
  }
  let primitive = mapPrimitive(primitiveNode.tagName, primitiveNode.attrs);
  if (!primitive) {
    diagnostics.push({
      severity: "warning",
      code: "unsupported-primitive",
      message: "Primitive is not supported by the host adapter",
      path: modPath,
      rawValue: `${primitiveNode.tagName} ${JSON.stringify(primitiveNode.attrs)}`,
    });
    primitive = {
      type: "Unsupported",
      sourceType: primitiveNode.tagName,
      raw: primitiveNode.attrs,
    };
  } else if (primitive.type === "Unsupported") {
    diagnostics.push({
      severity: "warning",
      code: "unsupported-primitive",
      message: `Primitive <${primitiveNode.tagName}> is preserved as Unsupported`,
      path: modPath,
      rawValue: `${primitiveNode.tagName} ${JSON.stringify(primitiveNode.attrs)}`,
    });
  }

  return {
    id,
    type: "simple", // 当前样本全部为 simple
    visible,
    primitive,
    transformMatrix: placement.matrix,
    color,
  };
}

/** 解析 <TransformMatrix Value="..." />。Missing and invalid are distinct. */
function parseTransformMatrix(entityNode: XmlModNode): {
  matrix: number[];
  diagnostic?: ParseDiagnostic;
  rawValue?: string;
} {
  const tmNode = entityNode.children.find(
    (n) => n.tagName === "TransformMatrix",
  );
  return decodeXmlModMatrix(
    tmNode ? (tmNode.attrs.Value ?? "") : undefined,
    "project-column-major",
  );
}

/** 解析 <Color R="..." G="..." B="..." A="..." /> */
function parseColor(entityNode: XmlModNode): XmlModColor | undefined {
  const colorNode = entityNode.children.find((n) => n.tagName === "Color");
  if (!colorNode) return undefined;

  const r = parseInt(colorNode.attrs["R"], 10);
  const g = parseInt(colorNode.attrs["G"], 10);
  const b = parseInt(colorNode.attrs["B"], 10);
  const a = parseInt(colorNode.attrs["A"], 10);

  if ([r, g, b, a].some((n) => Number.isNaN(n))) return undefined;
  if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255)
    return undefined;
  // A 放宽到 0-255：Bentley 产物为字节制（实测含 255），JinQu/SDDP/BIMBase 为百分制。
  // 刻度判定在文档级（colorMaxA）完成，此处只做范围校验。
  if (a < 0 || a > 255) return undefined;

  return { r, g, b, a };
}

/**
 * 解析 primitive 子节点，未知标签保留 Unsupported/raw。
 *
 * 强类型 11 类（按 docs/schema/substation-mod.md）：
 * Cylinder / Cuboid / StretchedBody / PorcelainBushing / TruncatedCone /
 * Ring / TerminalBlock / Sphere / ChannelSteel / Table / CircularGasket
 *
 * 弱 schema 3 类：RectangularFixedPlate / OffsetRectangularTable / RectangularRing
 */
