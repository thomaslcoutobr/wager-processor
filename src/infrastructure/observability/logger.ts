import pino from "pino";
import { currentLogContext, type LogFn } from "../../application/log-context";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = LogFn;

/**
 * pino, JSON on stdout. Every line gets the ids of the current request/message from
 * AsyncLocalStorage (correlationId, messageId, transactionId, walletId, providerId). Credentials
 * are redacted; request logging is reduced to method, route, status and duration, so no body and no
 * full financial payload ever reaches the logs.
 */
export function createLogger(minLevel: string): Logger {
  // synchronous writes: a line logged right before process.exit or a crash is never lost
  const destination = pino.destination({ dest: 1, sync: true });
  const p = pino({
    level: minLevel === "silent" ? "silent" : minLevel,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: ["authorization", "cookie", "headers.authorization", "headers.cookie", "req.headers.authorization", "req.headers.cookie"],
      censor: "[redacted]",
    },
    mixin: () => ({ ...(currentLogContext() ?? {}) }),
  }, destination);
  return (level, msg, fields = {}) => p[level](fields, msg);
}
