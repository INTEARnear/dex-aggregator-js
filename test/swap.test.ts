import { afterEach, describe, expect, test, vi } from "vitest";
import type { RouterConnection } from "../src/connection.js";
import { swapWithNearConnect, swapWithSigner, type NearConnectWallet } from "../src/swap.js";
import type { SwapOutcome, Transaction } from "../src/types.js";
import { UnsafeTransactionsError } from "../src/validate.js";
import { call, quoteOf, transaction, withFeesInNextSteps } from "./helpers.js";
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

  test("tells the hashes of the swap's transactions", async () => {
    answerOutcome(swapped);
    const sent: string[][] = [];
    await swapWithNearConnect({
      wallet: recordingWallet(),
      request,
      quote,
      routerUrl: "https://router.test",
      onSwapSent: (txHashes) => sent.push(txHashes),
    });
    expect(sent).toEqual([Array.from({ length: swapTransactions }, (_, index) => `tx1-${index}`)]);
  });

  test("asks for the outcome again after the router's errors", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("Failed to get the transaction", { status: 502 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(Response.json(swapped));
    vi.stubGlobal("fetch", fetch);
    const result = await swapWithNearConnect({ wallet: recordingWallet(), request, quote, routerUrl: "https://router.test" });
    expect(result.outcome).toEqual(swapped);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test("doesn't ask again for the outcome of a request that's wrong", async () => {
    const fetch = vi.fn(async () => new Response("Transaction tx1-0 is signed by other.near, not intear.near", { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    const wallet = recordingWallet();
    await expect(swapWithNearConnect({ wallet, request, quote, routerUrl: "https://router.test" })).rejects.toThrow(
      "Couldn't find out what the swap did: Transaction tx1-0 is signed by other.near, not intear.near",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(wallet.batches).toHaveLength(1);
  });
});

test("swapping with a signer tells the hashes of the swap's transactions", async () => {
  const quote = withFeesInNextSteps(quoteOf("near_to_usdc_exact_in", "RheaDcl"));
  const signed: Transaction[] = [];
  const signer = {
    signAndSendTransaction: async (transaction: Transaction) => {
      signed.push(transaction);
      return `tx${signed.length}`;
    },
  };
  const asked: [number, string[]][] = [];
  const connection = {
    outcome: async (quoteId: number, txHashes: string[]) => {
      asked.push([quoteId, txHashes]);
      return swapped;
    },
  } as unknown as RouterConnection;
  const sent: string[][] = [];
  const result = await swapWithSigner({ signer, connection, request, quote, onSwapSent: (txHashes) => sent.push(txHashes) });
  const txHashes = quote.execution_instructions.map((_, index) => `tx${index + 1}`);
  expect(sent).toEqual([txHashes]);
  expect(asked).toEqual([[quote.quote_id, txHashes]]);
  expect(result).toEqual({ outcome: swapped, nextStepsError: null });
});
