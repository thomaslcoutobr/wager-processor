export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

const ORDER: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Minimal structured JSON logger (replaced by pino with context in the observability slice). */
export function createLogger(minLevel: string): Logger {
  const min = ORDER[minLevel] ?? ORDER.info!;
  return (level, msg, fields = {}) => {
    if ((ORDER[level] ?? 0) < min) return;
    const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields });
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  };
}
