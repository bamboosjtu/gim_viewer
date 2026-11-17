import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeContractCallErrors} from './native-contract-boundaries.mjs';
test('native own-command strings cannot drift from the generated command map',()=>{
  assert.deepEqual(nativeContractCallErrors('invokeTimed(DESKTOP_COMMANDS.get_file_info,{path});invoke(command,args);','bridge.ts'),[]);
  for(const code of ["invokeTimed('get_file_info')","invoke('unknown_native')","invokeCommand('plugin:gim-import|pick')"])assert.equal(nativeContractCallErrors(code,'bridge.ts').length,1);
  assert.deepEqual(nativeContractCallErrors("invoke('plugin:dialog|open')",'bridge.ts'),[]);
});
