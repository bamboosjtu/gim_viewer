import type { XmlModNode } from "./substationMod.js";
import type { ParseDiagnostic, ParseStatus } from "./types.js";
import {
  decodeXmlModMatrix,
  parseXmlModEntityId,
  type MatrixLayout,
} from "./xmlModValues.js";

export interface XmlModReadContext {
  readonly sourcePath: string;
  readonly matrixLayout: MatrixLayout;
}

export interface XmlModDiagnostic extends ParseDiagnostic {
  readonly ordinal?: number;
  readonly entityId?: number;
  readonly sourceTag?: string;
  readonly field?: string;
}

export interface RawPrimitiveSource {
  readonly sourceTag: string;
  readonly rawAttributes: Readonly<Record<string, string>>;
  readonly diagnostics: readonly XmlModDiagnostic[];
}

export interface RawXmlModEntity {
  readonly ordinal: number;
  readonly id?: number;
  readonly raw: XmlModNode;
  readonly visible: boolean;
  readonly primitive?: RawPrimitiveSource;
  readonly color?: Readonly<Record<string, string>>;
  readonly rawTransformMatrix?: string;
  readonly transformMatrix: readonly number[];
  readonly operandIds?: readonly (number | undefined)[];
}

export interface RawXmlModDocument extends XmlModReadContext {
  readonly entities: readonly RawXmlModEntity[];
  readonly entitiesById: ReadonlyMap<number, RawXmlModEntity>;
  readonly declaredEntityCount: number;
  readonly diagnostics: readonly XmlModDiagnostic[];
  readonly status: ParseStatus;
}

function named(node: XmlModNode, name: string): boolean {
  return node.tagName === name || node.tagName === name.toUpperCase();
}

function value(node: XmlModNode, name: string): string | undefined {
  return node.attrs[name] ?? node.attrs[name.toUpperCase()];
}

function attributeConflicts(node: XmlModNode): XmlModDiagnostic[] {
  const seen = new Map<string, string>();
  const conflicts: XmlModDiagnostic[] = [];
  for (const [field, rawValue] of Object.entries(node.attrs)) {
    const key = field.toUpperCase();
    if (seen.has(key)) {
      const same = seen.get(key) === rawValue;
      conflicts.push({
        severity: same ? "info" : "warning",
        code: same ? "duplicate-field" : "conflicting-field",
        message: same
          ? "Repeated attribute spelling"
          : "Conflicting attribute spellings",
        field,
        rawValue,
      });
    }
    seen.set(key, rawValue);
  }
  return conflicts;
}

function readEntity(
  raw: XmlModNode,
  ordinal: number,
  context: XmlModReadContext,
  diagnostics: XmlModDiagnostic[],
): RawXmlModEntity {
  const attributeIssues = attributeConflicts(raw);
  const conflictsWith = (field: string) =>
    attributeIssues.some(
      (issue) =>
        issue.code === "conflicting-field" &&
        issue.field?.toUpperCase() === field,
    );
  const id = conflictsWith("ID")
    ? undefined
    : parseXmlModEntityId(raw.attrs.ID);
  const report = (
    issue: XmlModDiagnostic,
    sourceTag: string,
  ): XmlModDiagnostic => {
    const located = {
      ...issue,
      path: context.sourcePath,
      ordinal,
      entityId: id,
      sourceTag,
    };
    diagnostics.push(located);
    return located;
  };
  for (const issue of attributeIssues) report(issue, raw.tagName);
  if (id === undefined)
    report(
      {
        severity: "warning",
        code: "invalid-entity-id",
        message: "Invalid Entity ID",
        field: "ID",
        rawValue: raw.attrs.ID,
      },
      raw.tagName,
    );
  let matrixNode: XmlModNode | undefined,
    colorNode: XmlModNode | undefined,
    primitiveNode: XmlModNode | undefined;
  let ambiguousPrimitive = false;
  let ambiguousMatrix = false;
  for (const child of raw.children) {
    if (named(child, "TransformMatrix")) {
      if (matrixNode) {
        ambiguousMatrix = true;
        report(
          {
            severity: "warning",
            code: "conflicting-field",
            message: "Repeated TransformMatrix",
          },
          child.tagName,
        );
      }
      matrixNode = child;
    } else if (named(child, "Color")) {
      if (colorNode)
        report(
          {
            severity: "warning",
            code: "conflicting-field",
            message: "Repeated Color",
          },
          child.tagName,
        );
      colorNode = child;
    } else if (!primitiveNode) primitiveNode = child;
    else ambiguousPrimitive = true;
  }
  if (matrixNode) {
    for (const issue of attributeConflicts(matrixNode)) {
      report(issue, matrixNode.tagName);
      if (
        issue.code === "conflicting-field" &&
        issue.field?.toUpperCase() === "VALUE"
      )
        ambiguousMatrix = true;
    }
  }
  const rawTransformMatrix = matrixNode
    ? (value(matrixNode, "Value") ?? "")
    : undefined;
  const placement = decodeXmlModMatrix(
    ambiguousMatrix ? "" : rawTransformMatrix,
    context.matrixLayout,
  );
  if (placement.diagnostic)
    report(
      { ...placement.diagnostic, field: "Value", rawValue: rawTransformMatrix },
      matrixNode!.tagName,
    );
  if (colorNode) {
    for (const issue of attributeConflicts(colorNode))
      report(issue, colorNode.tagName);
  }
  let primitive: RawPrimitiveSource | undefined;
  let operandIds: (number | undefined)[] | undefined;
  if (primitiveNode) {
    const node = primitiveNode;
    const issues = attributeConflicts(node).map((issue) =>
      report(issue, node.tagName),
    );
    if (ambiguousPrimitive)
      issues.push(
        report(
          {
            severity: "warning",
            code: "conflicting-field",
            message: "Entity declares multiple primitives",
          },
          node.tagName,
        ),
      );
    primitive = {
      sourceTag: node.tagName,
      rawAttributes: node.attrs,
      diagnostics: issues,
    };
    if (named(node, "Boolean")) {
      operandIds = ["Entity1", "Entity2"].map((field) => {
        const conflict = issues.some(
          (issue) =>
            issue.code === "conflicting-field" &&
            issue.field?.toUpperCase() === field.toUpperCase(),
        );
        return conflict ? undefined : parseXmlModEntityId(value(node, field));
      });
    }
  } else {
    report(
      {
        severity: "warning",
        code: "missing-primitive",
        message: "Entity has no primitive child",
      },
      raw.tagName,
    );
  }
  const visible = value(raw, "Visible")?.toLowerCase();
  if (visible !== undefined && visible !== "true" && visible !== "false") {
    report(
      {
        severity: "warning",
        code: "invalid-field-value",
        message: "Visible requires true or false",
        field: "Visible",
        rawValue: value(raw, "Visible"),
      },
      raw.tagName,
    );
  }
  return {
    ordinal,
    id,
    raw,
    primitive,
    color: colorNode?.attrs,
    rawTransformMatrix,
    transformMatrix: placement.matrix,
    visible:
      !conflictsWith("VISIBLE") &&
      (visible === undefined || visible === "true"),
    operandIds,
  };
}

export function parseRawXmlModRoot(
  device: XmlModNode,
  context: XmlModReadContext,
): RawXmlModDocument {
  if (
    context?.matrixLayout !== "a3-21-example" &&
    context?.matrixLayout !== "project-column-major"
  ) {
    throw Object.assign(
      new TypeError("An explicit MOD matrix layout is required"),
      { code: "matrix-layout-required" },
    );
  }
  const diagnostics: XmlModDiagnostic[] = [];
  const entities: RawXmlModEntity[] = [];
  const entitiesById = new Map<number, RawXmlModEntity>();
  const duplicateIds = new Set<number>();
  const blocks = named(device, "Device")
    ? device.children.filter((node) => named(node, "Entities"))
    : [];
  if (blocks.length !== 1)
    diagnostics.push({
      severity: "error",
      code: "invalid-xml",
      message: "Expected Device with one Entities block",
      path: context.sourcePath,
    });
  for (const block of blocks) {
    for (const node of block.children) {
      if (!named(node, "Entity")) {
        diagnostics.push({
          severity: "warning",
          code: "invalid-xml",
          message: "Expected an Entity declaration",
          path: context.sourcePath,
          sourceTag: node.tagName,
        });
        continue;
      }
      const entity = readEntity(
        node,
        entities.length + 1,
        context,
        diagnostics,
      );
      entities.push(entity);
      if (entity.id === undefined) continue;
      if (entitiesById.has(entity.id)) duplicateIds.add(entity.id);
      entitiesById.set(entity.id, entity);
    }
  }
  for (const id of duplicateIds) entitiesById.delete(id);
  for (const entity of entities) {
    const location = {
      path: context.sourcePath,
      ordinal: entity.ordinal,
      entityId: entity.id,
    };
    if (entity.id !== undefined && duplicateIds.has(entity.id)) {
      diagnostics.push({
        ...location,
        severity: "warning",
        code: "duplicate-entity-id",
        message: "Ambiguous Entity ID",
        field: "ID",
        rawValue: entity.raw.attrs.ID,
      });
    }
    entity.operandIds?.forEach((id, i) => {
      if (id === undefined || !entitiesById.has(id))
        diagnostics.push({
          ...location,
          sourceTag: entity.primitive?.sourceTag,
          severity: "warning",
          code: "missing-reference",
          field: "Entity" + (i + 1),
          message: "Boolean operand has no unique declaration",
        });
    });
  }
  const status =
    blocks.length === 0
      ? "failed"
      : diagnostics.some((issue) => issue.severity !== "info")
        ? "partial"
        : entities.length
          ? "ok"
          : "empty";
  return {
    ...context,
    entities,
    entitiesById,
    declaredEntityCount: entities.length,
    diagnostics,
    status,
  };
}
