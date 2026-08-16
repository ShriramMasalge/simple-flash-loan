import { useMemo, useRef, useState } from 'react';
import { baseUnits, tokens } from '../lib/format';
import type { PoolLedgerView } from '../lib/pool';
import type { WalletState } from '../lib/wallet';
import { connectBrowserClient } from '../lib/browser-client';

const STAGES = [
  { id: 1, label: 'REQUEST', desc: 'Loan amount + run label identified' },
  { id: 2, label: 'VALIDATE', desc: 'Pool open, amount within bounds, liquidity available' },
  { id: 3, label: 'BORROW', desc: 'Pool liquidity committed to the run' },
  { id: 4, label: 'ARBITRAGE', desc: 'Price pair proven profitable (bid/ask, private)' },
  { id: 5, label: 'REPAY', desc: 'Proceeds provably cover principal + fee' },
  { id: 6, label: 'SETTLE', desc: 'Fee captured, counters + run record written' },
] as const;

type Phase = 'idle' | 'running' | 'settled' | 'rejected';

export function BorrowPanel({
  pool,
  wallet,
  proofServer,
  zkBaseURL,
  indexer,
  indexerWS,
}: {
  pool: PoolLedgerView | null;
  wallet: WalletState;
  proofServer: string;
  zkBaseURL: string;
  indexer: string;
  indexerWS: string;
}) {
  const [amountStr, setAmountStr] = useState('10');
  const [bidStr, setBidStr] = useState('100');
  const [askStr, setAskStr] = useState('101');
  const [phase, setPhase] = useState<Phase>('idle');
  const [currentStage, setCurrentStage] = useState(0);
  const [runId, setRunId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const clientRef = useRef<Awaited<ReturnType<typeof connectBrowserClient>> | null>(null);

  const contractAddress = (import.meta as any).env?.VITE_CONTRACT_ADDRESS as string | undefined;

  const amount = baseUnits(amountStr);
  const bid = useMemo(() => (bidStr.trim() === '' ? null : BigInt(bidStr.trim())), [bidStr]);
  const ask = useMemo(() => (askStr.trim() === '' ? null : BigInt(askStr.trim())), [askStr]);

  const validation = useMemo(() => {
    if (!pool) return { ok: false, reason: 'Pool state not loaded.' };
    if (amount === null || amount <= 0n) return { ok: false, reason: 'Enter a positive loan amount.' };
    if (pool.paused) return { ok: false, reason: 'The pool is paused.' };
    if (amount < pool.minLoan || amount > pool.maxLoan) {
      return {
        ok: false,
        reason: `Amount must be between ${tokens(pool.minLoan)} and ${tokens(pool.maxLoan)} tokens.`,
      };
    }
    if (bid === null || ask === null || bid <= 0n || ask > 1_000_000_000n) {
      return { ok: false, reason: 'Prices must be in 1..1,000,000,000 base units.' };
    }
    if (ask <= bid) return { ok: false, reason: 'Arbitrage requires ask > bid.' };
    return { ok: true, reason: null };
  }, [pool, amount, bid, ask]);

  const fee = useMemo(
    () => (pool && amount !== null ? (amount * pool.protocolFeeBps) / 10_000n : 0n),
    [pool, amount],
  );
  const profitable = useMemo(
    () => amount !== null && bid !== null && ask !== null && amount * ask >= (amount + fee) * bid,
    [amount, bid, ask, fee],
  );

  const run = async () => {
    if (!validation.ok || !amount || !bid || !ask || !pool) return;
    const snapshotBid = bid;
    const snapshotAsk = ask;
    setPhase('running');
    setCurrentStage(0);
    setRunId(null);
    setOutcome(null);
    const id = `web-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16)}`;
    const step = () => setCurrentStage((s) => Math.min(s + 1, STAGES.length));
    const timer = setInterval(() => {
      step();
      if (currentStage >= STAGES.length - 1) clearInterval(timer);
    }, 550);

    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      if (wallet.status !== 'connected' || !wallet.api) {
        // No wallet: the dial stays illustrative; the CLI covers the real path.
        await pause(600);
        setRunId(id);
        setOutcome(
          'No wallet connected — the dial above is illustrative. On the local devnet run the identical atomic flow ' +
            'via `npm run demo`; with the wallet extension connected, Execute again for an on-chain run.',
        );
        setPhase('rejected');
        return;
      }
      if (!contractAddress) {
        throw new Error('VITE_CONTRACT_ADDRESS is not set — add the deployed pool address to frontend/.env');
      }
      setOutcome('Connecting to the pool through the wallet…');
      clientRef.current = await connectBrowserClient({
        walletApi: wallet.api,
        contractAddress,
        indexerUrl: indexer,
        indexerWsUrl: indexerWS,
        zkBaseURL,
        networkId: wallet.networkId ?? 'undeployed',
        arbitragePrices: () => {
          return { bid: snapshotBid, ask: snapshotAsk };
        },
      });
      setCurrentStage(2);
      setOutcome('Building the run transaction — proving via the wallet…');
      await pause(150);
      setCurrentStage(4);
      const EXECUTION_TIMEOUT_MS = 90_000;
      const WARNING_AFTER_MS = 15_000;
      const executionPromise = clientRef.current!.executeFlashLoan(amount, fee, id);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Wallet disconnected or execution timed out — please ensure the wallet extension is still connected and retry.')), EXECUTION_TIMEOUT_MS);
      });
      const warningTimer = setTimeout(() => {
        setOutcome('Still waiting on the wallet… keep the Lace extension open and respond to any popup.');
      }, WARNING_AFTER_MS);
      try {
        await Promise.race([executionPromise, timeoutPromise]);
      } finally {
        clearTimeout(warningTimer);
      }
      setCurrentStage(6);
      setRunId(id);
      setOutcome('Run settled on-chain — fee captured, run recorded.');
      setPhase('settled');
} catch (err: any) {
  console.error('executeFlashLoan failed:', err);
  setPhase('rejected');
  setOutcome(`Execution rejected: ${err?.message ?? String(err)}`);
} finally {
      clearInterval(timer);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div style={{ background: '#151d2e', border: '1px solid #2a3550', borderRadius: 10, padding: 18 }}>
        <h3 style={{ margin: '0 0 12px' }}>New flash-loan run</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.7 }}>Loan amount (tokens)</span>
            <input
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              style={{ padding: 8, borderRadius: 6, border: '1px solid #33415c', background: '#0f1420', color: '#dbe4f0' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.7 }}>Market bid (base units)</span>
            <input
              value={bidStr}
              onChange={(e) => setBidStr(e.target.value)}
              style={{ padding: 8, borderRadius: 6, border: '1px solid #33415c', background: '#0f1420', color: '#dbe4f0' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.7 }}>Market ask (base units)</span>
            <input
              value={askStr}
              onChange={(e) => setAskStr(e.target.value)}
              style={{ padding: 8, borderRadius: 6, border: '1px solid #33415c', background: '#0f1420', color: '#dbe4f0' }}
            />
          </label>
        </div>
        {pool && (
          <div style={{ fontSize: 13, marginTop: 12, opacity: 0.85 }}>
            Protocol fee: <strong>{tokens(fee)} tokens</strong> at{' '}
            {Number(pool.protocolFeeBps) / 100}% · expected proceeds{' '}
            {bid && ask && amount !== null && (amount * ask) / bid / 1_000_000n} tokens ·{' '}
            <span style={{ color: profitable ? '#5fd68a' : '#f0a0a8' }}>
              {profitable ? 'repayment provably covered' : 'does NOT cover repayment'}
            </span>
          </div>
        )}
        <div style={{ fontSize: 12, marginTop: 8, color: validation.ok ? '#5fd68a' : '#f0a0a8' }}>
          {validation.reason ?? 'All validation checks pass.'}
        </div>
        <button
          onClick={run}
          disabled={!validation.ok || phase === 'running'}
          style={{
            marginTop: 14,
            padding: '10px 18px',
            borderRadius: 8,
            cursor: validation.ok ? 'pointer' : 'not-allowed',
            background: '#2b5bd7',
            border: 'none',
            color: '#fff',
            fontWeight: 700,
          }}
        >
          {phase === 'running' ? 'Executing…' : 'Execute flash loan'}
        </button>
        {wallet.status !== 'connected' && (
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: 10 }}>
            No wallet connected — the proof dial below is illustrative. Use the wallet extension to execute in-browser,
            or `npm run demo` on the devnet.
          </p>
        )}
      </div>

      <div style={{ background: '#151d2e', border: '1px solid #2a3550', borderRadius: 10, padding: 18 }}>
        <h3 style={{ margin: '0 0 12px' }}>Proof dial — atomic lifecycle</h3>
        <div style={{ display: 'grid', gap: 8 }}>
          {STAGES.map((s, i) => {
            const state =
              phase === 'running' && i === currentStage
                ? 'active'
                : phase === 'running' && i < currentStage
                  ? 'done'
                  : phase === 'settled'
                    ? 'done'
                    : phase === 'rejected'
                      ? 'idle'
                      : 'idle';
            return (
              <div
                key={s.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: '1px solid #2a3550',
                  background: state === 'active' ? '#1d2b4a' : state === 'done' ? '#12301f' : 'transparent',
                }}
              >
                <span style={{ fontSize: 13, width: 22 }}>{state === 'done' ? '✓' : state === 'active' ? '…' : '·'}</span>
                <span style={{ fontWeight: 700, width: 90, fontSize: 13 }}>{s.label}</span>
                <span style={{ fontSize: 12, opacity: 0.65 }}>{s.desc}</span>
              </div>
            );
          })}
        </div>
        {runId && (
          <div style={{ fontSize: 12, marginTop: 12, fontFamily: 'monospace', opacity: 0.8 }}>
            runId: {runId}
          </div>
        )}
        {outcome && <div style={{ fontSize: 12, marginTop: 8, opacity: 0.8 }}>{outcome}</div>}
        <p style={{ fontSize: 11, opacity: 0.5, marginTop: 10 }}>
          Proof server: {proofServer} · ZK assets: {zkBaseURL} · indexer: {indexer}
        </p>
      </div>
    </div>
  );
}