/**
 * Unit tests for the pool's arithmetic invariants — fee quantification and
 * arbitrage profitability — mirrored from the Compact contract in
 * contracts/flash-loan-pool.compact. Imports its helpers from src/pool-math
 * so the e2e runner (plain tsx, no vitest runtime) can share them.
 *
 * The contract proves, without division:
 *   fee·10_000 ≤ amount·feeBps < (fee+1)·10_000      (fee == ⌊amount·feeBps/10_000⌋)
 *   amount·ask ≥ (amount+fee)·bid                     (proceeds cover repayment)
 *
 * These tests pin the exact fee per (amount, feeBps) and the exact
 * accept/reject boundary of the profitability check, so the e2e suite can
 * feed deterministic values into the on-chain circuits.
 */

import { describe, expect, it } from 'vitest';
import { exactFee, feeAccepted, arbitrageAccepted, AMOUNT_MAX, LIQUIDITY_CAP, PRICE_MAX } from '../../src/pool-math';

describe('protocol fee quantification (sandwich proof)', () => {
  const FEE_BPS_SET = [0n, 1n, 50n, 200n, 999n, 1000n];

  it('exact fee satisfies both inequalities for every amount in 1..2000 and all fee rates', () => {
    for (let a = 1n; a <= 2000n; a++) {
      for (const bps of FEE_BPS_SET) {
        const fee = exactFee(a, bps);
        expect(feeAccepted(a, fee, bps), `amount=${a} feeBps=${bps}`).toBe(true);
      }
    }
  });

  it('fee−1 is always rejected (the second inequality is strict)', () => {
    for (let a = 1n; a <= 2000n; a++) {
      for (const bps of FEE_BPS_SET) {
        const fee = exactFee(a, bps);
        if (fee === 0n) continue;
        expect(feeAccepted(a, fee - 1n, bps), `amount=${a} feeBps=${bps}`).toBe(false);
      }
    }
  });

  it('fee+1 is always rejected (the first inequality caps the fee)', () => {
    for (let a = 1n; a <= 2000n; a++) {
      for (const bps of FEE_BPS_SET) {
        const fee = exactFee(a, bps);
        expect(feeAccepted(a, fee + 1n, bps), `amount=${a} feeBps=${bps}`).toBe(false);
      }
    }
  });

  it('large loans keep exact fees across the allowed amount range', () => {
    const samples = [10_000n, 1_000_000n, 100_000_000n, AMOUNT_MAX];
    for (const a of samples) {
      for (const bps of FEE_BPS_SET) {
        const fee = exactFee(a, bps);
        expect(feeAccepted(a, fee, bps), `amount=${a} feeBps=${bps}`).toBe(true);
      }
    }
  });

  it('fixture vectors for the e2e suite', () => {
    // 10 tokens at 0.50% → 50_000 base units (0.05 token)
    expect(exactFee(10_000_000n, 50n)).toBe(50_000n);
    // feeBps == 1000 → 10% exactly for amounts divisible by 10
    expect(exactFee(100_000_000n, 1000n)).toBe(10_000_000n);
    // feeBps == 0 → zero fee for everything
    expect(exactFee(7_777_777n, 0n)).toBe(0n);
  });
});

describe('arbitrage profitability boundary', () => {
  it('accepts when proceeds cover repayment; rejects otherwise', () => {
    const amount = 10_000_000n;
    const fee = 50_000n;
    expect(arbitrageAccepted(amount, fee, 100n, 101n)).toBe(true); // profit 50k
    expect(arbitrageAccepted(amount, fee, 100n, 100n)).toBe(false); // flat → rejected
    expect(arbitrageAccepted(amount, fee, 101n, 101n)).toBe(false); // ask not above bid
  });

  it('rejects price pairs outside bounds', () => {
    expect(arbitrageAccepted(10_000_000n, 0n, 0n, 1n)).toBe(false); // bid == 0
    expect(arbitrageAccepted(10_000_000n, 0n, 1n, PRICE_MAX + 1n)).toBe(false); // ask too high
    expect(arbitrageAccepted(10_000_000n, 0n, 1n, PRICE_MAX)).toBe(true); // boundary ok
  });

  it('all products used by circuits stay below 2^63 on the enforced ranges', () => {
    expect(PRICE_MAX * AMOUNT_MAX).toBeLessThan(2n ** 63n);
    expect(AMOUNT_MAX * 1000n).toBeLessThan(2n ** 63n);
    expect((AMOUNT_MAX + AMOUNT_MAX) * PRICE_MAX).toBeLessThan(2n ** 63n);
    expect(LIQUIDITY_CAP + AMOUNT_MAX).toBeLessThan(2n ** 63n);
  });
});