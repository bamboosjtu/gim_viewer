import type { GeometryRefsPayload, DevSolidModelPayload, DevSubDevicePayload, PhmSolidModelPayload } from '@desktop/database.js';
import { parseDev } from '../../gim/geometry/devParser.js';
import { parsePhm } from '../../gim/geometry/phmParser.js';
import { normalizeFilePath } from '../../gim/fileLookup.js';

/** Test-only projection of the legacy DEV/PHM geometry reference chain. */
export async function buildGeometryRefsPayload(
  projectId: number,
  files: Map<string, File>,
  sourceSha256?: string | null,
  isCurrent?: () => boolean,
): Promise<GeometryRefsPayload> {
  const devSolidModels: DevSolidModelPayload[] = [];
  const devSubDevices: DevSubDevicePayload[] = [];
  const phmSolidModels: PhmSolidModelPayload[] = [];
  const devFiles: Array<{ path: string; file: File }> = [];
  const phmFiles: Array<{ path: string; file: File }> = [];

  for (const [entryPath, file] of files) {
    const normalized = normalizeFilePath(entryPath);
    const lower = normalized.toLowerCase();
    if (lower.startsWith('dev/') && lower.endsWith('.dev')) devFiles.push({ path: normalized, file });
    else if (lower.startsWith('phm/') && lower.endsWith('.phm')) phmFiles.push({ path: normalized, file });
  }

  for (const { path, file } of devFiles) {
    if (isCurrent && !isCurrent()) throw Error('index build cancelled');
    try {
      const doc = parseDev(await file.text(), path);
      doc.solidModels.forEach((sm, sortOrder) => devSolidModels.push({
        dev_path: path,
        solid_model_path: sm.solidModelPath,
        transform_matrix: sm.transformMatrix.length === 16 ? sm.transformMatrix.join(',') : null,
        sort_order: sortOrder,
      }));
      doc.subDevices.forEach((sd, sortOrder) => devSubDevices.push({
        dev_path: path,
        child_dev_path: sd.devPath,
        transform_matrix: sd.transformMatrix.length === 16 ? sd.transformMatrix.join(',') : null,
        sort_order: sortOrder,
      }));
    } catch (err) {
      console.warn(`[index] DEV 解析失败，跳过: ${path}`, err);
    }
  }

  for (const { path, file } of phmFiles) {
    if (isCurrent && !isCurrent()) throw Error('index build cancelled');
    try {
      const doc = parsePhm(await file.text(), path);
      doc.solidModels.forEach((sm, sortOrder) => phmSolidModels.push({
        phm_path: path,
        solid_model_path: sm.solidModelPath,
        transform_matrix: sm.transformMatrix.length === 16 ? sm.transformMatrix.join(',') : null,
        color: sm.color ? `${sm.color.r},${sm.color.g},${sm.color.b},${sm.color.a}` : null,
        phm_color_max_a: sm.color ? doc.colorMaxA : null,
        sort_order: sortOrder,
      }));
    } catch (err) {
      console.warn(`[index] PHM 解析失败，跳过: ${path}`, err);
    }
  }

  return {
    project_id: projectId,
    source_sha256: sourceSha256 ?? null,
    dev_solid_models: devSolidModels,
    dev_sub_devices: devSubDevices,
    phm_solid_models: phmSolidModels,
  };
}
