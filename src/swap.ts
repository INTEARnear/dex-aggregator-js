import {
  OUTCOME_TIMEOUT_MS,
  RETRY_DELAY_MS,
  requestIsWrong,
  retryDelay,
  type RouterConnection,
} from "./connection.ts";
import type {
  Action,
  ExecutionInstruction,
  Quote,
  SwapOutcome,
  Transaction,
  TraderSwapRequest,
} from "./types.ts";
import { validateNextSteps, validateQuote } from "./validate.ts";

export const ROUTER_URL = "https://router.intear.tech";

/** What near-connect's wallets do with transactions */
export interface NearConnectWallet {
  signAndSendTransactions(params: {
    transactions: Transaction[];
  }): Promise<{ transaction_outcome: { id: string } }[]>;
}

/** Signs a transaction without asking anyone, and sends it */
export interface Signer {
  /** Resolves with its hash once it executed, also when a receipt of it failed */
  signAndSendTransaction(transaction: Transaction): Promise<string>;
}

export interface SwapProgress {
  /**
   * The quote's transactions executed, and the router is finding out what they did, asking it
   * again after its errors until it tells or gives up
   */
  onSwapSent?: (txHashes: readonly string[]) => void;
  /** The next steps of the outcome are about to be signed */
  onOutcome?: (outcome: SwapOutcome) => void;
}

/** A signer failed on a transaction of the swap, after the ones before it executed */
export class SwapInterruptedError extends Error {
  /** Of the transactions that executed before it */
  readonly txHashes: readonly string[];

  constructor(txHashes: readonly string[], cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`The swap stopped after ${txHashes.length} of its transactions: ${reason}`, { cause });
    this.name = "SwapInterruptedError";
    this.txHashes = txHashes;
  }
}

export interface SwapResult {
  outcome: SwapOutcome;
  /** Of the transactions after the swap: its fees, and moving tokens where the trader asked */
  nextStepsError: unknown;
}

/**
 * Swaps with a wallet that asks the trader: the quote's transactions, its fee transactions
 * included, in one approval, as the wallet doesn't send the fee transactions of a swap that it sees
 * failed, then the next steps, if there are any, in another
 */
export async function swapWithNearConnect({
  wallet,
  request,
  quote,
  routerUrl = ROUTER_URL,
  retryDelayMs = RETRY_DELAY_MS,
  outcomeTimeoutMs = OUTCOME_TIMEOUT_MS,
  onSwapSent,
  onOutcome,
}: {
  wallet: NearConnectWallet;
  request: TraderSwapRequest;
  quote: Quote;
  routerUrl?: string;
  /** Waits twice as long after each request for the outcome that fails, from `min` up to `max` */
  retryDelayMs?: { min: number; max: number };
  /** Gives up on the outcome after this long, asking again until then when the router errs */
  outcomeTimeoutMs?: number;
} & SwapProgress): Promise<SwapResult> {
  if (quote.quote_id !== undefined) {
    throw new Error("A quote with its fees in the next steps is for swapWithSigner");
  }
  validateQuote(request, quote);
  const results = await wallet.signAndSendTransactions({
    transactions: toTransactions(quote.execution_instructions),
  });
  // The fee transactions come last, and the outcome is of the ones before them
  const swapTransactions = quote.execution_instructions.filter(
    (instruction) => instruction.NearTransaction.is_fee_transaction !== true,
  ).length;
  const txHashes = results.slice(0, swapTransactions).map((result) => result.transaction_outcome.id);
  onSwapSent?.(txHashes);
  const outcome = await fetchOutcome(routerUrl, request, quote, txHashes, retryDelayMs, outcomeTimeoutMs);
  validateNextSteps(request, quote, outcome);
  onOutcome?.(outcome);
  let nextStepsError: unknown = null;
  if (outcome.next_steps.length > 0) {
    try {
      await wallet.signAndSendTransactions({ transactions: toTransactions(outcome.next_steps) });
    } catch (error) {
      nextStepsError = error;
    }
  }
  return { outcome, nextStepsError };
}

/**
 * Swaps with a signer that doesn't ask anyone, on a quote of a subscription with
 * `feesInNextSteps`: the quote's transactions, one after another, then the next steps of their
 * outcome, which pay the fees and the quote improvement fee once the swap went through
 */
export async function swapWithSigner({
  signer,
  connection,
  request,
  quote,
  onSwapSent,
  onOutcome,
}: {
  signer: Signer;
  connection: RouterConnection;
  request: TraderSwapRequest;
  quote: Quote;
} & SwapProgress): Promise<SwapResult> {
  if (quote.quote_id === undefined) {
    throw new Error("swapWithSigner takes a quote of a subscription with feesInNextSteps");
  }
  validateQuote(request, quote);
  const txHashes: string[] = [];
  for (const transaction of toTransactions(quote.execution_instructions)) {
    try {
      txHashes.push(await signer.signAndSendTransaction(transaction));
    } catch (error) {
      throw new SwapInterruptedError(txHashes, error);
    }
  }
  onSwapSent?.(txHashes);
  const outcome = await connection.outcome(quote.quote_id, txHashes);
  validateNextSteps(request, quote, outcome);
  onOutcome?.(outcome);
  let nextStepsError: unknown = null;
  try {
    for (const transaction of toTransactions(outcome.next_steps)) {
      await signer.signAndSendTransaction(transaction);
    }
  } catch (error) {
    nextStepsError = error;
  }
  return { outcome, nextStepsError };
}

/** The router's transactions as near-connect and signers take them */
export function toTransactions(instructions: ExecutionInstruction[]): Transaction[] {
  return instructions.map(({ NearTransaction: { receiver_id, actions } }) => ({
    receiverId: receiver_id,
    actions: actions.map((action): Action => {
      if ("Transfer" in action) {
        return { type: "Transfer", params: { deposit: action.Transfer.deposit } };
      }
      const { method_name, args, gas, deposit } = action.FunctionCall;
      const bytes = Uint8Array.from(atob(args), (char) => char.charCodeAt(0));
      return {
        type: "FunctionCall",
        params: {
          methodName: method_name,
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON of the router's arguments, which validateQuote and validateNextSteps check before swapping
          args: JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>,
          gas: gas.toString(),
          deposit,
        },
      };
    }),
  }));
}

/** Asks again after errors, other than of a request that's wrong, until the outcome timeout */
async function fetchOutcome(
  routerUrl: string,
  request: TraderSwapRequest,
  quote: Quote,
  txHashes: string[],
  retryDelayMs: { min: number; max: number },
  outcomeTimeoutMs: number,
): Promise<SwapOutcome> {
  const params = new URLSearchParams({
    token_in: request.tokenIn,
    token_out: request.tokenOut,
    trader_account_id: request.traderAccountId,
    tx_hashes: txHashes.join(","),
    fee_amount: quote.fee_amount,
  });
  const deadline = Date.now() + outcomeTimeoutMs;
  for (let failedAttempts = 0; ; failedAttempts += 1) {
    let error: string;
    let status: number | null = null;
    try {
      const response = await fetch(`${routerUrl}/route/outcome?${params}`, {
        signal: AbortSignal.timeout(Math.max(0, deadline - Date.now())),
      });
      if (response.ok) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validateNextSteps checks it before anything is signed
        return (await response.json()) as SwapOutcome;
      }
      error = (await response.text()) || `HTTP ${response.status}`;
      status = response.status;
    } catch (fetchError) {
      error = fetchError instanceof Error ? fetchError.message : String(fetchError);
    }
    const delay = retryDelay(retryDelayMs, failedAttempts);
    if (requestIsWrong(status) || Date.now() + delay >= deadline) {
      throw new Error(`Couldn't find out what the swap did: ${error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
