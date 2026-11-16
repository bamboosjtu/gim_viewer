export interface DocumentParseInfo {
  status: 'ok' | 'empty' | 'unsupported' | 'failed';
  diagnostics: Array<{code: 'invalid-xml' | 'unsupported-root'; path: string; message: string}>;
}
