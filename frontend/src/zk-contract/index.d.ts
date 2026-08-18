import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type ArbitragePrices = { bid: bigint; ask: bigint };

export type RunRecord = { runId: string;
                          requester: Uint8Array;
                          amount: bigint;
                          fee: bigint
                        };

export type Witnesses<PS> = {
  arbitragePrices(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, ArbitragePrices];
}

export type ImpureCircuits<PS> = {
  executeFlashLoan(context: __compactRuntime.CircuitContext<PS>,
                   amount_0: bigint,
                   fee_0: bigint,
                   runId_0: string): __compactRuntime.CircuitResults<PS, []>;
  topUpLiquidity(context: __compactRuntime.CircuitContext<PS>, amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  withdrawLiquidity(context: __compactRuntime.CircuitContext<PS>,
                    amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  setFeeBps(context: __compactRuntime.CircuitContext<PS>, bps_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  setLoanLimits(context: __compactRuntime.CircuitContext<PS>,
                min_0: bigint,
                max_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  setPaused(context: __compactRuntime.CircuitContext<PS>, to_0: boolean): __compactRuntime.CircuitResults<PS, []>;
}

export type ProvableCircuits<PS> = {
  executeFlashLoan(context: __compactRuntime.CircuitContext<PS>,
                   amount_0: bigint,
                   fee_0: bigint,
                   runId_0: string): __compactRuntime.CircuitResults<PS, []>;
  topUpLiquidity(context: __compactRuntime.CircuitContext<PS>, amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  withdrawLiquidity(context: __compactRuntime.CircuitContext<PS>,
                    amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  setFeeBps(context: __compactRuntime.CircuitContext<PS>, bps_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  setLoanLimits(context: __compactRuntime.CircuitContext<PS>,
                min_0: bigint,
                max_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  setPaused(context: __compactRuntime.CircuitContext<PS>, to_0: boolean): __compactRuntime.CircuitResults<PS, []>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  executeFlashLoan(context: __compactRuntime.CircuitContext<PS>,
                   amount_0: bigint,
                   fee_0: bigint,
                   runId_0: string): __compactRuntime.CircuitResults<PS, []>;
  topUpLiquidity(context: __compactRuntime.CircuitContext<PS>, amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  withdrawLiquidity(context: __compactRuntime.CircuitContext<PS>,
                    amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  setFeeBps(context: __compactRuntime.CircuitContext<PS>, bps_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  setLoanLimits(context: __compactRuntime.CircuitContext<PS>,
                min_0: bigint,
                max_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  setPaused(context: __compactRuntime.CircuitContext<PS>, to_0: boolean): __compactRuntime.CircuitResults<PS, []>;
}

export type Ledger = {
  readonly adminKeyHash: Uint8Array;
  readonly poolLiquidity: bigint;
  readonly protocolFeeBps: bigint;
  readonly minLoan: bigint;
  readonly maxLoan: bigint;
  readonly paused: boolean;
  readonly runCounter: bigint;
  readonly totalFeeCollected: bigint;
  runs: {
    isEmpty(): boolean;
    length(): bigint;
    head(): { is_some: boolean, value: RunRecord };
    [Symbol.iterator](): Iterator<RunRecord>
  };
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               initialLiquidity_0: bigint,
               feeBps_0: bigint,
               min_0: bigint,
               max_0: bigint): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
