/**
 * Fund a local-devnet wallet from the genesis key (undeployed network).
 *
 * The devnet's dev preset mints the entire NIGHT supply to the genesis key
 * (GENESIS_SEED in network.ts — the same seed `npm run deploy` / `npm run demo`
 * use). This script transfers tNIGHT from that key to any unshielded address
 * (e.g. the one shown by the Lace wallet on the Undeployed network), and — if
 * the genesis wallet has no DUST yet — registers NIGHT UTXOs for DUST
 * generation first so it can pay the transfer's fees.
 *
 * Usage:
 *   npm run fund-wallet -- --to mn_addr_undeployed1q... [--amount 50000]
 */
import { WebSocket } from 'ws';

import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { resolveNetwork, GENESIS_SEED } from './network';
import { createWallet, persistWalletState, unshieldedToken } from './wallet';

// Enable WebSocket for GraphQL subscriptions
// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

// 1 token = 1_000_000 base units (the contract's scaling constants; NIGHT
// stars have the same scale on undeployed).
const BASE = 1_000_000n;

// DUST threshold (specks) before we consider the wallet able to pay fees.
// wallet.ts sets an additionalFeeOverhead of 3e14 specks, so be generous.
const DUST_THRESHOLD = 5_000_000_000_000_000n; // 5e15 specks

interface Args {
  to: string;
  amount: bigint;
  seed: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] ?? null : null;
  };
  const to = get('--to');
  const amountRaw = get('--amount');
  const seed = get('--seed') ?? GENESIS_SEED;

  const amount = amountRaw !== null
    ? BigInt(amountRaw) * BASE
    : 50_000n * BASE;

  if (!to) {
    throw new Error('Missing required --to <unshielded address>. Usage: npm run fund-wallet -- --to <address> [--amount <tokens>] [--seed <hex>]');
  }
  return { to, amount, seed };
}

function parseUnshieldedAddress(bech32: string, networkId: string): UnshieldedAddress {
  return UnshieldedAddress.codec.decode(networkId as never, MidnightBech32m.parse(bech32.trim()));
}

async function ensureDust(ctx: Awaited<ReturnType<typeof createWallet>>): Promise<void> {
  const facade = ctx.wallet;
  let state = await facade.waitForSyncedState();
  let dust = state.dust.balance(new Date());

  if (dust >= DUST_THRESHOLD) {
    console.log(`  ✅ DUST balance sufficient (${dust.toLocaleString()} specks)`);
    return;
  }
  console.log(`  ⚠ DUST balance is ${dust.toLocaleString()} specks — registering NIGHT UTXOs for DUST generation...`);

  const nightUtxos = state.unshielded.totalCoins;
  if (nightUtxos.length === 0) {
    throw new Error('No unshielded NIGHT UTXOs available to register for DUST generation.');
  }

  const recipe = await facade.registerNightUtxosForDustGeneration(
    nightUtxos,
    ctx.unshieldedKeystore.getPublicKey(),
    (payload) => ctx.unshieldedKeystore.signData(payload),
    state.dust.address,
  );
  const finalized = await facade.finalizeRecipe(recipe);
  const txId = await facade.submitTransaction(finalized);
  console.log(`  ↳ registration submitted (tx ${txId.slice(0, 16)}…), waiting for DUST to accrue...`);

  await facade.waitForGeneratedDust(nightUtxos, DUST_THRESHOLD, { timeoutMs: 180_000 });

  state = await facade.waitForSyncedState();
  dust = state.dust.balance(new Date());
  if (dust < DUST_THRESHOLD) {
    throw new Error(`DUST still below threshold after registration (${dust.toLocaleString()} specks).`);
  }
  console.log(`  ✅ DUST now ${dust.toLocaleString()} specks`);
}

async function main() {
  const { to, amount, seed } = parseArgs();
  const { network, config: networkConfig } = resolveNetwork();
  if (network !== 'undeployed') {
    console.error(`This script funds the local devnet only; active network is "${network}".`);
    process.exit(2);
  }

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    Genesis Wallet Funder                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  try {
    setNetworkId(networkConfig.networkId);
    const receiver = parseUnshieldedAddress(to, networkConfig.networkId);

    console.log(`  Recipient: ${to.trim()}`);
    console.log(`  Amount:    ${(amount / BASE).toString()} tNIGHT`);
    console.log('  Building genesis wallet...');
    const ctx = await createWallet({ network, networkConfig, seed });

    console.log('  Syncing with network...');
    console.log('  ℹ  This may take several minutes depending on network size.');
    console.log('     RPC disconnection messages during sync are normal and can be safely ignored.\n');
    const syncStart = Date.now();
    const syncInterval = setInterval(() => {
      const elapsed = Math.round((Date.now() - syncStart) / 1000);
      process.stdout.write(`\r  ⏳ Still syncing... (${elapsed}s elapsed)   `);
    }, 5000);

    const state = await ctx.wallet.waitForSyncedState();
    clearInterval(syncInterval);
    process.stdout.write('\r  ✓ Synced with network.                                      \n');

    const sender = ctx.unshieldedKeystore.getBech32Address();
    const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
    console.log(`\n  Sender:   ${sender}`);
    console.log(`  tNIGHT:   ${balance.toLocaleString()}`);

    if (balance < amount) {
      throw new Error(
        `Insufficient tNIGHT (have ${(balance / BASE).toString()}, need ${(amount / BASE).toString()}).`,
      );
    }

    await ensureDust(ctx);

    console.log('\n  Transferring tNIGHT...');
    const recipe = await ctx.wallet.transferTransaction(
      [
        {
          type: 'unshielded',
          outputs: [{ type: unshieldedToken().raw, receiverAddress: receiver, amount }],
        },
      ],
      { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
      { ttl: new Date(Date.now() + 30 * 60_000) },
    );
    const signed = await ctx.wallet.signRecipe(recipe, (payload) =>
      ctx.unshieldedKeystore.signData(payload),
    );
    const finalized = await ctx.wallet.finalizeRecipe(signed);
    const txId = await ctx.wallet.submitTransaction(finalized);
    console.log(`  ✅ Transfer submitted: ${txId}`);
    console.log(`     ${(amount / BASE).toString()} tNIGHT → ${to.trim()}\n`);

    await persistWalletState(network, ctx);
    await ctx.wallet.stop();
  } catch (error) {
    console.error('\n❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
