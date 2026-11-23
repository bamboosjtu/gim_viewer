import {describe,it,expect} from 'vitest';
import fixtures from '../../../../contracts/native-v1.fixtures.json';
import {GimError,nativeError,hasErrorCode} from '../errors.js';
import {NATIVE_ERROR_CODES} from '../generated/nativeContracts.js';

describe('native v1 error contract',()=>{
  it('uses the same error fixtures as Rust and keeps raw context',()=>{
    expect(fixtures.errors.map(error=>error.code)).toEqual([...NATIVE_ERROR_CODES]);
    for(const fixture of fixtures.errors){
      const error=nativeError(fixture);
      expect(error).toBeInstanceOf(GimError);expect(error.code).toBe(fixture.code);
      expect(error.message).toBe(fixture.message);expect(error.context).toEqual(fixture.context);
    }
  });
  it('never infers a code from localized or prefixed display text',()=>{
    for(const text of ['资源配额超限','INPUT_CORRUPT: CRC_ERROR','INDEX_INVALID: old format','source materializing']){
      expect(nativeError(text).code).toBe('PROTOCOL_INVALID');
      expect(hasErrorCode(text,'RESOURCE_LIMIT','INPUT_CORRUPT','INDEX_INVALID','SOURCE_MATERIALIZING')).toBe(false);
    }
    expect(nativeError({code:'FUTURE_CODE',message:'x'}).code).toBe('PROTOCOL_INVALID');
    expect(nativeError({code:'RESOURCE_LIMIT',message:17}).code).toBe('PROTOCOL_INVALID');
  });
});
