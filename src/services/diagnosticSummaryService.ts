/**
 * 诊断摘要服务：将 ProjectCacheDiagnostic 转为人类可读的 Markdown 风格文本。
 *
 * 用于：
 * - Ctrl+Shift+D 控制台输出
 * - 缓存管理 UI 中的"复制诊断"按钮
 */

/** 诊断 payload 的最小类型（与 Rust ProjectCacheDiagnostic 对应） */
interface DiagnosticPayload {
  project_type?: string | null;
  valid?: boolean;
  stored_parser_version?: string | null;
  current_parser_version?: string;
  parser_version_match?: boolean;

  // 变电工程
  entries_count?: number;
  cbm_nodes_count?: number;
  ifc_models_count?: number;
  ifc_entry_count?: number;
  cached_ifc_count?: number;
  missing_cache_paths?: string[];

  // 线路工程
  line_cbm_node_count?: number;
  line_cbm_child_count?: number;
  line_cbm_ref_count?: number;
  line_file_stat_count?: number;
  line_fam_property_count?: number;
  line_dev_property_count?: number;
  line_fam_source_count?: number;
  line_dev_source_count?: number;
  line_expected_fam_ref_count?: number;
  line_expected_dev_ref_count?: number;
  missing_line_fam_sources?: string[];
  missing_line_dev_sources?: string[];
}

/**
 * 将诊断 payload 转为可读的 Markdown 风格摘要文本。
 *
 * @param payload 诊断数据（ProjectCacheDiagnostic 或包含 diagnostic 字段的对象）
 * @returns 人类可读的摘要文本
 */
export function summarizeDiagnostic(payload: unknown): string {
  // 支持直接传入 diagnostic 或传入 { diagnostic } 包装
  const diag = (payload as { diagnostic?: DiagnosticPayload })?.diagnostic ?? (payload as DiagnosticPayload);
  if (!diag) {
    return '（无诊断数据）';
  }

  const projectType = diag.project_type ?? 'unknown';
  const valid = diag.valid ?? false;
  const storedVersion = diag.stored_parser_version ?? '(未设置)';
  const currentVersion = diag.current_parser_version ?? '(未知)';
  const versionMatch = diag.parser_version_match ?? false;

  const lines: string[] = [];
  lines.push(`工程类型：${projectType}`);
  lines.push(`缓存状态：valid=${valid}`);
  lines.push(`parser_version：${storedVersion} / ${currentVersion}${versionMatch ? '' : '（不匹配）'}`);

  if (projectType === 'transmission_line') {
    lines.push(`线路节点：${diag.line_cbm_node_count ?? 0}`);
    lines.push(`线路子节点：${diag.line_cbm_child_count ?? 0}`);
    lines.push(`线路引用：${diag.line_cbm_ref_count ?? 0}`);
    lines.push(`FAM 源：${diag.line_fam_source_count ?? 0}`);
    lines.push(`DEV 源：${diag.line_dev_source_count ?? 0}`);
    lines.push(`FAM 属性：${diag.line_fam_property_count ?? 0}`);
    lines.push(`DEV 属性：${diag.line_dev_property_count ?? 0}`);
    const missingFam = diag.missing_line_fam_sources?.length ?? 0;
    const missingDev = diag.missing_line_dev_sources?.length ?? 0;
    lines.push(`缺失 FAM：${missingFam}`);
    lines.push(`缺失 DEV：${missingDev}`);

    if (valid && missingFam === 0 && missingDev === 0) {
      lines.push('建议：缓存健康');
    } else if (!valid) {
      lines.push('建议：缓存无效，建议重新打开 GIM 重建');
    } else if (missingFam > 0 || missingDev > 0) {
      lines.push(`建议：存在缺失引用（FAM ${missingFam} / DEV ${missingDev}），可尝试重新打开`);
    } else {
      lines.push('建议：缓存可用');
    }
  } else {
    // substation / hybrid / unknown
    lines.push(`IFC entries：${diag.ifc_entry_count ?? diag.entries_count ?? 0}`);
    lines.push(`cached IFC：${diag.cached_ifc_count ?? 0}`);
    const missingCache = diag.missing_cache_paths?.length ?? 0;
    lines.push(`missing cache：${missingCache}`);

    if (valid && missingCache === 0) {
      lines.push('建议：缓存健康，可直接选择 IFC 加载');
    } else if (!valid) {
      lines.push('建议：缓存无效，建议重新打开 GIM 重建');
    } else if (missingCache > 0) {
      lines.push(`建议：存在 ${missingCache} 个 IFC 缓存缺失，可能需要重新解压`);
    } else {
      lines.push('建议：缓存可用');
    }
  }

  return lines.join('\n');
}
