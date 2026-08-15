import { bytesToHex, feePct, tokens } from '../lib/format';
import type { PoolLedgerView } from '../lib/pool';
import type { WalletState } from '../lib/wallet';

export function AdminPanel({ pool, wallet }: { pool: PoolLedgerView | null; wallet: WalletState }) {
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
          <p style={{ fontSize: 13, opacity: 0.85 }}>
            In-browser admin transactions (top-up, withdraw, setFeeBps, setLoanLimits, pause) are not yet wired to the
            wallet provider in this build. The deployer wallet can drive them on the devnet via the e2e suite (
            <code>npm run test:e2e</code>) or the deploy script's flow.
          </p>
        ) : (
          <p style={{ fontSize: 13, opacity: 0.85 }}>
            Admin calls must be signed by the pool's admin key (the deployer). Connect the Midnight wallet extension
            holding that key to unlock these actions in a future build; on the devnet, the CLI flow covers the same
            circuits.
          </p>
        )}
        <ul style={{ fontSize: 12, opacity: 0.7, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>topUpLiquidity — raise the virtual pool ceiling (cap 1,000,000,000,000 base)</li>
          <li>withdrawLiquidity — pull liquidity back out (never below 0)</li>
          <li>setFeeBps — change the protocol fee (0–1,000 bps)</li>
          <li>setLoanLimits — change min/max loan bounds</li>
          <li>setPaused — halt/resume all borrows</li>
        </ul>
      </div>
    </div>
  );
}