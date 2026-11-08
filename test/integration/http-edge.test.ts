import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { HealthChecks } from "../../src/interfaces/http/health.controller";
import { call, type RunningApp, startApp } from "../helpers/app";
import { createTestDb, type TestDb } from "../helpers/test-db";

// The HTTP edge: body limit, framework banner and what the open readiness endpoint shows.
let db: TestDb;
let running: RunningApp;

beforeAll(async () => {
  db = await createTestDb("http_edge");
  running = await startApp(db);
});
afterAll(async () => {
  await running?.close();
  await db?.drop();
});

describe("body limit (64 KiB)", () => {
  it("a body above the limit is 413 problem+json, retry AFTER_FIX, and the instance keeps serving", async () => {
    const r = await call(running.baseUrl, "POST", "/wallets", JSON.stringify({ playerId: "x".repeat(70_000) }));
    expect(r.status).toBe(413);
    expect(r.headers.get("content-type")).toContain("application/problem+json");
    expect(r.body).toMatchObject({ code: "VALIDATION_ERROR", retry: "AFTER_FIX" });
    expect((await call(running.baseUrl, "GET", "/health/live")).status).toBe(200);
  });
});

describe("response headers", () => {
  it("do not announce the framework (no X-Powered-By)", async () => {
    const r = await call(running.baseUrl, "GET", "/health/live");
    expect(r.headers.get("x-powered-by")).toBeNull();
  });
});

describe("readiness is open, so it shows no internal detail", () => {
  it("a failed check reads just 'fail'; the error message goes to the log hook", async () => {
    const seen: Array<{ name: string; message: string }> = [];
    const health = new HealthChecks(
      [
        { name: "postgres", check: () => Promise.reject(new Error("connect ECONNREFUSED 10.1.2.3:5432")) },
        { name: "sqs", check: () => Promise.resolve() },
      ],
      1_000,
      (name, error) => seen.push({ name, message: error.message }),
    );
    const r = await health.ready();
    expect(r).toEqual({ ok: false, checks: { postgres: "fail", sqs: "ok" } });
    expect(seen).toEqual([{ name: "postgres", message: "connect ECONNREFUSED 10.1.2.3:5432" }]);
  });

  it("over HTTP, an unreachable SQS gives 503 without the address in the body", async () => {
    const broken = await startApp(db, { env: { SQS_ENDPOINT: "http://127.0.0.1:1" } });
    try {
      const r = await fetch(`${broken.baseUrl}/health/ready`);
      const text = await r.text();
      expect(r.status).toBe(503);
      expect(JSON.parse(text).checks.sqs).toBe("fail");
      expect(text).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
    } finally {
      await broken.close();
    }
  });
});
