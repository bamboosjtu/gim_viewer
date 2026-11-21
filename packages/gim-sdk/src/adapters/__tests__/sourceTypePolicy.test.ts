import { expect, it } from 'vitest';
import type { EvidenceValue } from '../../semantic/types.js';
import {
  applyTypeDefaults,
  cabinetModelType,
  canonicalSourceType,
  ifcModelType,
  isTypeDeclaration,
  roadPositionType,
} from '../sourceTypePolicy.js';

const value = (text: string, evidenceId = text): EvidenceValue => ({
  value: text,
  evidenceId,
});

it('recognizes declarations while rejecting placeholder type text', () => {
  expect(isTypeDeclaration('GIS')).toBe(true);
  expect(isTypeDeclaration('-')).toBe(false);
  expect(isTypeDeclaration('无')).toBe(false);
});

it('keeps catalog aliases, neutral sets and opaque slash declarations whole', () => {
  expect(canonicalSourceType('PowerBox/LightingBox/MaintenanceBox')).toBe('PowerBox');
  expect(canonicalSourceType('消弧线圈及接地变压器成套装置')).toBe(
    'NeutralPointEquipment',
  );
  expect(canonicalSourceType('A/B')).toBe('A/B');
});

it('applies catalog defaults unless an explicit family already decides the type', () => {
  expect(applyTypeDefaults([value('SwitchCabinet')])).toEqual([
    { ...value('SwitchCabinet'), value: 'HVSwitchCabinet' },
  ]);
  const declarations = [
    value('SwitchCabinet', 'default'),
    value('RelayProtectionCabinet', 'explicit'),
  ];
  expect(applyTypeDefaults(declarations)).toEqual([declarations[1]]);
  expect(applyTypeDefaults([value('GIS')])).toEqual([value('GIS')]);
});

it('classifies cabinet models only from an unambiguous type value', () => {
  expect(cabinetModelType('测控柜')).toBe('MeasurementAndControlCabinet');
  expect(cabinetModelType('保护柜')).toBe('ProtectionCabinet');
  expect(cabinetModelType('保护测控柜')).toBeUndefined();
  expect(cabinetModelType('高压开关柜')).toBeUndefined();
});

it('recognizes IFC model declarations and ignores display names', () => {
  expect(ifcModelType('IFCBEAM', '钢梁')).toBe('SteelBeam');
  expect(ifcModelType('IFCCOLUMN', '钢柱')).toBe('SteelColumn');
  expect(ifcModelType('IFCDUCTSEGMENT', '风管')).toBe('Airduct');
  expect(ifcModelType('IFCBUILDINGELEMENTPROXY', '照明箱')).toBe('LightingBox');
  expect(ifcModelType('IFCBUILDINGELEMENTPROXY', '检修箱模型1')).toBe(
    'MaintenanceBox',
  );
  expect(ifcModelType('IFCBUILDINGELEMENTPROXY', '事故油池')).toBe('OilPool');
  expect(ifcModelType('IFCWALL', '墙')).toBeUndefined();
});

it('resolves road position only when every position agrees', () => {
  expect(roadPositionType('Road', [value('站内')])).toEqual({
    ...value('站内'),
    value: 'StationInRoadWays',
  });
  expect(roadPositionType('road', [value('站外')])).toEqual({
    ...value('站外'),
    value: 'StationOutRoadWays',
  });
  expect(
    roadPositionType('道路', [value('站内'), value('站外')]),
  ).toBeUndefined();
  expect(roadPositionType('道路', [])).toBeUndefined();
  expect(roadPositionType('Building', [value('站内')])).toBeUndefined();
});
