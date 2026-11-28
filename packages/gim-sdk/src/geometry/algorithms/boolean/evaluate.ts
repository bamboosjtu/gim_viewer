import { identityPlacement, isUsableAffineMatrix } from "../../affineMatrix.js";
import type { MeshData, GeometryDiagnostic } from "../../primitiveContracts.js";
import { BooleanGraph, type BooleanOperation } from "./graph.js";

export type BooleanResult =
  | {
      status: "success";
      mesh: MeshData;
      diagnostics: readonly GeometryDiagnostic[];
    }
  | { status: "empty"; diagnostics: readonly GeometryDiagnostic[] }
  | {
      status: "failed";
      diagnostics: readonly [GeometryDiagnostic, ...GeometryDiagnostic[]];
    };
export interface BooleanInput {
  operation: "union" | "difference" | "intersection";
  operands: readonly [MeshData, MeshData];
}
export interface GeometryBooleanBackend {
  readonly backendId: string;
  readonly version: string;
  evaluate(input: BooleanInput): BooleanResult | Promise<BooleanResult>;
}
export interface SyncBooleanBackend extends GeometryBooleanBackend {
  evaluate(input: BooleanInput): BooleanResult;
}
export function booleanFailure(
  id: number,
  code: string,
  message = code,
): BooleanResult {
  return {
    status: "failed",
    diagnostics: [
      {
        stage: "compose",
        severity: "warning",
        code,
        message,
        location: { entityId: id },
      },
    ],
  };
}
const empty: BooleanResult = { status: "empty", diagnostics: [] };
const operations: Record<BooleanOperation, BooleanInput["operation"]> = {
  Union: "union",
  Difference: "difference",
  Intersection: "intersection",
};

export function placeBooleanMesh(
  mesh: MeshData,
  m: readonly number[],
): MeshData {
  if (m.every((v, i) => v === identityPlacement[i])) return mesh;
  const positions = new Float32Array(mesh.positions.length),
    normals = new Float32Array(mesh.normals.length);
  const [a, b, c, , d, e, f, , g, h, i] = m;
  const cof = [
    e * i - f * h,
    f * g - d * i,
    d * h - e * g,
    c * h - b * i,
    a * i - c * g,
    b * g - a * h,
    b * f - c * e,
    c * d - a * f,
    a * e - b * d,
  ];
  const reflected = a * cof[0] + b * cof[1] + c * cof[2] < 0;
  for (let j = 0; j < positions.length; j += 3) {
    const x = mesh.positions[j],
      y = mesh.positions[j + 1],
      z = mesh.positions[j + 2];
    positions[j] = a * x + d * y + g * z + m[12];
    positions[j + 1] = b * x + e * y + h * z + m[13];
    positions[j + 2] = c * x + f * y + i * z + m[14];
    const nx = mesh.normals[j],
      ny = mesh.normals[j + 1],
      nz = mesh.normals[j + 2];
    const u = cof[0] * nx + cof[3] * ny + cof[6] * nz,
      v = cof[1] * nx + cof[4] * ny + cof[7] * nz,
      w = cof[2] * nx + cof[5] * ny + cof[8] * nz;
    const length = Math.hypot(u, v, w);
    if (length) {
      const scale = (reflected ? -1 : 1) / length;
      normals[j] = u * scale;
      normals[j + 1] = v * scale;
      normals[j + 2] = w * scale;
    }
  }
  let indices = mesh.indices;
  if (reflected) {
    indices =
      indices?.slice() ??
      Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
    for (let j = 0; j < indices.length; j += 3) {
      const b = indices[j + 1];
      indices[j + 1] = indices[j + 2];
      indices[j + 2] = b;
    }
  }
  return { ...mesh, positions, normals, indices };
}
type Step = { id: number; input: BooleanInput } | undefined;
type Plan = Generator<Step, BooleanResult, BooleanResult | undefined>;
/** Session cache is scoped to one immutable graph, leaf policy and backend. Only completed results can be reused. */
export class DetailedBooleanEvaluation {
  private readonly completed = new Map<number, BooleanResult>();
  constructor(
    private readonly graph: BooleanGraph,
    private readonly leaf: (id: number) => BooleanResult,
    readonly backend: GeometryBooleanBackend | undefined,
    readonly sourceKey: string,
    readonly policy: string,
  ) {}
  key(id: number): string {
    const op = this.graph.node(id)?.operation;
    return JSON.stringify([
      this.sourceKey,
      this.policy,
      this.backend?.backendId,
      this.backend?.version,
      id,
      op?.op,
      op?.entity1,
      op?.entity2,
    ]);
  }
  private *plan(id: number, active: Set<number>): Plan {
    const cached = this.completed.get(id);
    if (cached) return cached;
    const node = this.graph.node(id);
    if (!node || active.has(id))
      return booleanFailure(id, node ? "cycle" : "missing-reference");
    if (!isUsableAffineMatrix(node.localToParent))
      return booleanFailure(id, "invalid-source-matrix");
    active.add(id);
    try {
      let r: BooleanResult;
      if (!node.operation) {
        r = this.leaf(id);
      } else {
        const { op, entity1, entity2 } = node.operation;
        const a = yield* this.plan(entity1, active),
          b = yield* this.plan(entity2, active);
        if (a.status === "failed" || b.status === "failed") {
          const d: GeometryDiagnostic[] = [
            ...(a.status === "failed" ? a.diagnostics : []),
            ...(b.status === "failed" ? b.diagnostics : []),
          ];
          return {
            status: "failed",
            diagnostics: [
              {
                stage: "compose",
                severity: "warning",
                code: "operand-unavailable",
                message: "A Boolean operand is unavailable",
                location: { entityId: id },
              },
              ...d,
            ],
          };
        }
        if (a.status === "empty" || b.status === "empty") {
          r =
            op === "Intersection"
              ? empty
              : op === "Difference"
                ? a
                : a.status === "empty"
                  ? b
                  : a;
        } else if (!this.backend) {
          return booleanFailure(id, "boolean-backend-unavailable");
        } else {
          r =
            (yield {
              id,
              input: { operation: operations[op], operands: [a.mesh, b.mesh] },
            }) ?? booleanFailure(id, "boolean-backend-failed");
        }
      }
      if (r.status === "success") {
        if (!(r.mesh.indices?.length ?? r.mesh.positions.length))
          return booleanFailure(
            id,
            "invalid-boolean-success",
            "A nonempty result needs triangles",
          );
        r = { ...r, mesh: placeBooleanMesh(r.mesh, node.localToParent) };
      }
      if (r.status !== "failed") this.completed.set(id, r);
      yield;
      return r;
    } finally {
      active.delete(id);
    }
  }
  *steps(id: number): Generator<void, BooleanResult, void> {
    const gen = this.plan(id, new Set());
    let next = gen.next();
    while (!next.done) {
      const request = next.value;
      let reply: BooleanResult | undefined;
      if (request) {
        try {
          const r = this.backend!.evaluate(request.input);
          if (r instanceof Promise) {
            void r.catch(() => {});
            throw Error("Asynchronous backend requires evaluate()");
          }
          reply = r;
        } catch (e) {
          reply = booleanFailure(request.id, "csg-failed", String(e));
        }
      } else yield;
      next = gen.next(reply);
    }
    return next.value;
  }
  async evaluate(id: number): Promise<BooleanResult> {
    const gen = this.plan(id, new Set());
    let next = gen.next();
    while (!next.done) {
      const request = next.value;
      let reply: BooleanResult | undefined;
      if (request)
        try {
          reply = await this.backend!.evaluate(request.input);
        } catch (e) {
          reply = booleanFailure(request.id, "csg-failed", String(e));
        }
      next = gen.next(reply);
    }
    return next.value;
  }
}
