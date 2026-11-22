import { geometryTrackTimingKeys, geometryTrackSources } from './geometry-track-metrics.mjs';
import { publicView } from './observability.mjs';
import { isPublicArtifact } from './batch-input.mjs';
import { writeFileSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { median } from './statistics.mjs';
import { diagnosticLines, buildLabel } from './report-diagnostics.mjs';

const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
function reportView(out, state, { root = repoRoot, project } = {}) {
  if (!isPublicArtifact(root, out) || state.artifactRole === 'public-derived') return state;
  const view = {
    ...(project ?? ((value) => publicView(value, { anonymize: state.anonymize !== false })))(state),
    version: state.version,
    anonymize: state.anonymize !== false,
    baselineEligible: false,
  };
  for (const row of view.rows ?? []) row.sampleLabel ??= row.sampleId ?? row.inputId;
  return view;
}
export function csv(rows, columns) {
  const cell = (value) => {
    let text = value == null ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return (
    '\uFEFF' +
    [columns, ...rows.map((row) => columns.map((key) => row[key]))]
      .map((row) => row.map(cell).join(','))
      .join('\r\n') +
    '\r\n'
  );
}
const put = (out, name, value) => {
  const temporary = join(out, `${name}.next`);
  writeFileSync(temporary, value);
  // Windows readers/virus scanners can briefly deny replacement. Keep the old
  // complete report until a bounded retry succeeds; never truncate it in place.
  for (let attempt = 0; ; attempt++)
    try {
      renameSync(temporary, join(out, name));
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 9) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
};
/** Small recoverable checkpoint; derived tables are generated at termination. */
export function writeBatchCheckpoint(out, state) {
  put(out, 'results.json', JSON.stringify(state));
}
/** Cheap public progress, without repeatedly serializing diagnostic tables. */
export function writeBatchProgress(out, state, { ready = false, ...options } = {}) {
  const counts = {};
  for (const row of state.rows ?? []) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const total = state.rows?.length ?? 0,
    pending = counts.PENDING ?? 0,
    running = counts.RUNNING ?? 0;
  const progress = {
    version: state.version,
    artifactRole: 'public-derived',
    artifactKind: 'batch-progress',
    baselineEligible: false,
    exportId: state.exportId,
    status: state.status,
    outcome: state.outcome,
    updatedAt: state.updatedAt,
    total,
    completed: total - pending - running,
    pending,
    running,
    counts,
    reportReady: ready,
  };
  put(out, 'status.json', JSON.stringify(progress, null, 2));
  if (ready) return;
  // Project only the result rows and report header. Diagnostic arrays can be
  // large and must not be traversed or exported on every checkpoint.
  const {
    version,
    exportId,
    status,
    outcome,
    preset,
    repetitions,
    buildFingerprint,
    buildInfo,
    profileDigest,
    anonymize,
    environmentCalibration,
    baselineEligible,
    updatedAt,
    rows,
  } = state;
  const view = reportView(
    out,
    {
      version,
      exportId,
      status,
      outcome,
      preset,
      repetitions,
      buildFingerprint,
      buildInfo,
      profileDigest,
      anonymize,
      environmentCalibration,
      baselineEligible,
      updatedAt,
      rows,
    },
    options,
  );
  put(out, 'report.html', renderBatchHtml(view, summarize(view.rows ?? []), counts, progress));
}
const metrics = [
  'firstResponseMs',
  'modelTreeReadyMs',
  'geometryCommitMs',
  'firstGeometryMs',
  'allGeometryReadyMs',
  'automaticLoadMs',
  'cachePublishMs',
  'settledMs',
  'writeDrainMs',
  'processPrivatePeakBytes',
  ...geometryTrackTimingKeys,
];
export function summarize(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.inputId}:${row.cacheState}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map((group) => {
    const result = {
      inputId: group[0].inputId,
      sampleId: group[0].sampleId,
      sampleLabel: group[0].sampleLabel,
      sampleTier: group[0].sampleTier,
      group: group[0].group,
      cacheState: group[0].cacheState,
      planned: group.length,
      passed: group.filter((r) => r.status === 'PASS').length,
      partial: group.filter((r) => r.status === 'PARTIAL').length,
      failed: group.filter((r) => ['FAIL', 'INPUT_ERROR', 'ERROR'].includes(r.status)).length,
      inconclusive: group.filter((r) => r.status === 'INCONCLUSIVE').length,
      skipped: group.filter((r) => ['SKIPPED', 'DUPLICATE', 'CANCELLED'].includes(r.status)).length,
    };
    const comparable = group.filter((row) => ['PASS', 'PARTIAL'].includes(row.status));
    result.validRepetitions = comparable.length;
    result.startupRetries = group.reduce(
      (sum, row) => sum + Math.max(0, (row.attempts ?? 1) - 1),
      0,
    );
    const signatures = new Set(
      comparable.map((row) =>
        row.status === 'PASS' ? 'PASS' : (row.partialSignature ?? 'PARTIAL:unverified'),
      ),
    );
    result.coverageGroups = signatures.size;
    result.partialSignatures = [...signatures]
      .filter((value) => value !== 'PASS')
      .sort()
      .join(';');
    const mixedCoverage = signatures.size > 1 || signatures.has('PARTIAL:unverified');
    // Never mix full and source-degraded coverage in one median.
    for (const key of metrics) {
      const values = comparable.map((row) => row[key]).filter(Number.isFinite);
      result[`${key}Median`] =
        !mixedCoverage && values.length === comparable.length && values.length
          ? median(values)
          : null;
      result[`${key}Count`] = values.length;
      result[`${key}Missing`] = comparable.length - values.length;
      result[`${key}P95`] =
        !mixedCoverage && values.length === comparable.length && values.length
          ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
          : null;
    }
    return result;
  });
}

export function writeBatchReports(out, state, options = {}) {
  state = reportView(out, state, options);
  const summaries = summarize(state.rows),
    counts = {};
  for (const row of state.rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const publicState = { ...state, counts, summaries };
  put(out, 'results.json', JSON.stringify(publicState, null, 2));
  const exportRows = state.rows.map((row) => ({
    ...row,
    buildCommit: state.buildInfo?.commit,
    buildFingerprint: state.buildFingerprint,
    partialFailedOccurrences: row.partialCounts?.failedOccurrences,
    partialFailedSources: row.partialCounts?.failedSourceCount,
    partialUnresolvedReferences: row.partialCounts?.unresolvedReferences,
  }));
  const columns = [
    'inputId',
    'buildCommit',
    'buildFingerprint',
    'sampleLabel',
    'sourcePath',
    'sampleId',
    'sourceSha256',
    'sampleTier',
    'group',
    'repetition',
    'cacheState',
    'status',
    'error',
    'runId',
    'partialKind',
    'partialFailedOccurrences',
    'partialFailedSources',
    'partialUnresolvedReferences',
    ...metrics,
    ...Object.keys(geometryTrackSources),
    'cacheWriteBytes',
    'cacheWriteMsPerMiB',
    'attempts',
    'startupFailures',
    'projectType',
    'correctness',
    'semanticDigestScope',
    'pendingCount',
    'pendingSourceCount',
    'pendingDigest',
    'geometryTimingPolicy',
    'workerHeapPolicy',
    'geometryStructuralFingerprint',
    'devContentDigest',
    'devContentCovered',
    'devContentComplete',
    'partialEvidenceStatus',
    'partialEvidenceDigest',
    'partialSignature',
    'inputIntegrity',
    'environmentSuspend',
    'inputVariantCode',
    'inputVariant',
    'cacheFailureCode',
    'cachePublished',
    'coverageComplete',
    'engineeringCacheStatus',
    'devCatalogMisses',
    'sourceFailureCatalogMisses',
    'unexplainedCatalogMisses',
    'catalogProofComplete',
    'devPartialOccurrences',
    'partialGeometryReasons',
    'geometryDiagnosticScope',
    'sourceReferenceStatuses',
    'coverageIncompleteReasons',
    'unresolvedReferenceCount',
    'gpuTimingStatus',
    'gpuTimingSamples',
    'gpuMemoryStatus',
    'gpuMemoryBytes',
    'gpuMemoryScope',
    'measurementDetailDropped',
    'measurementDetailStatus',
    'measurementAggregatedDetail',
    'measurementLifecycleComplete',
    'measurementLifecycleIssues',
    'measurementIncompleteItems',
    'memoryEvidenceComplete',
    'memoryIncompleteItems',
    'templateDiagnosticsStatus',
    'cancelledBeforeStart',
    'lateBackgroundTasks',
    'finalEvidenceIssue',
    'finalEvidenceAttempts',
    'finalEvidenceDrifts',
    'cacheVerified',
    'measurementComplete',
    'processSamples',
    'processSamplesAvailable',
    'missingWorkerHeaps',
    'unavailableWorkerHeaps',
    'shortLivedWorkerHeaps',
    'notApplicableWorkerHeaps',
    'failedGeometry',
    'failedGeometryReasons',
    'geometryStatuses',
    'failedSourceCount',
    'failedSourceSetDigest',
    'pendingTasks',
    'interruptedAtMs',
    'interruptedWritePending',
    'interruptedCacheSettled',
    'backgroundSettled',
    'cachePublication',
    'linePackAssessment',
    'duplicateOf',
  ];
  put(out, 'results.csv', csv(exportRows, columns));
  put(
    out,
    'summary.csv',
    csv(summaries, [
      'inputId',
      'sampleLabel',
      'sampleId',
      'sampleTier',
      'group',
      'cacheState',
      'planned',
      'validRepetitions',
      'coverageGroups',
      'partialSignatures',
      'startupRetries',
      'passed',
      'partial',
      'failed',
      'inconclusive',
      'skipped',
      ...metrics.flatMap((key) => [`${key}Median`, `${key}P95`, `${key}Count`, `${key}Missing`]),
    ]),
  );
  put(
    out,
    'errors.csv',
    csv(
      exportRows.filter((row) => !['PASS', 'PENDING', 'RUNNING', 'DUPLICATE'].includes(row.status)),
      columns,
    ),
  );
  put(
    out,
    'stages.csv',
    csv(state.stages, [
      'runId',
      'sampleLabel',
      'sourceSha256',
      'sampleId',
      'repetition',
      'cacheState',
      'stage',
      'count',
      'totalMs',
      'maxMs',
      'workloadBytes',
      'msPerMiB',
      'p50LowerMs',
      'p50UpperMs',
      'p95LowerMs',
      'p95UpperMs',
      'p99LowerMs',
      'p99UpperMs',
    ]),
  );
  put(
    out,
    'slow-tasks.csv',
    csv(state.slowTasks ?? [], [
      'runId',
      'sampleLabel',
      'sourceSha256',
      'sampleId',
      'repetition',
      'cacheState',
      'family',
      'workerId',
      'sourceId',
      'status',
      'durationMs',
    ]),
  );
  put(
    out,
    'slow-phases.csv',
    csv(state.slowPhases ?? [], [
      'runId',
      'sampleLabel',
      'sourceSha256',
      'sampleId',
      'repetition',
      'cacheState',
      'family',
      'stage',
      'workerId',
      'sourceId',
      'durationMs',
    ]),
  );
  put(
    out,
    'slow-templates.csv',
    csv(state.templateDiagnostics ?? [], [
      'runId',
      'sampleLabel',
      'sourceSha256',
      'sampleId',
      'repetition',
      'cacheState',
      'kind',
      'sourceId',
      'taskId',
      'lod',
      'priority',
      'admittedPriority',
      'slotCapacityAtEnqueue',
      'slotCapacity',
      'slotsBusyAtEnqueue',
      'queueDepthAtEnqueue',
      'slotsBusyAtAdmit',
      'status',
      'queueWaitMs',
      'slotOccupancyMs',
      'cacheReadMs',
      'workerAwaitMs',
      'workerQueueWaitTotalMs',
      'workerDispatches',
      'inputBudgetWaitMs',
      'outputBytes',
      'cacheStatus',
      'memoryPressure',
    ]),
  );
  put(
    out,
    'workers.csv',
    csv(state.workers, [
      'runId',
      'sampleLabel',
      'sourceSha256',
      'sampleId',
      'repetition',
      'cacheState',
      'workerId',
      'family',
      'heapAvailability',
      'heapReason',
      'heapSamples',
      'failedHeapSamples',
      'observedHeapPeakBytes',
      'maxSampleDelayMs',
      'maxSampleGapMs',
    ]),
  );
  put(out, 'report.html', renderBatchHtml(state, summaries, counts));
}

/** Presentation only: full measurements and identities remain in JSON/CSV. */
export function renderBatchHtml(state, summaries = summarize(state.rows), counts, progress) {
  counts ??= state.rows.reduce((result, row) => {
    result[row.status] = (result[row.status] ?? 0) + 1;
    return result;
  }, {});
  const numeric = (value, scale = 1, digits = 3) =>
    Number.isFinite(value) ? (value / scale).toFixed(digits) : '—';
  const seconds = (value) => numeric(value, 1000);
  const cacheLabel = (value) =>
    value === 'cold' ? '冷开' : value === 'warm' ? '暖开' : (value ?? '—');
  const measured = state.rows.filter((row) => Number.isFinite(row.firstGeometryMs));
  const visibleGeometry =
    measured.length > 0 &&
    measured.every((row) => row.geometryTimingPolicy === 'in-viewport-model-draw-submitted-v1');
  const geometryTitle = visibleGeometry ? '首次可见 s' : '首次几何 s';
  const showRepetition = state.repetitions > 1 || state.rows.some((row) => row.repetition > 1);
  const trackColumns = [
    ['DEV 首绘提交 s', 'devFirstDrawSubmittedMs'],
    ['DEV 基础结算 s', 'devBaseSettledMs'],
    ['IFC 首绘提交 s', 'ifcFirstDrawSubmittedMs'],
    ['IFC 基础结算 s', 'ifcBaseSettledMs'],
  ];
  const showTracks = state.rows.some((row) =>
    trackColumns.some(([, key]) => Number.isFinite(row[key])),
  );
  const timeColumns = [
    ['导航响应 s', 'firstResponseMs'],
    ['模型树就绪 s', 'modelTreeReadyMs'],
    [geometryTitle, 'firstGeometryMs'],
    ...(showTracks ? trackColumns : []),
    ['自动表示 s', 'automaticLoadMs'],
    ['完全结算 s', 'settledMs'],
  ];
  const completeness = (value) => (value === true ? '完整' : value === false ? '不完整' : '未提供');
  const gpuStatus = (value, timing = false) =>
    ({
      available: '已有有效采样',
      'not-requested': '未启用',
      unsupported: timing ? '计时探针不支持' : '表示探针不支持',
      unavailable: '已请求但未取得有效数据',
    })[value] ?? '本次未记录';
  const gpuSummary = (key) => {
    const values = new Set(
      state.rows
        .filter((row) => !['PENDING', 'RUNNING'].includes(row.status))
        .map((row) => row[key]),
    );
    return values.size
      ? [...values].map((value) => gpuStatus(value, key === 'gpuTimingStatus')).join(' / ')
      : '尚无运行记录';
  };
  const renderDetails = (row) => {
    const facts = [];
    if (typeof row.measurementComplete === 'boolean')
      facts.push(['测量采集', completeness(row.measurementComplete)]);
    if (typeof row.memoryEvidenceComplete === 'boolean')
      facts.push(['内存证据', completeness(row.memoryEvidenceComplete)]);
    if (typeof row.measurementLifecycleComplete === 'boolean')
      facts.push(['任务生命周期', completeness(row.measurementLifecycleComplete)]);
    if (row.measurementDetailStatus || Number.isFinite(row.measurementDetailDropped)) {
      const status =
        { complete: '完整', 'aggregate-only': '仅聚合完整', incomplete: '不完整' }[
          row.measurementDetailStatus
        ] ?? '状态未提供';
      facts.push([
        '测量事件明细',
        status +
          (Number.isFinite(row.measurementDetailDropped)
            ? `；容量丢弃 ${row.measurementDetailDropped} 条`
            : '；丢弃数量未提供'),
      ]);
    }
    if (typeof row.devContentComplete === 'boolean')
      facts.push([
        'DEV L0 内容证据',
        completeness(row.devContentComplete) +
          (Number.isFinite(row.devContentCovered) ? `，覆盖 ${row.devContentCovered} 个表示` : ''),
      ]);
    facts.push([
      'GPU Pass 计时',
      gpuStatus(row.gpuTimingStatus, true) +
        (row.gpuTimingStatus === 'available' && Number.isFinite(row.gpuTimingSamples)
          ? `，${row.gpuTimingSamples} 个有效查询`
          : ''),
    ]);
    facts.push([
      'GPU 显存（表示探针）',
      Number.isFinite(row.gpuMemoryBytes)
        ? numeric(row.gpuMemoryBytes, 2 ** 20) + ' MiB'
        : gpuStatus(row.gpuMemoryStatus),
    ]);
    if (row.gpuMemoryScope === 'DEV-representations-only')
      facts.push(['显存证据范围', '仅 DEV 表示，不是整机或整个工程的显存']);
    for (const [label, key, scale, unit] of [
      ['基础几何齐备', 'allGeometryReadyMs', 1000, 's'],
      ['DEV 写排水', 'writeDrainMs', 1000, 's'],
      ['DEV 写入', 'cacheWriteBytes', 2 ** 20, 'MiB'],
      ['DEV 写入服务', 'cacheWriteMsPerMiB', 1, 'ms/MiB'],
    ])
      if (Number.isFinite(row[key])) facts.push([label, numeric(row[key], scale) + ' ' + unit]);
    for (const [label, keys] of [
      [
        'DEV：启动／首个可用／首次绘制提交／基础结算',
        ['devFirstStartMs', 'devFirstUsableMs', 'devFirstDrawSubmittedMs', 'devBaseSettledMs'],
      ],
      [
        'IFC：获准加载／实际转换开始／首个可用／首次绘制提交／基础结算',
        [
          'ifcFirstLoadAdmittedMs',
          'ifcFirstConversionStartMs',
          'ifcFirstUsableMs',
          'ifcFirstDrawSubmittedMs',
          'ifcBaseSettledMs',
        ],
      ],
      [
        'IFC：首文件列表等待／首转换插槽等待',
        ['ifcFirstOrderedWaitMs', 'ifcFirstConversionSlotWaitMs'],
      ],
    ])
      if (keys.some((key) => Number.isFinite(row[key]))) {
        facts.push([
          label,
          keys
            .map((key) => (Number.isFinite(row[key]) ? numeric(row[key], 1000) + ' s' : '未观察'))
            .join(' / '),
        ]);
      }
    if (row.ifcFirstUsableSource) facts.push(['首个可用 IFC 的来源', row.ifcFirstUsableSource]);
    if (row.ifcFirstConversionPath) facts.push(['首次 IFC 转换原因', row.ifcFirstConversionPath]);
    if (row.projectType) facts.push(['模型类型', row.projectType]);
    if (row.group) facts.push(['样本分组', row.group]);
    if (row.inputVariant) facts.push(['输入变体', row.inputVariant]);
    return facts.length
      ? '<details class="row-details"><summary>测量与运行详情</summary><dl>' +
          facts
            .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
            .join('') +
          '</dl></details>'
      : '';
  };
  const renderIssues = (row) => {
    const lines = diagnosticLines(row, state.workers ?? []);
    const empty =
      { PENDING: '尚未执行', RUNNING: '执行中', PASS: '未记录问题' }[row.status] ??
      '原因未提供，需核对原始记录';
    return (
      (lines.length
        ? '<ul class="diagnostics">' +
          lines.map((text) => '<li>' + escapeHtml(text) + '</li>').join('') +
          '</ul>'
        : `<span class="note">${escapeHtml(empty)}</span>`) + renderDetails(row)
    );
  };
  const columns = [
    {
      label: state.anonymize ? '样本别名' : '样本',
      cell: (row) => escapeHtml(row.sampleLabel ?? row.sampleId ?? row.inputId),
    },
    ...(showRepetition
      ? [{ label: '轮次', cell: (row) => escapeHtml(row.repetition ?? '—'), numeric: true }]
      : []),
    { label: '冷 / 暖', cell: (row) => escapeHtml(cacheLabel(row.cacheState)) },
    {
      label: '结果',
      cell: (row) => `<span class="${escapeHtml(row.status)}">${escapeHtml(row.status)}</span>`,
    },
    ...timeColumns.map(([label, key]) => ({
      label,
      cell: (row) => seconds(row[key]),
      numeric: true,
    })),
    {
      label: '进程峰值 GiB',
      cell: (row) => numeric(row.processPrivatePeakBytes, 2 ** 30),
      numeric: true,
    },
    { label: '问题与缺口', cell: renderIssues, className: 'issues' },
  ];
  const rows = state.rows
    .map(
      (row) =>
        `<tr data-status="${escapeHtml(row.status)}">${columns.map((column) => `<td class="${column.numeric ? 'number' : (column.className ?? '')}">${column.cell(row)}</td>`).join('')}</tr>`,
    )
    .join('');
  const distribution = (row) => {
    const statuses = [
      ['PASS', row.passed],
      ['PARTIAL', row.partial],
      ['失败', row.failed],
      ['INCONCLUSIVE', row.inconclusive],
      ['跳过', row.skipped],
    ];
    const pending = row.planned - statuses.reduce((sum, [, count]) => sum + count, 0);
    if (pending > 0) statuses.push(['待结束', pending]);
    return (
      statuses
        .filter(([, count]) => count > 0)
        .map(([label, count]) => `${label} ${count}`)
        .join(' · ') +
      (row.coverageGroups > 1 ? '；覆盖不一致，中位数不汇总' : '') +
      (row.startupRetries ? `；启动重试 ${row.startupRetries} 次` : '')
    );
  };
  const summaryColumns = [
    '样本',
    '冷 / 暖',
    '有效 / 计划',
    '结果分布',
    ...timeColumns.map(([label]) => label.replace(' s', '中位 s')),
    '进程峰值中位 GiB',
  ];
  const summaryRows = summaries
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.sampleLabel ?? row.sampleId ?? row.inputId)}</td><td>${escapeHtml(cacheLabel(row.cacheState))}</td><td class="number">${row.validRepetitions}/${row.planned}</td><td>${escapeHtml(distribution(row))}</td>${timeColumns.map(([, key]) => `<td class="number">${seconds(row[key + 'Median'])}</td>`).join('')}<td class="number">${numeric(row.processPrivatePeakBytesMedian, 2 ** 30)}</td></tr>`,
    )
    .join('');
  const calibration = state.environmentCalibration;
  const gib = (bytes) => (Number.isFinite(bytes) ? numeric(bytes, 2 ** 30, 1) : '不可用');
  const calibrationNote = Number.isFinite(calibration?.cpuMs)
    ? `控制器校准：CPU SHA256 ${numeric(calibration.cpuMs, 1, 1)} ms · 工作区同步写 ${numeric(calibration.writeSyncMs, 1, 1)} ms · 暖读 ${numeric(calibration.readWarmMs, 1, 1)} ms · CPU ${calibration.machine?.cpuModel ?? '未知'} / ${calibration.machine?.reportedCpuMHz ?? '未知'} MHz · 空闲内存 ${gib(calibration.machine?.freeMemoryBytes)} GiB · 工作区可用 ${gib(calibration.machine?.diskAvailableBytes)} GiB · 电源模式 ${calibration.machine?.powerMode ?? '不可用'}`
    : '控制器校准：不可用；正式跨轮比较需要完整校准证据。';
  const statusOptions = Object.keys(counts)
    .sort()
    .map((key) => `<option>${escapeHtml(key)}</option>`)
    .join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GIM Benchmark 批量报告</title>
<style>
body{font:14px system-ui,sans-serif;background:#101923;color:#e3edf7;margin:24px}h1{font-size:26px}a{color:#80bdff}header{display:flex;gap:24px;align-items:baseline;flex-wrap:wrap}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}.card{padding:10px 18px;background:#1d2d3e;border-radius:8px}.note{color:#aebfd0;line-height:1.6}.scroll{overflow:auto;border:1px solid #32455b;max-height:75vh}
table{border-collapse:collapse;width:100%;font-size:13px}.results-table{min-width:1280px}.summary-table{min-width:1180px}th,td{padding:9px 10px;text-align:left;border-bottom:1px solid #304055;vertical-align:top;line-height:1.5}th{background:#203347;cursor:pointer;white-space:nowrap;position:sticky;top:0}td{overflow-wrap:anywhere}th.number,td.number{white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums}.results-table th.number,.summary-table th.number{min-width:96px}.results-table th:first-child,.summary-table th:first-child{min-width:150px}.issues{min-width:260px;max-width:380px}.diagnostics{margin:0;padding-left:18px}.diagnostics li+li{margin-top:5px}tr:nth-child(even){background:#162332}
.PASS{color:#77e6b5}.PARTIAL,.INCONCLUSIVE,.SKIPPED,.CANCELLED{color:#ffd587}.FAIL,.ERROR,.INPUT_ERROR{color:#ff9e9e}input,select{font:inherit;padding:8px;background:#1d2d3e;color:#fff;border:1px solid #536b84;border-radius:4px;margin:6px}
.tabs{display:flex;gap:8px;margin:20px 0 12px;border-bottom:1px solid #405268}.tabs button{font:inherit;color:#b8c9da;background:transparent;border:0;border-bottom:3px solid transparent;padding:10px 16px;cursor:pointer}.tabs button[aria-selected="true"]{color:#fff;border-bottom-color:#4a9dff}.tabs button:focus-visible{outline:2px solid #80bdff;outline-offset:2px}[hidden]{display:none!important}
summary{cursor:pointer;color:#a9cfff}.metadata{margin:12px 0}.row-details{margin-top:8px;font-size:12px}.row-details dl{margin:8px 0;display:grid;grid-template-columns:auto 1fr;gap:5px 10px}.row-details dt{color:#aebfd0}.row-details dd{margin:0}footer{margin-top:24px}
</style>
<header><h1>GIM Benchmark</h1><strong>${escapeHtml(state.status)} · ${escapeHtml(state.outcome)}</strong></header>
<p class="note">${state.anonymize ? '匿名样本' : '样本文件名'} · ${escapeHtml(state.preset)} · ${state.repetitions} 轮 · ${escapeHtml(state.updatedAt)}</p>
${progress ? `<p class="note" id="progress">已结束 ${progress.completed} / ${progress.total} 项，运行中 ${progress.running} 项，待执行 ${progress.pending} 项。刷新查看最近检查点；检查点不是控制器仍存活的证明。<br>完整 CSV 在结束或恢复后导出。若控制器已退出，在 desktop/ 中执行 <code>npm run bench -- recover-batch --output &lt;本报告目录&gt;</code>；未完成项不会计为通过。<br><a href="status.json">进度 JSON</a> · <a href="profile.json">冻结计划</a></p>` : ''}
<details class="metadata"><summary>构建与环境信息</summary><p class="note">构建 ${escapeHtml(buildLabel(state))}<br>源码指纹 ${escapeHtml(state.buildFingerprint ?? '未记录')}<br>可执行文件 ${escapeHtml(state.buildInfo?.executableSha256 ?? '未记录')}<br>固定运行时 ${escapeHtml(state.buildInfo?.runtimeSha256 ?? '未记录')}<br>Profile ${escapeHtml(state.profileDigest ?? '未记录')}</p><p class="note">${escapeHtml(calibrationNote)}</p></details>
<p class="note" id="gpu-summary"><b>GPU</b> · 型号 / 驱动：本批未记录 · Pass 计时：${escapeHtml(gpuSummary('gpuTimingStatus'))} · 显存：${escapeHtml(gpuSummary('gpuMemoryStatus'))}。进程 Private Bytes 不是 GPU 显存；未采集的 GPU 耗时或显存不填 0。</p>
<div class="cards">${Object.entries(counts)
    .map(
      ([key, value]) =>
        `<div class="card ${escapeHtml(key)}">${escapeHtml(key)} <b>${value}</b></div>`,
    )
    .join('')}</div>
<p class="note">时间为从打开工程起的秒数；进程峰值为进程树 Private Bytes 观测峰值。导航响应、首个几何与自动表示分别记录，完全结算包括任务、缓存、后台及静默窗口。${visibleGeometry ? '首次可见确认实体进入有效视口的绘制流程，不等待 GPU 完成。' : '本批次未提供统一的可见性计时口径，首次几何不推定为首次实体可见。'}<br>来源缺陷和测量完整性分别判断：<b>测量事件丢弃 0 条，不表示模型没有缺陷。</b>空值为未取得；完整诊断见行内详情和 CSV / JSON。</p>
${showTracks ? '<p class="note">DEV 和 IFC 各自记录首次有效视口绘制提交与基础结算。两轨共用工程打开时的计时起点。</p>' : ''}
<div class="tabs" role="tablist" aria-label="报告视图"><button id="tab-results" type="button" role="tab" aria-controls="panel-results" aria-selected="true" tabindex="0">测量结果</button><button id="tab-coverage" type="button" role="tab" aria-controls="panel-coverage" aria-selected="false" tabindex="-1">样本覆盖</button></div>
<section id="panel-coverage" role="tabpanel" aria-labelledby="tab-coverage" hidden><p class="note">中位数只使用同一覆盖状态的 PASS / PARTIAL 轮次；失败、未完成项不作为有效轮次，覆盖不一致时不合并。</p><div class="scroll"><table class="summary-table"><thead><tr>${summaryColumns.map((value, index) => `<th scope="col"${index === 2 || index >= 4 ? ' class="number"' : ''}>${escapeHtml(value)}</th>`).join('')}</tr></thead><tbody>${summaryRows}</tbody></table></div></section>
<section id="panel-results" role="tabpanel" aria-labelledby="tab-results">
${progress ? '' : `<details class="metadata"><summary>完整数据与诊断下载</summary><p><a href="results.csv">全部结果 CSV</a> · <a href="errors.csv">错误 CSV</a> · <a href="summary.csv">汇总 CSV</a> · <a href="stages.csv">阶段 CSV</a> · <a href="slow-tasks.csv">慢任务 CSV</a> · <a href="slow-phases.csv">慢阶段 CSV</a> · <a href="slow-templates.csv">慢模板 CSV</a> · <a href="workers.csv">Worker CSV</a> · <a href="results.json">JSON</a></p></details>`}
<label>筛选 <input id="search" placeholder="样本 / 结果 / 问题"></label><label>状态 <select id="status"><option value="">全部</option>${statusOptions}</select></label><span id="visible"></span>
<div class="scroll"><table id="results" class="results-table"><thead><tr>${columns.map((column) => `<th scope="col"${column.numeric ? ' class="number"' : ''}>${escapeHtml(column.label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></section>
<footer class="note">${state.baselineEligible ? '当前冷暖测量证据齐备；是否认可为基线仍须开发者显式决定，PARTIAL 来源缺口需单独复核。' : '此报告尚不是认可基线；摸底结果或不完整测量不作为基线通过。'}<br>${state.anonymize ? '此报告已隐藏源路径与文件名。' : '此报告包含样本文件名，分享前请确认资料权属。'}完整记录保留运行标识与来源/测量字段；原始日志、授权清单、profile 和堆快照仅留在工作区私有目录。</footer>
<script>
const tabs=[...document.querySelectorAll('[role="tab"]')];
function selectTab(tab){for(const item of tabs){const active=item===tab;item.setAttribute('aria-selected',String(active));item.tabIndex=active?0:-1;document.getElementById(item.getAttribute('aria-controls')).hidden=!active}}
for(const tab of tabs){tab.onclick=()=>selectTab(tab);tab.onkeydown=event=>{if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;event.preventDefault();const next=tabs[(tabs.indexOf(tab)+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length];selectTab(next);next.focus()}}
const table=document.querySelector('#results'),body=table.tBodies[0],search=document.querySelector('#search'),status=document.querySelector('#status');
function filter(){let n=0;for(const row of body.rows){const show=(!status.value||row.dataset.status===status.value)&&row.textContent.toLowerCase().includes(search.value.toLowerCase());row.hidden=!show;if(show)n++}document.querySelector('#visible').textContent=n+' 行'}
search.oninput=status.onchange=filter;
table.querySelectorAll('th').forEach((th,index)=>{let ascending=true;th.onclick=()=>{const rows=[...body.rows];rows.sort((a,b)=>{const x=a.cells[index].textContent,y=b.cells[index].textContent;return (ascending?1:-1)*(x!==''&&y!==''&&Number.isFinite(+x)&&Number.isFinite(+y)?+x-+y:x.localeCompare(y))});rows.forEach(row=>body.append(row));ascending=!ascending}});filter();
</script></html>`;
}
