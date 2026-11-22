import { buildCbmTree } from '../../../gim/cbmParser.js';
import { findEquipmentEntry, prepareEquipmentFiles } from '../../../gim/equipmentModel.js';
import type { SessionScope } from '../../../shared/sessionScope.js';

export async function loadEquipmentSource(rawFiles: Map<string, File>, scope: SessionScope) {
  const files = await scope.read(() => prepareEquipmentFiles(rawFiles, scope.isCurrent));
  const entry = await scope.read(() => findEquipmentEntry(files));
  if (!entry) throw new Error('设备包缺少唯一、有效的 Device CBM 或 DEV 装配入口');
  const tree = await scope.read(() => buildCbmTree(files, undefined, entry));
  if (!tree) throw new Error('无法构建设备模型层级');
  return { files, tree };
}
