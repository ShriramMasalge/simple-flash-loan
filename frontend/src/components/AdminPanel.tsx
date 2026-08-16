import { useState } from 'react';
import { bytesToHex, feePct, tokens } from '../lib/format';
import type { PoolLedgerView } from '../lib/pool';
import type { WalletState } from '../lib/wallet';
import { connectBrowserClient } from '../lib/browser-client';

export function AdminPanel({
  pool,
  wallet,
  indexer,
  indexerWS,
  zkBaseURL,
}: {
  pool: PoolLedgerView | null;
  wallet: WalletState;
  indexer: string;
  indexerWS: string;
  zkBaseURL: string;
}) {
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [actionPhase, setActionPhase] = useState<'idle' | 'running'>('idle');

  const contractAddress = (import.meta as any).env?.VITE_CONTRACT_ADDRESS as string | undefined;

  async function executeAdminAction<T>(
    label: string,
    fn: (client: Awaited<ReturnType<typeof connectBrowserClient>>) => Promise<T>,
  ): Promise<T> {
    if (wallet.status !== 'connected' || !wallet.api) {
      throw new Error('Wallet not connected.');
    }
    if (!contractAddress) {
      throw new Error('Contract address not set.');
    }
    setActionPhase('running');
    setActionStatus(`Starting ${label}…`);
    const EXECUTION_TIMEOUT_MS = 90_000;
    const WARNING_AFTER_MS = 15_000;
    const client = await connectBrowserClient({
      walletApi: wallet.api,
      contractAddress,
      indexerUrl: indexer,
      indexerWsUrl: indexerWS,
      zkBaseURL,
      networkId: wallet.networkId ?? 'undeployed',
      arbitragePrices: () => ({ bid: 100n, ask: 101n }),
    });
    const warningTimer = setTimeout(() => {
      setActionStatus(`Still waiting on the wallet… keep the Lace extension open.`);
    }, WARNING_AFTER_MS);
    try {
      const result = await Promise.race([
        fn(client),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Execution timed out — please ensure the wallet is connected and retry.`)), EXECUTION_TIMEOUT_MS),
        ),
      ]);
      setActionStatus(`${label} confirmed on-chain.`);
      return result as T;
    } catch (err: any) {
      setActionStatus(`${label} failed: ${err?.message ?? String(err)}`);
      throw err;
    } finally {
      clearTimeout(warningTimer);
      setActionPhase('idle');
    }
  }

  async function handleSetPaused(to: boolean) {
    try {
      await executeAdminAction(`setPaused(${to})`, (c) => c.setPaused(to));
    } catch (err: any) {
      console.error('setPaused failed:', err);
    }
  }

  if (!pool) return <p style={{ opacity: 0.6 }}>No pool data.</p>;
  return (
    <div style={{ display: 'grid', gap: 18, maxWidth: 720 }}>
      <div style={{ background: '#151d2e', border: '1px solid #2a3550', borderRadius: 10, padding: 18 }}>
        <h3 style={{ margin: '0 0 12px' }}>Pool parameters</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, fontSize: 14 }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.6 }}>Admin key hash</div>
            <code style={{ fontSize: 11, wordBreak: 'break-all' }}>
              {bytesToHex(pool.adminKeyHash)}
            </code>
          </div>
          <div>
            <div style={{ fontSize: 12, opacity: 0.6 }}>Fee rate</div>
            {feePct(pool.protocolFeeBps)} ({pool.protocolFeeBps.toString()} bps)
          </div>
          <div>
            <div style={{ fontSize: 12, opacity: 0.6 }}>Loan bounds</div>
            {tokens(pool.minLoan)} – {tokens(pool.maxLoan)} tokens
          </div>
          <div>
            <div style={{ fontSize: 12, opacity: 0.6 }}>Liquidity</div>
            {tokens(pool.poolLiquidity)} tokens
          </div>
          <div>
            <div style={{ fontSize: 12, opacity: 0.6 }}>Status</div>
            {pool.paused ? 'PAUSED' : 'Open'}
          </div>
        </div>
      </div>

      <div style={{ background: '#151d2e', border: '1px solid #2a3550', borderRadius: 10, padding: 18 }}>
        <h3 style={{ margin: '0 0 8px' }}>Admin actions</h3>
        {wallet.status === 'connected' ? (
          <>
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  onClick={() => handleSetPaused(!pool.paused)}
                  disabled={actionPhase === 'running'}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 6,
                    border: '1px solid #33415c',
                    background: '#2b5bd7',
                    color: '#fff',
                    cursor: actionPhase === 'running' ? 'not-allowed' : 'pointer',
                    fontWeight: 700,
                  }}
                >
                  {pool.paused ? 'Unpause pool' : 'Pause pool'}
                </button>
                <span style={{ fontSize: 13, opacity: 0.85 }}>
                  {actionStatus ?? `Pool is currently ${pool.paused ? 'paused' : 'open'}.`}
                </span>
              </div>
            </div>
            <p style={{ fontSize: 12, opacity: 0.5, marginTop: 10 }}>
              On-chain state refreshes every 5 seconds — verify changes in the Pool tab after each action.
            </p>
          </>
        ) : (
          <p style={{ fontSize: 13, opacity: 0.85 }}>
            Admin calls must be signed by the pool's admin key (the deployer). Connect the Midnight wallet extension
            holding that key to unlock admin actions in a future build; on the devnet, the CLI flow covers the same
            circuits.
          </p>
        )}
        <ul style={{ fontSize: 12, opacity: 0.7, paddingLeft: 18, lineHeight: 1.7, marginTop: 10 }}>
          <li>topUpLiquidity — not yet wired in-browser</li>
          <li>withdrawLiquidity — not yet wired in-browser</li>
          <li>setFeeBps — not yet wired in-browser</li>
          <li>setLoanLimits — not yet wired in-browser</li>
          <li>setPaused — in-browser flow implemented and reaches the contract (confirmed: unauthorized wallets are correctly rejected), but requires the original deployer's admin key, which isn't available in this Lace installation. Verified working via the CLI deploy/demo path.</li>
        </ul>
      </div>
    </div>
  );
}
