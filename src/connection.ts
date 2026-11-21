import { parseToken, routeQuery } from "./request.ts";
import type { Quote, SwapOutcome, SwapRequest } from "./types.ts";
import { UnsafeTransactionsError, validateQuote } from "./validate.ts";

export const ROUTER_SUBSCRIBE_URL = "wss://router.intear.tech/route/subscribe";
export const RETRY_DELAY_MS = { min: 250, max: 10_000 };
/** The router waits up to 80 seconds for a swap's transactions and balances, so it's a few tries */
export const OUTCOME_TIMEOUT_MS = 180_000;

/** Twice as long after each attempt that failed */
export function retryDelay(delayMs: { min: number; max: number }, failedAttempts: number): number {
  return Math.min(delayMs.max, delayMs.min * 2 ** failedAttempts);
}

/** The HTTP status of the router's error says asking again won't help, unlike a rate limit */
export function requestIsWrong(status: unknown): boolean {
  return typeof status === "number" && status >= 400 && status < 500 && status !== 429;
}

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

/**
 * Of an event of a WebSocket. Compared like a method's parameter, so that the handlers of
 * WebSockets whose events have more in them fit.
 */
type EventHandler<Event> = { handle(event: Event): void }["handle"];

/** What the connection needs of a WebSocket: the browser's, Node's, or `ws` */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: EventHandler<unknown> | null;
  onmessage: EventHandler<{ data: unknown }> | null;
  onclose: EventHandler<unknown> | null;
  onerror: EventHandler<unknown> | null;
  send(data: string): void;
  close(): void;
}

export interface RouterConnectionOptions {
  url?: string;
  /** The global `WebSocket` if not given */
  WebSocket?: new (url: string) => WebSocketLike;
  /**
   * Waits twice as long after each attempt to connect, or to get an outcome, that fails, from
   * `min` up to `max`
   */
  reconnectDelayMs?: { min: number; max: number };
  /** Gives up on an attempt to connect after this long, and tries again */
  connectTimeoutMs?: number;
  /** Gives up on an outcome after this long, asking again until then when the router errs */
  outcomeTimeoutMs?: number;
  /** Of the status changing from `connecting`, which it starts as */
  onStatusChange?: (status: ConnectionStatus) => void;
}

export interface QuoteUpdate {
  /** Safe to sign, best first */
  quotes: readonly Quote[];
  /** Left out, and why */
  rejected: readonly { quote: Quote; error: UnsafeTransactionsError }[];
}

export interface SubscribeOptions {
  /**
   * Leaves the fee transactions out of the quotes and gives each an ID, whose outcome has them in
   * its next steps, with the quote improvement fee. For signers that sign without asking, see
   * `swapWithSigner`.
   */
  feesInNextSteps: boolean;
  onQuotes: (update: QuoteUpdate) => void;
  /**
   * Of the router's errors, after which the route request is sent again, unless the router says
   * the request is wrong, which ends the subscription
   */
  onError?: (error: Error) => void;
}

interface PendingOutcome {
  message: string;
  resolve: (outcome: SwapOutcome) => void;
  reject: (error: Error) => void;
  failedAttempts: number;
  /** Of the router's last error, which the outcome is asked for again after */
  lastError: string | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  timeout: ReturnType<typeof setTimeout>;
}

interface Subscription {
  id: number;
  message: string;
  request: SwapRequest;
  options: SubscribeOptions;
  /** Of the route requests that the router answered with an error since its last routes */
  failedAttempts: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

/** What the router sends, before it's checked */
interface RouterMessage {
  id?: unknown;
  routes?: unknown;
  outcome?: unknown;
  error?: unknown;
  /** The HTTP status of the error */
  status?: unknown;
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
  readonly #outcomeTimeoutMs: number;
  #socket: WebSocketLike | null = null;
  #status: ConnectionStatus = "connecting";
  #nextId = 1;
  #subscription: Subscription | null = null;
  readonly #outcomes = new Map<number, PendingOutcome>();
  #failedAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RouterConnectionOptions = {}) {
    this.#url = options.url ?? ROUTER_SUBSCRIBE_URL;
    this.#WebSocket = options.WebSocket ?? globalThis.WebSocket;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? RETRY_DELAY_MS;
    this.#onStatusChange = options.onStatusChange;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.#outcomeTimeoutMs = options.outcomeTimeoutMs ?? OUTCOME_TIMEOUT_MS;
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
    if (this.#status === "closed") {
      throw new Error("The connection to the router is closed");
    }
    // Checking its quotes needs the tokens, so a request for others fails here, not on its quotes
    parseToken(request.tokenIn);
    parseToken(request.tokenOut);
    const id = this.#nextId++;
    const message = JSON.stringify({
      id,
      query: routeQuery(request),
      fees_in_next_steps: options.feesInNextSteps,
    });
    this.#endSubscription();
    this.#subscription = { id, message, request, options, failedAttempts: 0, retryTimer: null };
    this.#send(message);
    return () => {
      if (this.#subscription?.id === id) {
        this.#endSubscription();
        this.#send(JSON.stringify({ id: this.#nextId++ }));
      }
    };
  }

  /**
   * Of a quote with an ID, once its transactions executed, or only its swap with `"swap"`. Asks
   * again after the router's errors, until `outcomeTimeoutMs`.
   */
  outcome(
    quoteId: number,
    txHashes: readonly string[],
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
      const timeout = setTimeout(() => {
        const pending = this.#outcomes.get(id);
        if (pending !== undefined) {
          this.#finishOutcome(id, pending);
          const lastError = pending.lastError === null ? "" : `: ${pending.lastError}`;
          reject(new Error(`The router didn't tell the outcome in ${this.#outcomeTimeoutMs} ms${lastError}`));
        }
      }, this.#outcomeTimeoutMs);
      this.#outcomes.set(id, {
        message,
        resolve,
        reject,
        failedAttempts: 0,
        lastError: null,
        retryTimer: null,
        timeout,
      });
      this.#send(message);
    });
  }

  close(): void {
    this.#setStatus("closed");
    this.#endSubscription();
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#socket?.close();
    this.#socket = null;
    for (const [id, pending] of this.#outcomes) {
      this.#finishOutcome(id, pending);
      pending.reject(new Error("The connection to the router is closed"));
    }
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
      // The others are asked for again once they waited after the router's error
      if (this.#subscription !== null && this.#subscription.retryTimer === null) {
        socket.send(this.#subscription.message);
      }
      for (const pending of this.#outcomes.values()) {
        if (pending.retryTimer === null) {
          socket.send(pending.message);
        }
      }
    };
    socket.onmessage = (event) => this.#receive(String(event.data));
    // Node's WebSocket only errors when it can't connect, without closing
    socket.onerror = lost;
    socket.onclose = lost;
  }

  #reconnect(): void {
    this.#setStatus("reconnecting");
    const delay = retryDelay(this.#reconnectDelayMs, this.#failedAttempts);
    this.#failedAttempts += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  #receive(data: string): void {
    let message: RouterMessage;
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("Isn't an object");
      }
      message = parsed;
    } catch {
      this.#subscription?.options.onError?.(new Error(`The router sent something else than a message: ${data}`));
      return;
    }
    const id = typeof message.id === "number" ? message.id : null;
    const pending = id === null ? undefined : this.#outcomes.get(id);
    const error = typeof message.error === "string" ? message.error : null;
    if (id !== null && pending !== undefined) {
      if (message.outcome !== undefined) {
        this.#finishOutcome(id, pending);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validateNextSteps checks it before anything is signed
        pending.resolve(message.outcome as SwapOutcome);
        return;
      }
      const outcomeError = error ?? "The router answered without an outcome";
      if (requestIsWrong(message.status)) {
        this.#finishOutcome(id, pending);
        pending.reject(new Error(`The router can't tell the outcome: ${outcomeError}`));
        return;
      }
      pending.lastError = outcomeError;
      this.#sendAgainLater(pending);
      return;
    }
    const subscription = this.#subscription;
    // Of an earlier route request
    if (subscription === null || subscription.id !== id) {
      return;
    }
    if (Array.isArray(message.routes)) {
      subscription.failedAttempts = 0;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checkQuotes checks each of them
      subscription.options.onQuotes(checkQuotes(subscription.request, message.routes as Quote[]));
      return;
    }
    // The router stopped routing the request
    if (requestIsWrong(message.status)) {
      this.#endSubscription();
    } else {
      this.#sendAgainLater(subscription);
    }
    subscription.options.onError?.(new Error(error ?? "The router answered without routes"));
  }

  /** Waits twice as long as after the request's previous error */
  #sendAgainLater(request: PendingOutcome | Subscription): void {
    request.retryTimer = setTimeout(() => {
      request.retryTimer = null;
      this.#send(request.message);
    }, retryDelay(this.#reconnectDelayMs, request.failedAttempts));
    request.failedAttempts += 1;
  }

  #endSubscription(): void {
    if (this.#subscription !== null && this.#subscription.retryTimer !== null) {
      clearTimeout(this.#subscription.retryTimer);
    }
    this.#subscription = null;
  }

  #finishOutcome(id: number, pending: PendingOutcome): void {
    this.#outcomes.delete(id);
    clearTimeout(pending.timeout);
    if (pending.retryTimer !== null) {
      clearTimeout(pending.retryTimer);
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
  const safe: Quote[] = [];
  const rejected: { quote: Quote; error: UnsafeTransactionsError }[] = [];
  for (const quote of quotes) {
    try {
      validateQuote(request, quote);
      safe.push(quote);
    } catch (error) {
      if (!(error instanceof UnsafeTransactionsError)) {
        throw error;
      }
      rejected.push({ quote, error });
    }
  }
  return { quotes: safe, rejected };
}
