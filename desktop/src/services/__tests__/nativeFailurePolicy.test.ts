import {it,expect} from 'vitest';
import {GimError} from '@desktop/contracts.js';
import {canFallbackFromNativeExtraction,canRecoverNativeExtractionReceipt} from '../openGimService.js';

it('chooses native extraction fallback from codes independently of display language',()=>{
  for(const code of ['RESOURCE_LIMIT','INPUT_CORRUPT','SOURCE_CHANGED','SESSION_SUPERSEDED','CANCELLED','UNAUTHORIZED','PROTOCOL_INVALID','OPERATION_FAILED'] as const){
    expect(canFallbackFromNativeExtraction(new GimError(code,'unavailable'))).toBe(false);
  }
  for(const code of ['IO','BACKEND_UNAVAILABLE','UNSUPPORTED_FORMAT'] as const){
    expect(canFallbackFromNativeExtraction(new GimError(code,'资源配额，损坏，source materializing'))).toBe(true);
  }
  expect(canFallbackFromNativeExtraction(new Error('native failed'))).toBe(false);
  expect(canFallbackFromNativeExtraction(new GimError('RESPONSE_INVALID','payload truncated'))).toBe(false);
  expect(canRecoverNativeExtractionReceipt(new GimError('RESPONSE_INVALID','payload truncated'))).toBe(true);
  expect(canRecoverNativeExtractionReceipt(new GimError('PROTOCOL_INVALID','old native string'))).toBe(false);
});
