export class InvalidDevGeometryError extends Error {
  constructor(readonly devPath: string, readonly reason: string, readonly sourceEvidence?: string) {
    super(`DEV 几何无效，拒绝导出 GLB: ${devPath}: ${reason}`);
    this.name = 'InvalidDevGeometryError';
  }
}

