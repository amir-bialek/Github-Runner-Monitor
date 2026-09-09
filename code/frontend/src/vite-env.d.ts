/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
  readonly VITE_GITHUB_TOKEN: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface AppConfig {
  readonly heading?: string
  readonly tabTitle?: string
  readonly historyLimit?: number
  readonly historyPageSize?: number
  readonly queuePageSize?: number
  readonly queueMaxItems?: number
  readonly runningPageSize?: number
  readonly runnersRefreshSeconds?: number
}

interface Window {
  __APP_CONFIG__?: AppConfig
}
