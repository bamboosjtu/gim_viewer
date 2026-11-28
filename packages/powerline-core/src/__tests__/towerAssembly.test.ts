import { expect, it } from "vitest";
import { parseHNumCommaRecord, selectTowerParts } from "../index.js";
it("keeps common Body prefix, explicit leg/subleg, and trailing cross-section rods in their source frame", () => {
  const doc = parseHNumCommaRecord(
    "HNum,2\nH,1000,Body1,Leg1\nH,2000,Body2,Leg2\nBody1\nP,1,0,0,1000\nLeg1\nP,2,0,0,100\nBody2\nP,3,0,0,500\nLeg2\nHLeg2,300,200\nP,4,0,0,200\nSubLeg1\nP,5,0,0,10,0\nSubLeg2\nP,6,0,0,0\nR,1,2\nR,1,3\nR,3,4\nR,4,6",
    "t.mod",
  );
  const sel = selectTowerParts(doc, { heightMm: 2000, subLegs: [2] });
  expect(sel.confirmed).toBe(true);
  expect(sel.sections.flatMap((s) => s.points.map((p) => p.id))).toEqual([
    1, 3, 4, 6,
  ]);
  expect(sel.sections.flatMap((s) => s.rods.map((r) => r.ordinal))).toEqual([
    1, 2, 3,
  ]);
  expect(selectTowerParts(doc, { heightMm: 1500 }).confirmed).toBe(false);
  expect(selectTowerParts(doc, { heightMm: 2000 }).missing).toContain(
    "unspecified-subleg",
  );
});

it('retains an indeterminate declaration when both P references are missing or repeated',()=>{
 const d=parseHNumCommaRecord('HNum,1\nH,1000,Body1\nBody1\nP,1,1,2,3\nP,1,4,5,6\nR,1,99','a.mod');
 const selected=selectTowerParts(d,{heightMm:1000});expect(selected.sections[0].rods).toHaveLength(1);expect(selected.missing).toContain('unresolved-rod:0:0');
 expect(selected.sections[0].rods[0]).toMatchObject({ordinal:0,start:undefined,end:undefined});
});
