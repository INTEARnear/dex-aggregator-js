import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { RouterConnection, type ConnectionStatus, type QuoteUpdate } from "../src/connection.js";
import type { Quote, SwapOutcome } from "../src/types.js";
import { quoteOf, tamper, withFeesInNextSteps } from "./helpers.js";
import { REQUESTS } from "./requests.js";

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

/** Answers route requests with `routes`, and outcome requests unless `answerOutcomes` is off */
class MockRouter {
  readonly server: WebSocketServer;
  readonly received: ClientMessage[] = [];
  answerOutcomes = true;

  constructor(port: number, readonly routes: Quote[]) {
    this.server = new WebSocketServer({ port });
    this.server.on("connection", (socket: WebSocket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(String(data)) as ClientMessage;
        this.received.push(message);
        if (message.outcome !== undefined) {
          if (this.answerOutcomes) {
            socket.send(JSON.stringify({ id: message.id, outcome: OUTCOME }));
          }
        } else if (message.query !== undefined) {
          socket.send(JSON.stringify({ id: message.id, routes: this.routes }));
        }
      });
    });
  }

  static async start(port: number, routes: Quote[]): Promise<MockRouter> {
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
