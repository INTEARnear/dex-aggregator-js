import { OUTCOME_TIMEOUT_MS, RETRY_DELAY_MS, retryDelay, type RouterConnection } from "./connection.js";
import type {
  Action,
  ExecutionInstruction,
  Quote,
  SwapOutcome,
  Transaction,
  TraderSwapRequest,
} from "./types.js";
import { validateNextSteps, validateQuote } from "./validate.js";

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
  onSwapSent?: (txHashes: string[]) => void;
  /** The next steps of the outcome are about to be signed */
  onOutcome?: (outcome: SwapOutcome) => void;
}

export interface SwapResult {
  outcome: SwapOutcome;
  /** Of the transactions after the swap: its fees, and moving tokens where the trader asked */
  nextStepsError: unknown;
}

/**
 * Swaps with a wallet that asks the trader: the quote's transactions in one approval, then, after
 * the swap, its fee transactions if it went through, and the next steps, in another
 */
export async function swapWithNearConnect({
  wallet,
  request,
  quote,
  routerUrl = ROUTER_URL,
  onSwapSent,
  onOutcome,
}: {
  wallet: NearConnectWallet;
  request: TraderSwapRequest;
  quote: Quote;
  routerUrl?: string;
} & SwapProgress): Promise<SwapResult> {
  if (quote.quote_id !== undefined) {
    throw new Error("A quote with its fees in the next steps is for swapWithSigner");
  }
  validateQuote(request, quote);
  const isFee = (instruction: ExecutionInstruction) =>
    instruction.NearTransaction.is_fee_transaction === true;
  const results = await wallet.signAndSendTransactions({
    transactions: toTransactions(quote.execution_instructions.filter((i) => !isFee(i))),
  });
  const txHashes = results.map((result) => result.transaction_outcome.id);
  onSwapSent?.(txHashes);
  const outcome = await fetchOutcome(routerUrl, request, quote, txHashes);
  validateNextSteps(request, quote, outcome);
  onOutcome?.(outcome);
  const afterSwap = [
    ...(outcome.charge_fee ? quote.execution_instructions.filter(isFee) : []),
    ...outcome.next_steps,
  ];
  let nextStepsError: unknown = null;
  if (afterSwap.length > 0) {
    try {
      await wallet.signAndSendTransactions({ transactions: toTransactions(afterSwap) });
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
  const txHashes = [];
  for (const transaction of toTransactions(quote.execution_instructions)) {
    txHashes.push(await signer.signAndSendTransaction(transaction));
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
): Promise<SwapOutcome> {
  const params = new URLSearchParams({
    token_in: request.tokenIn,
    token_out: request.tokenOut,
    trader_account_id: request.traderAccountId,
    tx_hashes: txHashes.join(","),
    fee_amount: quote.fee_amount,
  });
  const deadline = Date.now() + OUTCOME_TIMEOUT_MS;
  for (let failedAttempts = 0; ; failedAttempts += 1) {
    let error: string;
    let requestIsWrong = false;
    try {
      const response = await fetch(`${routerUrl}/route/outcome?${params}`, {
        signal: AbortSignal.timeout(Math.max(0, deadline - Date.now())),
      });
      if (response.ok) {
        return (await response.json()) as SwapOutcome;
      }
      error = (await response.text()) || `HTTP ${response.status}`;
      requestIsWrong = response.status >= 400 && response.status < 500 && response.status !== 429;
    } catch (fetchError) {
      error = fetchError instanceof Error ? fetchError.message : String(fetchError);
    }
    const delay = retryDelay(RETRY_DELAY_MS, failedAttempts);
    if (requestIsWrong || Date.now() + delay >= deadline) {
      throw new Error(`Couldn't find out what the swap did: ${error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
