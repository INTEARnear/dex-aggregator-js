/**
 * A token where the trader holds it, as the router names it: `near`, `nep141:<contract>` (or
 * just the contract), `rhea-nep141:<contract>` for a balance on Rhea, and `intear-dex:near` or
 * `intear-dex:nep141:<contract>` for a balance on Intear DEX
 */
export type TokenId = string;

export type Slippage =
  | { type: "fixed"; slippage: number }
  | { type: "auto"; minSlippage: number; maxSlippage: number };

export interface SwapRequest {
  tokenIn: TokenId;
  tokenOut: TokenId;
  amount: { exactIn: bigint } | { exactOut: bigint };
  /** `0.01` is 1% */
  slippage: Slippage;
  /** Needed to swap, not to quote */
  traderAccountId?: string;
  signingPublicKey?: string;
  /** All of them when not given */
  dexes?: string[];
  referrerId?: string;
  /** Fractions of the input that each account takes, like `{ "app.near": 0.005 }` for 0.5% */
  fees?: Record<string, number>;
  /** Takes what a swap gives above the quote's estimate, or takes below it */
  quoteImprovementReceiver?: string;
}

/** A request whose quotes can be swapped */
export type TraderSwapRequest = SwapRequest & { traderAccountId: string };

/** The router's actions, with base64 JSON arguments */
export type RouterAction =
  | {
      FunctionCall: {
        method_name: string;
        args: string;
        gas: number;
        deposit: string;
      };
    }
  | { Transfer: { deposit: string } };

export interface ExecutionInstruction {
  NearTransaction: {
    receiver_id: string;
    actions: RouterAction[];
    /** Pays referral fees after the swap, only if its outcome says `charge_fee` */
    is_fee_transaction?: boolean;
  };
}

export type RouterAmount =
  | { amount_in: string; amount_out?: never }
  | { amount_out: string; amount_in?: never };

export interface Quote {
  dex_id: string;
  /** `amount_out` for exact-in, `amount_in` for exact-out */
  estimated_amount: RouterAmount;
  worst_case_amount: RouterAmount;
  execution_instructions: ExecutionInstruction[];
  token_output: TokenId;
  discount?: RouterAmount;
  /** yoctoNEAR */
  estimated_max_gas_cost: string;
  estimated_gas_usage: string;
  storage_deposits: string;
  /** What the fee transactions pay out of the wallet balance of the input token */
  fee_amount: string;
  signing?: { nonce: number; block_hash: string };
  /** Of a quote whose fees are paid in the next steps of its outcome */
  quote_id?: number;
}

/** `charge_fee` is whether the swap went through, and `error` why it didn't */
export type SwapOutcome = {
  amount_in: string;
  amount_out: string;
  balance_changes: { token: TokenId; change: string }[];
  next_steps: ExecutionInstruction[];
  settled: boolean;
  quote_improvement_fee?: string;
} & ({ charge_fee: true; error: null } | { charge_fee: false; error: string });

/** A transaction as near-connect takes it, and as a signer gets it */
export interface Transaction {
  receiverId: string;
  actions: Action[];
}

export type Action =
  | {
      type: "FunctionCall";
      params: {
        methodName: string;
        args: Record<string, unknown>;
        gas: string;
        deposit: string;
      };
    }
  | { type: "Transfer"; params: { deposit: string } };
