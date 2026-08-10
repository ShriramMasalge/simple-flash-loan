/**
 * Pure arithmetic mirror of the pool's on-chain invariants
 * (contracts/flash-loan-pool.compact). Shared by:
 *   - tests/unit/pool-math.test.ts  (vitest fixtures)
 *   - tests/e2e/run.ts              (deterministic inputs for the devnet)
 *   - src/demo-cli.ts               (fee preview before submitting)
 */

export const AMOUNT_MAX = 1_000_000_000n;
export const LIQUIDITY_CAP = 1_000_000_000_000n;
export const PRICE_MAX = 1_000_000_000n;
export const FEE_BPS_MAX = 1000n;
export const FEE_DENOM = 10000n;

/** Exact protocol fee for a loan — mirrors the contract's sandwich proof. */
export function exactFee(amount: bigint, feeBps: bigint): bigint {
  return (amount * feeBps) / FEE_DENOM;
}

/** True iff `fee` satisfies the contract's sandwich inequalities. */
export function feeAccepted(amount: bigint, fee: bigint, feeBps: bigint): boolean {
  if (fee > amount) return false;
  if (fee * FEE_DENOM > amount * feeBps) return false;
  return (fee + 1n) * FEE_DENOM > amount * feeBps;
}

/** True iff the repayment check accepts `(amount, fee)` at prices `(bid, ask)`. */
export function arbitrageAccepted(amount: bigint, fee: bigint, bid: bigint, ask: bigint): boolean {
  if (ask <= bid) return false;
  if (bid < 1n || ask > PRICE_MAX) return false;
  return amount * ask >= (amount + fee) * bid;
}