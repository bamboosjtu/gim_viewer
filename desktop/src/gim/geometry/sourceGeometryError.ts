export class InvalidDevGeometryError extends Error {
  constructor(
    readonly devPath: string,
    readonly reason: string,
    readonly sourceEvidence?: string,
    readonly source: 'cold' | 'warm' = 'cold',
  ) {
    super(`DEV 几何无效，拒绝导出 GLB: ${devPath}: ${reason}`);
    this.name = 'InvalidDevGeometryError';
  }
}

export class MissingDevDependencyError extends Error {
  constructor(
    readonly devPath: string,
    message: string,
    readonly sourceEvidence: string,
  ) {
    super(message);
    this.name = 'MissingDevDependencyError';
  }
  static forPath(devPath: string, missingPath: string, kind: 'DEV' | 'PHM' | 'MOD' | 'GL' | 'STL') {
    return new MissingDevDependencyError(
      devPath,
      `${kind} 文件不存在: ${missingPath}`,
      `source-reference-missing-v1: ${kind}:${missingPath}`,
    );
  }
}

export type GeometryFailureKind =
  'source-invalid' | 'missing-dependency' | 'capacity-exceeded' | 'parse-failed';

export function geometryFailureKind(error: unknown): GeometryFailureKind {
  if (error instanceof MissingDevDependencyError) return 'missing-dependency';
  if (error instanceof InvalidDevGeometryError && error.sourceEvidence) return 'source-invalid';
  // The coordinate-precision guard is a representation limit. Without independent
  // source evidence it does not establish malformed input or a parser defect.
  if (
    error instanceof InvalidDevGeometryError &&
    /^insufficient-float32-coordinate-precision/.test(error.reason)
  )
    return 'capacity-exceeded';
  if ((error as { geometryKind?: unknown })?.geometryKind === 'capacity-exceeded')
    return 'capacity-exceeded';
  let message = '',
    current = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (typeof current === 'string' || current instanceof Error) {
      message += ` ${String(current)}`;
    } else if (
      typeof current === 'object' &&
      'message' in current &&
      typeof current.message === 'string'
    )
      message += ` ${current.message}`;
    current = (current as { cause?: unknown }).cause;
  }
  if (
    /DEV split.*(?:budget|reservation|exceeds)|reserved output budget|compiled result exceeds|GLB.*(?:quota|limit)|out of memory|allocation failed/i.test(
      message,
    )
  )
    return 'capacity-exceeded';
  return 'parse-failed';
}
