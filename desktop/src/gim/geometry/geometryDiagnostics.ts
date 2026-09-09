/**
 * DEV geometry degradation contract shared by the geometry pipeline and the
 * substation inspector.
 *
 * This is deliberately a small runtime summary, not another geometry model.
 * The parsers and GLB manifest remain the source of truth; this index only
 * carries the result far enough for a user to understand why a device has no
 * visible geometry.  Keys are case-insensitive normalized DEV paths while the
 * first observed spelling is retained for display/diagnostics.
 */

export type GeometryDiagnosticStatus =
  | 'renderable'
  | 'partial'
  | 'empty'
  | 'unsupported'
  | 'failed';

export type GeometryDiagnosticReason =
  | 'empty-device-xml'
  | 'assembly-node-without-own-geometry'
  | 'phm-no-solidmodel'
  | 'dev-no-solidmodel'
  | 'parser-unsupported'
  | 'missing-dependency'
  | 'parse-failed'
  | 'unknown';

export type GeometryDiagnosticSource = 'cold' | 'warm' | 'raw';

export interface GeometryDiagnostic {
  devPath: string;
  status: GeometryDiagnosticStatus;
  source: GeometryDiagnosticSource;
  reason?: GeometryDiagnosticReason;
  discoveredModCount?: number;
  discoveredStlCount?: number;
  renderableModCount?: number;
  renderableStlCount?: number;
  emptySourceCount?: number;
  unsupportedSourceCount?: number;
  partialSourceCount?: number;
  unsupportedPrimitiveTypeCounts: Record<string, number>;
  /**
   * Human-readable detail is intentionally short and non-sensitive.  It is
   * suitable for the inspector, while raw paths remain in the source tab.
   */
  detail?: string;
}

export interface GeometryDiagnosticStore {
  geometryDiagnosticsByDevPath?: Map<string, GeometryDiagnostic>;
}

export interface SerializationDiagnosticInput {
  status: 'complete' | 'partial' | 'empty' | 'unsupported';
  discoveredModCount?: number;
  discoveredStlCount?: number;
  renderableModCount?: number;
  renderableStlCount?: number;
  emptySourceCount?: number;
  unsupportedSourceCount?: number;
  partialSourceCount?: number;
  unsupportedPrimitiveTypeCounts?: Record<string, number>;
  reason?: GeometryDiagnosticReason;
}

export interface ManifestDiagnosticInput {
  status: 'glb' | 'partial' | 'empty' | 'unsupported';
}

export function normalizeGeometryDiagnosticPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) return '';
  return normalized.toLowerCase().startsWith('dev/') ? normalized : `DEV/${normalized}`;
}

function diagnosticKey(path: string): string {
  return normalizeGeometryDiagnosticPath(path).toLowerCase();
}

function statusFromSerialization(status: SerializationDiagnosticInput['status']): GeometryDiagnosticStatus {
  switch (status) {
    case 'complete': return 'renderable';
    case 'partial': return 'partial';
    case 'unsupported': return 'unsupported';
    case 'empty': return 'empty';
  }
}

function statusFromManifest(status: ManifestDiagnosticInput['status']): GeometryDiagnosticStatus {
  switch (status) {
    case 'glb': return 'renderable';
    case 'partial': return 'partial';
    case 'empty': return 'empty';
    case 'unsupported': return 'unsupported';
  }
}

function defaultDetail(status: GeometryDiagnosticStatus): string | undefined {
  switch (status) {
    case 'partial':
      return '部分几何可渲染；其余来源或 primitive 已降级。';
    case 'empty':
      return '没有可渲染几何来源；可能是空 XML、空 PHM 或装配节点自身无几何。';
    case 'unsupported':
      return '源文件存在，但当前几何解析器不支持其类型。';
    case 'failed':
      return '几何加载或解析失败；已隔离该 DEV，不影响其它设备。';
    case 'renderable':
      return undefined;
  }
}

export function diagnosticFromSerialization(
  devPath: string,
  input: SerializationDiagnosticInput,
  source: Exclude<GeometryDiagnosticSource, 'raw'> = 'cold',
): GeometryDiagnostic {
  const status = statusFromSerialization(input.status);
  return {
    devPath: normalizeGeometryDiagnosticPath(devPath),
    status,
    source,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.discoveredModCount != null ? { discoveredModCount: input.discoveredModCount } : {}),
    ...(input.discoveredStlCount != null ? { discoveredStlCount: input.discoveredStlCount } : {}),
    ...(input.renderableModCount != null ? { renderableModCount: input.renderableModCount } : {}),
    ...(input.renderableStlCount != null ? { renderableStlCount: input.renderableStlCount } : {}),
    ...(input.emptySourceCount != null ? { emptySourceCount: input.emptySourceCount } : {}),
    ...(input.unsupportedSourceCount != null ? { unsupportedSourceCount: input.unsupportedSourceCount } : {}),
    ...(input.partialSourceCount != null ? { partialSourceCount: input.partialSourceCount } : {}),
    unsupportedPrimitiveTypeCounts: { ...(input.unsupportedPrimitiveTypeCounts ?? {}) },
    ...(defaultDetail(status) ? { detail: defaultDetail(status) } : {}),
  };
}

export function diagnosticFromManifest(
  devPath: string,
  input: ManifestDiagnosticInput,
): GeometryDiagnostic {
  const status = statusFromManifest(input.status);
  return {
    devPath: normalizeGeometryDiagnosticPath(devPath),
    status,
    source: 'warm',
    unsupportedPrimitiveTypeCounts: {},
    ...(defaultDetail(status) ? { detail: defaultDetail(status) } : {}),
  };
}

export function diagnosticForFailure(
  devPath: string,
  reason: GeometryDiagnosticReason = 'parse-failed',
  source: GeometryDiagnosticSource = 'raw',
  detail?: string,
): GeometryDiagnostic {
  return {
    devPath: normalizeGeometryDiagnosticPath(devPath),
    status: 'failed',
    source,
    reason,
    unsupportedPrimitiveTypeCounts: {},
    detail: detail ?? defaultDetail('failed'),
  };
}

export function setGeometryDiagnostic(
  store: GeometryDiagnosticStore,
  diagnostic: GeometryDiagnostic,
): void {
  const normalizedPath = normalizeGeometryDiagnosticPath(diagnostic.devPath);
  if (!normalizedPath) return;
  if (!store.geometryDiagnosticsByDevPath) {
    store.geometryDiagnosticsByDevPath = new Map<string, GeometryDiagnostic>();
  }
  store.geometryDiagnosticsByDevPath.set(diagnosticKey(normalizedPath), {
    ...diagnostic,
    devPath: normalizedPath,
    unsupportedPrimitiveTypeCounts: { ...diagnostic.unsupportedPrimitiveTypeCounts },
  });
}

export function getGeometryDiagnostic(
  store: GeometryDiagnosticStore,
  devPath: string | undefined,
): GeometryDiagnostic | undefined {
  if (!devPath) return undefined;
  return store.geometryDiagnosticsByDevPath?.get(diagnosticKey(devPath));
}

export function geometryStatusLabel(status: GeometryDiagnosticStatus): string {
  switch (status) {
    case 'renderable': return '可渲染';
    case 'partial': return '部分可渲染';
    case 'empty': return '无可渲染几何';
    case 'unsupported': return '当前解析器不支持';
    case 'failed': return '加载失败（已隔离）';
  }
}

export function geometryReasonLabel(reason: GeometryDiagnosticReason): string {
  switch (reason) {
    case 'empty-device-xml': return 'EMPTY_DEVICE_XML 空设备源';
    case 'assembly-node-without-own-geometry': return '装配节点无自有几何';
    case 'phm-no-solidmodel': return 'PHM 未声明 SOLIDMODEL';
    case 'dev-no-solidmodel': return 'DEV 未声明可达 SOLIDMODEL';
    case 'parser-unsupported': return '几何类型暂不支持';
    case 'missing-dependency': return '几何依赖缺失';
    case 'parse-failed': return '几何解析失败';
    case 'unknown': return '未分类';
  }
}
