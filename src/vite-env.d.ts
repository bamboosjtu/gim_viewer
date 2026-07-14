/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 强制启用 MapLibre overlay（生产环境可用） */
  readonly VITE_ENABLE_MAPLIBRE?: string;
  /** 天地图 API 密钥（https://console.tianditu.gov.cn/） */
  readonly VITE_TIANDITU_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
