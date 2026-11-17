import {it,expect} from 'vitest';
import {createIfcRuntimeModelId} from '../projectSession.js';
  it('运行时 ID 绑定源 GIM 身份，同时保持 logical ID 稳定', () => {
    const logical = 'logical-model';
    const runtimeA = createIfcRuntimeModelId('sha-a', logical);
    const runtimeB = createIfcRuntimeModelId('sha-b', logical);
    expect(runtimeA).not.toBe(logical);
    expect(runtimeA).not.toBe(runtimeB);
    expect(runtimeA).toBe(createIfcRuntimeModelId('SHA-A', logical));
    expect(createIfcRuntimeModelId('sha-a', logical, 1))
      .not.toBe(createIfcRuntimeModelId('sha-a', logical, 2));
  });

