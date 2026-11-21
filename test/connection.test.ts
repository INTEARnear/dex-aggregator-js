import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { RouterConnection, type ConnectionStatus, type QuoteUpdate } from "../src/connection.ts";
import type { SwapOutcome } from "../src/types.ts";
import { quoteOf, tamper, withFeesInNextSteps } from "./helpers.ts";
import { REQUESTS } from "./requests.ts";

const REQUEST = REQUESTS["near_to_usdc_exact_in"]!;
const QUOTE = withFeesInNextSteps(quoteOf("near_to_usdc_exact_in", "RheaDcl"));
const OUTCOME: SwapOutcome = {
  charge_fee: true,
  amount_in: "995000000000000000000000",
  amount_out: "2846353",
  balance_changes: [],
  next_steps: [],
  error: null,
  settled: true,
};

interface ClientMessage {
  id: number;
  query?: string;
  fees_in_next_steps?: boolean;
  outcome?: { quote_id: number; tx_hashes: string[] };
}

/**
 * Answers route requests with `routes`, and outcome requests unless `answerOutcomes` is off, with
 * `routeError` the first `failedRoutes` times, and `outcomeError` the first `failedOutcomes` times
 */
class MockRouter {
  readonly server: WebSocketServer;
  readonly received: ClientMessage[] = [];
  answerOutcomes = true;
  failedRoutes = 0;
  routeError = { error: "Rate limit exceeded", status: 429 };
  failedOutcomes = 0;
  outcomeError = { error: "Rate limit exceeded", status: 429 };
  readonly routes: unknown[];

  constructor(port: number, routes: unknown[]) {
    this.routes = routes;
    this.server = new WebSocketServer({ port });
    this.server.on("connection", (socket: WebSocket) => {
      socket.on("message", (data) => {
        // Text frames arrive as a Buffer
        const message = JSON.parse((data as Buffer).toString()) as ClientMessage;
        this.received.push(message);
        if (message.outcome !== undefined) {
          if (this.failedOutcomes > 0) {
            this.failedOutcomes -= 1;
            socket.send(JSON.stringify({ id: message.id, ...this.outcomeError }));
          } else if (this.answerOutcomes) {
            socket.send(JSON.stringify({ id: message.id, outcome: OUTCOME }));
          }
        } else if (message.query !== undefined) {
          if (this.failedRoutes > 0) {
            this.failedRoutes -= 1;
            socket.send(JSON.stringify({ id: message.id, ...this.routeError }));
          } else {
            socket.send(JSON.stringify({ id: message.id, routes: this.routes }));
          }
        }
      });
    });
  }

  get outcomeRequests(): ClientMessage[] {
    return this.received.filter((message) => message.outcome !== undefined);
  }

  get routeRequests(): ClientMessage[] {
    return this.received.filter((message) => message.query !== undefined);
  }

  static async start(port: number, routes: unknown[]): Promise<MockRouter> {
    const router = new MockRouter(port, routes);
    await new Promise((resolve) => router.server.once("listening", resolve));
    return router;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  /** Like the process going down: the connections drop without a close handshake */
  async kill(): Promise<void> {
    for (const client of this.server.clients) {
      client.terminate();
    }
    await new Promise((resolve) => this.server.close(resolve));
  }
}

function nextUpdate(updates: QuoteUpdate[]): Promise<QuoteUpdate> {
  const count = updates.length;
  return waitFor(() => updates[count]);
}

async function waitFor<T>(value: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = value();
    if (current !== undefined) {
      return current;
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("RouterConnection", () => {
  let routers: MockRouter[] = [];
  let connection: RouterConnection | undefined;

  afterEach(async () => {
    connection?.close();
    await Promise.all(routers.map((router) => router.kill().catch(() => {})));
    routers = [];
  });

  test("leaves out quotes whose transactions aren't safe to sign", async () => {
    const tampered = tamper(QUOTE, 0, 1, (args) => {
      args["amount"] = "1995000000000000000000000";
    });
    const router = await MockRouter.start(0, [QUOTE, tampered]);
    routers.push(router);
    connection = new RouterConnection({ url: `ws://localhost:${router.port}` });
    const updates: QuoteUpdate[] = [];
    connection.subscribe(REQUEST, { feesInNextSteps: true, onQuotes: (update) => updates.push(update) });

    const update = await nextUpdate(updates);
    expect(update.quotes).toEqual([QUOTE]);
    expect(update.rejected.map(({ quote }) => quote)).toEqual([tampered]);
    expect(router.received[0]).toMatchObject({ id: 1, fees_in_next_steps: true });
  });

  test("goes on routing and asks for outcomes again after the router restarts", async () => {
    const first = await MockRouter.start(0, [QUOTE]);
    routers.push(first);
    const port = first.port;
    const statuses: ConnectionStatus[] = [];
    connection = new RouterConnection({
      url: `ws://localhost:${port}`,
      reconnectDelayMs: { min: 10, max: 50 },
      onStatusChange: (status) => statuses.push(status),
    });
    const updates: QuoteUpdate[] = [];
    connection.subscribe(REQUEST, { feesInNextSteps: true, onQuotes: (update) => updates.push(update) });
    await nextUpdate(updates);

    // The router goes down while it waits for the transactions
    first.answerOutcomes = false;
    const outcome = connection.outcome(QUOTE.quote_id!, ["7xEDD8Bdu9arQn7dDghTDMzhvuwmiKsRFJovq8LyfVQw"]);
    await waitFor(() => first.received.find((message) => message.outcome !== undefined));
    await first.kill();
    await waitFor(() => (statuses.at(-1) === "reconnecting" ? true : undefined));

    // Its connection attempts fail while it's down
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connection.status).toBe("reconnecting");

    const second = await MockRouter.start(port, [QUOTE]);
    routers.push(second);
    const update = await nextUpdate(updates);
    expect(update.quotes).toEqual([QUOTE]);
    await expect(outcome).resolves.toEqual(OUTCOME);
    expect(connection.status).toBe("open");
    // The same route request and outcome request, by their IDs
    expect(second.received).toEqual([
      first.received[0],
      first.received.find((message) => message.outcome !== undefined),
    ]);
  });

  test("connects with ws's WebSocket", async () => {
    const router = await MockRouter.start(0, [QUOTE]);
    routers.push(router);
    connection = new RouterConnection({ url: `ws://localhost:${router.port}`, WebSocket });
    const updates: QuoteUpdate[] = [];
    connection.subscribe(REQUEST, { feesInNextSteps: true, onQuotes: (update) => updates.push(update) });
    expect((await nextUpdate(updates)).quotes).toEqual([QUOTE]);
  });

  test("ignores the routes of a route request it replaced", async () => {
    const router = await MockRouter.start(0, [QUOTE]);
    routers.push(router);
    connection = new RouterConnection({ url: `ws://localhost:${router.port}` });
    const first: QuoteUpdate[] = [];
    const second: QuoteUpdate[] = [];
    connection.subscribe(REQUEST, { feesInNextSteps: true, onQuotes: (update) => first.push(update) });
    connection.subscribe(REQUEST, { feesInNextSteps: true, onQuotes: (update) => second.push(update) });
    await nextUpdate(second);
    expect(first).toEqual([]);
  });

  test("rejects quotes that aren't shaped like the router's, and keeps the others", async () => {
    const { storage_deposits: _, ...malformed } = QUOTE;
    const router = await MockRouter.start(0, [QUOTE, malformed]);
    routers.push(router);
    connection = new RouterConnection({ url: `ws://localhost:${router.port}` });
    const updates: QuoteUpdate[] = [];
    connection.subscribe(REQUEST, { feesInNextSteps: true, onQuotes: (update) => updates.push(update) });

    const update = await nextUpdate(updates);
    expect(update.quotes).toEqual([QUOTE]);
    expect(update.rejected.map(({ error }) => error.problems)).toEqual([
      ["The quote isn't shaped like the router's quotes: storage_deposits isn't an amount"],
    ]);
  });

  test("reports what the router sends that isn't a message", async () => {
    const router = await MockRouter.start(0, []);
    routers.push(router);
    router.server.on("connection", (socket: WebSocket) => socket.send("Bad gateway"));
    connection = new RouterConnection({ url: `ws://localhost:${router.port}` });
    const errors: Error[] = [];
    connection.subscribe(REQUEST, { feesInNextSteps: true, onQuotes: () => {}, onError: (error) => errors.push(error) });
    const error = await waitFor(() => errors[0]);
    expect(error.message).toBe("The router sent something else than a message: Bad gateway");
  });

  test("asks for an outcome again after the router's errors", async () => {
    const router = await MockRouter.start(0, []);
    routers.push(router);
    router.failedOutcomes = 2;
    connection = new RouterConnection({ url: `ws://localhost:${router.port}`, reconnectDelayMs: { min: 10, max: 50 } });
    await expect(connection.outcome(QUOTE.quote_id!, ["7xEDD8Bdu9arQn7dDghTDMzhvuwmiKsRFJovq8LyfVQw"])).resolves.toEqual(
      OUTCOME,
    );
    expect(router.outcomeRequests).toHaveLength(3);
    expect(new Set(router.outcomeRequests.map((message) => JSON.stringify(message))).size).toBe(1);
  });

  test("gives up on an outcome after its timeout, with the router's last error", async () => {
    const router = await MockRouter.start(0, []);
    routers.push(router);
    router.failedOutcomes = Infinity;
    connection = new RouterConnection({
      url: `ws://localhost:${router.port}`,
      reconnectDelayMs: { min: 10, max: 20 },
      outcomeTimeoutMs: 200,
    });
    await expect(connection.outcome(1, ["7xEDD8Bdu9arQn7dDghTDMzhvuwmiKsRFJovq8LyfVQw"])).rejects.toThrow(
      "The router didn't tell the outcome in 200 ms: Rate limit exceeded",
    );
    // Once the last request on its way arrived, it's not asked again
    await new Promise((resolve) => setTimeout(resolve, 50));
    const asked = router.outcomeRequests.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(router.outcomeRequests).toHaveLength(asked);
  });

  test("fails an outcome at once when the router says the request is wrong", async () => {
    const router = await MockRouter.start(0, []);
    routers.push(router);
    router.failedOutcomes = Infinity;
    router.outcomeError = { error: "Quote 1 doesn't exist", status: 404 };
    connection = new RouterConnection({ url: `ws://localhost:${router.port}`, reconnectDelayMs: { min: 10, max: 20 } });
    await expect(connection.outcome(1, ["7xEDD8Bdu9arQn7dDghTDMzhvuwmiKsRFJovq8LyfVQw"])).rejects.toThrow(
      "The router can't tell the outcome: Quote 1 doesn't exist",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.outcomeRequests).toHaveLength(1);
  });

  test("asks for the routes again after the router's errors", async () => {
    const router = await MockRouter.start(0, [QUOTE]);
    routers.push(router);
    router.failedRoutes = 2;
    connection = new RouterConnection({ url: `ws://localhost:${router.port}`, reconnectDelayMs: { min: 10, max: 50 } });
    const updates: QuoteUpdate[] = [];
    const errors: Error[] = [];
    connection.subscribe(REQUEST, {
      feesInNextSteps: true,
      onQuotes: (update) => updates.push(update),
      onError: (error) => errors.push(error),
    });
    const update = await nextUpdate(updates);
    expect(update.quotes).toEqual([QUOTE]);
    expect(errors.map((error) => error.message)).toEqual(["Rate limit exceeded", "Rate limit exceeded"]);
    expect(router.routeRequests).toHaveLength(3);
    expect(new Set(router.routeRequests.map((message) => JSON.stringify(message))).size).toBe(1);
  });

  test("ends the subscription when the router says the request is wrong", async () => {
    const router = await MockRouter.start(0, [QUOTE]);
    routers.push(router);
    router.failedRoutes = Infinity;
    router.routeError = { error: "Slippage must be between 0.00 and 1.00", status: 400 };
    connection = new RouterConnection({ url: `ws://localhost:${router.port}`, reconnectDelayMs: { min: 10, max: 20 } });
    const errors: Error[] = [];
    connection.subscribe(REQUEST, { feesInNextSteps: true, onQuotes: () => {}, onError: (error) => errors.push(error) });
    const error = await waitFor(() => errors[0]);
    expect(error.message).toBe("Slippage must be between 0.00 and 1.00");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.routeRequests).toHaveLength(1);
  });

  test("subscribing to a token that the router doesn't name throws", async () => {
    const router = await MockRouter.start(0, []);
    routers.push(router);
    connection = new RouterConnection({ url: `ws://localhost:${router.port}` });
    expect(() =>
      connection!.subscribe({ ...REQUEST, tokenOut: "intear-dex:usdc" }, { feesInNextSteps: true, onQuotes: () => {} }),
    ).toThrow("Intear DEX only has NEAR and NEP-141s, not intear-dex:usdc");
  });

  test("gives up on an outcome the router doesn't answer", async () => {
    const router = await MockRouter.start(0, []);
    routers.push(router);
    router.answerOutcomes = false;
    connection = new RouterConnection({ url: `ws://localhost:${router.port}`, outcomeTimeoutMs: 100 });
    await expect(connection.outcome(1, ["7xEDD8Bdu9arQn7dDghTDMzhvuwmiKsRFJovq8LyfVQw"])).rejects.toThrow(
      "The router didn't tell the outcome in 100 ms",
    );
  });

  test("subscribing once it's closed throws", async () => {
    const router = await MockRouter.start(0, []);
    routers.push(router);
    connection = new RouterConnection({ url: `ws://localhost:${router.port}` });
    connection.close();
    expect(() => connection!.subscribe(REQUEST, { feesInNextSteps: true, onQuotes: () => {} })).toThrow(
      "The connection to the router is closed",
    );
  });

  test("closing fails the outcomes it waits for", async () => {
    const router = await MockRouter.start(0, []);
    routers.push(router);
    router.answerOutcomes = false;
    connection = new RouterConnection({ url: `ws://localhost:${router.port}` });
    const outcome = connection.outcome(1, ["7xEDD8Bdu9arQn7dDghTDMzhvuwmiKsRFJovq8LyfVQw"]);
    connection.close();
    await expect(outcome).rejects.toThrow("The connection to the router is closed");
  });
});
