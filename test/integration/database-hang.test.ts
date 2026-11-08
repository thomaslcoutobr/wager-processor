import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Socket } from "bun";
import { call, createWallet, postWager, type RunningApp, startApp } from "../helpers/app";
import { createTestDb, type TestDb } from "../helpers/test-db";

// Lb-06: a database that hangs without closing the connection (paused, or behind a network that drops
// packets) used to leave HTTP requests waiting forever, with no 503. The pool now has a connect/acquire
// timeout and every query a client-side read timeout, both classified as DATABASE_UNAVAILABLE.

/** TCP proxy between the app and Postgres. In black-hole mode it swallows bytes and keeps the sockets open. */
function blackHoleProxy(target: URL) {
  let blackHole = false;
  const upstreams = new Set<Socket<unknown>>();
  const server = Bun.listen<{ upstream?: Socket<unknown>; early: Uint8Array[] }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      async open(client) {
        client.data = { early: [] };
        const upstream = await Bun.connect({
          hostname: target.hostname,
          port: Number(target.port || 5432),
          socket: {
            data(_s, chunk) {
              if (!blackHole) client.write(chunk);
            },
            close() {
              client.end();
            },
            error() {
              client.end();
            },
          },
        });
        upstreams.add(upstream);
        client.data.upstream = upstream;
        for (const c of client.data.early) upstream.write(c);
      },
      data(client, chunk) {
        if (blackHole) return;
        if (client.data.upstream) client.data.upstream.write(chunk);
        else client.data.early.push(new Uint8Array(chunk));
      },
      close(client) {
        client.data.upstream?.end();
      },
    },
  });
  return {
    url(original: URL): string {
      const u = new URL(original.toString());
      u.hostname = "127.0.0.1";
      u.port = String(server.port);
      return u.toString();
    },
    setBlackHole(on: boolean) {
      blackHole = on;
    },
    stop() {
      for (const u of upstreams) u.end();
      server.stop(true);
    },
  };
}

let db: TestDb;
let proxy: ReturnType<typeof blackHoleProxy>;
let running: RunningApp;

beforeAll(async () => {
  db = await createTestDb("dbhang");
  proxy = blackHoleProxy(new URL(db.appUrl));
  running = await startApp(db, {
    env: { DATABASE_URL: proxy.url(new URL(db.appUrl)), DB_CONNECT_TIMEOUT_MS: "2000", DB_QUERY_TIMEOUT_MS: "3000", LOCK_TIMEOUT_MS: "1000" },
  });
});
afterAll(async () => {
  proxy?.setBlackHole(false);
  proxy?.stop(); // the swallowed bytes broke those connections: closing them lets the pool drop them
  await running?.close().catch(() => {});
  await db?.drop();
});

describe("Postgres hanging without closing the connection", () => {
  it("a POST answers 503 SERVICE_UNAVAILABLE within the query timeout instead of hanging", async () => {
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(running.baseUrl, "100.00", playerId);
    expect((await call(running.baseUrl, "GET", `/wallets/${walletId}`)).status).toBe(200);

    proxy.setBlackHole(true);
    const started = Date.now();
    const r = await Promise.race([
      postWager(running.baseUrl, { walletId, playerId, amount: "10.00" }),
      new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => setTimeout(() => resolve({ status: 0, body: {} }), 20_000)),
    ]);
    expect(r.status).toBe(503);
    expect(r.body.retry).toBe("SAME_REQUEST");
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 60_000);
});
