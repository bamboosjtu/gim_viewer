export class InvalidDevGeometryError extends Error {
  constructor(readonly devPath: string, readonly reason: string, readonly sourceEvidence?: string,
    readonly source: 'cold' | 'warm' = 'cold') {
    super(`DEV 几何无效，拒绝导出 GLB: ${devPath}: ${reason}`);
    this.name = 'InvalidDevGeometryError';
  }
}

export class MissingDevDependencyError extends Error {
  constructor(readonly devPath:string,message:string,readonly sourceEvidence:string){
    super(message);
    this.name='MissingDevDependencyError';
  }
  static forPath(devPath:string,missingPath:string,kind:'DEV'|'PHM'|'MOD'|'GL'|'STL'){
    return new MissingDevDependencyError(devPath,`${kind} 文件不存在: ${missingPath}`,
      `source-reference-missing-v1: ${kind}:${missingPath}`);
  }
}

export function geometryFailureKind(error:unknown):'source-invalid'|'missing-dependency'|'capacity-exceeded'|'parse-failed'{
  if(error instanceof MissingDevDependencyError)return 'missing-dependency';
  if(error instanceof InvalidDevGeometryError&&error.sourceEvidence)return 'source-invalid';
  const message=String(error);
  if(/DEV split.*(?:budget|reservation|exceeds)|reserved output budget|out of memory|allocation failed/i.test(message))
    return 'capacity-exceeded';
  return 'parse-failed';
}

