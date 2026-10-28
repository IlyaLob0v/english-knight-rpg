/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the gateway (apps/server). Default "/api", proxied by the Vite dev server. */
  readonly VITE_API_BASE?: string;
}
