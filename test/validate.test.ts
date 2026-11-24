import { describe, expect, expectTypeOf, test } from "vitest";
import type { Quote, SwapOutcome, SwapRequest } from "../src/types.ts";
import { UnsafeTransactionsError, validateNextSteps, validateQuote } from "../src/validate.ts";
import {
  call,
  fixture,
  quoteOf,
  tamper,
  tamperJson,
  transaction,
  withFeesInNextSteps,
} from "./helpers.ts";
import { REQUESTS, USDC } from "./requests.ts";

const NEAR_TO_USDC = REQUESTS["near_to_usdc_exact_in"]!;

/** The operation of a kind in the arguments of a `deposit_near` to Intear DEX */
function engineOperation(args: Record<string, unknown>, kind: string): Record<string, unknown> {
  const operations = (args["operations"] as Record<string, unknown>)["operations"] as Record<string, Record<string, unknown>>[];
  const operation = operations.find((candidate) => kind in candidate)?.[kind];
  if (operation === undefined) {
    throw new Error(`No ${kind} operation`);
  }
  return operation;
}

function problemsOf(check: () => void): readonly string[] {
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

test("a request has one amount", () => {
  expectTypeOf<{ exactIn: bigint }>().toExtend<SwapRequest["amount"]>();
  expectTypeOf<{ exactOut: bigint }>().toExtend<SwapRequest["amount"]>();
  expectTypeOf<{ exactIn: bigint; exactOut: bigint }>().not.toExtend<SwapRequest["amount"]>();
});

describe("quotes of router.intear.tech", () => {
  const cases = Object.entries(REQUESTS).flatMap(([name, request]) =>
    fixture(name).map((quote) => [`${name} on ${quote.dex_id}`, request, quote] as const),
  );
  test.each(cases)("%s is safe to sign", (_, request, quote) => {
    expect(problemsOf(() => validateQuote(request, quote))).toEqual([]);
  });
  test.each(cases)("%s is safe to sign with its fees in the next steps", (_, request, quote) => {
    expect(problemsOf(() => validateQuote(request, withFeesInNextSteps(quote)))).toEqual([]);
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

describe("what the checks leave to the router", () => {
  const intearDex = quoteOf("near_to_usdc_exact_in", "IntearDex");
  const expectSafe = (quote: Quote, request = NEAR_TO_USDC) =>
    expect(problemsOf(() => validateQuote(request, quote))).toEqual([]);

  test("fields of Intear DEX that routes may add", () => {
    expectSafe(
      tamper(intearDex, 0, 0, (args) => {
        (args["operations"] as Record<string, unknown>)["new_field"] = "value";
        engineOperation(args, "SwapAdvanced")["new_field"] = "value";
      }),
    );
  });

  test("rescue addresses, which only get what Intear DEX can't send to the trader", () => {
    expectSafe(
      tamper(intearDex, 0, 0, (args) => {
        engineOperation(args, "OracleRequest")["rescue_address"] = "wallet.intear.near";
        engineOperation(args, "Withdraw")["rescue_address"] = "wallet.intear.near";
      }),
    );
  });

  test("withdrawing to the trader by name", () => {
    expectSafe(
      tamper(intearDex, 0, 0, (args) => {
        engineOperation(args, "Withdraw")["to"] = "intear.near";
      }),
    );
  });

  test("operations that move none of the trader's assets", () => {
    expectSafe(
      tamper(intearDex, 0, 0, (args) => {
        const operations = (args["operations"] as Record<string, unknown>)["operations"] as unknown[];
        operations.unshift({ RegisterAssets: { asset_ids: ["near"], for: null } }, { NewOperation: {} });
      }),
    );
  });

  test("registering the referrer, which takes what Intear DEX can't send to the trader", () => {
    const quote = structuredClone(intearDex);
    quote.execution_instructions.unshift(
      transaction("dex.intear.near", [call("register_assets", { asset_ids: ["near"], for: { Account: "app.near" } })]),
    );
    expectSafe(quote, { ...NEAR_TO_USDC, referrerId: "app.near" });
  });
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

  test("an argument of Rhea DCL that routes don't pass", () => {
    expectUnsafe(
      tamper(rheaDcl, 0, 1, (args) =>
        tamperJson(args, "msg", (msg) => {
          (msg["Swap"] as Record<string, unknown>)["receiver_id"] = "evil.near";
        }),
      ),
      /arguments that routes don't: receiver_id/,
    );
  });

  test("an argument of Rhea that routes don't pass", () => {
    expectUnsafe(
      tamper(rhea, 0, 1, (args) =>
        tamperJson(args, "msg", (msg) => {
          msg["swap_out_recipient"] = "evil.near";
        }),
      ),
      /arguments that routes don't: swap_out_recipient/,
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

  test("withdrawing a balance on Intear DEX to someone else", () => {
    const quote = structuredClone(intearDex);
    quote.execution_instructions.push(
      transaction("dex.intear.near", [
        call("withdraw", { asset_id: `nep141:${USDC}`, amount: { Exact: "1" }, withdraw_to: "evil.near" }),
      ]),
    );
    expectUnsafe(quote, /dex\.intear\.near withdraw: Withdraws to someone else than the trader/);
  });

  test("moving the trader's assets with an operation that routes don't run", () => {
    expectUnsafe(
      tamper(intearDex, 0, 0, (args) => {
        const operations = (args["operations"] as Record<string, unknown>)["operations"] as unknown[];
        operations.push({
          TransferAsset: { to: { Account: "evil.near" }, asset_id: `nep141:${USDC}`, amount: "1" },
        });
      }),
      /Moves the trader's assets with TransferAsset/,
    );
  });

  test("registering assets for someone the swap doesn't pay", () => {
    const quote = structuredClone(intearDex);
    quote.execution_instructions.unshift(
      transaction("dex.intear.near", [call("register_assets", { asset_ids: ["near"], for: { Account: "evil.near" } })]),
    );
    expectUnsafe(quote, /Registers evil\.near/);
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

  test("paying an oracle more than 1 NEAR", () => {
    expectUnsafe(
      tamper(intearDex, 0, 0, (args) => {
        engineOperation(args, "OracleRequest")["fee"] = ["near", "1000000000000000000000001"];
      }),
      /Pays an oracle 1000000000000000000000001 of near, more than 1000000000000000000000000/,
    );
  });

  test("buying the oracle fee with more than 1 NEAR", () => {
    expectUnsafe(
      tamper(intearDex, 0, 0, (args) => {
        const oracleRequest = engineOperation(args, "OracleRequest");
        oracleRequest["fee"] = [`nep141:${USDC}`, "1000"];
        oracleRequest["swap"] = {
          dex_id: "slimedragon.near/xyk",
          message: "",
          asset_in: "near",
          constraint: "1000000000000000000000001",
        };
      }),
      /Pays an oracle 1000000000000000000000001 of near, more than 1000000000000000000000000/,
    );
  });

  test("paying an oracle with an asset that oracles aren't paid with", () => {
    const request = { ...REQUESTS["intear_balances_exact_in"]!, tokenIn: "intear-dex:nep141:meme.near" };
    const quote = tamper(quoteOf("intear_balances_exact_in", "IntearDex"), 0, 0, (args) => {
      const operations = args["operations"] as Record<string, Record<string, unknown>>[];
      operations.find((operation) => "OracleRequest" in operation)!["OracleRequest"]!["fee"] = ["nep141:meme.near", "1"];
    });
    expectUnsafe(quote, /Pays an oracle with nep141:meme\.near, which oracles aren't paid with/, request);
  });

  test("exact-out on Intear DEX without a swap", () => {
    const quote = tamper(quoteOf("near_to_usdc_exact_out", "IntearDex"), 0, 0, (args) => {
      (args["operations"] as Record<string, unknown>)["operations"] = [];
    });
    expectUnsafe(
      quote,
      /The swaps guarantee 0 of the output, less than the requested output of 2000000/,
      REQUESTS["near_to_usdc_exact_out"],
    );
  });

  test("referral fees on Intear DEX on top of fee transactions", () => {
    const fee = 5_000_000_000_000_000_000_000n;
    const quote = tamper(intearDex, 0, 0, (args, action) => {
      action.deposit = (BigInt(action.deposit) - fee).toString();
      const amount = engineOperation(args, "SwapAdvanced")["amount"] as { Amount: { ExactIn: string } };
      amount.Amount.ExactIn = (BigInt(amount.Amount.ExactIn) - fee).toString();
    });
    quote.fee_amount = fee.toString();
    quote.execution_instructions.push(
      transaction("wrap.near", [call("near_deposit", {}, fee.toString())]),
      transaction(
        "wrap.near",
        [call("ft_transfer", { receiver_id: "wallet.intear.near", amount: fee.toString(), memo: "Trading fee (wallet.intear.near)" })],
        true,
      ),
    );
    expectUnsafe(quote, /The fees of 9975000000000000000000 are more than the requested fees of at most 5000000000000000000002/);
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
    expectUnsafe(quote, /Routes don't make Transfer actions/);
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
  /** Of a swap that beat the estimate by 1000: the trader spends 1 NEAR with the fees, and gets the estimate */
  const outcome = (changes: Partial<Omit<SwapOutcome, "charge_fee" | "error">> = {}): SwapOutcome => ({
    charge_fee: true,
    amount_in: "1000000000000000000000000",
    amount_out: estimatedOut.toString(),
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

  test("swapping the whole input, with the fees on top", () => {
    expectUnsafe(
      tamper(quote, 0, 1, (args) => {
        args["amount"] = "1000000000000000000000000";
      }),
      /spend 1005000000000000000000000 of the input, more than the 1000000000000000000000000/,
    );
  });

  test("the next steps pay the fees and the quote improvement fee", () => {
    expect(problemsOf(() => validateNextSteps(NEAR_TO_USDC, quote, outcome()))).toEqual([]);
  });

  test("a quote improvement fee of more than the swap beat the quote by", () => {
    const problems = problemsOf(() =>
      validateNextSteps(NEAR_TO_USDC, quote, outcome({ amount_out: (estimatedOut - 1n).toString() })),
    );
    expect(problems).toEqual([
      "With a quote improvement fee of 1000, the trader gets 2846352, not the quote's estimate of 2846353",
    ]);
  });

  test("a quote improvement fee of less than the swap beat the quote by", () => {
    const problems = problemsOf(() =>
      validateNextSteps(NEAR_TO_USDC, quote, outcome({ amount_out: (estimatedOut + 1n).toString() })),
    );
    expect(problems).toEqual([
      "With a quote improvement fee of 1000, the trader gets 2846354, not the quote's estimate of 2846353",
    ]);
  });

  test("a quote improvement fee other than the outcome's", () => {
    const problems = problemsOf(() =>
      validateNextSteps(NEAR_TO_USDC, quote, outcome({ quote_improvement_fee: "500" })),
    );
    expect(problems).toEqual(["The next steps pay a quote improvement fee of 1000, not the outcome's 500"]);
  });

  test("the quote improvement fee of exact-out, in the input", () => {
    const request = REQUESTS["near_to_usdc_exact_out"]!;
    const exactOut = quoteOf("near_to_usdc_exact_out", "RheaDcl");
    const nextSteps = [
      ...exactOut.execution_instructions.filter((instruction) => instruction.NearTransaction.is_fee_transaction === true),
      transaction(
        "wrap.near",
        [call("ft_transfer", { receiver_id: "wallet.intear.near", amount: "1000", memo: "Quote improvement fee" })],
        true,
      ),
    ];
    // The trader spends the estimate: what the swap took, its fees, and the quote improvement fee
    const spent = outcome({ amount_in: "702653299353018149569161", amount_out: "2000000", next_steps: nextSteps });
    expect(problemsOf(() => validateNextSteps(request, withFeesInNextSteps(exactOut), spent))).toEqual([]);
    const spentMore = { ...spent, amount_in: "702653299353018149569162" };
    expect(problemsOf(() => validateNextSteps(request, withFeesInNextSteps(exactOut), spentMore))).toEqual([
      "With a quote improvement fee of 1000, the trader spends 702653299353018149569162, not the quote's estimate of 702653299353018149569161",
    ]);
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

describe("limits of storage deposits", () => {
  const rheaBalances = REQUESTS["rhea_balances_exact_in"]!;
  const allowingStorage = (quote: Quote): Quote => ({ ...quote, storage_deposits: "100000000000000000000000000" });

  test("leaving more storage on Rhea to someone else than they need", () => {
    expectUnsafe(
      allowingStorage(
        tamper(quoteOf("rhea_balances_exact_in", "Rhea"), 0, 2, (_, action) => {
          action.deposit = "60000000000000000000000";
        }),
      ),
      /Leaves 60000000000000000000000 of storage on Rhea to wallet\.intear\.near to withdraw, more than 50000000000000000000000/,
      rheaBalances,
    );
  });

  test("leaving storage on Rhea to someone else over several deposits", () => {
    const quote = allowingStorage(structuredClone(quoteOf("rhea_balances_exact_in", "Rhea")));
    const deposit = call(
      "storage_deposit",
      { registration_only: false, account_id: "dex-aggregator.intear.near" },
      "20000000000000000000000",
      3_000_000_000_000,
    );
    quote.execution_instructions[0]!.NearTransaction.actions.push(deposit, deposit);
    expectUnsafe(quote, /Leaves 64060000000000000000000 of storage on Rhea to dex-aggregator\.intear\.near/, rheaBalances);
  });

  test("attaching more than the limit to storage deposits in all", () => {
    const quote = allowingStorage(structuredClone(quoteOf("near_to_usdc_exact_in", "RheaDcl")));
    quote.execution_instructions.unshift(
      transaction("dclv2.ref-labs.near", [
        call("storage_deposit", { registration_only: true }, "2000000000000000000000000", 3_000_000_000_000),
      ]),
    );
    expectUnsafe(quote, /attach 2000000000000000000000000 to storage deposits, more than 1000000000000000000000000 in all/);
  });
});

describe("actions of the router", () => {
  const rheaDcl = quoteOf("near_to_usdc_exact_in", "RheaDcl");

  test("an action of two kinds", () => {
    const quote = structuredClone(rheaDcl);
    Object.assign(quote.execution_instructions[0]!.NearTransaction.actions[0]!, {
      Transfer: { deposit: "100000000000000000000000000" },
    });
    expectUnsafe(quote, /wrap\.near near_deposit: Has 2 variants instead of one/);
  });

  test("a deposit that isn't a decimal amount", () => {
    expectUnsafe(
      tamper(rheaDcl, 0, 1, (_, action) => {
        action.deposit = "0x1";
      }),
      /deposit isn't an amount/,
    );
  });

  test("gas that isn't a whole amount", () => {
    const quote = structuredClone(rheaDcl);
    const action = quote.execution_instructions[0]!.NearTransaction.actions[1]!;
    if ("FunctionCall" in action) {
      action.FunctionCall.gas = 1.5;
    }
    expectUnsafe(quote, /Its gas of 1\.5 isn't an amount/);
  });

  test("the most gas the router attaches to a call", () => {
    const withGas = (gas: number): Quote => {
      const quote = structuredClone(rheaDcl);
      const action = quote.execution_instructions[0]!.NearTransaction.actions[1]!;
      if ("FunctionCall" in action) {
        action.FunctionCall.gas = gas;
      }
      return quote;
    };
    expect(problemsOf(() => validateQuote(NEAR_TO_USDC, withGas(900_000_000_000_000)))).toEqual([]);
    expectUnsafe(withGas(900_000_000_000_001), /Attaches 900000000000001 gas, more than the router attaches to a call/);
  });

  test("more transactions than the router finds the outcome of", () => {
    const quote = structuredClone(rheaDcl);
    const unwrap = transaction("wrap.near", [call("near_withdraw", { amount: "1" })]);
    quote.execution_instructions.push(...Array.from({ length: 19 }, () => unwrap));
    expectUnsafe(quote, /Has 21 transactions, more than 20/);
  });

  test("a quote that isn't shaped like the router's", () => {
    const { storage_deposits: _, ...malformed } = rheaDcl;
    expectUnsafe(malformed as Quote, /The quote isn't shaped like the router's quotes: storage_deposits isn't an amount/);
    expectUnsafe({ ...rheaDcl, execution_instructions: [null] } as unknown as Quote, /The quote isn't shaped like the router's quotes/);
  });

  test("swapping exact-out on Rhea", () => {
    const request = REQUESTS["near_to_usdc_exact_out"]!;
    const quote = tamper(quoteOf("near_to_usdc_exact_out", "RheaDcl"), 0, 1, (args) => {
      args["receiver_id"] = "v2.ref-finance.near";
      args["msg"] = JSON.stringify({
        force: 0,
        actions: [
          { pool_id: 1, token_in: "wrap.near", token_out: USDC, amount_in: args["amount"], amount_out: "0", min_amount_out: "0" },
        ],
        skip_degen_price_sync: true,
        skip_unwrap_near: true,
        referral_id: "wallet.intear.near",
      });
    });
    expectUnsafe(quote, /Swaps exact-out on Rhea, which routes don't/, request);
  });
});

describe("chains of swaps on Intear DEX", () => {
  const USDT = "nep141:usdt.tether-token.near";
  type Operation = Record<string, unknown>;

  /** The quote's swap as two through USDT, the way the router chains them */
  function chained(
    name: "near_to_usdc_exact_in" | "near_to_usdc_exact_out",
    change: (first: Operation, second: Operation, operations: Operation[]) => void = () => {},
  ): Quote {
    return tamper(quoteOf(name, "IntearDex"), 0, 0, (args) => {
      const operations = (args["operations"] as Operation)["operations"] as Operation[];
      const index = operations.findIndex((operation) => "SwapSimple" in operation || "SwapAdvanced" in operation);
      const swap = Object.values(operations[index]!)[0] as Operation;
      const first: Operation = {
        dex_id: "slimedragon.near/xyk",
        message: "",
        asset_in: swap["asset_in"],
        asset_out: USDT,
        amount: swap["amount"],
        constraint: null,
        quote_improvement_fee: null,
      };
      const second: Operation = {
        dex_id: "slimedragon.near/xyk",
        message: "",
        asset_in: USDT,
        asset_out: swap["asset_out"],
        amount: "OutputOfLastIn",
        constraint: swap["constraint"],
        quote_improvement_fee: swap["quote_improvement_fee"],
      };
      operations.splice(index, 1, { SwapSimple: first }, { SwapSimple: second });
      change(first, second, operations);
    });
  }

  test("swapping through another token", () => {
    expect(problemsOf(() => validateQuote(NEAR_TO_USDC, chained("near_to_usdc_exact_in")))).toEqual([]);
  });

  test("a lower minimum output at the end", () => {
    expectUnsafe(
      chained("near_to_usdc_exact_in", (_, second) => {
        second["constraint"] = "1";
      }),
      /guarantee 1 of the output/,
    );
  });

  test("constraining a swap before the last one", () => {
    expectUnsafe(
      chained("near_to_usdc_exact_in", (first) => {
        first["constraint"] = "1";
      }),
      /Constrains a swap before the last one of a chain/,
    );
  });

  test("swapping something else than the swap before gave", () => {
    expectUnsafe(
      chained("near_to_usdc_exact_in", (_, second) => {
        second["asset_in"] = "near";
      }),
      /Swaps something else than what the swap before it gave/,
    );
  });

  test("swapping what a withdrawal gave", () => {
    expectUnsafe(
      chained("near_to_usdc_exact_in", (first, second, operations) => {
        // The first swap gives the output on its own, then the second swaps it again
        first["asset_out"] = second["asset_out"];
        first["constraint"] = second["constraint"];
        second["asset_in"] = second["asset_out"];
        const index = operations.findIndex((operation) => operation["SwapSimple"] === first);
        operations.splice(index + 1, 0, {
          Withdraw: { asset_id: first["asset_out"], amount: { Full: { at_least: null } }, to: null, rescue_address: null },
        });
      }),
      /Swaps something else than what the swap before it gave/,
    );
  });

  test("ending in something else than the output", () => {
    expectUnsafe(
      chained("near_to_usdc_exact_in", (_, second) => {
        second["asset_out"] = USDT;
      }),
      /Swaps to something else than the output/,
    );
  });

  test("chaining exact-out swaps", () => {
    expectUnsafe(
      chained("near_to_usdc_exact_out"),
      /only exact-in swaps do/,
      REQUESTS["near_to_usdc_exact_out"],
    );
  });
});

describe("split swaps on Intear DEX", () => {
  type Operation = Record<string, unknown>;

  /** The quote's swap split into two of its own parts of the input, the way the router splits it */
  function split(change: (first: Operation, second: Operation) => void = () => {}): Quote {
    return tamper(quoteOf("near_to_usdc_exact_in", "IntearDex"), 0, 0, (args) => {
      const operations = (args["operations"] as Operation)["operations"] as Operation[];
      const index = operations.findIndex((operation) => "SwapSimple" in operation || "SwapAdvanced" in operation);
      const swap = Object.values(operations[index]!)[0] as Operation;
      const amount = BigInt((swap["amount"] as { Amount: { ExactIn: string } }).Amount.ExactIn);
      const constraint = BigInt(swap["constraint"] as string);
      const fee = swap["quote_improvement_fee"] as Operation;
      const expected = BigInt(fee["quote_expected_amount"] as string);
      const part = (share: (whole: bigint) => bigint): Operation => ({
        dex_id: "slimedragon.near/xyk",
        message: "",
        asset_in: swap["asset_in"],
        asset_out: swap["asset_out"],
        amount: { Amount: { ExactIn: share(amount).toString() } },
        constraint: share(constraint).toString(),
        quote_improvement_fee: { ...fee, quote_expected_amount: share(expected).toString() },
      });
      const first = part((whole) => (whole * 7n) / 10n);
      const second = part((whole) => whole - (whole * 7n) / 10n);
      operations.splice(index, 1, { SwapSimple: first }, { SwapSimple: second });
      change(first, second);
    });
  }

  test("a split swap", () => {
    expect(problemsOf(() => validateQuote(NEAR_TO_USDC, split()))).toEqual([]);
  });

  test("quote improvement fees of what the estimate already has, between them", () => {
    expectUnsafe(
      split((_, second) => {
        const fee = second["quote_improvement_fee"] as Operation;
        fee["quote_expected_amount"] = (BigInt(fee["quote_expected_amount"] as string) - 1n).toString();
      }),
      /Takes a quote improvement fee of what beats/,
    );
  });

  test("guaranteeing less than the worst case between them", () => {
    expectUnsafe(
      split((_, second) => {
        second["constraint"] = (BigInt(second["constraint"] as string) - 1n).toString();
      }),
      /The swaps guarantee/,
    );
  });
});

describe("limits of the next steps", () => {
  const quote = quoteOf("near_to_usdc_exact_in", "RheaDcl");
  const outcome = (nextSteps: SwapOutcome["next_steps"]): SwapOutcome => ({
    charge_fee: true,
    amount_in: "995000000000000000000000",
    amount_out: "2846353",
    balance_changes: [],
    next_steps: nextSteps,
    error: null,
    settled: true,
  });
  const rheaStorage = (args: Record<string, unknown>, deposit: string) =>
    call("storage_deposit", { registration_only: false, ...args }, deposit, 3_000_000_000_000);

  test("leaving storage on Rhea to someone else", () => {
    const deposits = transaction(
      "v2.ref-finance.near",
      Array.from({ length: 2 }, () => rheaStorage({ account_id: "dex-aggregator.intear.near" }, "30000000000000000000000")),
    );
    expect(problemsOf(() => validateNextSteps(NEAR_TO_USDC, quote, outcome([deposits])))).toEqual([
      "v2.ref-finance.near storage_deposit: Leaves 60000000000000000000000 of storage on Rhea to dex-aggregator.intear.near to withdraw, more than 50000000000000000000000",
    ]);
  });

  test("attaching more than the limit to storage deposits in all", () => {
    const deposits = transaction(
      "v2.ref-finance.near",
      Array.from({ length: 11 }, () => rheaStorage({}, "100000000000000000000000")),
    );
    expect(problemsOf(() => validateNextSteps(NEAR_TO_USDC, quote, outcome([deposits])))).toEqual([
      "The transactions attach 1100000000000000000000000 to storage deposits, more than 1000000000000000000000000 in all",
    ]);
  });

  test("an outcome that isn't shaped like the router's", () => {
    const { next_steps: _, ...malformed } = outcome([]);
    expect(problemsOf(() => validateNextSteps(NEAR_TO_USDC, quote, malformed as SwapOutcome))).toEqual([
      expect.stringMatching(/^The outcome isn't shaped like the router's outcomes/),
    ]);
  });
});
