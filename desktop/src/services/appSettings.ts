/**
 * 应用设置：保存在本地 SQLite 的 app_setting 表，页面启动时加载到内存。
 *
 * 目前包含：
 * - `tianditu.apiKey`：天地图 API 密钥（不再从 .env / 构建产物读取）
 * - `ifc.skipLargeFiles`：跳过超过阈值的非关键 IFC（默认关闭，允许后台长转换）
 *
 * 浏览器开发模式没有原生数据库，设置只在当前会话内存中生效。
 */
import { getAppSettings, setAppSetting } from '@desktop/database.js';
import { isTauri } from '@desktop/runtime.js';
import { setTiandituKey } from '../config/tianditu.js';

export const SETTING_TIANDITU_KEY = 'tianditu.apiKey';
export const SETTING_SKIP_LARGE_IFC = 'ifc.skipLargeFiles';

/** 超过该大小的单 IFC 视为超大文件（后台长转换，可被跳过开关排除）。 */
export const LARGE_IFC_BYTES = 64 * 1024 * 1024;

const values = new Map<string, string>();
let loaded = false;

export async function loadAppSettings(): Promise<void> {
  if (loaded) return;
  loaded = true;
  if (!isTauri()) return;
  try {
    const settings = await getAppSettings();
    for (const [key, value] of Object.entries(settings)) values.set(key, value);
  } catch (error) {
    console.warn('[settings] 读取应用设置失败:', error);
  }
  setTiandituKey(values.get(SETTING_TIANDITU_KEY) ?? '');
}

export function getSetting(key: string): string {
  return values.get(key) ?? '';
}

export function isSettingEnabled(key: string): boolean {
  return values.get(key) === '1';
}

export function shouldSkipLargeIfc(): boolean {
  return isSettingEnabled(SETTING_SKIP_LARGE_IFC);
}

/** 更新设置并立即应用；空值表示清除。 */
export async function updateSetting(key: string, value: string): Promise<void> {
  const normalized = value ?? '';
  if (normalized) values.set(key, normalized);
  else values.delete(key);
  if (key === SETTING_TIANDITU_KEY) setTiandituKey(normalized);
  if (isTauri()) await setAppSetting(key, normalized);
  window.dispatchEvent(new CustomEvent('gim:settings-changed', { detail: { key, value: normalized } }));
}
