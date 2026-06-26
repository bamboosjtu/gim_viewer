/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 强制启用 MapLibre overlay（生产环境可用） */
  readonly VITE_ENABLE_MAPLIBRE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
