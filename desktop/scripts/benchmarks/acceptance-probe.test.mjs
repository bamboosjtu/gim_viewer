import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyNativeStartup} from './acceptance-probe.mjs';

test('native startup distinguishes browser process failure, setup denial, timeout and application exit', () => {
  assert.deepEqual(classifyNativeStartup("GPU process launch failed: error_code=18\nGPU process isn't usable. Goodbye.", null), {
    stage: 'webview-gpu-process-launch', gpuLaunchErrorCodes: [18], reason: 'WebView browser terminated after GPU process launch failures',
  });
  assert.equal(classifyNativeStartup('Failed to setup app: 拒绝访问。 (os error 5)', 101).stage, 'native-setup');
  assert.equal(classifyNativeStartup('', null).stage, 'native-startup-timeout');
  assert.equal(classifyNativeStartup('', 0).stage, 'native-process-exit');
});
