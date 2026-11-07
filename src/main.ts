import "reflect-metadata";
import { createApp } from "./app";
import { loadConfig } from "./infrastructure/config";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  app.enableShutdownHooks();
  await app.listen(config.port, "0.0.0.0");
  console.log(JSON.stringify({ level: "info", msg: "listening", port: config.port }));
}

bootstrap().catch((err) => {
  console.error(JSON.stringify({ level: "fatal", msg: "startup failed", err: String(err) }));
  process.exit(1);
});
