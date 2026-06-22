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

/** 实际安装的 @thatopen/fragments 版本（构建期由 vite.config 注入，P2 评审 #7） */
declare const __FRAGMENTS_PKG_VERSION__: string;
/** 实际安装的 web-ifc 版本（构建期由 vite.config 注入） */
declare const __WEB_IFC_PKG_VERSION__: string;
