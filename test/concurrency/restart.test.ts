import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, wagerBody } from "../helpers/app";
import { expectGlobalConsistency, submitUntilFinal } from "../helpers/invariants";
import { waitFor } from "../helpers/locks";
import { spawnApp, type SpawnedApp } from "../helpers/spawn";
import { createTestQueues, queueDepth, requestedEnvelope, sendRaw, type TestQueues } from "../helpers/sqs";
import { createTestDb, type TestDb } from "../helpers/test-db";

let db: TestDb;
let queues: TestQueues;
const alive = new Set<SpawnedApp>();

beforeAll(async () => {
  db = await createTestDb("restart");
  queues = await createTestQueues("restart", { visibilityTimeoutS: 2 });
});
afterAll(async () => {
  for (const a of alive) a.kill("SIGTERM");
  await Promise.all([...alive].map((a) => a.exited));
  await db?.drop();
});

const env = () => ({
  ...queues.env,
  DATABASE_URL: db.appUrl,
  ENABLE_SQS_CONSUMER: "true",
  ENABLE_OUTBOX_PUBLISHER: "true",
  ENABLE_PENDING_WORKER: "true",
  OUTBOX_POLL_MS: "100",
  PENDING_POLL_MS: "100",
});

async function start(): Promise<SpawnedApp> {
  const a = await spawnApp(env());
  alive.add(a);
  void a.exited.then(() => alive.delete(a));
  return a;
}
const urls = () => [...alive].map((a) => a.baseUrl).filter(Boolean);

describe("restarts in the middle of the traffic (section 13, test 8)", () => {
  it("SIGKILL one instance, SIGTERM another, start a new one: final state is consistent and nothing is lost or doubled", async () => {
    const a = await start();
    const b = await start();
    const wallets = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const playerId = crypto.randomUUID();
        const r = await call(a.baseUrl, "POST", "/wallets", { playerId, initialBalance: { amount: "500.00", currency: "BRL" } });
        return { walletId: r.body.id as string, playerId };
      }),
    );

    // a provider that keeps sending, retrying the SAME request on 5xx or broken connections
    const httpOps: Promise<{ status: number }>[] = [];
    const queued: string[] = [];
    let stop = false;
    const producer = (async () => {
      let n = 0;
      while (!stop) {
        const w = wallets[n % wallets.length]!;
        const kind = n % 4 === 0 ? "WIN" : "BET";
        const req = wagerBody({ ...w, kind, amount: kind === "WIN" ? "2.00" : "5.00" });
        httpOps.push(submitUntilFinal(urls, req.key, req.body));
        if (n % 3 === 0) {
          const q = wagerBody({ ...w, amount: "1.00" });
          queued.push(q.key);
          await sendRaw(queues.urls.main, JSON.stringify(requestedEnvelope({ ...q.body, idempotencyKey: q.key })), w.walletId);
        }
        n++;
        await new Promise((r) => setTimeout(r, 10));
      }
    })();

    await new Promise((r) => setTimeout(r, 1_500));
    a.kill("SIGKILL"); // crash: whatever was in flight is lost before or after its commit
    await new Promise((r) => setTimeout(r, 1_000));
    const c = await start();
    b.kill("SIGTERM"); // graceful: drains and leaves
    const bCode = await b.exited;
    if (bCode !== 0) {
      const notRequests = b.lines.filter((l) => !l.includes('"msg":"request"') && !l.includes('"msg":"processing message"'));
      console.log(`instance B exited ${bCode}; non-request lines:\n${notRequests.slice(-25).join("\n")}`);
    }
    expect(bCode).toBe(0);
    await new Promise((r) => setTimeout(r, 1_500));
    stop = true;
    await producer;
    const results = await Promise.all(httpOps);
    expect(results.every((r) => r.status === 200 || r.status === 422)).toBe(true);

    // the survivor finishes the job left behind
    await waitFor(async () => {
      const d = await queueDepth(queues.urls.main);
      return d.visible === 0 && d.inFlight === 0;
    }, 30_000);
    await waitFor(async () => (await db.app`select count(*)::int as n from outbox_messages where published_at is null`)[0].n === 0, 30_000);

    const ids = wallets.map((w) => w.walletId);
    await expectGlobalConsistency(db.app, ids);
    const [q] = await db.app`select count(*)::int as n from wager_transactions where idempotency_key in ${db.app(queued)}`;
    expect(q.n).toBe(queued.length); // every queued message applied, once
    for (const id of ids) {
      const r = await call(c.baseUrl, "POST", `/wallets/${id}/reconciliation`);
      expect(r.body.consistent).toBe(true);
    }
    expect(httpOps.length).toBeGreaterThan(50);
  });
});
