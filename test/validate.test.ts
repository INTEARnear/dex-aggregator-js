import { describe, expect, test } from "vitest";
import type { Quote, SwapOutcome } from "../src/types.js";
import { UnsafeTransactionsError, validateNextSteps, validateQuote } from "../src/validate.js";
import {
  call,
  fixture,
  quoteOf,
  tamper,
  tamperJson,
  transaction,
  withFeesInNextSteps,
} from "./helpers.js";
import { REQUESTS, USDC } from "./requests.js";

const NEAR_TO_USDC = REQUESTS["near_to_usdc_exact_in"]!;

/** The operation of a kind in the arguments of a `deposit_near` to Intear DEX */
function engineOperation(args: Record<string, unknown>, kind: string): Record<string, unknown> {
  const operations = (args["operations"] as Record<string, unknown>)["operations"] as Record<string, Record<string, unknown>>[];
  const operation = operations.find((operation) => kind in operation)?.[kind];
  if (operation === undefined) {
    throw new Error(`No ${kind} operation`);
  }
  return operation;
}

function problemsOf(check: () => void): string[] {
  try {
    check();
  } catch (error) {
    if (error instanceof UnsafeTransactionsError) {
      return error.problems;
    }
    throw error;
  }
  return [];
}

function expectUnsafe(quote: Quote, problem: RegExp, request = NEAR_TO_USDC): void {
  const problems = problemsOf(() => validateQuote(request, quote));
  expect(problems, problems.join("\n")).toContainEqual(expect.stringMatching(problem));
}

describe("quotes of router.intear.tech", () => {
  const cases = Object.entries(REQUESTS).flatMap(([name, request]) =>
    fixture(name).map((quote) => [`${name} on ${quote.dex_id}`, request, quote] as const),
  );
  test.each(cases)("%s is safe to sign", (_, request, quote) => {
    expect(problemsOf(() => validateQuote(request, quote))).toEqual([]);
  });
});

test("buying the oracle fee with the input", () => {
  const quote = tamper(quoteOf("near_to_usdc_exact_in", "IntearDex"), 0, 0, (args) => {
    const oracleRequest = engineOperation(args, "OracleRequest");
    const [, nearFee] = oracleRequest["fee"] as [string, string];
    oracleRequest["fee"] = [`nep141:${USDC}`, "1000"];
    oracleRequest["swap"] = { dex_id: "slimedragon.near/xyk", message: "", asset_in: "near", constraint: nearFee };
  });
  expect(problemsOf(() => validateQuote(NEAR_TO_USDC, quote))).toEqual([]);
});

test("a fee discount on Intear DEX", () => {
  const quote = tamper(quoteOf("near_to_usdc_exact_in", "IntearDex"), 0, 0, (args) => {
    (args["operations"] as Record<string, unknown>)["fee_discount"] = {
      discount: {
        ForTrader: { trader_id: "intear.near", fee_discount: 250_000, expiration_block_height: 190_000_000 },
      },
      signature: "c2lnbmF0dXJl",
    };
  });
  expect(problemsOf(() => validateQuote(NEAR_TO_USDC, quote))).toEqual([]);
});

describe("tampered quotes", () => {
  const rhea = quoteOf("near_to_usdc_exact_in", "Rhea");
  const rheaDcl = quoteOf("near_to_usdc_exact_in", "RheaDcl");
  const intearDex = quoteOf("near_to_usdc_exact_in", "IntearDex");

  test("swapping more than the input", () => {
    expectUnsafe(
      tamper(rhea, 0, 1, (args) => {
        args["amount"] = "1995000000000000000000000";
      }),
      /spend 2000000000000000000000000 of the input, more than the 1000000000000000000000000/,
    );
  });

  test("calling another contract", () => {
    const quote = structuredClone(rhea);
    quote.execution_instructions[0]!.NearTransaction.receiver_id = "evil.near";
    expectUnsafe(quote, /evil\.near .*Isn't one of the swap's tokens/);
  });

  test("sending the input to another contract", () => {
    expectUnsafe(
      tamper(rhea, 0, 1, (args) => {
        args["receiver_id"] = "evil.near";
      }),
      /Sends the input to evil\.near/,
    );
  });

  test("attaching more to storage deposits than the quote says", () => {
    const quote = quoteOf("rhea_balances_exact_in", "Rhea");
    expectUnsafe(
      tamper(quote, 0, 2, (_, action) => {
        action.deposit = "50000000000000000000000";
      }),
      /attach 74060000000000000000000 to storage deposits, more than the quote's 35260000000000000000000/,
      REQUESTS["rhea_balances_exact_in"],
    );
  });

  test("registering someone the swap doesn't pay", () => {
    const quote = quoteOf("rhea_balances_exact_in", "Rhea");
    expectUnsafe(
      tamper(quote, 0, 2, (args) => {
        args["account_id"] = "evil.near";
      }),
      /Registers evil\.near/,
      REQUESTS["rhea_balances_exact_in"],
    );
  });

  test("a lower minimum output on Rhea DCL", () => {
    expectUnsafe(
      tamper(rheaDcl, 0, 1, (args) =>
        tamperJson(args, "msg", (msg) => {
          (msg["Swap"] as Record<string, unknown>)["min_output_amount"] = "1";
        }),
      ),
      /guarantee 1 of the output, less than the quote's worst case/,
    );
  });

  test("a lower minimum output on Rhea", () => {
    expectUnsafe(
      tamper(rhea, 0, 1, (args) =>
        tamperJson(args, "msg", (msg) => {
          const actions = msg["actions"] as Record<string, unknown>[];
          actions[actions.length - 1]!["min_amount_out"] = "0";
        }),
      ),
      /guarantee 0 of the output/,
    );
  });

  test("an argument that routes don't pass", () => {
    expectUnsafe(
      tamper(rheaDcl, 0, 1, (args) =>
        tamperJson(args, "msg", (msg) => {
          (msg["Swap"] as Record<string, unknown>)["receiver_id"] = "evil.near";
        }),
      ),
      /arguments that routes don't: receiver_id/,
    );
  });

  test("a fee to someone the request doesn't pay", () => {
    expectUnsafe(
      tamper(rhea, 1, 1, (args) => {
        args["receiver_id"] = "evil.near";
      }),
      /Pays a fee to evil\.near/,
    );
  });

  test("withdrawing the output of Intear DEX to someone else", () => {
    expectUnsafe(
      tamper(intearDex, 0, 0, (args) => {
        engineOperation(args, "Withdraw")["to"] = "evil.near";
      }),
      /Withdraws to someone else than the trader/,
    );
  });

  test("an operation that routes don't run", () => {
    expectUnsafe(
      tamper(intearDex, 0, 0, (args) => {
        const operations = (args["operations"] as Record<string, unknown>)["operations"] as unknown[];
        operations.push({
          TransferAsset: { to: { Account: "evil.near" }, asset_id: `nep141:${USDC}`, amount: "1" },
        });
      }),
      /Runs TransferAsset on Intear DEX/,
    );
  });

  test("buying the oracle fee with more than the input", () => {
    const quote = tamper(quoteOf("intear_balances_exact_in", "IntearDex"), 0, 0, (args) => {
      const operations = args["operations"] as Record<string, Record<string, unknown>>[];
      const oracleRequest = operations.find((operation) => "OracleRequest" in operation)!["OracleRequest"]!;
      oracleRequest["fee"] = [`nep141:${USDC}`, "1000"];
      oracleRequest["swap"] = {
        dex_id: "slimedragon.near/xyk",
        message: "",
        asset_in: "near",
        constraint: "1000000000000000000000000",
      };
    });
    expectUnsafe(
      quote,
      /spend 1999600000000000000000000 of the input, more than the 1000000000000000000000000/,
      REQUESTS["intear_balances_exact_in"],
    );
  });

  test("buying the oracle fee with something else than the input", () => {
    expectUnsafe(
      tamper(intearDex, 0, 0, (args) => {
        engineOperation(args, "OracleRequest")["swap"] = {
          dex_id: "slimedragon.near/xyk",
          message: "",
          asset_in: `nep141:${USDC}`,
          constraint: "1",
        };
      }),
      /Buys the oracle fee with something else than the input/,
    );
  });

  test("buying the oracle fee without a limit", () => {
    expectUnsafe(
      tamper(intearDex, 0, 0, (args) => {
        engineOperation(args, "OracleRequest")["swap"] = {
          dex_id: "slimedragon.near/xyk",
          message: "",
          asset_in: "near",
          constraint: null,
        };
      }),
      /The most the oracle fee's swap takes isn't an amount/,
    );
  });

  test("a quote improvement fee of what the estimate already has", () => {
    expectUnsafe(
      tamper(intearDex, 0, 0, (args) => {
        const swap = engineOperation(args, "SwapAdvanced");
        (swap["quote_improvement_fee"] as Record<string, unknown>)["quote_expected_amount"] = "2816571";
      }),
      /Takes a quote improvement fee of what beats 2816571/,
    );
  });

  test("more referral fees than requested", () => {
    expectUnsafe(
      tamper(intearDex, 0, 0, (args) => {
        (args["operations"] as Record<string, unknown>)["referral_fees"] = [
          ["wallet.intear.near", 40_000],
          ["dex-aggregator.intear.near", 10_000],
        ];
      }),
      /Referral fees of 50000 millionths are more than the requested 5000/,
    );
  });

  test("transferring NEAR", () => {
    const quote = structuredClone(rhea);
    quote.execution_instructions[0]!.NearTransaction.actions.push({ Transfer: { deposit: "1" } });
    expectUnsafe(quote, /Routes don't transfer NEAR to anyone/);
  });

  test("a worst case beyond the slippage", () => {
    const quote = tamper(rheaDcl, 0, 1, (args) =>
      tamperJson(args, "msg", (msg) => {
        (msg["Swap"] as Record<string, unknown>)["min_output_amount"] = "2000000";
      }),
    );
    quote.worst_case_amount = { amount_out: "2000000" };
    expectUnsafe(quote, /The worst case 2000000 is further from the estimate/);
  });
});

describe("fees in the next steps", () => {
  const quote = withFeesInNextSteps(quoteOf("near_to_usdc_exact_in", "RheaDcl"));
  const feeTransactions = quoteOf("near_to_usdc_exact_in", "RheaDcl").execution_instructions.filter(
    (instruction) => instruction.NearTransaction.is_fee_transaction === true,
  );
  const estimatedOut = 2_846_353n;
  const quoteImprovementFee = transaction(
    USDC,
    [
      call("storage_deposit", { registration_only: true, account_id: "wallet.intear.near" }, "1250000000000000000000"),
      call("ft_transfer", { receiver_id: "wallet.intear.near", amount: "1000", memo: "Quote improvement fee" }),
    ],
    true,
  );
  const outcome = (changes: Partial<Omit<SwapOutcome, "charge_fee" | "error">> = {}): SwapOutcome => ({
    charge_fee: true,
    amount_in: "995000000000000000000000",
    amount_out: (estimatedOut + 1_000n).toString(),
    balance_changes: [],
    next_steps: [...feeTransactions, quoteImprovementFee],
    error: null,
    settled: true,
    quote_improvement_fee: "1000",
    ...changes,
  });

  test("the quote leaves its fee transactions out", () => {
    expect(problemsOf(() => validateQuote(NEAR_TO_USDC, quote))).toEqual([]);
    expectUnsafe(
      { ...quoteOf("near_to_usdc_exact_in", "RheaDcl"), quote_id: 7 },
      /A quote whose fees are in the next steps has fee transactions/,
    );
  });

  test("the next steps pay the fees and the quote improvement fee", () => {
    expect(problemsOf(() => validateNextSteps(NEAR_TO_USDC, quote, outcome()))).toEqual([]);
  });

  test("a quote improvement fee of more than the swap beat the quote by", () => {
    const problems = problemsOf(() =>
      validateNextSteps(NEAR_TO_USDC, quote, outcome({ amount_out: (estimatedOut + 999n).toString() })),
    );
    expect(problems).toEqual([
      "The quote improvement fee of 1000 isn't the 999 that the swap beat the quote by",
    ]);
  });

  test("a quote improvement fee other than the outcome's", () => {
    const problems = problemsOf(() =>
      validateNextSteps(NEAR_TO_USDC, quote, outcome({ quote_improvement_fee: "500", amount_out: (estimatedOut + 500n).toString() })),
    );
    expect(problems).toEqual(["The next steps pay a quote improvement fee of 1000, not the outcome's 500"]);
  });

  test("fees after a swap that failed", () => {
    const { quote_improvement_fee: _, ...swapped } = outcome();
    const failed: SwapOutcome = { ...swapped, charge_fee: false, error: "Slippage" };
    const problems = problemsOf(() => validateNextSteps(NEAR_TO_USDC, quote, failed));
    expect(problems).toContainEqual(
      "The next steps pay fees, which are only due after a swap that went through",
    );
  });
});

describe("next steps of quotes with fee transactions", () => {
  const quote = quoteOf("near_to_usdc_exact_in", "RheaDcl");
  const outcome = (nextSteps: SwapOutcome["next_steps"]): SwapOutcome => ({
    charge_fee: false,
    amount_in: "0",
    amount_out: "0",
    balance_changes: [],
    next_steps: nextSteps,
    error: "Slippage",
    settled: true,
  });

  test("returning the wNEAR of a failed swap", () => {
    const unwrap = transaction("wrap.near", [call("near_withdraw", { amount: "995000000000000000000000" })]);
    expect(problemsOf(() => validateNextSteps(NEAR_TO_USDC, quote, outcome([unwrap])))).toEqual([]);
  });

  test("transferring the trader's tokens away", () => {
    const transfer = transaction("wrap.near", [
      call("ft_transfer", { receiver_id: "evil.near", amount: "995000000000000000000000", memo: "Trading fee (evil.near)" }),
    ]);
    expect(problemsOf(() => validateNextSteps(NEAR_TO_USDC, quote, outcome([transfer])))).toEqual([
      "wrap.near ft_transfer: Transfers tokens to evil.near outside of a fee transaction",
    ]);
  });

  test("swapping", () => {
    const swap = quote.execution_instructions[0]!;
    expect(problemsOf(() => validateNextSteps(NEAR_TO_USDC, quote, outcome([swap])))).toContainEqual(
      "wrap.near ft_transfer_call: Next steps don't swap",
    );
  });
});
