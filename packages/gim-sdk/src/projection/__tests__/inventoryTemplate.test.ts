import {expect,it} from 'vitest';
import {projectInventoryTemplate} from '../inventoryTemplate.js';
import {normalizeEngineeringModel} from '../../semantic/normalize.js';
import {declaredObject} from '../../semantic/__tests__/evidenceFixtures.js';
import {catalogPathLabel} from '../../semantic/catalog/catalogLabels.js';

it('projects whole leaves and source-to-owner aliases without changing members or pending identities',()=>{
 const model=normalizeEngineeringModel('scope',[
  declaredObject('host','主变压器'),declaredObject('part','散热器',{assemblyParentId:'host'}),
  declaredObject('orphan','散热器'),declaredObject('text','文字',{objectRoles:[{value:'source_only',evidenceId:'role'}]}),
 ]),before=structuredClone(model),view=projectInventoryTemplate(model);
 expect([...view.nodes.values()].filter(n=>n.kind==='entity')).toHaveLength(1);
 expect([...view.nodes.values()].filter(n=>n.kind==='entity').every(n=>!n.children.length)).toBe(true);
 expect(view.rowsBySource.get('part')).toBe(view.rowsBySource.get('host'));
 expect(view.rowsBySource.has('orphan')).toBe(false);expect(view.rowsBySource.has('text')).toBe(false);
 expect(view.rowsByEntity.has(model.pending[0].id)).toBe(false);
 expect(view.nodes.get(view.rootKey)?.entityCount).toBe(1);
 expect(model).toEqual(before);
});

it('places transformer protection cabinets and gateways at the same template level, including a template equal to the functional subtype',()=>{
 const model=normalizeEngineeringModel('scope',[
  declaredObject('cabinet','1号主变压器保护柜',{typeCategory:'E16.panel_cabinet'}),
  declaredObject('protection','保护模块',{typeCategory:'part',assemblyParentId:'cabinet',componentTypeCandidates:[{value:'transformer_protection_device',evidenceId:'family:装置名称',confidence:'confirmed'}]}),
  declaredObject('gateway','I区网关机柜',{typeCategory:'E16.panel_cabinet'}),
 ]),before=structuredClone(model),view=projectInventoryTemplate(model);
 const cabinet=model.entities.find(e=>e.sourceIds.includes('cabinet'))!,gateway=model.entities.find(e=>e.sourceIds.includes('gateway'))!;
 const cabinetRow=view.nodes.get(view.rowsByEntity.get(cabinet.id)![0])!,gatewayRow=view.nodes.get(view.rowsByEntity.get(gateway.id)![0])!;
 const cabinetTemplate=view.nodes.get(cabinetRow.parent!)!,gatewayTemplate=view.nodes.get(gatewayRow.parent!)!;
 expect(cabinet).toMatchObject({category:'E17',subtypeLabel:'主变压器保护柜',subtypeStatus:'confirmed'});
 expect(catalogPathLabel(cabinet)).toBe('二次屏柜 / 主变压器保护柜');
 expect(cabinetTemplate).toMatchObject({kind:'template',title:'主变压器保护柜'});
 expect(gatewayTemplate).toMatchObject({kind:'template',title:'I区网关机柜',parent:cabinetTemplate.parent});
 expect(view.nodes.get(cabinetTemplate.parent!)?.title).toBe('二次屏柜');
 expect(cabinetRow.children).toEqual([]);expect(view.rowsBySource.get('protection')).toBe(cabinetRow.key);
 expect(model).toEqual(before);
});

it('counts neutral equipment without creating body placeholders or rows for unresolved neutral attachments',()=>{
 const model=normalizeEngineeringModel('scope',[
  declaredObject('neutral','接地变及消弧线圈装置',{typeCategory:'E04',identityCodes:[{value:'neutral-a',evidenceId:'code'}]}),
  declaredObject('pending','中性点成套装置',{typeCategory:'neutral_set'}),
 ]),view=projectInventoryTemplate(model);
 expect(model.entities).toHaveLength(1);expect(model.pending).toHaveLength(1);
 expect([...view.nodes.values()].find(n=>n.title==='中性点成套设备')?.entityCount).toBe(1);
 expect([...view.nodes.values()].some(n=>n.title==='（本体）'||n.title==='宿主/边界待确认')).toBe(false);
 expect(view.rowsByEntity.size).toBe(1);expect(view.rowsBySource.has('pending')).toBe(false);
});
