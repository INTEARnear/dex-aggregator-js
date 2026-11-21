# @intear/dex-aggregator

> [!WARNING]
> 
> this library is 100% vibecoded, i haven't fully reviewed it yet, and idk if ever will. this is sort of a reference implementation, used on dex.intea.rs so it at least works in one actively maintained app and will not get abandoned.

Client of the Intear DEX Aggregator (router.intear.tech) that checks the router's transactions before anyone signs them, for both ways of paying fees:

- **near-connect** (`swapWithNearConnect`): wallets that ask the trader. The quote's transactions are approved at once, then, after the swap, its fee transactions (only if the swap went through) and the next steps of its outcome, which move tokens where the trader asked for them.
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
const connection = new RouterConnection();
const stop = connection.subscribe(request, {
  feesInNextSteps: true,
  onQuotes: async ({ quotes, rejected }) => {
    // `rejected` has the quotes whose transactions aren't safe to sign, and why
    const [best] = quotes;
    if (best !== undefined) {
      stop();
      const { outcome } = await swapWithSigner({ signer, connection, request, quote: best });
    }
  },
});
```

A signer is `{ signAndSendTransaction(transaction): Promise<txHash> }`. `transaction` has the shape near-connect takes, so with near-api-js it's `account.signAndSendTransaction({ receiverId, actions: actions.map(...) })` with `actions.functionCall(methodName, args, BigInt(gas), BigInt(deposit))`.

## What's checked

`validateQuote` (on every quote of a subscription, and before swapping) and `validateNextSteps` (before the next steps are signed) only accept the calls the router makes, with exactly the arguments it passes, and check that:

- the transactions spend at most the exact input, or the quote's worst case of an exact-out swap, counting fees, and wrap at most that much NEAR
- the swaps give at least the quote's worst case, which is within the requested slippage of its estimate
- they only call the swap's tokens, wNEAR, Rhea, Rhea DCL and Intear DEX, and only send the trader's tokens to those DEXes and to the requested fee receivers
- Intear DEX's operations only swap the input for the output, withdraw to the trader, and take the requested referral fees and a quote improvement fee for the requested receiver of no more than the quote's estimate beats
- storage deposits attach no more than the quote's `storage_deposits`, for the trader, the DEXes and the fee receivers
- next steps don't swap, only pay fees after a swap that went through, no more than the quote's `fee_amount`, and pay the quote improvement fee that the outcome's amounts and the quote's estimate add up to

A check that fails throws `UnsafeTransactionsError`, with every problem in `problems`.

## Reconnecting

`RouterConnection` reconnects whenever its connection is lost, waiting twice as long after each failed attempt (250 ms to 10 s by default), and gives up on an attempt after `connectTimeoutMs`. Once it's back, it sends the route request again, and every outcome request that wasn't answered, which the router answers from the quotes it stored by their ID, also after a restart. `onStatusChange` tells `connecting`, `open`, `reconnecting` and `closed`. Right after a restart, the router can answer with no routes until it has loaded the pools.

Node's own `WebSocket` (Node 22) errors without closing when it can't connect, which the connection treats as a lost connection too.

## Development

```bash
npm install
npm test
npm run build
```
