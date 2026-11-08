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
  //  1. readiness 503 and HTTP drain (new requests 503 + Connection: close; in-flight ones finish)
  //  2. app.close(): beforeApplicationShutdown drains the consumer (or hands messages back) and the
  //     pollers; then the HTTP server closes; onApplicationShutdown closes the pool and SQS client last
  //  3. idle keep-alive sockets are closed once no request is in flight, so server.close() can return
  const server = app.getHttpServer() as { closeIdleConnections?(): void; closeAllConnections?(): void };
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    container.log("info", "shutting down", { signal });
    setTimeout(() => process.exit(1), config.shutdownGraceMs + 5_000).unref(); // hard stop
    container.health.startDraining();
    container.httpDrain.start();
    const httpDone = container.httpDrain.waitIdle(config.shutdownGraceMs).then((idle) => {
      if (!idle) container.log("warn", "http requests still in flight after the grace period");
      server.closeAllConnections?.();
    });
    try {
      await Promise.all([httpDone, app.close()]);
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
