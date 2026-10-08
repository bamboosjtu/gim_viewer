/** Optional host logging; parsing has no dependency on a UI or runtime. */
export const DEBUG_RUNTIME_LOGS = true;
export const DEBUG_LINE_MAP = true;
let sink: ((...args: unknown[]) => void) | undefined;
export function setParserLogSink(value?: (...args: unknown[]) => void): void { sink = value; }
export function debugLog(enabled: boolean, ...args: unknown[]): void { if (enabled) sink?.(...args); }
