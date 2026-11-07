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
  const health = new HealthChecks([
    {
      name: "postgres",
      check: async () => {
        await orm.em.fork().execute("select 1");
      },
    },
  ]);
  return {
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
    submit: new SubmitWagerTransaction(uow, read, clock, ids, policy, metrics, random),
    createWallet: new CreateWallet(uow, clock, ids, metrics),
  };
}

class OrmLifecycle implements OnApplicationShutdown {
  constructor(private readonly orm: MikroORM) {}

  /** Runs after beforeApplicationShutdown (where in-flight work drains), so the pool is closed last. */
  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
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
        { provide: TOKENS.lifecycle, useValue: new OrmLifecycle(c.orm) },
        ProviderAuthGuard,
      ],
    };
  }
}

export async function createApp(config: AppConfig, overrides: AppOverrides = {}): Promise<INestApplication> {
  const container = await buildContainer(config, overrides);
  const app = await NestFactory.create(AppModule.forRoot(container), {
    bodyParser: false,
    logger: config.logLevel === "silent" ? false : ["error", "warn"],
  });
  app.use(jsonBody(64 * 1024));
  app.useGlobalFilters(
    new ProblemFilter((error) => {
      if (config.logLevel !== "silent") console.error(JSON.stringify({ level: "error", msg: "request failed", err: String(error) }));
    }),
  );
  return app;
}
