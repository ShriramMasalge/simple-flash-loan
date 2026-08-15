import { bytesToHex, feePct, shortAddr, tokens } from '../lib/format';
import type { PoolLedgerView } from '../lib/pool';

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div
      style={{
        background: '#151d2e',
        border: '1px solid #2a3550',
        borderRadius: 10,
        padding: '14px 16px',
        minWidth: 150,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.65 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, opacity: 0.5, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export function PoolView({ pool, loading }: { pool: PoolLedgerView | null; loading: boolean }) {
  if (loading) return <p style={{ opacity: 0.6 }}>Reading pool state…</p>;
  if (!pool) return <p style={{ opacity: 0.6 }}>No pool data.</p>;

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Card label="Pool liquidity" value={`${tokens(pool.poolLiquidity)}`} sub="tokens (virtual)" />
        <Card label="Protocol fee" value={feePct(pool.protocolFeeBps)} sub={`${pool.protocolFeeBps.toString()} bps`} />
        <Card label="Loan bounds" value={`${tokens(pool.minLoan)} – ${tokens(pool.maxLoan)}`} sub="tokens" />
        <Card
          label="Status"
          value={pool.paused ? 'PAUSED' : 'Open'}
          sub={pool.paused ? 'borrows rejected' : 'borrows accepted'}
        />
        <Card label="Runs completed" value={pool.runCounter.toString()} sub="audit counter" />
        <Card label="Fees collected" value={tokens(pool.totalFeeCollected)} sub="tokens" />
      </div>

      <div>
        <h3 style={{ margin: '8px 0 10px' }}>Recent runs (newest first)</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', opacity: 0.6 }}>
              <th style={{ padding: '6px 10px', borderBottom: '1px solid #2a3550' }}>runId</th>
              <th style={{ padding: '6px 10px', borderBottom: '1px solid #2a3550' }}>amount</th>
              <th style={{ padding: '6px 10px', borderBottom: '1px solid #2a3550' }}>fee</th>
              <th style={{ padding: '6px 10px', borderBottom: '1px solid #2a3550' }}>requester (hash)</th>
            </tr>
          </thead>
          <tbody>
            {pool.runs.length === 0 && (
              <tr>
                <td colSpan={4} style={{ padding: '10px', opacity: 0.5 }}>
                  No completed runs yet — be the first to borrow.
                </td>
              </tr>
            )}
            {pool.runs.slice(0, 20).map((r) => (
              <tr key={r.runId}>
                <td style={{ padding: '6px 10px', borderBottom: '1px solid #1c2436', fontFamily: 'monospace', fontSize: 12 }}>
                  {r.runId}
                </td>
                <td style={{ padding: '6px 10px', borderBottom: '1px solid #1c2436' }}>{tokens(r.amount)}</td>
                <td style={{ padding: '6px 10px', borderBottom: '1px solid #1c2436' }}>{tokens(r.fee)}</td>
                <td style={{ padding: '6px 10px', borderBottom: '1px solid #1c2436', fontFamily: 'monospace', fontSize: 12 }}>
                  {shortAddr(bytesToHex(r.requester))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: 11, opacity: 0.5, marginTop: 8 }}>
          Requesters are stored as SHA-256 hashes of the borrower's coin public key — pseudonymous by design.
        </p>
      </div>
    </div>
  );
}