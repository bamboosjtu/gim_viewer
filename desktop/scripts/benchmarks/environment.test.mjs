import {test} from 'node:test';
import assert from 'node:assert/strict';
import {confirmedEnvironmentSuspend} from './environment.mjs';

test('lock and suspend evidence plus observation gap is required before classifying infrastructure suspend',()=>{
  const log='VideoCaptureManager::OnScreenLocked\nMSPL::OnSuspend';
  assert.equal(confirmedEnvironmentSuspend('renderer-process-exited',log,90000),true);
  assert.equal(confirmedEnvironmentSuspend('renderer-process-exited',log,5000),false);
  assert.equal(confirmedEnvironmentSuspend('renderer-process-exited','unrelated crash',90000),false);
  assert.equal(confirmedEnvironmentSuspend('project-open-failed',log,90000),false);
});
