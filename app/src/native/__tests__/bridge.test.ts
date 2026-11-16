import {beforeEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke,isTauri:()=>true,Channel:class {}}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn()}));
import {getSettings,readSource,chooseNativeFile} from '../bridge.js';

beforeEach(()=>{mocks.invoke.mockReset();});
it('normalizes application and platform plugin errors with the same v1 codes',async()=>{
  mocks.invoke.mockRejectedValue({code:'SOURCE_CHANGED',message:'任意语言'});
  await expect(getSettings()).rejects.toMatchObject({code:'SOURCE_CHANGED',message:'任意语言'});
  mocks.invoke.mockRejectedValue({code:'BACKEND_UNAVAILABLE',message:'platform unavailable'});
  await expect(chooseNativeFile(()=>{})).rejects.toMatchObject({code:'BACKEND_UNAVAILABLE'});
});
it('preserves successful source bytes and rejects legacy error strings as protocol failures',async()=>{
  mocks.invoke.mockResolvedValue('KEY=A=B');
  await expect(readSource('id','DEV/a.dev')).resolves.toBe('KEY=A=B');
  expect(mocks.invoke).toHaveBeenCalledWith('read_source',{id:'id',path:'DEV/a.dev'});
  mocks.invoke.mockRejectedValue('source materializing');
  await expect(readSource('id','DEV/a.dev')).rejects.toMatchObject({code:'PROTOCOL_INVALID'});
});
