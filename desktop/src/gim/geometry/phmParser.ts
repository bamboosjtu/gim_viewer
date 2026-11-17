/**
 * PHM 文件解析器。
 *
 * PHM（Physical Model / Assembly）是 GIM 工程中描述组合模型的文件，
 * 采用 KEY=VALUE 文本格式，将多个基础几何模型（MOD / STL）组装在一起，
 * 每个引用的模型通过独立的变换矩阵定义空间位置，并可指定颜色。
 *
 * 详见 docs/schema/geometry-model.md。
 *
 * 关键约束：
 * - PHM 不分节，无 [section] 语法
 * - SOLIDSn 和 SOLIDMODELn 两组各自以 index 关联 TRANSFORMMATRIXn / COLORn
 * - COLORn 为空字符串时 color 字段为 undefined（MOD 引用典型）
 * - TRANSFORMMATRIXn 缺失时回退单位矩阵
 * - SOLIDMODELn 目标可为 .mod/.stl/.gl/.phm（.phm 嵌套由遍历层递归处理）
 */

import type { PhmDocument, PhmSolidModelEntry, XmlModColor } from './ir.js';
import { parseBoundedCount } from '../parserLimits.js';
import {
  getFirstNonEmptyKv,
  isGimEmptyValue,
} from '../gimValueSemantics.js';
import {parseSourceDocument,sourceScalarProperties,sourceScalar,sourceDiagnostic,sourceConflicts} from '../sourceDocument.js';
import {isUsableAffineMatrix} from './affineMatrix.js';

/** 单位矩阵（列主序，长度 16） */
const IDENTITY_MATRIX: number[] = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

/**
 * 解析 PHM 文件内容为 PhmDocument。
 *
 * @param text PHM 文件文本内容
 * @param phmPath PHM 文件路径（如 "PHM/abc.phm"），用于 PhmDocument.phmPath
 */
export function parsePhm(text: string, phmPath: string): PhmDocument {
  const doc=parseSourceDocument(phmPath,text),kv=sourceScalarProperties(doc),sourceDiagnostics=sourceConflicts(doc);
  const solidModels:PhmSolidModelEntry[]=[];
  for(const [group,reference,block] of [['SOLIDS','SOLIDS','phm-solids'],['SOLIDMODELS','SOLIDMODEL','phm-models']] as const) {
    const count=parseBoundedCount(getFirstNonEmptyKv(kv,[group+'.NUM']),group+'.NUM');
    for(let i=0;i<count;i++) {
      const path=sourceScalar(doc,reference+i,block);if(path.status!=='resolved'||isGimEmptyValue(path.value))continue;
      const placement=sourceScalar(doc,'TRANSFORMMATRIX'+i,block),color=sourceScalar(doc,'COLOR'+i,block);
      let matrix=[...IDENTITY_MATRIX];
      if(placement.fields.length&&placement.status!=='ambiguous'){
        const parts=placement.value.split(','),values=parts.map(value=>Number(value.trim()));
        if(parts.every(value=>value.trim())&&isUsableAffineMatrix(values))matrix=values;
        else sourceDiagnostics.push(sourceDiagnostic(doc,'TRANSFORMMATRIX'+i,placement.fields,'invalid-source-matrix'));
      }
      solidModels.push({solidModelPath:path.value,transformMatrix:matrix,color:parseColor(color.value)});
    }
  }
  return {phmPath,solidModels,isEmpty:solidModels.length===0,colorMaxA:solidModels.reduce((max,row)=>Math.max(max,row.color?.a??0),0),
    ...(sourceDiagnostics.length?{sourceDiagnostics}:{}),};
}



function parseColor(raw: string | undefined): XmlModColor | undefined {
  if (typeof raw !== 'string' || isGimEmptyValue(raw)) return undefined;
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 4) return undefined;
  const [r, g, b, a] = parts.map((p) => parseInt(p, 10));
  if ([r, g, b, a].some((n) => Number.isNaN(n))) return undefined;
  if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) return undefined;
  // A 放宽到 0-255：JinQu/SDDP 为百分制，Bentley/BIMBase 可能出现字节制与非零哨兵差异。
  // 刻度判定由消费方（colorToMaterial）按值域处理。
  if (a < 0 || a > 255) return undefined;
  return { r, g, b, a };
}
