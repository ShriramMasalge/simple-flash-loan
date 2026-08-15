# Simple Flash Loan Pool (Midnight)

An educational, honest flash-loan implementation on Midnight. A pool contract
issues an *atomic* loan: borrow, arbitrage, and repay must all succeed inside a
single transaction or the whole run is rejected — no funds ever leave the pool
permanently without a covering repayment.

```
REQUEST → VALIDATE → BORROW → ARBITRAGE PROOF → REPAY → SETTLE
         └────────────── all inside one atomic transaction ──────────┘
```

## Why Midnight fits flash loans

Flash loans are atomic-by-construction: the pool never takes counterparty risk
because borrow and repay happen in the same transaction. Midnight adds two
things that matter here:

- **Zk proof that repayment is covered, without revealing the arbitrage.** The
  circuit checks `askPrice × borrowed ≥ (borrowed + fee) × bidPrice`; the actual
  prices stay private on-chain.
- **Private audit trail.** Each borrower is recorded as a hash of their coin
  public key, not an address.

## Project layout

```
contracts/flash-loan-pool       compact (pre-nargo) contracts
contracts/managed/…             compiled circuit (zkir, keys, contract JS)
frontend/                       React pool dashboard (read-only on devnet)
src/                            zkapp library + deploy script
tests/e2e/                      the full lifecycle as an executable demo
scripts/                        compile + devnet helper scripts
docker-compose.yml              local Midnight devnet
```

## Quick start (local devnet)

```bash
npm install
docker compose up -d          # indexer + proof server, API at 127.0.0.1:8088
npm run wait-for-indexer
npm run compile                # circuit → managed artifacts (needs nargo)
npm run sync:zk                # (re)sync ZK assets to the frontend
npm run deploy                 # deploy the pool on the devnet, print address
npm run demo                   # run a full atomic flash-loan lifecycle
```

`npm run demo` prints the six stages and, at the end, a contract address you can
paste into the frontend (`frontend/.env` → `VITE_CONTRACT_ADDRESS`).

## Frontend

```bash
cd frontend && npm install && npm run dev
```

- **Pool tab** — live liquidity, fee, bounds, paused state, run history.
- **Borrow tab** — loan amount + market prices, live validation with the exact
  circuit math (fee, profitability, bounds), and a six-stage proof dial showing
  the atomic lifecycle. With a DApp Connector wallet extension connected
  (`window.midnight`), Execute runs the real circuit: the wallet proves,
  balances and submits; without one, the dial stays illustrative and the CLI
  (`npm run demo`) covers the identical flow.
- **Admin tab** — pool parameters and the list of admin actions. (Admin
  transactions are not wired through the wallet in this build; on the devnet
  they are driven by the deploy script and `npm run test:e2e`.)

### Wallet status: "Wallet: not detected"

Real Midnight wallet extensions **exist and are installable today** — this is
not a permanent platform limitation of the devnet setup:

- **GSD Wallet** (community, Chrome) — explicitly built for testing against
  `undeployed` (local), DevNet, and QANet networks; the natural match for this
  repo's local devnet.
- **Lace** (lace.io, official, Chrome) — targets the public networks and
  expects a local proof server (`http://localhost:6300`) for proving.
- **1AM / Nocturne** (Chrome/Firefox) — additional DApp Connector wallets.

"Wallet: not detected" means the browser has no extension injecting
`window.midnight`; installing one (and refreshing the page once — extensions
inject shortly after page load) should activate the Connect button, because
the detection and `connect(networkId)` call in this repo follow the DApp
Connector API (CAIP-372) shape.

**Honest caveat:** that wiring has **not been validated end-to-end against a
live extension in this environment**. Local-network ids like `undeployed` are
wallet-defined (only `mainnet` is standardized by the connector spec), and
each wallet differs in proving, DUST, and address handling — so treat a
connected wallet here as *unverified*, not broken. The verified execution
routes remain the CLI and `npm run test:e2e` on the devnet.

## What this project deliberately does NOT do

This is an educational implementation, not a product. Specifically:

- **No real arbitrage execution.** The demo supplies fixed bid/ask prices.
  Integrating a real DEX/oracle feed is left to you.
- **No oracles, no liquidation of underwater runs.** Atomicity makes most of
  these unnecessary *if* the circuit is correct — which is exactly why the
  proof-of-repayment checks live inside the circuit rather than in app code.
- **Virtual liquidity.** The pool tracks its own token ledger; it is not wired
  to a shielded-token faucet or a real reserve.
- **In-browser execution is implemented but not extension-verified.** The
  Borrow tab wires the DApp Connector API (prove/balance/submit via the
  wallet) and builds the same compiled circuit the CLI uses, but the exact
  wire format (base64 of `tx.serialize()`) is documented for wallet
  integration and has not been validated against a live extension — the
  devnet CLI path is the verified execution route today. See "Wallet status"
  above for which extensions exist and what is verified.

Treat every zkapp claim about correctness as *a claim to verify*, not a
guarantee. The e2e suite (`npm run test:e2e`) demonstrates the happy path and
rejections (pause, bounds, ask ≤ bid) on the devnet.

## Notes

- Fee: `fee = amount × feeBps / 10000`, enforced as `feeBps ∈ [0, 1000]`.
- Loan bounds and pool caps are enforced in the circuit (asserts, not UI).
- Committed liquidity during a run means a run can never be double-satisfied.
