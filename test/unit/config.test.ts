import { describe, expect, it } from "bun:test";
import { loadConfig } from "../../src/infrastructure/config";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

describe("consumer concurrency", () => {
  it("defaults to 4 loops, within half of the default pool of 10", () => {
    const c = loadConfig(base);
    expect(c.sqs.consumerConcurrency).toBe(4);
    expect(c.dbPoolMax).toBe(10);
  });

  it("accepts up to half of the pool", () => {
    expect(loadConfig({ ...base, DB_POOL_MAX: "10", SQS_CONSUMER_CONCURRENCY: "5" }).sqs.consumerConcurrency).toBe(5);
    expect(loadConfig({ ...base, DB_POOL_MAX: "1", SQS_CONSUMER_CONCURRENCY: "1" }).sqs.consumerConcurrency).toBe(1);
  });

  it("refuses more loops than half of the pool, which would let the consumer starve HTTP", () => {
    expect(() => loadConfig({ ...base, DB_POOL_MAX: "10", SQS_CONSUMER_CONCURRENCY: "6" })).toThrow(/at most half of DB_POOL_MAX/);
    expect(() => loadConfig({ ...base, SQS_CONSUMER_CONCURRENCY: "0" })).toThrow(/SQS_CONSUMER_CONCURRENCY/);
  });
});
