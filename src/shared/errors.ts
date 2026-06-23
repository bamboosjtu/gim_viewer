/** GIM 解析错误 */
export class GimParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'GimParseError';
  }
}

/** IFC 加载错误 */
export class IfcLoadError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'IfcLoadError';
  }
}
