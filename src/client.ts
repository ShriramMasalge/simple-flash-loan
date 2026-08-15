/**
 * Shared client for the Simple Flash Loan Pool: wallet, providers, compiled
 * contract (with the arbitrage-price witness), and typed circuit calls.
 *
 * Used by src/deploy.ts (deployment), tests/e2e/run.ts (verification), and
 * the demo CLI. The witness is stateful by design: callers set
 * `client.setPrices(bid, ask)` before `executeFlashLoan`, mirroring what the
 * frontend does when the user supplies a price pair.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';

import { resolveNetwork, type NetworkConfig, type NetworkId } from './network';
import { createWallet, unshieldedToken, type WalletContext } from './wallet';

// @ts-expect-error wallet sync requires a WebSocket implementation
globalThis.WebSocket = WebSocket;

export const CONTRACT_NAME = 'flash-loan-pool';
export const PRIVATE_STATE_ID = 'flashLoanPoolPrivateState';
export const PRIVATE_STATE_STORE = 'flash-loan-pool-state';

// Deploy defaults (mirror the README's example pool).
export const DEFAULT_INITIAL_LIQUIDITY = 100_000_000n; // 100 tokens
export const DEFAULT_FEE_BPS = 50n;                    // 0.50%
export const DEFAULT_MIN_LOAN = 10_000n;               // 0.01 token
export const DEFAULT_MAX_LOAN = 100_000_000n;          // 100 tokens

export interface ArbitragePrices {
  bid: bigint;
  ask: bigint;
}

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

function zkConfigPath(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, '..', 'contracts', 'managed', CONTRACT_NAME);
}

export async function loadCompiledContract() {
  const zk = zkConfigPath();
  const contractPath = path.join(zk, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) {
    throw new Error('Compiled contract missing — run `npm run compile` first.');
  }
  const mod = await import(pathToFileURL(contractPath).href);
  return { zkConfigPath: zk, Contract: mod.Contract as any };
}

export interface CompiledFlashLoanContract {
  zkConfigPath: string;
  makeCompiledContract(getPrices: () => ArbitragePrices): unknown;
}

export async function compileContract(): Promise<CompiledFlashLoanContract> {
  const { zkConfigPath: zk, Contract } = await loadCompiledContract();
  return {
    zkConfigPath: zk,
    // The witness reads prices lazily through `getPrices`, so setPrices()
    // between calls is reflected without rebuilding the compiled contract.
    makeCompiledContract(getPrices: () => ArbitragePrices) {
      return (CompiledContract.make as any)(CONTRACT_NAME, Contract).pipe(
        (CompiledContract.withWitnesses as any)({
          // The generated wrapper destructures the witness result as
          // [nextPrivateState, result]; this contract keeps no private state,
          // so the first element is undefined.
          arbitragePrices: () => {
            const p = getPrices();
            console.log('[witness] arbitragePrices:', { bid: p.bid.toString(), ask: p.ask.toString() });
            return [undefined, { bid: p.bid, ask: p.ask }];
          },
        }),
        (CompiledContract.withCompiledFileAssets as any)(zk),
      );
    },
  };
}

export function privateStatePassword(): string {
  return process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';
}

export async function createProviders(walletCtx: WalletContext, networkConfig: NetworkConfig, zk: string) {
  const walletProvider = {
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return walletCtx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

  const zkConfigProvider = new NodeZkConfigProvider(zk);
  const accountId = walletCtx.unshieldedKeystore.getBech32Address().toString();

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: PRIVATE_STATE_STORE,
      accountId,
      privateStoragePasswordProvider: () => privateStatePassword(),
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

export interface FlashLoanPoolClientOptions {
  network: NetworkId;
  networkConfig: NetworkConfig;
  seed: string;
  prices?: ArbitragePrices;
}

export class FlashLoanPoolClient {
  readonly zkConfigPath: string;
  private readonly network: NetworkId;
  private readonly networkConfig: NetworkConfig;
  readonly walletCtx: WalletContext;
  private providerCache: Awaited<ReturnType<typeof createProviders>> | null = null;

  private prices: ArbitragePrices;
  private handles: {
    provisionedAddress?: string;
    contract?: any;
  } = {};

  constructor(opts: FlashLoanPoolClientOptions, zkConfigPath: string, walletCtx: WalletContext) {
    this.network = opts.network;
    this.networkConfig = opts.networkConfig;
    this.zkConfigPath = zkConfigPath;
    this.walletCtx = walletCtx;
    this.prices = opts.prices ?? { bid: 100n, ask: 101n };
  }

  static async create(opts: FlashLoanPoolClientOptions): Promise<FlashLoanPoolClient> {
    const compiled = await compileContract();
    const walletCtx = await createWallet({ network: opts.network, networkConfig: opts.networkConfig, seed: opts.seed });
    return new FlashLoanPoolClient(opts, compiled.zkConfigPath, walletCtx);
  }

  setPrices(bid: bigint, ask: bigint): void {
    this.prices = { bid, ask };
  }

  get address(): string | undefined {
    return this.handles.provisionedAddress;
  }

  async providers() {
    if (!this.providerCache) {
      this.providerCache = await createProviders(this.walletCtx, this.networkConfig, this.zkConfigPath);
    }
    return this.providerCache;
  }

  async compiledContract() {
    const compiled = await compileContract();
    return compiled.makeCompiledContract(() => this.prices);
  }

  async deploy(initialLiquidity: bigint, feeBps: bigint, minLoan: bigint, maxLoan: bigint) {
    const providers = await this.providers();
    const deployed = await deployContract(providers, {
      compiledContract: (await this.compiledContract()) as any,
      args: [initialLiquidity, feeBps, minLoan, maxLoan],
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: {},
    });
    this.handles.contract = deployed;
    this.handles.provisionedAddress = deployed.deployTxData.public.contractAddress;
    return this.handles.provisionedAddress;
  }

  async connect(contractAddress: string) {
    const providers = await this.providers();
    const contract = await findDeployedContract(providers, {
      contractAddress,
      compiledContract: (await this.compiledContract()) as any,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: {},
    });
    this.handles.contract = contract;
    this.handles.provisionedAddress = contractAddress;
    return contract;
  }

  get contract(): any {
    if (!this.handles.contract) throw new Error('Not connected to contract — deploy or connect first.');
    return this.handles.contract;
  }

  async readLedger(): Promise<PoolLedgerView> {
    const providers = await this.providers();
    const onChain = await providers.publicDataProvider.queryContractState(this.address ?? '');
    if (!onChain) throw new Error('queryContractState returned null');
    // The imported state is a WASM ContractState: its `.data` is the JS
    // ChargedState that the generated ledger() getter can decode.
    const charged: any = (onChain as any).data ?? (onChain as any).state;
    const { ledger } = await import(pathToFileURL(path.join(this.zkConfigPath, 'contract', 'index.js')).href);
    const view = ledger(charged);
    const runs: RunRecordView[] = [];
    for (const r of view.runs as any) runs.push(r as RunRecordView);
    return {
      adminKeyHash: (view.adminKeyHash as any) instanceof Uint8Array ? (view.adminKeyHash as Uint8Array) : new Uint8Array(32),
      poolLiquidity: view.poolLiquidity as bigint,
      protocolFeeBps: view.protocolFeeBps as bigint,
      minLoan: view.minLoan as bigint,
      maxLoan: view.maxLoan as bigint,
      paused: view.paused as boolean,
      runCounter: view.runCounter as bigint,
      totalFeeCollected: view.totalFeeCollected as bigint,
      runs,
    };
  }

  /** Submits a circuit call and waits for finalization (rejects on failure). */
  async executeFlashLoan(amount: bigint, fee: bigint, runId: string): Promise<unknown> {
    return this.contract.callTx.executeFlashLoan(amount, fee, runId);
  }

  async topUpLiquidity(amount: bigint): Promise<unknown> {
    return this.contract.callTx.topUpLiquidity(amount);
  }

  async withdrawLiquidity(amount: bigint): Promise<unknown> {
    return this.contract.callTx.withdrawLiquidity(amount);
  }

  async setFeeBps(bps: bigint): Promise<unknown> {
    return this.contract.callTx.setFeeBps(bps);
  }

  async setLoanLimits(min: bigint, max: bigint): Promise<unknown> {
    return this.contract.callTx.setLoanLimits(min, max);
  }

  async setPaused(to: boolean): Promise<unknown> {
    return this.contract.callTx.setPaused(to);
  }

  async stopWallet(): Promise<void> {
    await this.walletCtx.wallet.stop();
  }
}

export { unshieldedToken };
export type { NetworkConfig };
export { resolveNetwork };