import { routeQuery } from "./request.js";
import type { Quote, SwapOutcome, SwapRequest } from "./types.js";
import { UnsafeTransactionsError, validateQuote } from "./validate.js";

export const ROUTER_SUBSCRIBE_URL = "wss://router.intear.tech/route/subscribe";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

/** What the connection needs of a WebSocket: the browser's, Node's, or `ws` */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface RouterConnectionOptions {
  url?: string;
  /** The global `WebSocket` if not given */
  WebSocket?: new (url: string) => WebSocketLike;
  /** Waits twice as long after each attempt that fails, from `min` up to `max` */
  reconnectDelayMs?: { min: number; max: number };
  /** Gives up on an attempt to connect after this long, and tries again */
  connectTimeoutMs?: number;
  onStatusChange?: (status: ConnectionStatus) => void;
}

export interface QuoteUpdate {
  /** Safe to sign, best first */
  quotes: Quote[];
  /** Left out, and why */
  rejected: { quote: Quote; error: UnsafeTransactionsError }[];
}

export interface SubscribeOptions {
  /**
   * Leaves the fee transactions out of the quotes and gives each an ID, whose outcome has them in
   * its next steps, with the quote improvement fee. For signers that sign without asking, see
   * `swapWithSigner`.
   */
  feesInNextSteps: boolean;
  onQuotes: (update: QuoteUpdate) => void;
  onError?: (error: Error) => void;
}

interface PendingOutcome {
  message: string;
  resolve: (outcome: SwapOutcome) => void;
  reject: (error: Error) => void;
}

interface Subscription {
  id: number;
  message: string;
  request: SwapRequest;
  options: SubscribeOptions;
}

const OPEN = 1;

/**
 * A connection to the router's `/route/subscribe` that comes back by itself: once it's
 * reconnected, the route request goes on, and the outcomes asked for are asked again, as the
 * router stores quotes by their ID
 */
export class RouterConnection {
  readonly #url: string;
  readonly #WebSocket: new (url: string) => WebSocketLike;
  readonly #reconnectDelayMs: { min: number; max: number };
  readonly #onStatusChange: ((status: ConnectionStatus) => void) | undefined;
  readonly #connectTimeoutMs: number;
  #socket: WebSocketLike | null = null;
  #status: ConnectionStatus = "connecting";
  #nextId = 1;
  #subscription: Subscription | null = null;
  readonly #outcomes = new Map<number, PendingOutcome>();
  #failedAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RouterConnectionOptions = {}) {
    this.#url = options.url ?? ROUTER_SUBSCRIBE_URL;
    this.#WebSocket =
      options.WebSocket ?? (globalThis.WebSocket as unknown as new (url: string) => WebSocketLike);
    this.#reconnectDelayMs = options.reconnectDelayMs ?? { min: 250, max: 10_000 };
    this.#onStatusChange = options.onStatusChange;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.#connect();
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  /**
   * Routes the request, again whenever the pools change, replacing the previous route request.
   * Quotes whose transactions aren't safe to sign are left out. Returns what stops it.
   */
  subscribe(request: SwapRequest, options: SubscribeOptions): () => void {
    const id = this.#nextId++;
    const message = JSON.stringify({
      id,
      query: routeQuery(request),
      fees_in_next_steps: options.feesInNextSteps,
    });
    this.#subscription = { id, message, request, options };
    this.#send(message);
    return () => {
      if (this.#subscription?.id === id) {
        this.#subscription = null;
        this.#send(JSON.stringify({ id: this.#nextId++ }));
      }
    };
  }

  /** Of a quote with an ID, once its transactions executed, or only its swap with `"swap"` */
  outcome(
    quoteId: number,
    txHashes: string[],
    waitUntil: "executed" | "swap" = "executed",
  ): Promise<SwapOutcome> {
    if (this.#status === "closed") {
      return Promise.reject(new Error("The connection to the router is closed"));
    }
    const id = this.#nextId++;
    const message = JSON.stringify({
      id,
      outcome: { quote_id: quoteId, tx_hashes: txHashes, wait_until: waitUntil },
    });
    return new Promise((resolve, reject) => {
      this.#outcomes.set(id, { message, resolve, reject });
      this.#send(message);
    });
  }

  close(): void {
    this.#setStatus("closed");
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#socket?.close();
    this.#socket = null;
    for (const pending of this.#outcomes.values()) {
      pending.reject(new Error("The connection to the router is closed"));
    }
    this.#outcomes.clear();
  }

  /** Sent once the connection is open, if it isn't */
  #send(message: string): void {
    if (this.#socket?.readyState === OPEN) {
      this.#socket.send(message);
    }
  }

  #connect(): void {
    const socket = new this.#WebSocket(this.#url);
    this.#socket = socket;
    const lost = () => {
      clearTimeout(connectTimeout);
      if (this.#socket !== socket || this.#status === "closed") {
        return;
      }
      this.#socket = null;
      socket.close();
      this.#reconnect();
    };
    const connectTimeout = setTimeout(lost, this.#connectTimeoutMs);
    socket.onopen = () => {
      clearTimeout(connectTimeout);
      this.#failedAttempts = 0;
      this.#setStatus("open");
      if (this.#subscription !== null) {
        socket.send(this.#subscription.message);
      }
      for (const pending of this.#outcomes.values()) {
        socket.send(pending.message);
      }
    };
    socket.onmessage = (event) => this.#receive(String(event.data));
    // Node's WebSocket only errors when it can't connect, without closing
    socket.onerror = lost;
    socket.onclose = lost;
  }

  #reconnect(): void {
    this.#setStatus("reconnecting");
    const delay = Math.min(
      this.#reconnectDelayMs.max,
      this.#reconnectDelayMs.min * 2 ** this.#failedAttempts,
    );
    this.#failedAttempts += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  #receive(data: string): void {
    const message = JSON.parse(data) as {
      id: number;
      routes?: Quote[];
      outcome?: SwapOutcome;
      error?: string;
    };
    const pending = this.#outcomes.get(message.id);
    if (pending !== undefined) {
      this.#outcomes.delete(message.id);
      if (message.outcome !== undefined) {
        pending.resolve(message.outcome);
      } else {
        pending.reject(new Error(message.error ?? "The router answered without an outcome"));
      }
      return;
    }
    const subscription = this.#subscription;
    // Of an earlier route request
    if (subscription?.id !== message.id) {
      return;
    }
    if (message.routes !== undefined) {
      subscription.options.onQuotes(checkQuotes(subscription.request, message.routes));
    } else {
      subscription.options.onError?.(new Error(message.error ?? "The router answered without routes"));
    }
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.#status !== status) {
      this.#status = status;
      this.#onStatusChange?.(status);
    }
  }
}

function checkQuotes(request: SwapRequest, quotes: Quote[]): QuoteUpdate {
  const update: QuoteUpdate = { quotes: [], rejected: [] };
  for (const quote of quotes) {
    try {
      validateQuote(request, quote);
      update.quotes.push(quote);
    } catch (error) {
      if (!(error instanceof UnsafeTransactionsError)) {
        throw error;
      }
      update.rejected.push({ quote, error });
    }
  }
  return update;
}
