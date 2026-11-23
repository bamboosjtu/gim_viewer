import {describe,expect,it} from 'vitest';
import {parseKeyValue} from '../kvParser.js';
describe('parseKeyValue', () => {
  it('解析标准 KEY=VALUE 格式', () => {
    const result = parseKeyValue('ENTITYNAME=F1System\nSUBSYSTEM=area.cbm');
    expect(result['ENTITYNAME']).toBe('F1System');
    expect(result['SUBSYSTEM']).toBe('area.cbm');
  });

  it('空字符串返回空对象', () => {
    expect(parseKeyValue('')).toEqual({});
  });

  it('忽略空行和无效行', () => {
    const result = parseKeyValue('\n\nKEY=val\n\n=noval\nvalonly\n');
    expect(result['KEY']).toBe('val');
    expect(Object.keys(result)).toHaveLength(1);
  });

  it('VALUE 中含等号也能正确解析', () => {
    const result = parseKeyValue('FORMULA=a=b+c');
    expect(result['FORMULA']).toBe('a=b+c');
  });

  it('trim 键值两端空白', () => {
    const result = parseKeyValue('  KEY  =  value  ');
    expect(result['KEY']).toBe('value');
  });

  it('支持 \\r\\n 换行', () => {
    const result = parseKeyValue('KEY1=val1\r\nKEY2=val2\r\n');
    expect(result['KEY1']).toBe('val1');
    expect(result['KEY2']).toBe('val2');
  });

  it('重复冲突键不选择任一值', () => {
    const result = parseKeyValue('KEY=first\nKEY=second');
    expect(result['KEY']).toBe('');
  });

  it('等号在行首（idx=0）的行被忽略', () => {
    const result = parseKeyValue('=value\nKEY=val');
    expect(result['KEY']).toBe('val');
    expect(result['']).toBeUndefined();
  });
});
