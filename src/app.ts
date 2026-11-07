import "reflect-metadata";
import { type DynamicModule, type INestApplication, Module, type OnApplicationShutdown } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "./application/create-wallet";
import type { Clock, IdGenerator } from "./application/ports";
import { SubmitWagerTransaction } from "./application/submit-wager-transaction";
import { PendingReferencePolicy } from "./domain/pending-reference-policy";
import type { AppConfig } from "./infrastructure/config";
import { Failpoints } from "./infrastructure/failpoints";
import { PromMetrics } from "./infrastructure/observability/metrics";
import { MikroReadStore } from "./infrastructure/persistence/mikro-read-store";
import { MikroUnitOfWork } from "./infrastructure/persistence/mikro-unit-of-work";
import { createOrm } from "./infrastructure/persistence/orm";
import { SystemClock, UuidV7Generator } from "./infrastructure/system";
import { createLogger, type Logger } from "./infrastructure/observability/logger";
import { type BackgroundJob, BackgroundJobs } from "./infrastructure/workers/background-jobs";
import { PendingReferenceWorker } from "./infrastructure/workers/pending-reference-worker";
import { ResolvePendingReference } from "./application/resolve-pending-reference";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { EventBus } from "./application/ports";
import { ProcessWagerMessage } from "./application/process-wager-message";
import { PublishOutboxBatch } from "./application/publish-outbox-batch";
import { createSqsClient, QueueDirectory, SqsEventBus } from "./infrastructure/messaging/sqs";
import { SqsConsumer } from "./infrastructure/messaging/sqs-consumer";
import { OutboxPublisherWorker } from "./infrastructure/workers/outbox-publisher-worker";
import { AnonymousIdentity, PROVIDER_IDENTITY, ProviderAuthGuard } from "./interfaces/http/auth";
import { HealthChecks, HealthController } from "./interfaces/http/health.controller";
import { jsonBody } from "./interfaces/http/json-body";
import { MetricsController } from "./interfaces/http/metrics.controller";
import { ProblemFilter } from "./interfaces/http/problem";
import { TOKENS } from "./interfaces/http/tokens";
import { WageringController } from "./interfaces/http/wagering.controller";
import { WalletsController } from "./interfaces/http/wallets.controller";

export interface AppOverrides {
  clock?: Clock;
  ids?: IdGenerator;
  failpoints?: Failpoints;
  random?: () => number;
  /** Tests wrap the real SQS bus (to record publishers or simulate SQS down). */
  wrapEventBus?: (bus: EventBus) => EventBus;
}

/** Everything the process needs, wired by hand (composition root). Nest only hosts the HTTP part. */
export interface Container {
  config: AppConfig;
  orm: MikroORM;
  metrics: PromMetrics;
  clock: Clock;
  ids: IdGenerator;
  failpoints: Failpoints;
  health: HealthChecks;
  submit: SubmitWagerTransaction;
  createWallet: CreateWallet;
  read: MikroReadStore;
  uow: MikroUnitOfWork;
  policy: PendingReferencePolicy;
  log: Logger;
  resolvePending: ResolvePendingReference;
  pendingWorker: PendingReferenceWorker;
  sqs: SQSClient;
  queues: QueueDirectory;
  eventBus: EventBus;
  outboxPublisher: OutboxPublisherWorker;
  consumer: SqsConsumer;
  jobs: BackgroundJob[];
}

export async function buildContainer(config: AppConfig, overrides: AppOverrides = {}): Promise<Container> {
  const failpoints =
    overrides.failpoints ?? new Failpoints(config.failpoints, { allowInProduction: false, nodeEnv: config.nodeEnv });
  const orm = await createOrm({ url: config.databaseUrl, poolMax: config.dbPoolMax });
  const metrics = new PromMetrics();
  const clock = overrides.clock ?? new SystemClock();
  const ids = overrides.ids ?? new UuidV7Generator();
  const random = overrides.random ?? Math.random;
  const uow = new MikroUnitOfWork(orm, config.lockTimeoutMs, metrics, failpoints);
  const read = new MikroReadStore(orm);
  const policy = PendingReferencePolicy.create(config.pendingReference);
  const sqs = createSqsClient(config.sqs);
  const queues = new QueueDirectory(sqs);
  const realBus = new SqsEventBus(sqs, queues, config.sqs.eventsQueueName);
  const eventBus = overrides.wrapEventBus ? overrides.wrapEventBus(realBus) : realBus;
  // readiness = Postgres and SQS reachable (inbound queue and events queue), 1 s each
  const health = new HealthChecks([
    {
      name: "postgres",
      check: async () => {
        await orm.em.fork().execute("select 1");
      },
    },
    { name: "sqs", check: () => queues.probe(config.sqs.queueName, 1_000) },
    { name: "sqs-events", check: () => eventBus.check() },
  ]);
  const log = createLogger(config.logLevel);
  const resolvePending = new ResolvePendingReference(uow, clock, ids, policy, metrics, random);
  const pendingWorker = new PendingReferenceWorker(
    read,
    resolvePending,
    clock,
    metrics,
    { pollMs: config.pendingReference.pollMs, batchSize: config.pendingReference.batchSize },
    log,
  );
  const submit = new SubmitWagerTransaction(uow, read, clock, ids, policy, metrics, random);
  const outboxPublisher = new OutboxPublisherWorker(
    new PublishOutboxBatch(uow, eventBus, clock, failpoints, { batchSize: config.outbox.batchSize, random }),
    read,
    clock,
    metrics,
    { pollMs: config.outbox.pollMs, batchSize: config.outbox.batchSize },
    log,
  );
  const consumer = new SqsConsumer(
    sqs,
    queues,
    new ProcessWagerMessage(submit, uow, clock, ids, config.sqs.consumerName),
    {
      queueName: config.sqs.queueName,
      dlqName: config.sqs.dlqName,
      maxReceiveCount: config.sqs.maxReceiveCount,
      visibilityTimeoutS: config.sqs.visibilityTimeoutS,
      waitTimeS: config.sqs.waitTimeS,
      batchSize: config.sqs.batchSize,
      retryBaseMs: config.sqs.retryBaseMs,
      retryMaxMs: config.sqs.retryMaxMs,
      shutdownGraceMs: config.shutdownGraceMs,
    },
    metrics,
    failpoints,
    log,
    random,
  );
  // stop order matters: the consumer drains first (it feeds the others), then the pollers
  const jobs: BackgroundJob[] = [];
  if (config.enable.consumer) jobs.push(consumer);
  if (config.enable.pendingWorker) jobs.push({ name: "pending-reference-worker", start: () => pendingWorker.start(), stop: () => pendingWorker.stop() });
  if (config.enable.outboxPublisher) jobs.push(outboxPublisher);
  return {
    sqs,
    queues,
    eventBus,
    outboxPublisher,
    consumer,
    config,
    orm,
    metrics,
    clock,
    ids,
    failpoints,
    health,
    uow,
    read,
    policy,
    log,
    resolvePending,
    pendingWorker,
    jobs,
    submit,
    createWallet: new CreateWallet(uow, clock, ids, metrics),
  };
}

class InfraLifecycle implements OnApplicationShutdown {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
  ) {}

  /** Runs after beforeApplicationShutdown (where in-flight work drains), so the pool is closed last. */
  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
    this.sqs.destroy();
  }
}

@Module({})
class AppModule {
  static forRoot(c: Container): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, MetricsController, WalletsController, WageringController],
      providers: [
        { provide: TOKENS.submit, useValue: c.submit },
        { provide: TOKENS.createWallet, useValue: c.createWallet },
        { provide: TOKENS.readStore, useValue: c.read },
        { provide: TOKENS.ids, useValue: c.ids },
        { provide: TOKENS.health, useValue: c.health },
        { provide: TOKENS.metrics, useValue: c.metrics },
        { provide: PROVIDER_IDENTITY, useValue: new AnonymousIdentity() },
        { provide: TOKENS.lifecycle, useValue: new InfraLifecycle(c.orm, c.sqs) },
        { provide: TOKENS.failpoints, useValue: c.failpoints },
        { provide: TOKENS.jobs, useValue: new BackgroundJobs(c.jobs, c.health) },
        ProviderAuthGuard,
      ],
    };
  }
}

export async function createApp(
  config: AppConfig,
  overrides: AppOverrides = {},
): Promise<{ app: INestApplication; container: Container }> {
  const container = await buildContainer(config, overrides);
  const app = await NestFactory.create(AppModule.forRoot(container), {
    bodyParser: false,
    logger: config.logLevel === "silent" ? false : ["error", "warn"],
  });
  app.use(jsonBody(64 * 1024));
  app.useGlobalFilters(new ProblemFilter((error) => container.log("error", "request failed", { err: String(error) })));
  return { app, container };
}
