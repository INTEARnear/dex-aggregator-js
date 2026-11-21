import { afterEach, describe, expect, test, vi } from "vitest";
import { swapWithNearConnect, type NearConnectWallet } from "../src/swap.js";
import type { SwapOutcome, Transaction } from "../src/types.js";
import { UnsafeTransactionsError } from "../src/validate.js";
import { call, quoteOf, transaction } from "./helpers.js";
import { REQUESTS } from "./requests.js";

const request = REQUESTS["near_to_usdc_exact_in"]!;
const quote = quoteOf("near_to_usdc_exact_in", "RheaDcl");

/** Signs every batch it's asked to, and remembers what it signed */
function recordingWallet(): NearConnectWallet & { batches: Transaction[][] } {
  const batches: Transaction[][] = [];
  return {
    batches,
    signAndSendTransactions: async ({ transactions }) => {
      batches.push(transactions);
      return transactions.map((_, index) => ({ transaction_outcome: { id: `tx${batches.length}-${index}` } }));
    },
  };
}

function methods(batch: Transaction[]): string[][] {
  return batch.map(({ actions }) =>
    actions.map((action) => (action.type === "FunctionCall" ? action.params.methodName : "Transfer")),
  );
}

function answerOutcome(outcome: SwapOutcome): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => Response.json(outcome));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const unwrap = transaction("wrap.near", [call("near_withdraw", { amount: "995000000000000000000000" })]);
const swapped: SwapOutcome = {
  charge_fee: true,
  amount_in: "995000000000000000000000",
  amount_out: "2846353",
  balance_changes: [],
  next_steps: [],
  error: null,
  settled: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("swapping with near-connect", () => {
  const isFee = (index: number) => quote.execution_instructions[index]!.NearTransaction.is_fee_transaction === true;
  const swapTransactions = quote.execution_instructions.filter((_, index) => !isFee(index)).length;
  const feeTransactions = quote.execution_instructions.length - swapTransactions;

  test("signs the fee transactions only after the swap went through", async () => {
    expect(feeTransactions).toBeGreaterThan(0);
    const fetch = answerOutcome(swapped);
    const wallet = recordingWallet();
    const result = await swapWithNearConnect({ wallet, request, quote, routerUrl: "https://router.test" });
    expect(result).toEqual({ outcome: swapped, nextStepsError: null });
    expect(wallet.batches.map((batch) => batch.length)).toEqual([swapTransactions, feeTransactions]);
    const url = new URL(fetch.mock.calls[0]![0] as string);
    expect(url.pathname).toBe("/route/outcome");
    expect(url.searchParams.get("tx_hashes")).toBe(
      Array.from({ length: swapTransactions }, (_, index) => `tx1-${index}`).join(","),
    );
    expect(url.searchParams.get("fee_amount")).toBe(quote.fee_amount);
  });

  test("leaves the fees out after a swap that failed, and returns the tokens", async () => {
    answerOutcome({ ...swapped, charge_fee: false, error: "Slippage", amount_out: "0", next_steps: [unwrap] });
    const wallet = recordingWallet();
    await swapWithNearConnect({ wallet, request, quote, routerUrl: "https://router.test" });
    expect(wallet.batches).toHaveLength(2);
    expect(wallet.batches[0]).toHaveLength(swapTransactions);
    expect(methods(wallet.batches[1]!)).toEqual([["near_withdraw"]]);
  });

  test("signs nothing after the swap if the next steps aren't safe", async () => {
    const steal = transaction("wrap.near", [
      call("ft_transfer", { receiver_id: "evil.near", amount: "995000000000000000000000" }),
    ]);
    answerOutcome({ ...swapped, next_steps: [steal] });
    const wallet = recordingWallet();
    await expect(swapWithNearConnect({ wallet, request, quote, routerUrl: "https://router.test" })).rejects.toThrow(
      UnsafeTransactionsError,
    );
    expect(wallet.batches).toHaveLength(1);
  });

  test("reports the next steps failing apart from the swap", async () => {
    answerOutcome(swapped);
    const rejection = new Error("User rejected");
    let batches = 0;
    const wallet: NearConnectWallet = {
      signAndSendTransactions: async ({ transactions }) => {
        batches += 1;
        if (batches === 2) {
          throw rejection;
        }
        return transactions.map((_, index) => ({ transaction_outcome: { id: `tx${index}` } }));
      },
    };
    expect(await swapWithNearConnect({ wallet, request, quote, routerUrl: "https://router.test" })).toEqual({
      outcome: swapped,
      nextStepsError: rejection,
    });
  });
});
