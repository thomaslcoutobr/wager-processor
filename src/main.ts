import "reflect-metadata";
import { createApp } from "./app";
import { loadConfig } from "./infrastructure/config";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const { app, container } = await createApp(config);
  await app.listen(config.port, "0.0.0.0");
  const port = (app.getHttpServer().address() as { port: number }).port;
  container.log("info", "listening", { port, roles: container.jobs.map((j) => j.name) });

  // Own signal handling (instead of enableShutdownHooks) so a clean drain exits with code 0.
  // app.close() runs beforeApplicationShutdown (readiness 503, consumer drains or hands messages
  // back) and then onApplicationShutdown (pool and SQS client closed last).
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    container.log("info", "shutting down", { signal });
    setTimeout(() => process.exit(1), config.shutdownGraceMs + 5_000).unref(); // hard stop
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      container.log("error", "shutdown failed", { err: String(err) });
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

bootstrap().catch((err) => {
  console.error(JSON.stringify({ level: "fatal", msg: "startup failed", err: String(err) }));
  process.exit(1);
});
