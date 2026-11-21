import type { SwapRequest, TokenId } from "./types.js";

export const WRAP_NEAR = "wrap.near";

/** The query string of `/route`, and of a route request on `/route/subscribe` */
export function routeQuery(request: SwapRequest): string {
  const params = new URLSearchParams({
    token_in: request.tokenIn,
    token_out: request.tokenOut,
  });
  if ("exactIn" in request.amount) {
    params.set("amount_in", request.amount.exactIn.toString());
  } else {
    params.set("amount_out", request.amount.exactOut.toString());
  }
  if (request.slippage.type === "fixed") {
    params.set("slippage_type", "Fixed");
    params.set("slippage", request.slippage.slippage.toString());
  } else {
    params.set("slippage_type", "Auto");
    params.set("min_slippage", request.slippage.minSlippage.toString());
    params.set("max_slippage", request.slippage.maxSlippage.toString());
  }
  if (request.traderAccountId !== undefined) {
    params.set("trader_account_id", request.traderAccountId);
  }
  if (request.signingPublicKey !== undefined) {
    params.set("signing_public_key", request.signingPublicKey);
  }
  if (request.dexes !== undefined) {
    params.set("dexes", request.dexes.join(","));
  }
  if (request.referrerId !== undefined) {
    params.set("referrer_id", request.referrerId);
  }
  if (request.fees !== undefined) {
    params.set("fees", JSON.stringify(request.fees));
  }
  if (request.quoteImprovementReceiver !== undefined) {
    params.set("quote_improvement_receiver", request.quoteImprovementReceiver);
  }
  return params.toString();
}

/** Where a token is held, and the NEP-141 it is: wNEAR for NEAR */
export interface Token {
  place: "wallet" | "rhea" | "intear";
  contract: string;
}

export function parseToken(token: TokenId): Token {
  if (token === "near") {
    return { place: "wallet", contract: WRAP_NEAR };
  }
  if (token.startsWith("rhea-nep141:")) {
    return { place: "rhea", contract: token.slice("rhea-nep141:".length) };
  }
  if (token === "intear-dex:near") {
    return { place: "intear", contract: WRAP_NEAR };
  }
  if (token.startsWith("intear-dex:nep141:")) {
    return { place: "intear", contract: token.slice("intear-dex:nep141:".length) };
  }
  if (token.startsWith("intear-dex:")) {
    throw new Error(`Intear DEX only has NEAR and NEP-141s, not ${token}`);
  }
  return {
    place: "wallet",
    contract: token.startsWith("nep141:") ? token.slice("nep141:".length) : token,
  };
}

/** The asset IDs Intear DEX has the token as: NEAR is both native NEAR and wNEAR */
export function intearAssets(token: Token): string[] {
  return token.contract === WRAP_NEAR
    ? ["near", `nep141:${WRAP_NEAR}`]
    : [`nep141:${token.contract}`];
}
