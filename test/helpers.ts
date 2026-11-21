import { readFileSync } from "node:fs";
import type { ExecutionInstruction, Quote, RouterAction } from "../src/types.js";

export function fixture(name: string): Quote[] {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Quote[];
}

export function quoteOf(name: string, dexId: string): Quote {
  const quote = fixture(name).find((quote) => quote.dex_id === dexId);
  if (quote === undefined) {
    throw new Error(`${name} has no ${dexId} quote`);
  }
  return quote;
}

export function encodeArgs(args: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args))));
}

export function decodeArgs(args: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(args), (char) => char.charCodeAt(0))));
}

export function call(method: string, args: unknown, deposit = "1", gas = 30_000_000_000_000): RouterAction {
  return { FunctionCall: { method_name: method, args: encodeArgs(args), gas, deposit } };
}

export function transaction(
  receiverId: string,
  actions: RouterAction[],
  isFeeTransaction = false,
): ExecutionInstruction {
  return { NearTransaction: { receiver_id: receiverId, actions, is_fee_transaction: isFeeTransaction } };
}

/** A copy of the quote with an action's arguments, or the action itself, changed */
export function tamper(
  quote: Quote,
  instructionIndex: number,
  actionIndex: number,
  change: (args: Record<string, unknown>, action: { method_name: string; deposit: string }) => void,
): Quote {
  const copy = structuredClone(quote);
  const action = copy.execution_instructions[instructionIndex]?.NearTransaction.actions[actionIndex];
  if (action === undefined || !("FunctionCall" in action)) {
    throw new Error("No such function call");
  }
  const args = decodeArgs(action.FunctionCall.args);
  change(args, action.FunctionCall);
  action.FunctionCall.args = encodeArgs(args);
  return copy;
}

/** Changes a JSON string field of the arguments, like an ft_transfer_call's `msg` */
export function tamperJson(
  args: Record<string, unknown>,
  field: string,
  change: (value: Record<string, unknown>) => void,
): void {
  const value = JSON.parse(args[field] as string) as Record<string, unknown>;
  change(value);
  args[field] = JSON.stringify(value);
}

/** The quote as a subscription with `feesInNextSteps` has it: without its fee transactions */
export function withFeesInNextSteps(quote: Quote, quoteId = 7): Quote {
  return {
    ...structuredClone(quote),
    execution_instructions: quote.execution_instructions.filter(
      (instruction) => instruction.NearTransaction.is_fee_transaction !== true,
    ),
    quote_id: quoteId,
  };
}
