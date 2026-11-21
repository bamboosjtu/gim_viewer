import { describe, expect, it } from "vitest";
import { completeNeutralAssemblies } from "../recognition/neutralAssemblyResolver.js";
import type { SourceRecord } from "../../shared/sourceRecord.js";

function record(
  id: string,
  type: string,
  parent = "",
  track: "dev" | "ifc" = "dev",
): SourceRecord {
  return {
    id,
    track,
    source: `${id}.dev`,
    source_type: type,
    name: id,
    parent,
    properties: [],
    sources: [],
    context: [],
    guid: "",
  };
}

describe("neutral assembly semantic decision", () => {
  it("requires both direct typed witnesses", () => {
    expect(
      completeNeutralAssemblies([
        record("set", "GroundTransformer/ArcExtinguishingCoil"),
        record("ground", "GroundTransformer", "set"),
        record("coil", "消弧线圈", "set"),
      ]),
    ).toEqual(new Set(["set"]));
    expect(
      completeNeutralAssemblies([
        record("set", "GroundTransformer/ArcExtinguishingCoil"),
        record("ground", "接地变外壳", "set"),
        record("coil", "消弧线圈支架", "set"),
      ]),
    ).toEqual(new Set());
  });

  it("does not accept indirect descendants or duplicate one-sided types", () => {
    expect(
      completeNeutralAssemblies([
        record("set", "GroundTransformer/ArcExtinguishingCoil"),
        record("middle", "GroundTransformer", "set"),
        record("coil", "ArcExtinguishingCoil", "middle"),
      ]),
    ).toEqual(new Set());
    expect(
      completeNeutralAssemblies([
        record("set", "GroundTransformer/ArcExtinguishingCoil"),
        record("ground", "GroundTransformer", "set"),
        record("ground2", "GroundTransformer", "set"),
      ]),
    ).toEqual(new Set());
  });
});
