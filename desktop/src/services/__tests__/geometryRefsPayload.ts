import type {
  GeometryRefsPayload,
  DevSolidModelPayload,
  DevSubDevicePayload,
  PhmSolidModelPayload,
} from '@desktop/database.js';
import { parseDev } from '../../gim/geometry/devParser.js';
import { parsePhm } from '../../gim/geometry/phmParser.js';
import { normalizeFilePath } from '../../gim/fileLookup.js';
import { IndexBuildCancelledError } from '../gimIndexPersistenceService.js';

/** Test-only native index fixture: production intentionally publishes empty refs. */
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
    if (isCurrent && !isCurrent()) throw new IndexBuildCancelledError();
    try {
      const text = await file.text();
      const doc = parseDev(text, path);
      let smOrder = 0;
      for (const sm of doc.solidModels) {
        devSolidModels.push({
          dev_path: path,
          solid_model_path: sm.solidModelPath,
          transform_matrix: sm.transformMatrix.length === 16 ? sm.transformMatrix.join(',') : null,
          sort_order: smOrder++,
        });
      }
      for (const sd of doc.subDevices) {
        devSubDevices.push({
          dev_path: path,
          child_dev_path: sd.devPath,
          transform_matrix: sd.transformMatrix.length === 16 ? sd.transformMatrix.join(',') : null,
          sort_order: sd.sourceIndex,
        });
      }
    } catch (err) {
      console.warn(`[index] DEV 解析失败，跳过: ${path}`, err);
    }
  }

  for (const { path, file } of phmFiles) {
    if (isCurrent && !isCurrent()) throw new IndexBuildCancelledError();
    try {
      const text = await file.text();
      const doc = parsePhm(text, path);
      let smOrder = 0;
      for (const sm of doc.solidModels) {
        phmSolidModels.push({
          phm_path: path,
          solid_model_path: sm.solidModelPath,
          transform_matrix: sm.transformMatrix.length === 16 ? sm.transformMatrix.join(',') : null,
          color: sm.color ? `${sm.color.r},${sm.color.g},${sm.color.b},${sm.color.a}` : null,
          phm_color_max_a: sm.color ? doc.colorMaxA : null,
          sort_order: smOrder++,
        });
      }
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
