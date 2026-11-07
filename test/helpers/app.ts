import type { INestApplication } from "@nestjs/common";
import { type Container, createApp } from "../../src/app";
import { type AppConfig, loadConfig } from "../../src/infrastructure/config";
import { Failpoints } from "../../src/infrastructure/failpoints";
import type { Clock, EventBus } from "../../src/application/ports";
import type { TestDb } from "./test-db";

/** Clock the test can move forward; everything that decides time-based rules reads from it. */
export class TestClock implements Clock {
  constructor(private current = new Date()) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(d: Date): void {
    this.current = new Date(d.getTime());
  }
}

export interface RunningApp {
  app: INestApplication;
  container: Container;
  baseUrl: string;
  config: AppConfig;
  failpoints: Failpoints;
  close(): Promise<void>;
}

export interface StartOptions {
  env?: Record<string, string>;
  clock?: Clock;
  wrapEventBus?: (bus: EventBus) => EventBus;
}

/** Boots the real Nest app in-process against the test database (background roles off unless asked). */
export async function startApp(db: TestDb, opts: StartOptions = {}): Promise<RunningApp> {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: db.appUrl,
    ENABLE_SQS_CONSUMER: "false",
    ENABLE_OUTBOX_PUBLISHER: "false",
    ENABLE_PENDING_WORKER: "false",
    LOG_LEVEL: "silent",
    ...opts.env,
  });
  const failpoints = new Failpoints("", { allowInProduction: false });
  const { app, container } = await createApp(config, { clock: opts.clock, failpoints, wrapEventBus: opts.wrapEventBus });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as { port: number };
  return {
    app,
    container,
    config,
    failpoints,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await app.close();
    },
  };
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  // biome-ignore lint: test helper
  body: any;
}

export async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // keep raw text
  }
  return { status: res.status, headers: res.headers, body: parsed };
}

/** Creates a wallet over HTTP and returns its id. */
export async function createWallet(baseUrl: string, amount: string, playerId = crypto.randomUUID()): Promise<string> {
  const r = await call(baseUrl, "POST", "/wallets", { playerId, initialBalance: { amount, currency: "BRL" } });
  if (r.status !== 201) throw new Error(`wallet creation failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as string;
}

export interface WagerInput {
  walletId: string;
  playerId: string;
  kind?: string;
  amount?: string;
  currency?: string;
  externalTransactionId?: string;
  referenceExternalTransactionId?: string;
  roundId?: string;
  providerId?: string;
  idempotencyKey?: string;
}

export function wagerBody(w: WagerInput) {
  const ext = w.externalTransactionId ?? `tx-${crypto.randomUUID()}`;
  const providerId = w.providerId ?? "provider-a";
  return {
    key: w.idempotencyKey ?? `${providerId}:${ext}`,
    body: {
      providerId,
      externalTransactionId: ext,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: w.roundId ?? "round-1",
      gameId: "fortune-chimp",
      kind: w.kind ?? "BET",
      money: { amount: w.amount ?? "10.00", currency: w.currency ?? "BRL" },
      ...(w.referenceExternalTransactionId ? { referenceExternalTransactionId: w.referenceExternalTransactionId } : {}),
    },
  };
}

export async function postWager(baseUrl: string, w: WagerInput): Promise<ApiResponse> {
  const { key, body } = wagerBody(w);
  return call(baseUrl, "POST", "/wagering/transactions", body, { "Idempotency-Key": key });
}

/** All callers await the same gate, so their requests leave together. */
export function gate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
}
