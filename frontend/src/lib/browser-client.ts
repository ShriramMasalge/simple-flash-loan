/**
 * In-browser execution of the flash-loan pool via a DApp Connector wallet
 * (window.midnight, CAIP-372).
 *
 * The wallet handles proving (getProvingProvider), balancing + signing
 * (balanceUnsealedTransaction) and submission (submitTransaction), so the
 * DApp only needs to wire the ConnectedAPI into Midnight.js providers.
 *
 * Note: this path requires a wallet extension connected to a network where
 * the pool is deployed (e.g. preview/preprod). On the local devnet there is
 * no extension, so the CLI (`npm run demo`) remains the verified execution
 * path. The wire format for balanceUnsealedTransaction/submitTransaction is
 * the ledger's string form (`tx.toString()`); exact compatibility is verified
 * against a live extension at wallet-integration time.
 */
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';

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

function decodeBech32m(address: string): Uint8Array {
  // Minimal bech32m decode: strip "mn1"/"mn2"-style prefix + "1" separator,
  // then decode the 5-bit charset (qpzry9x8gf2tvdw0s3jn54khce6mua7l).
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const sep = address.lastIndexOf('1');
  if (sep < 1) throw new Error('Not a bech32m address');
  const data = address.slice(sep + 1);
  const words = new Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = CHARSET.indexOf(data[i]);
    if (v < 0) throw new Error('Invalid bech32m character');
    words[i] = v;
  }
  let acc = 0;
  let accBits = 0;
  const bytes: number[] = [];
  for (let p = 0; p < words.length - 6; p++) {
    acc = (acc << 5) | words[p];
    accBits += 5;
    if (accBits >= 8) {
      accBits -= 8;
      bytes.push((acc >>> accBits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export interface BrowserPoolClient {
  address: string;
  executeFlashLoan(amount: bigint, fee: bigint, runId: string): Promise<unknown>;
}

/** Connects to an already-deployed pool using the wallet extension. */
export async function connectBrowserClient(opts: BrowserClientOptions): Promise<BrowserPoolClient> {
  const { walletApi } = opts;

  const config = await walletApi.getConfiguration?.();
  const indexer = config?.indexerUri ?? opts.indexerUrl;
  const indexerWs = config?.indexerWsUri ?? opts.indexerWsUrl;
  const networkId = config?.networkId ?? opts.networkId;

  const shielded = await walletApi.getShieldedAddresses();
  // SDK's parseCoinPublicKeyToHex and parseEncPublicKeyToHex both expect
  // bech32 or hex strings — pass the raw shielded addresses as-is and let the
  // SDK handle decoding them internally.
  const coinPublicKey = shielded.shieldedCoinPublicKey;
  const encryptionPublicKey = shielded.shieldedEncryptionPublicKey;

  const arbitragePrices = opts.arbitragePrices;

  const zkConfigProvider = new FetchZkConfigProvider(opts.zkBaseURL);
  const provingProvider = await walletApi.getProvingProvider(zkConfigProvider);

  const { createProofProvider } = await import('@midnight-ntwrk/midnight-js-types');
  const proofProvider = createProofProvider(provingProvider);

  // The wallet's wire format is base64 of tx.serialize() (markers are the
  // ledger's string literals, matching wallet-sdk's own deserialize calls).
  const toWalletString = (tx: any) => {
    const bytes = tx.serialize() as Uint8Array;
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };
  const fromWalletString = (s: string) =>
    ledger.Transaction.deserialize('signature', 'proof', 'binding', b64ToBytes(s));

  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: PRIVATE_STATE_STORE,
      accountId: shielded.shieldedAddress,
      privateStoragePasswordProvider: () => Promise.resolve('Browser-Demo-Password123'),
    }),
    publicDataProvider: indexerPublicDataProvider(indexer, indexerWs),
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
  };
}

/** Builds the compiled contract with the arbitrage-price witness. */
export async function makeCompiledContract(getPrices?: () => { bid: bigint; ask: bigint }): Promise<unknown> {
  const mod = await import('../zk-contract/index.js');
  const contract = (CompiledContract.make as any)(CONTRACT_NAME, mod.Contract as any);
  const prices = getPrices ?? (() => {
    console.warn('arbitragePrices witness called with no prices provider');
    return { bid: 0n, ask: 0n };
  });
  return (contract as any).pipe((CompiledContract.withWitnesses as any)({
    arbitragePrices: () => {
      const p = prices();
      console.log('arbitrage witness:', { bid: String(p.bid), ask: String(p.ask) });
      return [undefined, { bid: p.bid, ask: p.ask }];
    },
  }));
}
