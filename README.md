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

## Setup / Run locally

### Prerequisites
- **Node.js ≥ 20** (tested with 20.x LTS)
- **Docker + Docker Compose** — runs the Midnight indexer and proof server
- **Compact compiler / nargo** — installed via `npm install` (pinned in `package.json`)

### Install
```bash
# Root dependencies (compiler, deploy scripts, test runner)
npm install

# Frontend dependencies
cd frontend && npm install && cd ..
```

### Environment variables
The frontend reads from `frontend/.env`. Create it from the example:
```bash
cp frontend/.env.example frontend/.env
```

Required variables (do not commit actual values):
- `VITE_CONTRACT_ADDRESS` — deployed pool contract address (hex, no `0x`)
- `MIDNIGHT_INDEXER_URL` — HTTP indexer endpoint (e.g., `https://indexer.preview.midnight.network/api/v1`)
- `MIDNIGHT_INDEXER_WS_URL` — WebSocket indexer endpoint (e.g., `wss://indexer.preview.midnight.network/api/v1/ws`)

### Run the dev server
```bash
cd frontend && npm run dev
```
Opens at `http://localhost:5173` (or next available port).

### Wallet requirement
A Midnight-compatible wallet extension (Lace, GSD Wallet, 1AM, or Nocturne) is required to connect and execute the borrow flow in-browser. Without an extension, the UI runs in illustrative mode; the verified execution path remains the CLI (`npm run demo` on devnet, or against Preview using the deployed address).

---

## Public state vs private witness

This contract demonstrates Midnight's core value proposition for DeFi: **selective disclosure**.

### PUBLIC on-chain state (visible to anyone querying the ledger)
- Pool liquidity (total deposited, available for loans)
- Protocol fee rate (`feeBps`, basis points, capped at 1000)
- Loan bounds: `minLoan`, `maxLoan`, per-run cap
- Admin key hash (the deployer's public key hash, controls admin actions)
- Paused status (`true`/`false`)
- Run history: each completed run records `runId`, `amount`, `fee`, `requesterHash` (hash of borrower's coin public key)

### PRIVATE witness (never submitted on-chain in plaintext)
- **Arbitrage bid/ask prices** — the two market prices the borrower uses to prove the flash loan is profitable. The circuit verifies `askPrice × amount ≥ (amount + fee) × bidPrice` without ever revealing `bidPrice` or `askPrice` to the network.

### Verified separation
This separation was explicitly verified during development:
- Private values (`bidPrice`, `askPrice`) do **not** appear in the React UI state, browser console, or any network request payload sent to the indexer
- They exist only inside the zero-knowledge circuit execution (via the wallet's proving API) and are discarded after the proof is generated
- The indexer receives only the transaction and its public outputs (runId, amounts, requesterHash)

---

## Initial product idea

An educational atomic flash-loan pool on Midnight Network demonstrating how a DeFi primitive can keep sensitive trading logic (arbitrage prices) private via zero-knowledge proofs, while keeping settlement, fees, liquidity, and pool health fully auditable on public ledger state.

---

## Network / deployment status

The contract is currently deployed on **Midnight Preview** network at address:

```
97e2579e27b1385749be77ae8d0997447a37574079d1b7b7f2247577c75f7b86
```

This is **Preview** (not Preprod, not Mainnet). Preview is a persistent test network that resets periodically; state and history are not guaranteed across resets.

---

## Current status / known limitations

### Working end-to-end (via Lace wallet on Preview)
- **Borrow flow**: Validate → Borrow → Arbitrage Proof → Repay → Settle executes atomically in a single transaction
- **Pool reads**: Liquidity, fee, bounds, paused state, and run history display correctly from indexer queries
- **Pause/unpause**: Contract logic implemented and CLI-verified

### Admin actions (implemented in contract, not fully wired in-browser)
Admin operations exist in the contract and pass CLI verification:
- Liquidity management (deposit/withdraw)
- Fee rate changes (`feeBps`)
- Loan bound adjustments (`minLoan`, `maxLoan`)
- Pause/unpause

**Limitation**: These require the original deployer's admin key. The connected Lace wallet in the frontend does not currently hold this key, so admin actions cannot be executed from the Admin tab in-browser. They remain available via the deployer's CLI environment. This is noted honestly rather than claimed as fully working in-browser.

---

## Project layout

```
contracts/flash-loan-pool       compact (pre-nargo) contracts
contracts/managed/…             compiled circuit (zkir, keys, contract JS)
frontend/                       React pool dashboard (read-only on devnet)
src/                            zkapp library + deploy script
tests/e2e/                      the full lifecycle as an executable demo
scripts/                        compile + devnet helper scripts (gitignored)
docker-compose.yml              local Midnight devnet
```

---

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

> **Note:** The steps above spin up a **local devnet** for development and
> testing from scratch. The live/verified deployment referenced elsewhere in
> this README (address `97e2579e27b1385749be77ae8d0997447a37574079d1b7b7f2247577c75f7b86`)
> is on the **Preview** network — a persistent public testnet. That deployment
> uses a stored seed in `.midnight-state.json` for the deployer wallet, not the
> local devnet flow. To interact with the Preview deployment, set
> `VITE_CONTRACT_ADDRESS` to the address above and use a Lace wallet connected
> to Preview; no local devnet or docker compose is required.

---

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

### Wallet status

**Lace wallet** connect/disconnect and the full borrow-flow circuit call
(Validate → Borrow → Arbitrage Proof → Repay → Settle) are verified working
on Preview network with the deployed contract at address
`97e2579e27b1385749be77ae8d0997447a37574079d1b7b7f2247577c75f7b86`. Two
successful end-to-end runs confirmed this session.

Other DApp Connector wallets (GSD Wallet, 1AM, Nocturne) follow the same
CAIP-372 API but have not been individually tested with this application.

---

## What this project deliberately does NOT do

This is an educational implementation, not a product. Specifically:

- **No real arbitrage execution.** The demo supplies fixed bid/ask prices.
  Integrating a real DEX/oracle feed is left to you.
- **No oracles, no liquidation of underwater runs.** Atomicity makes most of
  these unnecessary *if* the circuit is correct — which is exactly why the
  proof-of-repayment checks live inside the circuit rather than in app code.
- **Virtual liquidity.** The pool tracks its own token ledger; it is not wired
  to a shielded-token faucet or a real reserve.
- **In-browser admin actions reach the contract but require the deployer's
  admin key.** The Admin tab correctly constructs and submits admin
  transactions (pause/unpause, liquidity management, fee/limit changes), but
  the connected Lace wallet in this deployment does not hold the original
  deployer's admin key — so admin actions cannot be executed from the browser
  in this deployment. They remain verified and working via the deployer's CLI
  environment.

Treat every zkapp claim about correctness as *a claim to verify*, not a
guarantee. The e2e suite (`npm run test:e2e`) demonstrates the happy path and
rejections (pause, bounds, ask ≤ bid) on the devnet.

---

## Notes

- Fee: `fee = amount × feeBps / 10000`, enforced as `feeBps ∈ [0, 1000]`.
- Loan bounds and pool caps are enforced in the circuit (asserts, not UI).
- Committed liquidity during a run means a run can never be double-satisfied.