/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Connection target of the API server (e.g. https://example.com). When unset, a same-origin relative path is used.
   */
  readonly VITE_API_BASE?: string;
}
