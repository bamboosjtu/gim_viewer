import {afterEach,it,expect,vi} from 'vitest';
import {logger,setLogSink,debugLog,debugWarn} from '../logger.js';
afterEach(()=>setLogSink());
it('preserves error identity and structured context in the selected sink',()=>{
  const sink=vi.fn(),error=Object.assign(Error('same display message'),{code:'SOURCE_CHANGED'});setLogSink(sink);
  debugLog(false,'ignored');debugWarn(false,'ignored');logger.error('open',error);debugWarn(true,'context',{project:1});
  expect(sink).toHaveBeenCalledTimes(2);expect(sink.mock.calls[0]).toEqual(['error',['open',error]]);
  expect(sink.mock.calls[0][1][1]).toBe(error);
});
