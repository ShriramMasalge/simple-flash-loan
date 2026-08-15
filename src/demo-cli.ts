/**
 * Interactive demo CLI for the Simple Flash Loan Pool.
 *
 * Walks through the borrower's lifecycle against a deployed pool on the
 * current network: inspect the pool, pick a loan, review the exact protocol
 * fee, supply a private price pair, execute the atomic flash loan, and see
 * the settled ledger. Mirrors what the React frontend (Phase 6) will do.
 *
 * Usage:
 *   npm run demo            # interactive
 *   npm run demo -- --auto  # canned sequence (10 tokens @ 100/101)
 *   npm run demo -- --auto --amount 5000000   # canned with custom amount
 */
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolveNetwork, getOrCreateSeed, getDeployment } from './network';
import { FlashLoanPoolClient } from './client';
import { exactFee, feeAccepted } from './pool-math';

const TOKEN = 1_000_000n; // 1 token = 1_000_000 base units

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);

function tokens(base: bigint): string {
  const whole = base / TOKEN;
  const frac = base % TOKEN;
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
  return frac === 0n ? `${whole}` : `${whole}.${fracStr}`;
}

async function printPool(client: FlashLoanPoolClient, label = 'Pool state'): Promise<void> {
  const v = await client.readLedger();
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(`  ${label}`);
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`  Pool liquidity : ${tokens(v.poolLiquidity)} tokens (${v.poolLiquidity.toString()} base)`);
  console.log(`  Protocol fee   : ${Number(v.protocolFeeBps) / 100}% (${v.protocolFeeBps.toString()} bps)`);
  console.log(`  Loan bounds    : ${tokens(v.minLoan)} .. ${tokens(v.maxLoan)} tokens`);
  console.log(`  Pool status    : ${v.paused ? 'PAUSED' : 'open'}`);
  console.log(`  Runs completed : ${v.runCounter.toString()}`);
  console.log(`  Fees collected : ${tokens(v.totalFeeCollected)} tokens`);
  console.log('──────────────────────────────────────────────────────────────\n');
}

async function main() {
  const deployment = getDeployment(network);
  if (!deployment) {
    console.error('No deployment on file. Run: npm run deploy');
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const auto = args.includes('--auto');
  const amountArg = args.find((a) => a.startsWith('--amount='));
  const autoAmount = amountArg ? BigInt(amountArg.split('=')[1]) : 10_000_000n;

  console.log(`\n  Simple Flash Loan Pool — demo (network: ${network})`);
  console.log(`  Contract: ${deployment.address}\n`);

  const client = await FlashLoanPoolClient.create({ network, networkConfig, seed: SEED });
  await client.walletCtx.wallet.waitForSyncedState();
  await client.connect(deployment.address);

  await printPool(client, 'Current pool state');
  if (auto) {
    await runCanned(client, autoAmount);
  } else {
    await interact(client);
  }

  await printPool(client, 'Pool state after the run');
  const v = await client.readLedger();
  if (v.runs.length > 0) {
    console.log('  Most recent run:');
    const r = v.runs[0];
    console.log(`    runId   : ${r.runId}`);
    console.log(`    amount  : ${tokens(r.amount)} tokens`);
    console.log(`    fee     : ${tokens(r.fee)} tokens`);
    console.log(`    requester: ${Buffer.from(r.requester).toString('hex').slice(0, 16)}…\n`);
  }
  await client.stopWallet();
  process.exit(0);
}

async function interact(client: FlashLoanPoolClient): Promise<void> {
  const rl = readline.createInterface({ input, output });
  try {
    const v = await client.readLedger();
    while (true) {
      const raw = await rl.question(
        `  Loan amount in base units [default 10000000 (10 tokens), 0 = quit]? `,
      );
      const amount = raw.trim() === '' ? 10_000_000n : BigInt(raw.trim());
      if (amount === 0n) break;
      if (amount < v.minLoan || amount > v.maxLoan) {
        console.log(`  ❌ Amount outside [${tokens(v.minLoan)}, ${tokens(v.maxLoan)}] tokens.`);
        continue;
      }
      const fee = exactFee(amount, v.protocolFeeBps);
      console.log(`  Exact protocol fee: ${fee.toString()} base (${tokens(fee)} tokens)`);

      const bidRaw = await rl.question('  Market bid price (base units; e.g. 100)? ');
      const askRaw = await rl.question('  Market ask price (base units; e.g. 101)? ');
      const bid = bidRaw.trim() === '' ? 100n : BigInt(bidRaw.trim());
      const ask = askRaw.trim() === '' ? 101n : BigInt(askRaw.trim());
      if (!feeAccepted(amount, fee, v.protocolFeeBps)) {
        console.log('  ❌ Fee computation inconsistent — aborting.');
        continue;
      }
      client.setPrices(bid, ask);
      await client.connect(deploymentAddress(client));
      const runId = `demo-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16)}`;
      console.log(`  Executing atomic flash loan (runId ${runId})...`);
      const t = Date.now();
      try {
        await client.executeFlashLoan(amount, fee, runId);
        console.log(`  ✅ RUN SETTLED in ${((Date.now() - t) / 1000).toFixed(1)}s`);
      } catch (err: any) {
        console.log(`  ❌ RUN REJECTED: ${extractAssert(err) ?? 'unknown reason'}`);
      }
      await printPool(client, 'Pool state after this attempt');
    }
  } finally {
    rl.close();
  }
}

async function runCanned(client: FlashLoanPoolClient, amount: bigint): Promise<void> {
  const v = await client.readLedger();
  console.log(`  Canned run: ${tokens(amount)} tokens at bid=100 ask=101\n`);
  if (amount < v.minLoan || amount > v.maxLoan) {
    console.log(`  ❌ Canned amount outside loan bounds.`);
    return;
  }
  const fee = exactFee(amount, v.protocolFeeBps);
  client.setPrices(100n, 101n);
  await client.connect(deploymentAddress(client));
  const runId = `demo-auto-${Date.now().toString(36)}`;
  console.log(`  Fee: ${fee.toString()} base; runId ${runId}; executing...`);
  const t = Date.now();
  try {
    await client.executeFlashLoan(amount, fee, runId);
    console.log(`  ✅ RUN SETTLED in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  } catch (err: any) {
    console.log(`  ❌ RUN REJECTED: ${extractAssert(err) ?? 'unknown reason'}`);
  }
}

function deploymentAddress(client: FlashLoanPoolClient): string {
  const a = client.address;
  if (!a) throw new Error('client not connected');
  return a;
}

/** Pulls the deepest 'failed assert: <msg>' message out of the error chain. */
function extractAssert(err: any): string | null {
  let cur = err;
  while (cur) {
    const m = cur?.message;
    if (typeof m === 'string') {
      const i = m.indexOf('failed assert:');
      if (i >= 0) return m.slice(i + 'failed assert:'.length).trim();
    }
    cur = cur?.cause;
  }
  return null;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});