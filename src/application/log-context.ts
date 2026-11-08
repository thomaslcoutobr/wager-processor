import { AsyncLocalStorage } from "node:async_hooks";

/** Ids that every log line of a request/message carries (ARCHITECTURE §17). Never amounts or payloads. */
export interface LogContext {
  correlationId?: string;
  requestId?: string;
  messageId?: string;
  sqsMessageId?: string;
  causationId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with a context (inheriting the current one). */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run({ ...(storage.getStore() ?? {}), ...ctx }, fn);
}

/** The use case adds ids as it discovers them (wallet, provider, transaction). */
export function enrichLogContext(fields: LogContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}

export function currentLogContext(): LogContext | undefined {
  return storage.getStore();
}

export type LogFn = (level: "debug" | "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
