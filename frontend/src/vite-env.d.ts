/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Empty in production, where the Fastify app serves these assets itself. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
