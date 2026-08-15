/**
 * Network endpoint resolution for the browser.
 *
 * The SDK providers construct `new URL(...)` internally, so every endpoint
 * MUST be absolute. Local devnet: everything flows through the Vite dev-server
 * proxy (no CORS issues, no config needed). Public networks (preview/preprod):
 * real URLs passed at build time via MIDNIGHT_INDEXER_URL etc. — see
 * vite.config.ts.
 */
const DEFINES = (globalThis as any).__MIDNIGHT_INDEXER_URL__ !== undefined;

function absolute(base: string, path: string): string {
  return new URL(path, base).toString();
}

export interface NetworkEndpoints {
  indexer: string;
  indexerWS: string;
  proofServer: string;
  zkBaseURL: string;
}

export function resolveEndpoints(): NetworkEndpoints {
  const origin = globalThis.location?.origin ?? 'http://localhost:5173';
  const indexer = (globalThis as any).__MIDNIGHT_INDEXER_URL__ as string | undefined;
  if (DEFINES && indexer) {
    return {
      indexer,
      indexerWS: ((globalThis as any).__MIDNIGHT_INDEXER_WS_URL__ as string | undefined) ?? indexer.replace(/^http/, 'ws'),
      proofServer: ((globalThis as any).__MIDNIGHT_PROOF_SERVER_URL__ as string | undefined) ?? '',
      zkBaseURL: absolute(origin, '/zk'),
    };
  }
  // Devnet defaults through the Vite proxy — absolute URLs derived from the
  // page origin so the SDK's internal `new URL(...)` calls succeed.
  return {
    indexer: absolute(origin, '/api/v4/graphql'),
    indexerWS: absolute(origin, '/api/v4/graphql/ws').replace(/^https:/, 'wss:'),
    proofServer: absolute(origin, '/prove'),
    zkBaseURL: absolute(origin, '/zk'),
  };
}