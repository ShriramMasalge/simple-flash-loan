/**
 * End-to-end verification of the Simple Flash Loan Pool on the local devnet.
 * Requires: docker compose up -d, npm run compile, npm run deploy.
 *
 * Runs a deterministic, sequential script over the deployed contract: every
 * successful circuit call is followed by an on-chain ledger readback; every
 * failure path must reject the whole transaction (atomic semantics) with the
 * ledger untouched.
 *
 * Ledger arithmetic notes (see contracts/flash-loan-pool.compact):
 *   - fee == ⌊amount·feeBps/10_000⌋ (sandwich-proven, no division on-chain)
 *   - poolLiquidity / totalFeeCollected grow ONLY by the captured fee: the
 *     principal leaves and returns within the same atomic transaction.
 *   - runCounter == runs.length; runs is newest-first.
 */

import * as crypto from 'node:crypto';
import * as Rx from 'rxjs';
import { resolveNetwork, getOrCreateSeed, getDeployment } from '../../src/network';
import { persistWalletState } from '../../src/wallet';
import { FlashLoanPoolClient, DEFAULT_FEE_BPS } from '../../src/client';
import { exactFee } from '../../src/pool-math';

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);

const MAX_LANDING_SECONDS = 120;

let runSeq = 0;
function nextRunId(): string {
  runSeq += 1;
  return `e2e-${runSeq}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function fail(msg: string): never {
  console.error(`\n❌ e2e failed: ${msg}`);
  process.exit(1);
}

let passed = 0;
function ok(msg: string): void {
  passed += 1;
  console.log(`  ✅ ${msg}`);
}

function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    fail(`${label}: expected ${expected}, got ${actual}`);
  }
}

async function expectReject(p: Promise<unknown>, needle: string, label: string): Promise<void> {
  try {
    await p;
    fail(`${label}: expected circuit rejection, but the call succeeded`);
  } catch (err: any) {
    // The SDK wraps circuit failures; walk the whole cause chain.
    const parts: string[] = [];
    let cur = err;
    while (cur) {
      const m = cur?.message;
      if (m && !parts.includes(m)) parts.push(m);
      cur = cur?.cause;
    }
    const full = parts.join(' | ').toLowerCase();
    if (!full.includes('error executing circuit')) {
      fail(`${label}: expected a circuit rejection, but the call failed differently: ${full}`);
    }
    if (needle && !full.includes(needle)) {
      fail(`${label}: rejected, but for an unexpected reason (looking for "${needle}"): ${full}`);
    }
    ok(`${label} (rejected — ${needle || 'circuit failure'})`);
  }
}

interface ExpectedLedger {
  poolLiquidity: bigint;
  protocolFeeBps: bigint;
  minLoan: bigint;
  maxLoan: bigint;
  paused: boolean;
  runCounter: bigint;
  totalFeeCollected: bigint;
}

async function readLedger(client: FlashLoanPoolClient): Promise<ExpectedLedger> {
  const v = await client.readLedger();
  return {
    poolLiquidity: v.poolLiquidity,
    protocolFeeBps: v.protocolFeeBps,
    minLoan: v.minLoan,
    maxLoan: v.maxLoan,
    paused: v.paused,
    runCounter: v.runCounter,
    totalFeeCollected: v.totalFeeCollected,
  };
}

/** Poll the indexer until the ledger matches `expected` (or timeout). */
async function waitForLedger(client: FlashLoanPoolClient, expected: ExpectedLedger, label: string): Promise<void> {
  const deadline = Date.now() + MAX_LANDING_SECONDS * 1000;
  let last: ExpectedLedger | null = null;
  while (Date.now() < deadline) {
    last = await readLedger(client);
    if (
      last.poolLiquidity === expected.poolLiquidity &&
      last.protocolFeeBps === expected.protocolFeeBps &&
      last.minLoan === expected.minLoan &&
      last.maxLoan === expected.maxLoan &&
      last.paused === expected.paused &&
      last.runCounter === expected.runCounter &&
      last.totalFeeCollected === expected.totalFeeCollected
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`${label}: ledger never matched expected — last read: ${JSON.stringify(last, (_, x) => (typeof x === 'bigint' ? x.toString() : x))}`);
}

async function ensureDust(client: FlashLoanPoolClient): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const s = await Rx.firstValueFrom(client.walletCtx.wallet.state());
    if (s?.isSynced && s.dust.balance(new Date()) > 0n) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  fail('no DUST available after 120s');
}

async function runTest(client: FlashLoanPoolClient, address: string, expected: ExpectedLedger) {
  // re-connect so each call replays against the latest on-chain nonce
  await client.connect(address);
  await ensureDust(client);
  return expected;
}

async function main() {
  const deployment = getDeployment(network);
  if (!deployment) {
    console.error('No deployment on file. Run: npm run deploy');
    process.exit(1);
  }
  const address = deployment.address;
  console.log(`\nTesting ${address} (network: ${network})\n`);

  const client = await FlashLoanPoolClient.create({ network, networkConfig, seed: SEED });
  await client.walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, client.walletCtx);

  // ─── Baseline ────────────────────────────────────────────────────────────
  await client.connect(address);
  let expected = await readLedger(client);
  console.log('  Baseline ledger:');
  console.log(
    `    pool=${expected.poolLiquidity.toString()} feeBps=${expected.protocolFeeBps.toString()} ` +
      `min=${expected.minLoan.toString()} max=${expected.maxLoan.toString()} paused=${expected.paused} ` +
      `runs=${expected.runCounter.toString()} fees=${expected.totalFeeCollected.toString()}\n`,
  );
  // The suite is state-agnostic: all assertions are DELTAS from this snapshot,
  // so it can run repeatedly against the same deployment. (For a from-scratch
  // run, deploy a fresh contract and confirm the baseline shows runs=0.)

  // ─── Normalize admin parameters ───────────────────────────────────────────
  // Leftover state from a previously interrupted run (e.g. feeBps=1000) would
  // invalidate the fixture maths, so reset the admin params to the deploy
  // defaults first. The deployer wallet is the pool admin.
  console.log('─ T0  normalize admin parameters');
  const needFee = expected.protocolFeeBps !== DEFAULT_FEE_BPS;
  const needLimits = expected.minLoan !== 10_000n || expected.maxLoan !== 100_000_000n;
  const needPause = expected.paused;
  if (needFee || needLimits || needPause) {
    if (needPause) {
      await runTest(client, address, expected);
      await client.setPaused(false);
      expected = { ...expected, paused: false };
      await waitForLedger(client, expected, 'T0 unpause');
    }
    if (needLimits) {
      await runTest(client, address, expected);
      await client.setLoanLimits(10_000n, 100_000_000n);
      expected = { ...expected, minLoan: 10_000n, maxLoan: 100_000_000n };
      await waitForLedger(client, expected, 'T0 limits');
    }
    if (needFee) {
      await runTest(client, address, expected);
      await client.setFeeBps(DEFAULT_FEE_BPS);
      expected = { ...expected, protocolFeeBps: DEFAULT_FEE_BPS };
      await waitForLedger(client, expected, 'T0 fee');
    }
    ok('T0: admin parameters normalized to defaults');
  } else {
    ok('T0: admin parameters already at defaults');
  }
  client.setPrices(100n, 101n);

  // ─── T1  Admin: top up liquidity (must grow the pool) ─────────────────────
  console.log('─ T1  topUpLiquidity(+250 tokens)');
  await runTest(client, address, expected);
  await client.topUpLiquidity(250_000_000n);
  expected = { ...expected, poolLiquidity: expected.poolLiquidity + 250_000_000n };
  await waitForLedger(client, expected, 'T1');
  ok('topUpLiquidity: pool grew by 250,000,000');

  // ─── T2  Happy-path flash loan at 0.50% fee ───────────────────────────────
  console.log('─ T2  executeFlashLoan (10 tokens, profitable, exact fee)');
  const amount2 = 10_000_000n;
  const fee2 = exactFee(amount2, DEFAULT_FEE_BPS); // 50_000n
  const runId2 = nextRunId();
  client.setPrices(100n, 101n); // bid/ask — ask > bid, proceeds cover repayment
  await runTest(client, address, expected);
  await client.executeFlashLoan(amount2, fee2, runId2);
  expected = {
    ...expected,
    poolLiquidity: expected.poolLiquidity + fee2,
    runCounter: expected.runCounter + 1n,
    totalFeeCollected: expected.totalFeeCollected + fee2,
  };
  await waitForLedger(client, expected, 'T2');
  {
    const v = await client.readLedger();
    const head = v.runs[0];
    eq(head.runId, runId2, 'T2 runs[0].runId');
    eq(head.amount, amount2, 'T2 runs[0].amount');
    eq(head.fee, fee2, 'T2 runs[0].fee');
    eq(head.requester.length, 32, 'T2 runs[0].requester (32-byte key hash)');
    ok('executeFlashLoan: ledger captured fee, counter, and run record');
  }

  // ─── T3  Fee must be exact — ±1 both reverted, ledger untouched ───────────
  console.log('─ T3  executeFlashLoan with wrong fee (fee±1)');
  const before = { ...expected };
  await runTest(client, address, expected);
  await expectReject(
    client.executeFlashLoan(amount2, fee2 - 1n, nextRunId()),
    'fee below protocol rate',
    'T3 underpay fee',
  );
  await runTest(client, address, expected);
  await expectReject(
    client.executeFlashLoan(amount2, fee2 + 1n, nextRunId()),
    'fee above protocol rate',
    'T3 overpay fee',
  );
  eq((await readLedger(client)).runCounter, before.runCounter, 'T3 runCounter unchanged');
  eq((await readLedger(client)).poolLiquidity, before.poolLiquidity, 'T3 pool unchanged');
  ok('T3: fee sandwich is strict on both sides');

  // ─── T4  Loan below minimum ───────────────────────────────────────────────
  console.log('─ T4  executeFlashLoan below minLoan');
  await runTest(client, address, expected);
  await expectReject(
    client.executeFlashLoan(9_999n, exactFee(9_999n, DEFAULT_FEE_BPS), nextRunId()),
    'amount below minimum',
    'T4 below min',
  );
  eq((await readLedger(client)).runCounter, before.runCounter, 'T4 runCounter unchanged');

  // ─── T5  Loan above maximum ───────────────────────────────────────────────
  console.log('─ T5  executeFlashLoan above maxLoan');
  await runTest(client, address, expected);
  const bigAmount = 100_000_001n;
  await expectReject(
    client.executeFlashLoan(bigAmount, exactFee(bigAmount, DEFAULT_FEE_BPS), nextRunId()),
    'amount above maximum',
    'T5 above max',
  );
  eq((await readLedger(client)).runCounter, before.runCounter, 'T5 runCounter unchanged');

  // ─── T6  Unprofitable / out-of-bounds prices ─────────────────────────────
  console.log('─ T6  executeFlashLoan with bad prices');
  await runTest(client, address, expected);
  client.setPrices(100n, 100n); // flat market → ask not above bid
  await expectReject(client.executeFlashLoan(amount2, fee2, nextRunId()), 'unprofitable', 'T6 flat market');
  await runTest(client, address, expected);
  client.setPrices(0n, 101n); // bid below 1 → out of bounds
  await expectReject(client.executeFlashLoan(amount2, fee2, nextRunId()), 'out of bounds', 'T6 bid == 0');
  await runTest(client, address, expected);
  client.setPrices(1n, 1_000_000_001n); // ask above PRICE_MAX
  await expectReject(client.executeFlashLoan(amount2, fee2, nextRunId()), 'out of bounds', 'T6 ask too high');
  eq((await readLedger(client)).runCounter, before.runCounter, 'T6 runCounter unchanged');
  client.setPrices(100n, 101n);

  // ─── T7  Paused pool ──────────────────────────────────────────────────────
  console.log('─ T7  setPaused(true) blocks loans; unpause restores');
  await runTest(client, address, expected);
  await client.setPaused(true);
  expected = { ...expected, paused: true };
  await waitForLedger(client, expected, 'T7 pause');
  await runTest(client, address, expected);
  await expectReject(
    client.executeFlashLoan(amount2, fee2, nextRunId()),
    'pool is paused',
    'T7 paused borrow',
  );
  await runTest(client, address, expected);
  await client.setPaused(false);
  expected = { ...expected, paused: false };
  await waitForLedger(client, expected, 'T7 unpause');
  await runTest(client, address, expected);
  const runId7 = nextRunId();
  await client.executeFlashLoan(amount2, fee2, runId7);
  expected = {
    ...expected,
    poolLiquidity: expected.poolLiquidity + fee2,
    runCounter: expected.runCounter + 1n,
    totalFeeCollected: expected.totalFeeCollected + fee2,
  };
  await waitForLedger(client, expected, 'T7 borrow after unpause');
  eq((await client.readLedger()).runs[0].runId, runId7, 'T7 runs[0].runId');
  ok('T7: pause halts borrows, unpause restores them');

  // ─── T8  Withdraw: over-withdraw rejected; full withdraw drains the pool ──
  console.log('─ T8  withdrawLiquidity');
  await runTest(client, address, expected);
  await expectReject(
    client.withdrawLiquidity(expected.poolLiquidity + 1n),
    'insufficient liquidity',
    'T8 over-withdraw',
  );
  await runTest(client, address, expected);
  await client.withdrawLiquidity(expected.poolLiquidity);
  const drained = { ...expected, poolLiquidity: 0n };
  await waitForLedger(client, drained, 'T8 drain');
  await runTest(client, address, drained);
  await expectReject(
    client.executeFlashLoan(amount2, fee2, nextRunId()),
    'insufficient liquidity',
    'T8 borrow on empty pool',
  );
  await runTest(client, address, drained);
  await client.topUpLiquidity(100_000_000n);
  expected = { ...drained, poolLiquidity: 100_000_000n };
  await waitForLedger(client, expected, 'T8 refill');
  ok('T8: over-withdrawal reverted; empty pool rejects borrows; refill works');

  // ─── T9  Fee rate changes: 0%, 10%, and the 10% cap ───────────────────────
  console.log('─ T9  setFeeBps');
  await runTest(client, address, expected);
  await client.setFeeBps(0n);
  expected = { ...expected, protocolFeeBps: 0n };
  await waitForLedger(client, expected, 'T9 fee 0');
  await runTest(client, address, expected);
  const runId9a = nextRunId();
  await client.executeFlashLoan(5_000_000n, 0n, runId9a); // zero-fee loan
  expected = { ...expected, runCounter: expected.runCounter + 1n };
  await waitForLedger(client, expected, 'T9 zero-fee loan');
  ok('T9: zero-fee loan accepted with fee==0');
  await runTest(client, address, expected);
  await expectReject(
    client.executeFlashLoan(5_000_000n, 1n, nextRunId()),
    'fee above protocol rate',
    'T9 positive fee at 0%',
  );
  await runTest(client, address, expected);
  await client.setFeeBps(1000n); // 10%
  expected = { ...expected, protocolFeeBps: 1000n };
  await waitForLedger(client, expected, 'T9 fee 1000');
  await runTest(client, address, expected);
  // At 10% the borrowed capital must clear >1.1× per unit: ask ≥ 1.1·bid.
  client.setPrices(100n, 111n);
  await runTest(client, address, expected);
  const runId9b = nextRunId();
  const fee9b = exactFee(10_000_000n, 1000n); // 1_000_000n
  await client.executeFlashLoan(10_000_000n, fee9b, runId9b);
  expected = {
    ...expected,
    poolLiquidity: expected.poolLiquidity + fee9b,
    runCounter: expected.runCounter + 1n,
    totalFeeCollected: expected.totalFeeCollected + fee9b,
  };
  await waitForLedger(client, expected, 'T9 10% loan');
  eq((await client.readLedger()).runs[0].fee, fee9b, 'T9 runs[0].fee');
  await runTest(client, address, expected);
  await expectReject(client.setFeeBps(1001n), 'fee must be at most 1000 bps', 'T9 cap');
  await runTest(client, address, expected);
  await client.setFeeBps(DEFAULT_FEE_BPS);
  expected = { ...expected, protocolFeeBps: DEFAULT_FEE_BPS };
  await waitForLedger(client, expected, 'T9 restore fee');
  client.setPrices(100n, 101n);
  ok('T9: fee rates enforced (0%, 10%) and capped at 1000 bps');

  // ─── T10  Loan limits change: tiny loans allowed at min==1 ───────────────
  console.log('─ T10 setLoanLimits');
  await runTest(client, address, expected);
  await client.setLoanLimits(1n, 10_000n);
  expected = { ...expected, minLoan: 1n, maxLoan: 10_000n };
  await waitForLedger(client, expected, 'T10 narrow limits');
  await runTest(client, address, expected);
  const runId10a = nextRunId();
  const fee10 = exactFee(600n, DEFAULT_FEE_BPS); // 3n at 50 bps
  await client.executeFlashLoan(600n, fee10, runId10a);
  expected = {
    ...expected,
    poolLiquidity: expected.poolLiquidity + fee10,
    runCounter: expected.runCounter + 1n,
    totalFeeCollected: expected.totalFeeCollected + fee10,
  };
  await waitForLedger(client, expected, 'T10 tiny loan');
  await runTest(client, address, expected);
  const runId10b = nextRunId();
  await client.executeFlashLoan(600n, fee10, runId10b);
  expected = {
    ...expected,
    poolLiquidity: expected.poolLiquidity + fee10,
    runCounter: expected.runCounter + 1n,
    totalFeeCollected: expected.totalFeeCollected + fee10,
  };
  await waitForLedger(client, expected, 'T10 repeat tiny loan');
  await runTest(client, address, expected);
  await expectReject(client.setLoanLimits(0n, 10_000n), 'invalid minimum loan', 'T10 min==0 rejected');
  await runTest(client, address, expected);
  await expectReject(client.setLoanLimits(10_000n, 5_000n), 'min must not exceed max', 'T10 inverted limits');
  await runTest(client, address, expected);
  await client.setLoanLimits(10_000n, 100_000_000n);
  expected = { ...expected, minLoan: 10_000n, maxLoan: 100_000_000n };
  await waitForLedger(client, expected, 'T10 restore limits');
  ok('T10: loan limits adjustable and validated');

  // ─── T11  Audit trail: counter matches run history ───────────────────────
  console.log('─ T11 run history');
  {
    const v = await client.readLedger();
    eq(v.runCounter, BigInt(v.runs.length), 'T11 runCounter == runs.length');
    eq(v.runs[0].runId, runId10b, 'T11 newest run is first');
    if (v.runs.length > 1) eq(v.runs[1].runId, runId10a, 'T11 second-newest run');
    ok('T11: run history consistent (newest-first, counter == length)');
  }

  // ─── T12  Balance sheet: fees added up exactly ───────────────────────────
  console.log('─ T12 fee accounting');
  {
    const v = await client.readLedger();
    eq(v.totalFeeCollected, expected.totalFeeCollected, 'T12 totalFeeCollected');
    eq(v.poolLiquidity, expected.poolLiquidity, 'T12 poolLiquidity');
    ok(`T12: poolLiquidity=${v.poolLiquidity.toString()} fees=${v.totalFeeCollected.toString()}`);
  }

  await persistWalletState(network, client.walletCtx);
  await client.stopWallet();
  console.log(`\n${'─'.repeat(46)}`);
  console.log(`  ALL ${passed} E2E CHECKS PASSED`);
  console.log(`${'─'.repeat(46)}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});