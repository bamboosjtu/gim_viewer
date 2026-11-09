import {vi} from 'vitest';
import type {DeviceRuntime} from '../../../shared/deviceRuntime.js';

export function createDeviceRuntimeMock(overrides:Partial<DeviceRuntime>={}):DeviceRuntime{
  return {select:vi.fn(async()=>[]),clearSelection:vi.fn(),release:vi.fn(),diagnostics:{},...overrides};
}
