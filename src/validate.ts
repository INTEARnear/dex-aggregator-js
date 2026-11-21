import { WRAP_NEAR, intearAssets, parseToken, type Token } from "./request.js";
import type {
  ExecutionInstruction,
  Quote,
  RouterAction,
  RouterAmount,
  SwapOutcome,
  SwapRequest,
} from "./types.js";

const RHEA = "v2.ref-finance.near";
const RHEA_DCL = "dclv2.ref-labs.near";
const INTEAR_DEX = "dex.intear.near";
/** Takes a share of every referral fee */
const AGGREGATOR_FEE_RECEIVER = "dex-aggregator.intear.near";
const FULL_FEE_FRACTION = 1_000_000n;
/** The most that the router attaches to a call, with room in its transaction for the others */
const MAX_GAS = 900_000_000_000_000n;
/** Each path of a split route rounds its own worst case */
const WORST_CASE_ROUNDING = 32n;
const TRADING_FEE_MEMO_PREFIX = "Trading fee (";
const QUOTE_IMPROVEMENT_FEE_MEMO = "Quote improvement fee";
/** As many as the router finds the outcome of */
const MAX_TRANSACTIONS = 20;
/**
 * The most that the storage deposits of a quote attach in all, and again of its next steps, which
 * have no figure of them. A trader new to Rhea DCL deposits its minimum of 0.5 NEAR.
 */
export const MAX_STORAGE_DEPOSITS = 1_000_000_000_000_000_000_000_000n; // 1 NEAR
/**
 * The most that Rhea's storage deposits leave to each account other than the trader, which can
 * withdraw them. A fee receiver new to Rhea takes 0.0112 NEAR.
 */
export const MAX_STORAGE_DEPOSIT_FOR_OTHERS = 50_000_000_000_000_000_000_000n; // 0.05 NEAR

/** What makes the router's transactions unsafe to sign, one problem each */
export class UnsafeTransactionsError extends Error {
  constructor(readonly problems: string[]) {
    super(`The router's transactions aren't safe to sign: ${problems.join("; ")}`);
    this.name = "UnsafeTransactionsError";
  }
}

/**
 * Checks that the quote's transactions only do what the request asks: spend at most the input
 * the trader allows (the exact input, or the quote's worst case of exact-out), get at least the
 * quote's worst case of the output, call only the tokens of the swap and the DEXes the router
 * uses, attach no more to storage deposits than the quote says and the limits allow, and pay fees
 * only to the requested receivers, no more than requested. A quote that isn't shaped like the
 * router's is unsafe too.
 */
export function validateQuote(request: SwapRequest, quote: Quote): void {
  const checker = new TransactionChecker(request, quote, "quote");
  try {
    const feesInNextSteps = quote.quote_id !== undefined;
    checker.amounts();
    checker.transactionCount(quote.execution_instructions);
    for (const instruction of quote.execution_instructions) {
      const isFeeTransaction = instruction.NearTransaction.is_fee_transaction === true;
      if (isFeeTransaction && feesInNextSteps) {
        checker.problem("A quote whose fees are in the next steps has fee transactions");
      }
      checker.instruction(instruction, isFeeTransaction);
    }
    checker.quoteTotals(feesInNextSteps);
  } catch (error) {
    checker.problem(`The quote isn't shaped like the router's quotes: ${message(error)}`);
  }
  checker.throwProblems();
}

/**
 * Checks that the next steps of the quote's outcome only move the trader's input and output
 * between the places they hold them, and, of a quote whose fees are in its next steps whose swap
 * went through, pay its fees and the quote improvement fee that the outcome's amounts add up to
 */
export function validateNextSteps(
  request: SwapRequest,
  quote: Quote,
  outcome: SwapOutcome,
): void {
  const checker = new TransactionChecker(request, quote, "nextSteps");
  try {
    const feesDue = quote.quote_id !== undefined && outcome.charge_fee;
    checker.transactionCount(outcome.next_steps);
    for (const instruction of outcome.next_steps) {
      const isFeeTransaction = instruction.NearTransaction.is_fee_transaction === true;
      if (isFeeTransaction && !feesDue) {
        checker.problem("The next steps pay fees, which are only due after a swap that went through");
        continue;
      }
      checker.instruction(instruction, isFeeTransaction);
    }
    checker.nextStepTotals(outcome);
  } catch (error) {
    checker.problem(`The outcome isn't shaped like the router's outcomes: ${message(error)}`);
  }
  checker.throwProblems();
}

type Phase = "quote" | "nextSteps";

type Json = Record<string, unknown>;

class TransactionChecker {
  readonly #problems: string[] = [];
  readonly #tokenIn: Token;
  readonly #tokenOut: Token;
  readonly #inputAssets: string[];
  readonly #outputAssets: string[];
  readonly #feeReceivers: Set<string>;
  /** Of the requested fees, in millionths of the input */
  readonly #requestedFee: bigint;
  /** Of the input, sent to DEXes and to fee receivers */
  #spent = 0n;
  /** Paid out of the wallet balance of the input */
  #walletFees = 0n;
  /** Paid out of the balance of the input on Rhea */
  #rheaFees = 0n;
  #storageDeposits = 0n;
  /** Of accounts other than the trader, which they can withdraw */
  readonly #othersRheaStorage = new Map<string, bigint>();
  /** Native NEAR made into wNEAR */
  #wrapped = 0n;
  /** What the swaps give at least, of exact-in */
  #guaranteedOutput = 0n;
  #swaps = 0;
  #quoteImprovementFee = 0n;

  constructor(
    readonly request: SwapRequest,
    readonly quote: Quote,
    readonly phase: Phase,
  ) {
    this.#tokenIn = parseToken(request.tokenIn);
    this.#tokenOut = parseToken(request.tokenOut);
    this.#inputAssets = intearAssets(this.#tokenIn);
    this.#outputAssets = intearAssets(this.#tokenOut);
    this.#feeReceivers = new Set([
      ...Object.keys(request.fees ?? {}),
      AGGREGATOR_FEE_RECEIVER,
    ]);
    this.#requestedFee = Object.values(request.fees ?? {}).reduce(
      (total, fraction) => total + BigInt(Math.round(fraction * Number(FULL_FEE_FRACTION))),
      0n,
    );
  }

  problem(problem: string): void {
    this.#problems.push(problem);
  }

  throwProblems(): void {
    if (this.#problems.length > 0) {
      throw new UnsafeTransactionsError(this.#problems);
    }
  }

  get #exactIn(): boolean {
    return "exactIn" in this.request.amount;
  }

  /** What the quote estimates: the output of exact-in, the input of exact-out */
  get #estimated(): bigint {
    return amountOf(this.quote.estimated_amount, this.#exactIn ? "amount_out" : "amount_in");
  }

  /** The quote's amounts are of the request, its worst case within the slippage */
  amounts(): void {
    try {
      const estimated = this.#estimated;
      const worstCase = amountOf(
        this.quote.worst_case_amount,
        this.#exactIn ? "amount_out" : "amount_in",
      );
      const slippage =
        this.request.slippage.type === "fixed"
          ? this.request.slippage.slippage
          : this.request.slippage.maxSlippage;
      const maxSlippage =
        (estimated * BigInt(Math.round(slippage * Number(FULL_FEE_FRACTION)))) /
          FULL_FEE_FRACTION +
        WORST_CASE_ROUNDING;
      if (this.#exactIn ? worstCase < estimated - maxSlippage : worstCase > estimated + maxSlippage) {
        this.problem(
          `The worst case ${worstCase} is further from the estimate ${estimated} than the slippage allows`,
        );
      }
    } catch (error) {
      this.problem(`The quote's amounts: ${message(error)}`);
    }
  }

  transactionCount(instructions: ExecutionInstruction[]): void {
    if (instructions.length > MAX_TRANSACTIONS) {
      this.problem(`Has ${instructions.length} transactions, more than ${MAX_TRANSACTIONS}`);
    }
  }

  instruction(instruction: ExecutionInstruction, isFeeTransaction: boolean): void {
    const { receiver_id, actions } = instruction.NearTransaction;
    for (const action of actions) {
      try {
        this.#action(receiver_id, action, isFeeTransaction);
      } catch (error) {
        const method = "FunctionCall" in action ? action.FunctionCall.method_name : "Transfer";
        this.problem(`${receiver_id} ${method}: ${message(error)}`);
      }
    }
  }

  quoteTotals(feesInNextSteps: boolean): void {
    // What the trader allows the swap to take
    const maxInput =
      "exactIn" in this.request.amount
        ? this.request.amount.exactIn
        : amountOf(this.quote.worst_case_amount, "amount_in");
    if (this.#spent > maxInput) {
      this.problem(
        `The transactions spend ${this.#spent} of the input, more than the ${maxInput} the trader allows`,
      );
    }
    const storageDeposits = bigint(this.quote.storage_deposits, "storage_deposits");
    if (this.#storageDeposits > storageDeposits) {
      this.problem(
        `The transactions attach ${this.#storageDeposits} to storage deposits, more than the quote's ${storageDeposits}`,
      );
    }
    this.#storageDepositsWithinLimit();
    if (this.#wrapped > 0n && !(this.#tokenIn.contract === WRAP_NEAR && this.#wrapped <= maxInput)) {
      this.problem(`The transactions wrap ${this.#wrapped} NEAR, which isn't the input`);
    }
    const feeAmount = bigint(this.quote.fee_amount, "fee_amount");
    if (!feesInNextSteps && this.#walletFees !== feeAmount) {
      this.problem(
        `The fee transactions pay ${this.#walletFees}, not the quote's fee amount of ${feeAmount}`,
      );
    }
    const maxFees =
      (maxInput * this.#requestedFee) / FULL_FEE_FRACTION + BigInt(this.#feeReceivers.size);
    const fees = feeAmount + this.#rheaFees;
    if (fees > maxFees) {
      this.problem(`The fees of ${fees} are more than the requested fees of at most ${maxFees}`);
    }
    if (this.#swaps === 0 && this.#tokenIn.contract !== this.#tokenOut.contract) {
      this.problem("The transactions don't swap");
    }
    if (this.#exactIn && this.#swaps > 0) {
      const worstCase = amountOf(this.quote.worst_case_amount, "amount_out");
      if (this.#guaranteedOutput < worstCase) {
        this.problem(
          `The swaps guarantee ${this.#guaranteedOutput} of the output, less than the quote's worst case of ${worstCase}`,
        );
      }
    }
  }

  nextStepTotals(outcome: SwapOutcome): void {
    this.#storageDepositsWithinLimit();
    const feeAmount = bigint(this.quote.fee_amount, "fee_amount");
    if (this.#walletFees > feeAmount) {
      this.problem(`The next steps pay ${this.#walletFees} of fees, more than the quote's ${feeAmount}`);
    }
    const quoteImprovementFee = bigint(outcome.quote_improvement_fee ?? "0", "quote_improvement_fee");
    if (this.#quoteImprovementFee !== quoteImprovementFee) {
      this.problem(
        `The next steps pay a quote improvement fee of ${this.#quoteImprovementFee}, not the outcome's ${quoteImprovementFee}`,
      );
    }
    if (quoteImprovementFee > 0n) {
      const beatBy = this.#exactIn
        ? bigint(outcome.amount_out, "amount_out") - this.#estimated
        : this.#estimated - feeAmount - bigint(outcome.amount_in, "amount_in");
      if (quoteImprovementFee !== beatBy) {
        this.problem(
          `The quote improvement fee of ${quoteImprovementFee} isn't the ${beatBy} that the swap beat the quote by`,
        );
      }
    }
  }

  #action(receiverId: string, action: RouterAction, isFeeTransaction: boolean): void {
    // An action of two kinds would be checked as one of them and signed as the other
    const [kind] = singleEntry(action);
    if (!("FunctionCall" in action)) {
      throw new Error(`Routes don't make ${kind} actions`);
    }
    const { method_name: method, args: encodedArgs, gas, deposit } = action.FunctionCall;
    if (!Number.isSafeInteger(gas) || gas < 0) {
      throw new Error(`Its gas of ${gas} isn't an amount`);
    }
    if (BigInt(gas) > MAX_GAS) {
      throw new Error(`Attaches ${gas} gas, more than the router attaches to a call`);
    }
    const args = decodeArgs(encodedArgs);
    const attached = bigint(deposit, "deposit");
    // In next steps, a fee transaction also moves the quote improvement fee into the wallet first
    if (
      this.phase === "quote" &&
      isFeeTransaction &&
      method !== "ft_transfer" &&
      method !== "storage_deposit"
    ) {
      throw new Error("A fee transaction only transfers fees and registers their receivers");
    }
    if (receiverId === RHEA) {
      this.#rhea(method, args, attached);
    } else if (receiverId === RHEA_DCL) {
      this.#rheaDcl(method, args, attached);
    } else if (receiverId === INTEAR_DEX) {
      this.#intearDex(method, args, attached);
    } else if (receiverId === this.#tokenIn.contract || receiverId === this.#tokenOut.contract) {
      this.#token(receiverId, method, args, attached, isFeeTransaction);
    } else {
      throw new Error("Isn't one of the swap's tokens or the DEXes the router swaps on");
    }
  }

  #token(contract: string, method: string, args: Json, attached: bigint, isFeeTransaction: boolean): void {
    switch (method) {
      case "storage_deposit": {
        onlyKeys(args, ["registration_only", "account_id"]);
        if (args["registration_only"] !== true) {
          throw new Error("Deposits more than registration needs");
        }
        if (args["account_id"] !== undefined) {
          this.#storageAccount(args["account_id"]);
        }
        this.#storageDeposits += attached;
        return;
      }
      case "near_deposit": {
        onlyKeys(args, []);
        wrapNearOnly(contract);
        this.#wrapped += attached;
        return;
      }
      case "near_withdraw": {
        onlyKeys(args, ["amount"]);
        wrapNearOnly(contract);
        oneYocto(attached);
        return;
      }
      case "ft_transfer_call": {
        onlyKeys(args, ["receiver_id", "amount", "msg"]);
        oneYocto(attached);
        const receiverId = string(args["receiver_id"], "receiver_id");
        const amount = bigint(args["amount"], "amount");
        const msg = string(args["msg"], "msg");
        if (msg === "") {
          if (receiverId !== RHEA && receiverId !== INTEAR_DEX) {
            throw new Error(`Deposits into ${receiverId}, which only Rhea and Intear DEX hold for the trader`);
          }
          return;
        }
        this.#swapCall();
        if (contract !== this.#tokenIn.contract) {
          throw new Error("Swaps something else than the input");
        }
        this.#spent += amount;
        const swap = parseJson(msg, "msg");
        if (receiverId === RHEA) {
          onlyKeys(swap, ["force", "actions", "skip_degen_price_sync", "skip_unwrap_near", "referral_id"]);
          this.#rheaActions(swap["actions"]);
        } else if (receiverId === RHEA_DCL) {
          this.#rheaDclSwap(swap);
        } else if (receiverId === INTEAR_DEX) {
          this.#engineOperations(swap);
        } else {
          throw new Error(`Sends the input to ${receiverId}, which isn't a DEX the router swaps on`);
        }
        return;
      }
      case "ft_transfer": {
        onlyKeys(args, ["receiver_id", "amount", "memo"]);
        oneYocto(attached);
        const receiverId = string(args["receiver_id"], "receiver_id");
        const amount = bigint(args["amount"], "amount");
        const memo = string(args["memo"], "memo");
        if (!isFeeTransaction) {
          throw new Error(`Transfers tokens to ${receiverId} outside of a fee transaction`);
        }
        if (memo.startsWith(TRADING_FEE_MEMO_PREFIX)) {
          if (contract !== this.#tokenIn.contract) {
            throw new Error("Pays a referral fee in something else than the input");
          }
          this.#feeReceiver(receiverId);
          this.#walletFees += amount;
          this.#spent += amount;
          return;
        }
        if (memo === QUOTE_IMPROVEMENT_FEE_MEMO && this.phase === "nextSteps") {
          if (receiverId !== this.request.quoteImprovementReceiver) {
            throw new Error(`Pays the quote improvement fee to ${receiverId}, not the requested receiver`);
          }
          const improvedToken = this.#exactIn ? this.#tokenOut : this.#tokenIn;
          if (contract !== improvedToken.contract) {
            throw new Error("Pays the quote improvement fee in another token than the one the swap beat the quote in");
          }
          this.#quoteImprovementFee += amount;
          return;
        }
        throw new Error(`Transfers tokens to ${receiverId} with the memo ${JSON.stringify(memo)}`);
      }
      default:
        throw new Error("Isn't a call that routes make to tokens");
    }
  }

  #rhea(method: string, args: Json, attached: bigint): void {
    switch (method) {
      case "register_tokens": {
        onlyKeys(args, ["token_ids"]);
        oneYocto(attached);
        return;
      }
      case "storage_deposit": {
        onlyKeys(args, ["registration_only", "account_id"]);
        if (args["registration_only"] !== false) {
          throw new Error("Rhea's storage is deposited whole");
        }
        this.#storageDeposits += attached;
        if (args["account_id"] === undefined) {
          return;
        }
        const accountId = string(args["account_id"], "account_id");
        this.#storageAccount(accountId);
        if (accountId === this.request.traderAccountId) {
          return;
        }
        const leftToAccount = (this.#othersRheaStorage.get(accountId) ?? 0n) + attached;
        if (leftToAccount > MAX_STORAGE_DEPOSIT_FOR_OTHERS) {
          throw new Error(
            `Leaves ${leftToAccount} of storage on Rhea to ${accountId} to withdraw, more than ${MAX_STORAGE_DEPOSIT_FOR_OTHERS}`,
          );
        }
        this.#othersRheaStorage.set(accountId, leftToAccount);
        return;
      }
      case "swap": {
        onlyKeys(args, ["actions", "referral_id", "skip_degen_price_sync"]);
        oneYocto(attached);
        this.#swapCall();
        if (this.#tokenIn.place !== "rhea") {
          throw new Error("Swaps the trader's balance on Rhea, which isn't where the input is");
        }
        this.#spent += this.#rheaActions(args["actions"]);
        return;
      }
      case "mft_transfer": {
        onlyKeys(args, ["token_id", "receiver_id", "amount", "memo"]);
        oneYocto(attached);
        if (this.phase !== "quote") {
          throw new Error("Next steps pay no fees out of the balance on Rhea");
        }
        if (!string(args["memo"], "memo").startsWith(TRADING_FEE_MEMO_PREFIX)) {
          throw new Error("Transfers a Rhea balance for something else than a referral fee");
        }
        if (args["token_id"] !== this.#tokenIn.contract) {
          throw new Error("Pays a referral fee in something else than the input");
        }
        this.#feeReceiver(string(args["receiver_id"], "receiver_id"));
        const amount = bigint(args["amount"], "amount");
        this.#rheaFees += amount;
        this.#spent += amount;
        return;
      }
      case "withdraw": {
        onlyKeys(args, ["token_id", "amount", "skip_unwrap_near"]);
        oneYocto(attached);
        this.#ownToken(string(args["token_id"], "token_id"));
        return;
      }
      default:
        throw new Error("Isn't a call that routes make to Rhea");
    }
  }

  /** The input that the actions swap, adding up the least output they give */
  #rheaActions(actions: unknown): bigint {
    // Rhea's actions only guarantee an output of exact-in, which routes only swap there
    if (!this.#exactIn) {
      throw new Error("Swaps exact-out on Rhea, which routes don't");
    }
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new Error("Has no swap actions");
    }
    let swapped = 0n;
    let previousTokenOut: unknown;
    actions.forEach((action: unknown, index) => {
      const step = object(action, "action");
      onlyKeys(step, ["pool_id", "token_in", "token_out", "amount_in", "amount_out", "min_amount_out"]);
      if (step["amount_in"] !== undefined) {
        if (step["token_in"] !== this.#tokenIn.contract) {
          throw new Error(`A path swaps ${String(step["token_in"])}, which isn't the input`);
        }
        swapped += bigint(step["amount_in"], "amount_in");
      } else if (step["token_in"] !== previousTokenOut) {
        throw new Error("An action doesn't swap what the one before it gave");
      }
      previousTokenOut = step["token_out"];
      const next = actions[index + 1] as Json | undefined;
      if (next === undefined || next["amount_in"] !== undefined) {
        if (step["token_out"] !== this.#tokenOut.contract) {
          throw new Error(`A path ends in ${String(step["token_out"])}, which isn't the output`);
        }
        this.#guaranteedOutput += bigint(step["min_amount_out"], "min_amount_out");
      }
    });
    return swapped;
  }

  #rheaDcl(method: string, args: Json, attached: bigint): void {
    if (method !== "storage_deposit") {
      throw new Error("Isn't a call that routes make to Rhea DCL");
    }
    onlyKeys(args, ["registration_only"]);
    this.#storageDeposits += attached;
  }

  #rheaDclSwap(message: Json): void {
    const [kind, swap] = singleEntry(message);
    const fields = object(swap, kind);
    if (fields["output_token"] !== this.#tokenOut.contract) {
      throw new Error(`Swaps to ${String(fields["output_token"])}, which isn't the output`);
    }
    if (kind === "Swap" && "exactIn" in this.request.amount) {
      onlyKeys(fields, ["pool_ids", "output_token", "min_output_amount", "skip_unwrap_near", "referral_id"]);
      this.#guaranteedOutput += bigint(fields["min_output_amount"], "min_output_amount");
    } else if (kind === "SwapByOutput" && "exactOut" in this.request.amount) {
      onlyKeys(fields, ["pool_ids", "output_token", "output_amount", "skip_unwrap_near", "referral_id"]);
      if (bigint(fields["output_amount"], "output_amount") !== this.request.amount.exactOut) {
        throw new Error("Swaps for another amount than the requested output");
      }
    } else {
      throw new Error(`${kind} isn't the swap the request asks for`);
    }
  }

  #intearDex(method: string, args: Json, attached: bigint): void {
    switch (method) {
      case "storage_deposit": {
        onlyKeys(args, []);
        this.#storageDeposits += attached;
        return;
      }
      case "register_assets": {
        onlyKeys(args, ["asset_ids", "for"]);
        oneYocto(attached);
        if (args["for"] !== undefined) {
          const owner = object(args["for"], "for");
          onlyKeys(owner, ["Account"]);
          this.#storageAccount(owner["Account"]);
        }
        return;
      }
      case "deposit_near": {
        onlyKeys(args, ["operations"]);
        if (args["operations"] === undefined) {
          // Into the trader's own balance
          return;
        }
        this.#swapCall();
        if (this.#tokenIn.contract !== WRAP_NEAR) {
          throw new Error("Deposits NEAR, which isn't the input");
        }
        this.#spent += attached;
        this.#engineOperations(object(args["operations"], "operations"));
        return;
      }
      case "execute_operations": {
        oneYocto(attached);
        this.#swapCall();
        if (this.#tokenIn.place !== "intear") {
          throw new Error("Swaps the trader's balance on Intear DEX, which isn't where the input is");
        }
        this.#spent += this.#engineOperations(args);
        return;
      }
      case "withdraw": {
        onlyKeys(args, ["asset_id", "amount"]);
        oneYocto(attached);
        this.#ownAsset(args["asset_id"]);
        onlyKeys(object(args["amount"], "amount"), ["Exact"]);
        return;
      }
      default:
        throw new Error("Isn't a call that routes make to Intear DEX");
    }
  }

  /** What the operations take out of the trader's balance on Intear DEX */
  #engineOperations(args: Json): bigint {
    // A fee discount only lowers the swaps' pool fees, and the engine checks its signature
    onlyKeys(args, ["operations", "referrer", "referral_fees", "fee_discount"]);
    this.#engineReferralFees(args["referral_fees"]);
    const operations = args["operations"];
    if (!Array.isArray(operations)) {
      throw new Error("Has no operations");
    }
    let taken = 0n;
    let previousSwap: Json | undefined;
    operations.forEach((entry: unknown, index) => {
      const next: unknown = operations[index + 1];
      const [kind, value] = singleEntry(object(entry, "operation"));
      const operation = object(value, kind);
      switch (kind) {
        case "OracleRequest": {
          onlyKeys(operation, ["oracle_key", "dex_id", "request", "fee", "swap"]);
          const fee = operation["fee"];
          if (!Array.isArray(fee) || fee.length !== 2) {
            throw new Error("The oracle request has no fee");
          }
          if (operation["swap"] === null) {
            if (!this.#inputAssets.includes(fee[0])) {
              throw new Error("Pays the oracle in something else than the input");
            }
            taken += bigint(fee[1], "oracle fee");
            break;
          }
          // Buys the oracle's fee with at most `constraint` of the input
          const feeSwap = object(operation["swap"], "The oracle fee's swap");
          onlyKeys(feeSwap, ["dex_id", "message", "asset_in", "constraint"]);
          if (!this.#inputAssets.includes(feeSwap["asset_in"] as string)) {
            throw new Error("Buys the oracle fee with something else than the input");
          }
          taken += bigint(feeSwap["constraint"], "The most the oracle fee's swap takes");
          break;
        }
        case "SwapSimple": {
          onlyKeys(operation, ["dex_id", "message", "asset_in", "asset_out", "amount", "constraint", "quote_improvement_fee"]);
          taken += this.#engineSwap(operation, previousSwap, next);
          break;
        }
        case "SwapAdvanced": {
          onlyKeys(operation, ["asset_in", "asset_out", "amount", "constraint", "quote_improvement_fee", "options", "mode"]);
          taken += this.#engineSwap(operation, previousSwap, next);
          break;
        }
        case "Withdraw": {
          onlyKeys(operation, ["asset_id", "amount", "to", "rescue_address"]);
          this.#ownAsset(operation["asset_id"]);
          if (operation["to"] !== null || operation["rescue_address"] !== null) {
            throw new Error("Withdraws to someone else than the trader");
          }
          break;
        }
        default:
          throw new Error(`Runs ${kind} on Intear DEX, which routes don't`);
      }
      previousSwap = kind === "SwapSimple" || kind === "SwapAdvanced" ? operation : undefined;
    });
    return taken;
  }

  /**
   * What the swap takes at most of the input. Exact-in swaps can be chained: each swap of
   * `OutputOfLastIn` swaps what the one before it gave, and only the last one is constrained.
   */
  #engineSwap(operation: Json, previousSwap: Json | undefined, next: unknown): bigint {
    let taken = 0n;
    if (operation["amount"] === "OutputOfLastIn") {
      if (!this.#exactIn) {
        throw new Error("Swaps what the swap before it gave, which only exact-in swaps do");
      }
      if (previousSwap === undefined || string(operation["asset_in"], "asset_in") !== previousSwap["asset_out"]) {
        throw new Error("Swaps something else than what the swap before it gave");
      }
    } else {
      if (!this.#inputAssets.includes(operation["asset_in"] as string)) {
        throw new Error("Swaps something else than the input");
      }
      const amount = object(object(operation["amount"], "amount")["Amount"], "Amount");
      const [kind, value] = singleEntry(amount);
      if (kind === "ExactIn" && "exactIn" in this.request.amount) {
        taken = bigint(value, "ExactIn");
      } else if (kind === "ExactOut" && "exactOut" in this.request.amount) {
        if (bigint(value, "ExactOut") !== this.request.amount.exactOut) {
          throw new Error("Swaps for another amount than the requested output");
        }
      } else {
        throw new Error(`${kind} isn't the swap the request asks for`);
      }
    }
    const nextOperation = next as Json | undefined;
    const nextSwap = (nextOperation?.["SwapSimple"] ?? nextOperation?.["SwapAdvanced"]) as Json | undefined;
    if (nextSwap?.["amount"] === "OutputOfLastIn") {
      if (operation["constraint"] !== null || operation["quote_improvement_fee"] !== null) {
        throw new Error("Constrains a swap before the last one of a chain, which routes don't");
      }
      return taken;
    }
    if (!this.#outputAssets.includes(operation["asset_out"] as string)) {
      throw new Error("Swaps to something else than the output");
    }
    const constraint = bigint(operation["constraint"], "constraint");
    this.#engineQuoteImprovementFee(operation["quote_improvement_fee"]);
    if (!this.#exactIn) {
      // The most that an exact-out swap takes
      return constraint;
    }
    this.#guaranteedOutput += constraint;
    return taken;
  }

  #engineQuoteImprovementFee(fee: unknown): void {
    if (fee === null || fee === undefined) {
      return;
    }
    const fields = object(fee, "quote_improvement_fee");
    onlyKeys(fields, ["quote_expected_amount", "quote_improvement_receiver"]);
    if (fields["quote_improvement_receiver"] !== this.request.quoteImprovementReceiver) {
      throw new Error("Pays the quote improvement fee to someone else than the requested receiver");
    }
    const expected = bigint(fields["quote_expected_amount"], "quote_expected_amount");
    if (this.#exactIn ? expected < this.#estimated : expected > this.#estimated) {
      throw new Error(
        `Takes a quote improvement fee of what beats ${expected}, which the quote's estimate of ${this.#estimated} doesn't`,
      );
    }
  }

  #engineReferralFees(fees: unknown): void {
    if (fees === undefined) {
      return;
    }
    if (!Array.isArray(fees)) {
      throw new Error("Referral fees aren't a list");
    }
    let total = 0n;
    for (const fee of fees) {
      if (!Array.isArray(fee) || fee.length !== 2) {
        throw new Error("A referral fee isn't a receiver and a fraction");
      }
      this.#feeReceiver(string(fee[0], "referral fee receiver"));
      if (!Number.isSafeInteger(fee[1]) || fee[1] < 0) {
        throw new Error("A referral fee isn't millionths of the input");
      }
      total += BigInt(fee[1]);
    }
    if (total > this.#requestedFee) {
      throw new Error(`Referral fees of ${total} millionths are more than the requested ${this.#requestedFee}`);
    }
  }

  #swapCall(): void {
    if (this.phase === "nextSteps") {
      throw new Error("Next steps don't swap");
    }
    this.#swaps += 1;
  }

  #storageDepositsWithinLimit(): void {
    if (this.#storageDeposits > MAX_STORAGE_DEPOSITS) {
      this.problem(
        `The transactions attach ${this.#storageDeposits} to storage deposits, more than ${MAX_STORAGE_DEPOSITS} in all`,
      );
    }
  }

  #storageAccount(accountId: unknown): void {
    const allowed = new Set([
      ...(this.request.traderAccountId === undefined ? [] : [this.request.traderAccountId]),
      RHEA,
      INTEAR_DEX,
      ...this.#feeReceivers,
      ...(this.request.quoteImprovementReceiver === undefined ? [] : [this.request.quoteImprovementReceiver]),
    ]);
    if (typeof accountId !== "string" || !allowed.has(accountId)) {
      throw new Error(`Registers ${String(accountId)}, which the swap doesn't pay`);
    }
  }

  #feeReceiver(accountId: string): void {
    if (!this.#feeReceivers.has(accountId)) {
      throw new Error(`Pays a fee to ${accountId}, which the request doesn't`);
    }
  }

  #ownToken(contract: string): void {
    if (contract !== this.#tokenIn.contract && contract !== this.#tokenOut.contract) {
      throw new Error(`Moves ${contract}, which isn't the input or the output`);
    }
  }

  #ownAsset(assetId: unknown): void {
    const assets = [...this.#inputAssets, ...this.#outputAssets];
    if (typeof assetId !== "string" || !assets.includes(assetId)) {
      throw new Error(`Moves ${String(assetId)}, which isn't the input or the output`);
    }
  }
}

function amountOf(amount: RouterAmount, kind: "amount_in" | "amount_out"): bigint {
  return bigint(amount[kind], kind);
}

function decodeArgs(base64: string): Json {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return object(JSON.parse(new TextDecoder().decode(bytes)), "args");
}

function parseJson(json: string, what: string): Json {
  try {
    return object(JSON.parse(json), what);
  } catch (error) {
    throw new Error(`${what} isn't JSON: ${message(error)}`);
  }
}

function object(value: unknown, what: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} isn't an object`);
  }
  return value as Json;
}

function string(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new Error(`${what} isn't a string`);
  }
  return value;
}

function bigint(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${what} isn't an amount`);
  }
  return BigInt(value);
}

function singleEntry(value: Json): [string, unknown] {
  const entries = Object.entries(value);
  if (entries.length !== 1) {
    throw new Error(`Has ${entries.length} variants instead of one`);
  }
  return entries[0] as [string, unknown];
}

/** Routes call contracts with exactly these arguments, so anything else is someone else's */
function onlyKeys(value: Json, keys: string[]): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw new Error(`Has arguments that routes don't: ${unknown.join(", ")}`);
  }
}

function oneYocto(attached: bigint): void {
  if (attached > 1n) {
    throw new Error(`Attaches ${attached}, where routes attach at most 1 yoctoNEAR`);
  }
}

function wrapNearOnly(contract: string): void {
  if (contract !== WRAP_NEAR) {
    throw new Error("Only wNEAR wraps NEAR");
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
