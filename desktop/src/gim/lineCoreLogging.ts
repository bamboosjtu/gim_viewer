import { setParserLogSink } from '../../../packages/powerline-core/src/diagnostics.js';
import { DEBUG_RUNTIME_LOGS, DEBUG_LINE_MAP } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
setParserLogSink((...args) => debugLog(String(args[0]).startsWith('[LineMapData]') ? DEBUG_LINE_MAP : DEBUG_RUNTIME_LOGS, ...args));
