import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// Devnet services are reached through the Vite dev-server proxy (no CORS
// issues, no config needed). Public networks (preview/preprod) use real URLs
// configured via the MIDNIGHT_INDEXER_URL / MIDNIGHT_PROOF_SERVER_URL env vars
// loaded from the .env file.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const indexerUrl = env.MIDNIGHT_INDEXER_URL;
  const indexerWsUrl = env.MIDNIGHT_INDEXER_WS_URL;
  const proofServerUrl = env.MIDNIGHT_PROOF_SERVER_URL;

  return {
    plugins: [
      react(),
      wasm(),
      nodePolyfills({ include: ['buffer'], globals: { Buffer: true } }),
    ],
    optimizeDeps: {},
    server: {
      port: 5173,
      proxy: {
        '/api/v4/graphql': {
          target: 'http://127.0.0.1:8088',
          changeOrigin: true,
          ws: true,
        },
        '/api/v4/graphql/ws': {
          target: 'ws://127.0.0.1:8088',
          changeOrigin: true,
          ws: true,
        },
        '/prove': {
          target: 'http://127.0.0.1:6300',
          changeOrigin: true,
        },
      },
    },
    define: {
      __MIDNIGHT_INDEXER_URL__: JSON.stringify(indexerUrl ?? ''),
      __MIDNIGHT_INDEXER_WS_URL__: JSON.stringify(indexerWsUrl ?? ''),
      __MIDNIGHT_PROOF_SERVER_URL__: JSON.stringify(proofServerUrl ?? ''),
    },
    esbuild: { target: 'esnext' },
    resolve: {
      alias: {
        // cross-fetch's browser build exports an unbound window.fetch, which
        // throws "Illegal invocation" in Chrome — shim it with a bound wrapper.
        'cross-fetch': fileURLToPath(new URL('./src/lib/cross-fetch-shim.ts', import.meta.url)),
        // The Midnight SDK's storage chain (level → browser-level →
        // abstract-level) does `class … extends EventEmitter` from Node's
        // built-in 'events'. Vite externalizes Node builtins to an empty object
        // in the browser, so alias the npm browser-compatible 'events' package
        // (pure JS, no Node deps) in its place.
        events: 'events/events.js',
      },
    },
    build: {
      target: 'esnext',
      rollupOptions: {
        // The WASM wasm-modules plugin handles ledger WASM; nothing else is external.
      },
    },
  };
});
