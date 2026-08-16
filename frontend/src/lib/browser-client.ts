/**
 * In-browser execution of the flash-loan pool via a DApp Connector wallet
 * (window.midnight, CAIP-372).
 *
 * The wallet handles proving (getProvingProvider), balancing + signing
 * (balanceUnsealedTransaction) and submission (submitTransaction), so the
 * DApp only needs to wire the ConnectedAPI into Midnight.js providers.
 *
 * Note: This path requires a wallet extension connected to a network where
 * the pool is deployed (e.g. preview/preprod). On the local devnet there is
 * no extension, so the CLI (`npm run demo`) remains the verified execution
 * path. The wire format for balanceUnsealedTransaction/submitTransaction is
 * a hex string of tx.serialize().
 */
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import * as ledger from '@midnight-ntwrk/ledger-v8';

function toHex(buf: Uint8Array): string {
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

/**
 * Custom publicDataProvider that queries the indexer via direct GraphQL fetch
 * (omitting the `offset` argument, which the preview indexer mishandles),
 * and deserializes using compact-runtime's ContractState (the same WASM module
 * instance used by the generated zk-contract's ledger() function).
 * This avoids the "instanceof _ChargedState" error caused by mixing
 * ledger-v8's and compact-runtime's separate WASM module instances.
 */
function makeCustomPublicDataProvider(indexerUrl: string): any {
  const cache = new Map<string, ContractState>();

  async function fetchContractState(address: string, stateField: string = 'state') {
    const res = await fetch(indexerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query { contractAction(address: "${address}") { ${stateField} } }`,
      }),
    });
    const json = await res.json();
    const stateHex = json?.data?.contractAction?.[stateField];
    if (!stateHex) return null;
    const stateBytes = new Uint8Array(Buffer.from(stateHex, 'hex'));
    return ContractState.deserialize(stateBytes);
  }

  return {
    async queryContractState(address: string) {
      const cached = cache.get(address);
      if (cached) return cached;
      const cs = await fetchContractState(address, 'state');
      if (cs) cache.set(address, cs);
      return cs;
    },
    async queryDeployContractState(address: string) {
      // For a deployed contract, the deploy state is the initial state.
      // Fetch it via the deploy contract action if available, else fall back
      // to the current contract state.
      const res = await fetch(indexerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `query { contractAction(address: "${address}") { ... on ContractCall { deploy { transaction { contractActions { address state } } } } } }`,
        }),
      });
      const json = await res.json();
      const deployActions = json?.data?.contractAction?.deploy?.transaction?.contractActions;
      if (deployActions && Array.isArray(deployActions)) {
        const action = deployActions.find((a: any) => a.address === address);
        if (action?.state) {
          const stateBytes = new Uint8Array(Buffer.from(action.state, 'hex'));
          return ContractState.deserialize(stateBytes);
        }
      }
      // Fallback: use current state (same as queryContractState)
      return this.queryContractState(address);
    },
    async watchForDeployTxData(address: string) {
      // Fetch deploy transaction metadata for error reporting.
      const res = await fetch(indexerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `query { contractAction(address: "${address}") { ... on ContractCall { deploy { transaction { hash block { height hash timestamp } } } } } }`,
        }),
      });
      const json = await res.json();
      const tx = json?.data?.contractAction?.deploy?.transaction;
      if (!tx) {
        // Fallback minimal data
        return {
          tx: null,
          status: 'success',
          txId: address,
          txHash: '',
          blockHeight: 0n,
          blockHash: '',
          blockTimestamp: 0n,
          blockAuthor: '',
          segmentStatusMap: {},
          unshielded: { createdUtxos: [], spentUtxos: [] },
          indexerId: '',
          protocolVersion: 0,
          fees: { estimatedFees: [], paidFees: [] },
        };
      }
      return {
        tx: null,
        status: 'success',
        txId: address,
        txHash: tx.hash ?? '',
        blockHeight: BigInt(tx.block?.height ?? 0),
        blockHash: tx.block?.hash ?? '',
        blockTimestamp: BigInt(tx.block?.timestamp ?? 0) * 1000n, // seconds → ms
        blockAuthor: tx.block?.author ?? '',
        segmentStatusMap: {},
        unshielded: { createdUtxos: [], spentUtxos: [] },
        indexerId: '',
        protocolVersion: 0,
        fees: { estimatedFees: [], paidFees: [] },
      };
    },
    async queryZSwapAndContractState(address: string) {
      const contractState = await this.queryContractState(address);
      if (!contractState) return null;

      // Fetch zswapState and ledgerParameters from the indexer
      const res = await fetch(indexerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `query { contractAction(address: "${address}") { zswapState transaction { block { ledgerParameters } } } }`,
        }),
      });
      const json = await res.json();
      const result = json?.data?.contractAction;

      let zswapChainState: any;
      if (result?.zswapState) {
        const stateBytes = new Uint8Array(Buffer.from(result.zswapState, 'hex'));
        zswapChainState = ledger.ZswapChainState.deserialize(stateBytes);
      } else {
        zswapChainState = null;
      }

      let ledgerParameters: any;
      if (result?.transaction?.block?.ledgerParameters) {
        const paramsBytes = new Uint8Array(Buffer.from(result.transaction.block.ledgerParameters, 'hex'));
        ledgerParameters = ledger.LedgerParameters.deserialize(paramsBytes);
      } else {
        ledgerParameters = ledger.LedgerParameters.initialParameters();
      }

      return [zswapChainState, contractState, ledgerParameters];
    },
    async queryUnshieldedBalances(_address: string) {
      return [];
    },
    async queryBlocks(_address: string, _config?: any) {
      return { blocks: [], latestBlock: 0n, blocksSinceSync: 0n };
    },
    async watchForContractState(_address: string) {
      throw new Error('watchForContractState is not implemented in the browser public data provider.');
    },
    async watchForUnshieldedBalances(_address: string) {
      throw new Error('watchForUnshieldedBalances is not implemented in the browser public data provider.');
    },
    async watchForTxData(txId: string) {
      // Polls the indexer for the transaction with the given txId.
      // Returns finalized tx data. Polls indefinitely until the tx appears
      // (per PublicDataProvider spec), with a reasonable backoff.
      const PollIntervalMs = 5_000;
      for (;;) {
        const res = await fetch(indexerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `query { transactions(offset: { identifier: "${txId}" }) { id protocolVersion raw hash unshieldedCreatedOutputs { owner intentHash tokenType value } unshieldedSpentOutputs { owner intentHash tokenType value } block { height hash author timestamp } ... on RegularTransaction { identifiers fees { estimatedFees paidFees } transactionResult { status segments { id success } } } } }`,
          }),
        });
        const json = await res.json();
        const txs = json?.data?.transactions;
        if (txs && txs.length > 0) {
          const tx = txs[0];
          const statusMap: Record<string, number> = {
            SUCCESS: 4,       // SucceedEntirely
            PARTIAL_SUCCESS: 1, // FailFallible
            FAILURE: 0,       // FailEntirely
          };
          const status = statusMap[tx.transactionResult?.status ?? 'SUCCESS'] ?? 4;
          const segments = tx.transactionResult?.segments ?? [];
          const segmentStatusMap = tx.transactionResult?.status === 'PARTIAL_SUCCESS' && segments.length > 0
            ? new Map(segments.map((s: any) => [s.id, s.success ? 1 : 0]))
            : undefined;
          return {
            tx: ledger.Transaction.deserialize('signature', 'proof', 'binding', new Uint8Array(Buffer.from(tx.raw, 'hex'))),
            status,
            txId,
            txHash: tx.hash,
            identifiers: tx.identifiers,
            blockHeight: BigInt(tx.block?.height ?? 0),
            blockHash: tx.block?.hash ?? '',
            segmentStatusMap,
            unshielded: {
              created: (tx.unshieldedCreatedOutputs ?? []).map((u: any) => ({
                owner: u.owner,
                intentHash: u.intentHash,
                tokenType: u.tokenType,
                value: BigInt(u.value),
              })),
              spent: (tx.unshieldedSpentOutputs ?? []).map((u: any) => ({
                owner: u.owner,
                intentHash: u.intentHash,
                tokenType: u.tokenType,
                value: BigInt(u.value),
              })),
            },
            blockTimestamp: BigInt(tx.block?.timestamp ?? 0) * 1000n,
            blockAuthor: tx.block?.author ?? '',
            indexerId: tx.id,
            protocolVersion: tx.protocolVersion,
            fees: {
              estimatedFees: tx.fees?.estimatedFees ?? [],
              paidFees: tx.fees?.paidFees ?? [],
            },
          };
        }
        await new Promise((resolve) => setTimeout(resolve, PollIntervalMs));
      }
    },
    contractStateObservable(_address: string, _config: any) {
      throw new Error('contractStateObservable is not implemented in the browser public data provider.');
    },
    unshieldedBalancesObservable(_address: string, _config: any) {
      throw new Error('unshieldedBalancesObservable is not implemented in the browser public data provider.');
    },
  };
}

export const CONTRACT_NAME = 'flash-loan-pool';
const PRIVATE_STATE_ID = 'flashLoanPoolPrivateState';
const PRIVATE_STATE_STORE = 'sfl-browser-state';

export interface BrowserClientOptions {
  walletApi: any;
  contractAddress: string;
  indexerUrl: string;
  indexerWsUrl: string;
  zkBaseURL: string;
  arbitragePrices?: () => { bid: bigint; ask: bigint };
  /** Fallback network id when the wallet's configuration lacks one. */
  networkId: string;
}

export interface BrowserPoolClient {
  address: string;
  executeFlashLoan(amount: bigint, fee: bigint, runId: string): Promise<unknown>;
  setPaused(to: boolean): Promise<unknown>;
}

/** Connects to an already-deployed pool using the wallet extension. */
export async function connectBrowserClient(opts: BrowserClientOptions): Promise<BrowserPoolClient> {
  const { walletApi } = opts;

  const config = await walletApi.getConfiguration?.();
  const indexer = config?.indexerUri ?? opts.indexerUrl;
  const networkId = config?.networkId ?? opts.networkId;

  const shielded = await walletApi.getShieldedAddresses();
  const coinPublicKey = shielded.shieldedCoinPublicKey;
  const encryptionPublicKey = shielded.shieldedEncryptionPublicKey;

  const arbitragePrices = opts.arbitragePrices;

  const zkConfigProvider = new FetchZkConfigProvider(opts.zkBaseURL);
  const provingProvider = await walletApi.getProvingProvider(zkConfigProvider);

  const { createProofProvider } = await import('@midnight-ntwrk/midnight-js-types');
  const proofProvider = createProofProvider(provingProvider);

  const toWalletString = (tx: any) => toHex(tx.serialize());
  const fromWalletString = (s: string) => {
    return ledger.Transaction.deserialize('signature', 'proof', 'binding', fromHex(s)) as ledger.FinalizedTransaction;
  };

  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: PRIVATE_STATE_STORE,
      accountId: shielded.shieldedAddress,
      privateStoragePasswordProvider: () => Promise.resolve('Browser-Demo-Password123'),
    }),
    publicDataProvider: makeCustomPublicDataProvider(indexer),
    zkConfigProvider,
    proofProvider,
    walletProvider: {
      getCoinPublicKey: () => coinPublicKey,
      getEncryptionPublicKey: () => encryptionPublicKey,
      async balanceTx(tx: any) {
        const res = await walletApi.balanceUnsealedTransaction(toWalletString(tx));
        return fromWalletString(res.tx) as ledger.FinalizedTransaction;
      },
      submitTx: () => Promise.resolve(opts.contractAddress) as any,
    },
    midnightProvider: {
      getEncryptionPublicKey: () => encryptionPublicKey,
      submitTx: (tx: any) => walletApi.submitTransaction(toWalletString(tx)) as any,
    },
    networkId,
  } as any;

  const contract = await findDeployedContract(
    providers,
    {
      contractAddress: opts.contractAddress,
      compiledContract: await makeCompiledContract(arbitragePrices),
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: {},
    } as any,
  );

  return {
    address: opts.contractAddress,
    executeFlashLoan: (amount, fee, runId) => contract.callTx.executeFlashLoan(amount, fee, runId),
    setPaused: (to: boolean) => contract.callTx.setPaused(to),
  };
}

/** Builds the compiled contract with the arbitrage-price witness. */
export async function makeCompiledContract(getPrices?: () => { bid: bigint; ask: bigint }): Promise<any> {
  const mod = await import('../zk-contract/index.js');
  const prices = getPrices ?? (() => {
    console.warn('arbitragePrices witness called with no prices provider');
    return { bid: 0n, ask: 0n };
  });
  const { make, withWitnesses } = CompiledContract as any;
  const baseContract = make(CONTRACT_NAME, mod.Contract as any);
  const compiledContract = baseContract.pipe(withWitnesses({
    arbitragePrices: () => {
      const p = prices();
      return [undefined, { bid: p.bid, ask: p.ask }];
    },
  }));

  return compiledContract;
}
