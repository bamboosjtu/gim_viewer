import { describe, expect, it } from "vitest";
import { completeNeutralAssemblies } from "../recognition/neutralAssemblyResolver.js";
import type { SourceTypeObservation } from "../recognition/sourceFormatFacts.js";

const set: SourceTypeObservation = { sourceId: "set", declaredType: "GroundTransformer/ArcExtinguishingCoil" };
const ground: SourceTypeObservation = {
  sourceId: "ground", declaredType: "接地变压器", physicalParentId: "set",
};
const coil: SourceTypeObservation = {
  sourceId: "coil", declaredType: " 消弧线圈 ", physicalParentId: "set",
};

describe("neutral assembly semantic decision", () => {
  it("requires both direct typed witnesses", () => {
    expect(
      completeNeutralAssemblies([set, ground, coil]),
    ).toEqual(new Set(["set"]));
    expect(
      completeNeutralAssemblies([
        set,
        { ...ground, declaredType: "接地变外壳" },
        coil,
      ]),
    ).toEqual(new Set());
  });

  it("does not accept indirect descendants or duplicate one-sided types", () => {
    expect(
      completeNeutralAssemblies([set, ground, { ...coil, physicalParentId: "ground" }]),
    ).toEqual(new Set());
    expect(
      completeNeutralAssemblies([set, ground, { ...coil, physicalParentId: undefined }]),
    ).toEqual(new Set());
    expect(
      completeNeutralAssemblies([set, ground, { ...ground, sourceId: "ground2" }]),
    ).toEqual(new Set());
  });
});
