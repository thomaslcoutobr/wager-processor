/** Typed configuration read once from the environment. Every knob has a safe default for local runs. */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  dbPoolMax: number;
  dbConnectTimeoutMs: number;
  dbQueryTimeoutMs: number;
  lockTimeoutMs: number;
  logLevel: string;
  shutdownGraceMs: number;
  failpoints: string;
  pendingReference: { ttlMs: number; baseDelayMs: number; maxDelayMs: number; pollMs: number; batchSize: number };
  outbox: { pollMs: number; batchSize: number };
  sqs: {
    endpoint: string | undefined;
    region: string;
    queueName: string;
    dlqName: string;
    eventsQueueName: string;
    eventsDlqName: string;
    consumerName: string;
    visibilityTimeoutS: number;
    waitTimeS: number;
    maxReceiveCount: number;
    consumerConcurrency: number;
    retryBaseMs: number;
    retryMaxMs: number;
  };
  enable: { consumer: boolean; outboxPublisher: boolean; pendingWorker: boolean };
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min} (got "${raw}")`);
  return n;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true or false (got "${raw}")`);
}

export function loadConfig(env: Env = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const dbPoolMax = int(env, "DB_POOL_MAX", 10, 1);
  const lockTimeoutMs = int(env, "LOCK_TIMEOUT_MS", 5_000, 1);
  // a lock wait is a query too: the client-side timeout must leave room for lock_timeout to answer first
  const dbQueryTimeoutMs = int(env, "DB_QUERY_TIMEOUT_MS", 15_000, 1);
  if (dbQueryTimeoutMs <= lockTimeoutMs) {
    throw new Error(`DB_QUERY_TIMEOUT_MS must be greater than LOCK_TIMEOUT_MS (${lockTimeoutMs}), got ${dbQueryTimeoutMs}`);
  }
  // each consumer loop can hold a connection while it waits on a wallet lock: at most half of the
  // pool goes to them, the rest stays for HTTP and the two pollers (ARCHITECTURE §12)
  const consumerConcurrency = int(env, "SQS_CONSUMER_CONCURRENCY", 4, 1);
  const maxLoops = Math.max(1, Math.floor(dbPoolMax / 2));
  if (consumerConcurrency > maxLoops) {
    throw new Error(`SQS_CONSUMER_CONCURRENCY must be at most half of DB_POOL_MAX (${maxLoops}), got ${consumerConcurrency}`);
  }
  return {
    nodeEnv: env.NODE_ENV ?? "development",
    port: int(env, "PORT", 3000),
    databaseUrl,
    dbPoolMax,
    dbConnectTimeoutMs: int(env, "DB_CONNECT_TIMEOUT_MS", 5_000, 1),
    dbQueryTimeoutMs,
    lockTimeoutMs,
    logLevel: env.LOG_LEVEL ?? "info",
    shutdownGraceMs: int(env, "SHUTDOWN_GRACE_MS", 8_000),
    failpoints: env.FAILPOINTS ?? "",
    pendingReference: {
      ttlMs: int(env, "PENDING_REFERENCE_TTL_SECONDS", 600, 1) * 1000,
      baseDelayMs: int(env, "PENDING_REFERENCE_BASE_DELAY_MS", 1_000, 1),
      maxDelayMs: int(env, "PENDING_REFERENCE_MAX_DELAY_MS", 60_000, 1),
      pollMs: int(env, "PENDING_POLL_MS", 500, 1),
      batchSize: int(env, "PENDING_BATCH_SIZE", 20, 1),
    },
    outbox: {
      pollMs: int(env, "OUTBOX_POLL_MS", 200, 1),
      batchSize: int(env, "OUTBOX_BATCH_SIZE", 10, 1),
    },
    sqs: {
      endpoint: env.SQS_ENDPOINT || undefined,
      region: env.AWS_REGION ?? "us-east-1",
      queueName: env.SQS_QUEUE_NAME ?? "wager-transactions.fifo",
      dlqName: env.SQS_DLQ_NAME ?? "wager-transactions-dlq.fifo",
      eventsQueueName: env.SQS_EVENTS_QUEUE_NAME ?? "wager-events.fifo",
      eventsDlqName: env.SQS_EVENTS_DLQ_NAME ?? "wager-events-dlq.fifo",
      consumerName: env.SQS_CONSUMER_NAME ?? "wager-transactions-consumer",
      visibilityTimeoutS: int(env, "SQS_VISIBILITY_TIMEOUT_S", 30, 1),
      waitTimeS: int(env, "SQS_WAIT_TIME_S", 20, 0),
      maxReceiveCount: int(env, "SQS_MAX_RECEIVE_COUNT", 5, 1),
      consumerConcurrency,
      retryBaseMs: int(env, "SQS_RETRY_BASE_MS", 1_000, 0),
      retryMaxMs: int(env, "SQS_RETRY_MAX_MS", 30_000, 0),
    },
    enable: {
      consumer: bool(env, "ENABLE_SQS_CONSUMER", true),
      outboxPublisher: bool(env, "ENABLE_OUTBOX_PUBLISHER", true),
      pendingWorker: bool(env, "ENABLE_PENDING_WORKER", true),
    },
  };
}
