import { useEffect, useState } from 'react';
import { resolveEndpoints } from './lib/config';
import { readLedger, type PoolLedgerView } from './lib/pool';
import { connectWallet, disconnectWallet, detectWallet, type WalletState } from './lib/wallet';
import { PoolView } from './components/PoolView';
import { BorrowPanel } from './components/BorrowPanel';
import { AdminPanel } from './components/AdminPanel';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

setNetworkId('undeployed');

const CONTRACT_ADDRESS = (import.meta as any).env?.VITE_CONTRACT_ADDRESS as string | undefined;

type Tab = 'pool' | 'borrow' | 'admin';

export function App() {
  const [tab, setTab] = useState<Tab>('pool');
  const [pool, setPool] = useState<PoolLedgerView | null>(null);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [wallet, setWallet] = useState<WalletState>({
    status: 'unsupported',
    networkId: null,
    address: null,
    error: null,
    api: null,
  });

  const { indexer, indexerWS, proofServer, zkBaseURL } = resolveEndpoints();

  // Wallets inject asynchronously — detect before declaring them absent.
  useEffect(() => {
    let cancelled = false;
    void detectWallet().then((found) => {
      if (!cancelled) setWallet((w) => ({ ...w, status: found ? 'disconnected' : 'unsupported' }));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const v = await readLedger(indexer, CONTRACT_ADDRESS!);
        if (!cancelled) {
          setPool(v);
          setPoolError(null);
        }
      } catch (err: any) {
        if (!cancelled) setPoolError(err?.message ?? String(err));
      }
    };
    if (CONTRACT_ADDRESS) void tick();
    const id = setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [indexer]);

  const onConnect = async () => {
    setWallet((w) => ({ ...w, status: 'connecting', error: null }));
    const next = await connectWallet('undeployed');
    setWallet(next);
  };

  const onDisconnect = async () => {
    await disconnectWallet();
    setWallet({ status: 'disconnected', networkId: null, address: null, error: null, api: null });
  };

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>Simple Flash Loan Pool</h1>
          <p style={{ margin: '4px 0 0', opacity: 0.7, fontSize: 13 }}>
            Educational atomic flash-loan lifecycle on Midnight — validate → borrow → arbitrage proof → repay → settle
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <code style={{ fontSize: 11, opacity: 0.75, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {CONTRACT_ADDRESS ?? 'VITE_CONTRACT_ADDRESS not set'}
          </code>
          {wallet.status === 'connected' ? (
            <button onClick={onDisconnect} style={{ padding: '6px 12px', borderRadius: 6, cursor: 'pointer' }}>
              Disconnect {wallet.address?.slice(0, 8) ?? ''}…
            </button>
          ) : wallet.status === 'connecting' ? (
            <button disabled style={{ padding: '6px 12px', borderRadius: 6 }}>
              Connecting…
            </button>
          ) : (
            <button
              onClick={onConnect}
              disabled={wallet.status === 'unsupported'}
              title={wallet.status === 'unsupported' ? 'No Midnight wallet extension detected' : undefined}
              style={{ padding: '6px 12px', borderRadius: 6, cursor: wallet.status === 'unsupported' ? 'not-allowed' : 'pointer' }}
            >
              {wallet.status === 'unsupported' ? 'Wallet: not detected' : 'Connect wallet'}
            </button>
          )}
        </div>
      </header>

      {poolError && (
        <div style={{ background: '#3a1520', border: '1px solid #7a2a3a', borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>
          Pool state unavailable: {poolError}
        </div>
      )}
      {wallet.error && (
        <div style={{ background: '#3a1520', border: '1px solid #7a2a3a', borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>
          Wallet error: {wallet.error}
        </div>
      )}

      <nav style={{ display: 'flex', gap: 8 }}>
        {(['pool', 'borrow', 'admin'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: tab === t ? 700 : 400,
              background: tab === t ? '#2b5bd7' : 'transparent',
              border: '1px solid #33415c',
            }}
          >
            {t === 'pool' ? 'Pool' : t === 'borrow' ? 'Borrow' : 'Admin'}
          </button>
        ))}
      </nav>

      {tab === 'pool' && <PoolView pool={pool} loading={!pool && !poolError} />}
      {tab === 'borrow' && (
        <BorrowPanel pool={pool} wallet={wallet} proofServer={proofServer} zkBaseURL={zkBaseURL} indexer={indexer} indexerWS={indexerWS} />
      )}
      {tab === 'admin' && <AdminPanel pool={pool} wallet={wallet} />}
    </div>
  );
}