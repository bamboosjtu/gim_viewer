import {afterEach,it,expect,vi} from 'vitest';
import {logger,setLogSink,debugLog,debugWarn} from '../logger.js';
import {reportBackgroundError} from '../backgroundErrors.js';
afterEach(()=>setLogSink());
it('preserves error identity and structured context in the selected sink',()=>{
  const sink=vi.fn(),error=Object.assign(Error('same display message'),{code:'SOURCE_CHANGED'});setLogSink(sink);
  debugLog(false,'ignored');debugWarn(false,'ignored');logger.error('open',error);debugWarn(true,'context',{project:1});
  expect(sink).toHaveBeenCalledTimes(2);expect(sink.mock.calls[0]).toEqual(['error',['open',error]]);
  expect(sink.mock.calls[0][1][1]).toBe(error);
});
it('preserves native error code/context through the detached-work sink and ignores cancellation',()=>{
  const sink=vi.fn(),error={code:'SOURCE_CHANGED',message:'source changed',context:{operation:'restore'}};
  setLogSink(sink);reportBackgroundError(error);reportBackgroundError(new DOMException('cancelled','AbortError'));
  expect(sink).toHaveBeenCalledTimes(1);expect(sink.mock.calls[0]).toEqual(['error',['[Background task]',error]]);
  expect(sink.mock.calls[0][1][1]).toBe(error);
});
