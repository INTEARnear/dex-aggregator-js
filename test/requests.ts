import type { SwapRequest, TraderSwapRequest } from "../src/types.js";

export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ONE_NEAR = 10n ** 24n;

function request(tokenIn: string, tokenOut: string, amount: SwapRequest["amount"]): TraderSwapRequest {
  return {
    tokenIn,
    tokenOut,
    amount,
    slippage: { type: "fixed", slippage: 0.01 },
    traderAccountId: "intear.near",
    referrerId: "wallet.intear.near",
    fees: { "wallet.intear.near": 0.005 },
    quoteImprovementReceiver: "wallet.intear.near",
  };
}

/** What each fixture's quotes were requested with, from router.intear.tech */
export const REQUESTS: Record<string, TraderSwapRequest> = {
  near_to_usdc_exact_in: request("near", USDC, { exactIn: ONE_NEAR }),
  usdc_to_near_exact_in: request(USDC, "near", { exactIn: 3_000_000n }),
  near_to_usdc_exact_out: request("near", USDC, { exactOut: 2_000_000n }),
  usdc_to_near_exact_out: request(USDC, "near", { exactOut: ONE_NEAR }),
  rhea_balances_exact_in: request("rhea-nep141:wrap.near", `rhea-nep141:${USDC}`, { exactIn: ONE_NEAR }),
  intear_balances_exact_in: request("intear-dex:near", `intear-dex:nep141:${USDC}`, { exactIn: ONE_NEAR }),
};
