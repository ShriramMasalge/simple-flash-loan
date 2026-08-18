/**
 * Browser wallet adapter around the Midnight wallet extension
 * (window.midnight, CAIP-372 / dapp-connector-api v4).
 *
 * Extensions inject their InitialAPI under the global window.midnight, keyed
 * by a UUID (e.g. window.midnight['a1b2…'], GSD) — discovering a wallet means
 * scanning Object.values(window.midnight) and filtering for the `connect`
 * entry point (one-arg: networkId → ConnectedAPI). Some wallets also expose
 * the older direct shape (window.midnight.connect). No extension installed is
 * an EXPECTED state — the app runs read-only (pool dashboard) and points at
 * `npm run demo` for the CLI path.
 */
export type WalletStatus = 'unsupported' | 'disconnected' | 'connecting' | 'connected' | 'error';

export interface WalletState {
  status: WalletStatus;
  networkId: string | null;
  address: string | null;
  error: string | null;
  /** ConnectedAPI (dapp-connector) instance when connected. */
  api: any;
}

declare global {
  interface Window {
    midnight?: Record<string, any>;
  }
}

export interface WalletApi {
  name?: string;
  rdns?: string;
  apiVersion?: string;
  connect: (networkId: string) => Promise<any>;
  disconnect?: () => Promise<void>;
}

/** Discover injected InitialAPI instances (UUID-keyed per v4, or legacy direct). */
export function listWallets(): WalletApi[] {
  if (typeof window === 'undefined' || !window.midnight || typeof window.midnight !== 'object') return [];
  const candidates: any[] = [...Object.values(window.midnight)];
  if (typeof window.midnight.connect === 'function') candidates.push(window.midnight);
  return candidates.filter(
    (w): w is WalletApi => !!w && typeof w === 'object' && typeof w.connect === 'function',
  );
}

/** True when any Midnight wallet extension injects the dapp-connector API. */
export function hasWalletExtension(): boolean {
  return listWallets().length > 0;
}

/**
 * Wallet extensions inject asynchronously (and dispatch `midnight#ready`), so
 * poll briefly for an injected InitialAPI before declaring it unsupported.
 */
export async function detectWallet(timeoutMs = 2000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (hasWalletExtension()) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

export async function connectWallet(networkId: string, chosenWallet?: WalletApi): Promise<WalletState> {
  const wallets = listWallets();
  if (wallets.length === 0) {
    return {
      status: 'unsupported',
      networkId: null,
      address: null,
      error: 'No Midnight wallet extension detected.',
      api: null,
    };
  }
  const wallet = chosenWallet ?? wallets[0];
  try {
    const api = await wallet.connect(networkId);
    const [status, shielded] = await Promise.all([
      api.getConnectionStatus?.().catch(() => Promise.resolve(undefined)),
      api.getShieldedAddresses?.().catch(() => Promise.resolve(undefined)),
    ]);
    return {
      status: 'connected',
      networkId: status?.networkId ?? networkId,
      address: shielded?.shieldedAddress ?? null,
      error: null,
      api,
    };
  } catch (err: any) {
    return {
      status: 'error',
      networkId: null,
      address: null,
      error: `${err?.message ?? String(err)} — this app requires the "${networkId}" network. Switch to ${networkId} in the Lace extension, then reconnect.`,
      api: null,
    };
  }
}

export async function disconnectWallet(): Promise<void> {
  const wallets = listWallets();
  for (const w of wallets) {
    try {
      await w.disconnect?.();
    } catch {
      // ignore — extension may already be disconnected
    }
  }
}
