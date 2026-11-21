// Additive diagnostic fields; never used for correctness or regression gates.
const moments = {
  devFirstStartMs: 'devFirstStart',
  devFirstUsableMs: 'devFirstUsable',
  devFirstDrawSubmittedMs: 'devFirstDrawSubmitted',
  devBaseSettledMs: 'devBaseSettled',
  ifcFirstLoadAdmittedMs: 'ifcFirstLoadAdmitted',
  ifcFirstConversionStartMs: 'ifcFirstConversionStart',
  ifcFirstUsableMs: 'ifcFirstUsable',
  ifcFirstDrawSubmittedMs: 'ifcFirstDrawSubmitted',
  ifcBaseSettledMs: 'ifcBaseSettled',
};
export const geometryTrackTimingKeys = [
  ...Object.keys(moments), 'ifcFirstOrderedWaitMs', 'ifcFirstConversionSlotWaitMs',
];
export const geometryTrackSources = {
  ifcFirstUsableSource: ['lod-cache', 'ifc', 'unknown'],
  ifcFirstConversionPath: ['cache-miss', 'cache-restore-failed', 'raw-policy'],
};
export const geometryTrackKeys = [...geometryTrackTimingKeys, ...Object.keys(geometryTrackSources)];

const timeOrNull = value => Number.isFinite(value) && value >= 0 ? value : null;

export function geometryTrackMetrics(observation) {
  const details = observation?.geometryTrackDetails;
  const values = Object.fromEntries(
    Object.entries(moments).map(([key,moment]) => [key,timeOrNull(observation?.moments?.[moment])]),
  );
  values.ifcFirstOrderedWaitMs = values.ifcFirstLoadAdmittedMs === null
    ? null : timeOrNull(details?.ifcFirstOrderedWaitMs);
  values.ifcFirstConversionSlotWaitMs = values.ifcFirstConversionStartMs === null
    ? null : timeOrNull(details?.ifcFirstConversionSlotWaitMs);
  for (const [key,allowed] of Object.entries(geometryTrackSources)) {
    const relevant = key === 'ifcFirstUsableSource' ? values.ifcFirstUsableMs : values.ifcFirstConversionStartMs;
    values[key] = relevant !== null && allowed.includes(details?.[key]) ? details[key] : null;
  }
  return values;
}
