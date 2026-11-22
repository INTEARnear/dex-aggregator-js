# @intear/dex-aggregator

> [!WARNING]
> 
> this library is 100% vibecoded, i haven't fully reviewed it yet, and idk if ever will. this is sort of a reference implementation, used on dex.intea.rs so it at least works in one actively maintained app and will not get abandoned.

Client of the Intear DEX Aggregator (router.intear.tech) that checks the router's transactions before anyone signs them, for both ways of paying fees:

- **near-connect** (`swapWithNearConnect`): wallets that ask the trader. The quote's transactions, its fee transactions included, are approved at once: the wallet doesn't send the fee transactions of a swap that it sees failed. Then, if there are any, the next steps of its outcome, which move tokens where the trader asked for them, in another approval.
- **Signers** (`swapWithSigner`): accounts that sign without asking, like bots and custodial wallets. Quotes of a subscription with `feesInNextSteps` leave the fee transactions out and have a `quote_id`. The outcome of their transactions, asked for by that ID, has the fees and the quote improvement fee in its next steps, once the swap went through.

```ts
import { RouterConnection, swapWithSigner, type SwapRequest } from "@intear/dex-aggregator";

const request: SwapRequest = {
  tokenIn: "near",
  tokenOut: "usdc.near",
  amount: { exactIn: 10n ** 24n },
  slippage: { type: "fixed", slippage: 0.01 },
  traderAccountId: "trader.near",
  fees: { "app.near": 0.005 },
  quoteImprovementReceiver: "app.near",
};
// The router estimates the price, so the least to take for 1 NEAR comes from a price you trust
const leastAmountOut = 2_500_000n; // 2.5 USDC
const connection = new RouterConnection();
const stop = connection.subscribe(request, {
  feesInNextSteps: true,
  onQuotes: ({ quotes, rejected }) => {
    // `rejected` has the quotes whose transactions aren't safe to sign, and why
    const [best] = quotes;
    if (best === undefined || BigInt(best.worst_case_amount.amount_out!) < leastAmountOut) {
      return;
    }
    stop();
    swapWithSigner({
      signer,
      connection,
      request,
      quote: best,
      onSwapSent: (txHashes) => console.log("Swapped in", txHashes),
    })
      .then(({ outcome, nextStepsError }) => console.log(outcome, nextStepsError))
      .catch((error) => console.error("The swap failed", error));
  },
});
```

A signer is `{ signAndSendTransaction(transaction): Promise<txHash> }`. `transaction` has the shape near-connect takes, so with near-api-js it's `account.signAndSendTransaction({ receiverId, actions: actions.map(...) })` with `actions.functionCall(methodName, args, BigInt(gas), BigInt(deposit))`.

## What's checked

`validateQuote` (on every quote of a subscription, and before swapping) and `validateNextSteps` (before the next steps are signed) only accept the calls the router makes, with exactly the arguments it passes, and check that:

- the transactions spend at most the exact input, or the quote's worst case of an exact-out swap, counting fees, also the ones its next steps pay, and wrap at most that much NEAR
- the fee transactions, the fees paid on Rhea and the referral fees that Intear DEX takes add up to no more than the requested fees
- the swaps give at least the quote's worst case of exact-in, which is within the requested slippage of its estimate, or the requested output of exact-out, which only swaps on Rhea DCL and Intear DEX, whose swaps give exactly what they're asked for
- they only call the swap's tokens, wNEAR, Rhea, Rhea DCL and Intear DEX, and only send the trader's tokens to those DEXes and to the requested fee receivers
- Intear DEX's operations only swap the input for the output, also through other tokens one swap after another, withdraw to the trader, pay oracles no more than `MAX_ORACLE_FEES` (1 NEAR, 1 USDT, 1 USDC or 1000 TEAR of the input, out of it or by a swap that buys their fee, and no other asset), and take the requested referral fees and a quote improvement fee for the requested receiver of no more than the quote's estimate beats
- storage deposits attach no more than the quote's `storage_deposits`, and no more than `MAX_STORAGE_DEPOSITS` (1 NEAR) in all, also in the next steps, for the trader, the DEXes and the fee receivers, and leave no more than `MAX_STORAGE_DEPOSIT_FOR_OTHERS` (0.05 NEAR) on Rhea to each account other than the trader, which it could withdraw
- next steps don't swap, only pay fees after a swap that went through, no more than the quote's `fee_amount`, and pay the quote improvement fee that leaves the trader with exactly the quote's estimate: the outcome's `amount_out` of exact-in, or `amount_in` of exact-out, which are what the trader got and spent, fees included
- there are at most 20 transactions, as many as the router finds the outcome of

A check that fails throws `UnsafeTransactionsError`, with every problem in `problems`, also when the router's quote or outcome isn't shaped like its quotes and outcomes are.

The quote's estimate and worst case come from the router, so the checks can't tell a bad price: compare them with a price you trust before swapping.

## Reconnecting

`RouterConnection` reconnects whenever its connection is lost, waiting twice as long after each failed attempt (250 ms to 10 s by default), and gives up on an attempt after `connectTimeoutMs`. Once it's back, it sends the route request again, and every outcome request that wasn't answered, which the router answers from the quotes it stored by their ID, also after a restart. Its status starts as `connecting`, and `onStatusChange` tells when it changes to `open`, `reconnecting` and `closed`. Right after a restart, the router can answer with no routes until it has loaded the pools.

A route request or an outcome request that the router answers with an error is sent again after the same delays, and an outcome is asked for until `outcomeTimeoutMs` (3 minutes by default), when it fails with the router's last error. When the router says the request is wrong, with an error status of 4xx other than 429, the outcome fails at once, and the subscription ends, with `onError` telling why. `swapWithNearConnect` asks `/route/outcome` again the same way, after its own `retryDelayMs` and until its own `outcomeTimeoutMs`. Either way, `onSwapSent` gets the hashes of the swap's transactions first, which tell what the swap did when the router doesn't. When a signer fails on one of them, `swapWithSigner` throws `SwapInterruptedError`, with the hashes of the ones that executed before it in `txHashes`.

Node's own `WebSocket` (Node 22) errors without closing when it can't connect, which the connection treats as a lost connection too.

## Development

```bash
npm install
npm run check
npm run lint
npm test
npm run build
```

Node runs the source as it is, stripping its types (`node src/index.ts`), so `tsconfig.json` only allows TypeScript that can be stripped, and imports name the `.ts` files, which the build makes `.js`.
