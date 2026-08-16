/**
 * Pool ledger types + on-chain reading (browser-safe).
 *
 * The pool's own generated contract module (synced by scripts/sync-zk.mjs into
 * src/zk-contract) provides the ledger() getter used to decode indexer state —
 * the same decoding path the e2e suite uses.
 */

import { ContractState } from '@midnight-ntwrk/compact-runtime';

export interface RunRecordView {
  runId: string;
  requester: Uint8Array;
  amount: bigint;
  fee: bigint;
}

export interface PoolLedgerView {
  adminKeyHash: Uint8Array;
  poolLiquidity: bigint;
  protocolFeeBps: bigint;
  minLoan: bigint;
  maxLoan: bigint;
  paused: boolean;
  runCounter: bigint;
  totalFeeCollected: bigint;
  runs: RunRecordView[];
}

let ledgerModulePromise: Promise<any> | null = null;

async function ledgerGetter(): Promise<(state: unknown) => any> {
  if (!ledgerModulePromise) {
    ledgerModulePromise = import('../zk-contract/index.js');
  }
  const mod = await ledgerModulePromise;
  return mod.ledger;
}

/** Reads + decodes the latest on-chain pool state from the indexer. */
export async function readLedger(indexerUrl: string, contractAddress: string): Promise<PoolLedgerView> {
  const res = await fetch(indexerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query { contractAction(address: "${contractAddress}") { state } }`,
    }),
  });
  const json = await res.json();
  const stateHex = json?.data?.contractAction?.state;
  if (!stateHex) throw new Error('No contract state returned by the indexer.');

  const stateBytes = new Uint8Array(Buffer.from(stateHex, 'hex'));
  const onChain: any = ContractState.deserialize(stateBytes);
  const charged: unknown = onChain.data ?? onChain.state;
  const ledgerFn = await ledgerGetter();
  const view = ledgerFn(charged);
  const runs: RunRecordView[] = [];
  for (const r of view.runs) runs.push(r);
  return {
    adminKeyHash: view.adminKeyHash,
    poolLiquidity: view.poolLiquidity,
    protocolFeeBps: view.protocolFeeBps,
    minLoan: view.minLoan,
    maxLoan: view.maxLoan,
    paused: view.paused,
    runCounter: view.runCounter,
    totalFeeCollected: view.totalFeeCollected,
    runs,
  };
}
