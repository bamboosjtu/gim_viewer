/**
 * 应用设置面板。
 *
 * 目前包含天地图 API Key（本地数据库保存，不再从 .env 读取）与 IFC 大文件
 * 跳过开关。密钥不写入构建产物，也不随工程缓存分发。
 */
import {
  LARGE_IFC_BYTES,
  SETTING_SKIP_LARGE_IFC,
  SETTING_TIANDITU_KEY,
  getSetting,
  isSettingEnabled,
  updateSetting,
} from '../services/appSettings.js';

let modal: HTMLElement | null = null;

function close(): void {
  modal?.remove();
  modal = null;
}

export function openSettingsPanel(): void {
  if (modal) return;
  const key = getSetting(SETTING_TIANDITU_KEY);
  const skipLarge = isSettingEnabled(SETTING_SKIP_LARGE_IFC);
  const largeMb = Math.round(LARGE_IFC_BYTES / (1024 * 1024));

  modal = document.createElement('div');
  modal.id = 'settings-modal';
  modal.className = 'cache-modal';
  modal.innerHTML = `
    <div class="cache-dialog" role="dialog" aria-modal="true" aria-label="设置">
      <div class="cache-head">
        <div>
          <h2>设置</h2>
          <div class="cache-sub">保存在本机数据库，不写入构建产物</div>
        </div>
        <button id="settings-close" class="cache-close" aria-label="关闭">×</button>
      </div>
      <div class="cache-body">
        <section class="settings-section">
          <div class="settings-title">天地图 API Key</div>
          <div class="settings-desc">用于线路工程的卫星影像 / 地形图 / 矢量图底图；留空表示未配置，自动回退 OSM。<a href="https://console.tianditu.gov.cn/" target="_blank" rel="noreferrer">申请 Key</a></div>
          <input id="settings-tianditu-key" class="settings-input" type="password" autocomplete="off"
            placeholder="粘贴天地图 API Key" />
          <label class="settings-check">
            <input id="settings-skip-large" type="checkbox" ${skipLarge ? 'checked' : ''} />
            跳过超过 ${largeMb} MB 的非关键 IFC（默认关闭：后台继续转换）
          </label>
          <div class="settings-note">修改天地图 Key 后，重新打开线路工程生效；跳过开关在下一次打开工程时生效。</div>
        </section>
        <div id="settings-status" class="settings-status" role="status"></div>
      </div>
      <div class="cache-foot">
        <button id="settings-clear" class="cache-btn danger">清除 Key</button>
        <button id="settings-cancel" class="cache-btn">取消</button>
        <button id="settings-save" class="cache-btn primary">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const keyInput = modal.querySelector<HTMLInputElement>('#settings-tianditu-key')!;
  keyInput.value = key;
  const skipInput = modal.querySelector<HTMLInputElement>('#settings-skip-large')!;
  const status = modal.querySelector<HTMLElement>('#settings-status')!;
  const setStatus = (text: string, error = false): void => {
    status.textContent = text;
    status.classList.toggle('error', error);
  };

  modal.querySelector('#settings-close')?.addEventListener('click', close);
  modal.querySelector('#settings-cancel')?.addEventListener('click', close);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });

  const save = async (): Promise<void> => {
    const saveButton = modal?.querySelector<HTMLButtonElement>('#settings-save');
    if (saveButton) saveButton.disabled = true;
    setStatus('保存中…');
    try {
      await updateSetting(SETTING_TIANDITU_KEY, keyInput.value.trim());
      await updateSetting(SETTING_SKIP_LARGE_IFC, skipInput.checked ? '1' : '0');
      setStatus('已保存');
      setTimeout(() => { if (modal) close(); }, 400);
    } catch (error) {
      setStatus(`保存失败: ${error instanceof Error ? error.message : String(error)}`, true);
    } finally {
      if (saveButton) saveButton.disabled = false;
    }
  };

  modal.querySelector('#settings-save')?.addEventListener('click', () => { void save(); });
  modal.querySelector('#settings-clear')?.addEventListener('click', () => {
    keyInput.value = '';
    setStatus('Key 已清空，点击“保存”生效');
  });
  keyInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void save();
  });
}
