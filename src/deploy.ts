/**
 * Deploy the Simple Flash Loan Pool to a Midnight network (default: local
 * devnet via docker compose). Non-interactive: runs straight through.
 */
import { resolveNetwork, getOrCreateSeed, recordDeployment } from './network';
import { persistWalletState, unshieldedToken } from './wallet';
import * as Rx from 'rxjs';

import { FlashLoanPoolClient, DEFAULT_INITIAL_LIQUIDITY, DEFAULT_FEE_BPS, DEFAULT_MIN_LOAN, DEFAULT_MAX_LOAN } from './client';

async function waitForProofServer(proofServer: string, maxAttempts = 60, delayMs = 2000): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fetch(proofServer, { method: 'GET', signal: AbortSignal.timeout(3000) });
      return true;
    } catch {
      // keep polling
    }
    if (attempt < maxAttempts) {
      process.stdout.write(`\r  Waiting for proof server... (${attempt}/${maxAttempts})   `);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

async function ensureDust(walletCtx: any): Promise<void> {
  const state: any = await Rx.firstValueFrom(walletCtx.wallet.state());
  const unregisteredUtxos = state.unshielded.availableCoins.filter(
    (c: any) => !c.meta?.registeredForDustGeneration,
  );
  if (unregisteredUtxos.length > 0) {
    console.log(`  Registering ${unregisteredUtxos.length} NIGHT UTXOs for DUST generation...`);
    const recipe = await walletCtx.wallet.registerNightUtxosForDustGeneration(
      unregisteredUtxos,
      walletCtx.unshieldedKeystore.getPublicKey(),
      (payload: any) => walletCtx.unshieldedKeystore.signData(payload),
    );
    const finalized = await walletCtx.wallet.finalizeRecipe(recipe);
    await walletCtx.wallet.submitTransaction(finalized);
  }
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const s: any = await Rx.firstValueFrom(walletCtx.wallet.state());
    if (s?.isSynced && s.dust.balance(new Date()) > 0n) {
      console.log('  DUST tokens ready!\n');
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('Not enough DUST after 120s of polling.');
}

async function main() {
  const { network, config: networkConfig } = resolveNetwork();
  const seed = getOrCreateSeed(network);

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Deploy simple-flash-loan to ${network}`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('─── Wallet ───────────────────────────────────────────────────\n');
  const client = await FlashLoanPoolClient.create({ network, networkConfig, seed });
  const walletCtx = client.walletCtx;
  const restoredCount = Object.values(walletCtx.restored).filter(Boolean).length;
  if (restoredCount > 0) {
    console.log(`  Restored ${restoredCount}/3 child wallets from saved state — sync resumes from saved point.`);
  }

  console.log('  Syncing with network...');
  console.log('  ℹ  This may take several minutes on a fresh devnet; RPC disconnects are normal.\n');
  const syncStart = Date.now();
  const syncInterval = setInterval(() => {
    process.stdout.write(`\r  ⏳ Still syncing... (${Math.round((Date.now() - syncStart) / 1000)}s elapsed)   `);
  }, 5000);
  const state = await walletCtx.wallet.waitForSyncedState();
  clearInterval(syncInterval);
  process.stdout.write('\r  ✓ Synced with network.                                      \n');

  await persistWalletState(network, walletCtx);

  const address = walletCtx.unshieldedKeystore.getBech32Address();
  const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
  console.log(`  Wallet Address: ${address}`);
  console.log(`  Balance: ${balance.toLocaleString()} tNight\n`);

  if (network === 'undeployed' && balance === 0n) {
    console.error(
      '\n❌ Genesis-seed wallet has zero NIGHT. Check `docker compose ps` and logs, then `docker compose down -v` and retry.\n',
    );
    await client.stopWallet();
    process.exit(1);
  }

  console.log('─── DUST Token Setup ────────────────────────────────────────\n');
  await ensureDust(walletCtx);

  console.log('─── Deploy Contract ─────────────────────────────────────────\n');
  console.log('  Checking proof server...');
  const proofServerReady = await waitForProofServer(networkConfig.proofServer);
  if (!proofServerReady) {
    console.log('\n  ❌ Proof server not responding. Run: docker compose up -d\n');
    await client.stopWallet();
    process.exit(1);
  }
  process.stdout.write('\r  Proof server ready!                                 \n');

  // Fresh DUST projection gap: sleep ~1 block before the first attempt.
  process.stdout.write('  Generating DUST...');
  await new Promise((r) => setTimeout(r, 6000));
  process.stdout.write(' done.\n');

  const MAX_RETRIES = 20;
  const RETRY_DELAY_MS = 5000;
  let contractAddress: string | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      contractAddress = await client.deploy(DEFAULT_INITIAL_LIQUIDITY, DEFAULT_FEE_BPS, DEFAULT_MIN_LOAN, DEFAULT_MAX_LOAN);
      break;
    } catch (err: any) {
      const errMsg = err?.message || err?.toString() || '';
      const errCause = err?.cause?.message || err?.cause?.toString() || '';
      const fullError = `${errMsg} ${errCause}`;
      const isDustShortage =
        fullError.includes('Not enough Dust') ||
        fullError.includes('Insufficient Funds') ||
        fullError.includes('could not balance dust');

      if (!(isDustShortage && attempt === 1)) {
        console.error(`\n  Attempt ${attempt} error: ${errMsg}`);
        if (errCause && errCause !== errMsg) console.error(`  Cause: ${errCause}`);
      }

      if (isDustShortage) {
        const currentState = await walletCtx.wallet.waitForSyncedState();
        const dustBalance = currentState.dust.balance(new Date());
        if (attempt === 1) {
          console.log(`  Still generating DUST, retrying in ${RETRY_DELAY_MS / 1000}s...`);
        } else {
          console.log(`  ⏳ DUST balance: ${dustBalance.toLocaleString()} (attempt ${attempt}/${MAX_RETRIES}); retrying in ${RETRY_DELAY_MS / 1000}s...`);
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }

  if (!contractAddress) throw new Error('Deployment failed after all retries');

  console.log('  ✅ Contract deployed successfully!\n');
  console.log(`  Contract Address: ${contractAddress}\n`);

  recordDeployment(network, contractAddress, address.toString());
  console.log('  Saved to .midnight-state.json\n');

  await persistWalletState(network, walletCtx);
  await client.stopWallet();
  console.log('─── Deployment complete ─────────────────────────────────────\n');
  console.log('  Next: npm run test:e2e\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});