import type { Subprocess } from "bun";

/**
 * A real app process (`bun src/main.ts`), for what an in-process app cannot show: SIGKILL at a
 * failpoint, SIGTERM draining, several instances. Logs are JSON lines on stdout/stderr.
 */
export interface SpawnedApp {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  baseUrl: string;
  lines: string[];
  waitForLine(pattern: RegExp, timeoutMs?: number): Promise<string>;
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

async function pump(stream: ReadableStream<Uint8Array>, lines: string[], onLine: () => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      lines.push(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      onLine();
    }
  }
  if (buffer) lines.push(buffer);
  onLine();
}

export async function spawnApp(env: Record<string, string>, opts: { waitReady?: boolean } = {}): Promise<SpawnedApp> {
  const lines: string[] = [];
  const waiters = new Set<() => void>();
  const notify = () => {
    for (const w of [...waiters]) w();
  };
  const proc = Bun.spawn(["bun", "src/main.ts"], {
    env: { ...process.env, NODE_ENV: "test", PORT: "0", LOG_LEVEL: "info", ...env } as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  void pump(proc.stdout, lines, notify);
  void pump(proc.stderr, lines, notify);

  const waitForLine = (pattern: RegExp, timeoutMs = 15_000): Promise<string> =>
    new Promise((resolve, reject) => {
      const check = () => {
        const hit = lines.find((l) => pattern.test(l));
        if (hit) {
          waiters.delete(check);
          clearTimeout(timer);
          resolve(hit);
        }
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`no log line matching ${pattern} within ${timeoutMs} ms. Last lines:\n${lines.slice(-15).join("\n")}`));
      }, timeoutMs);
      waiters.add(check);
      check();
    });

  let baseUrl = "";
  if (opts.waitReady !== false) {
    const listening = await waitForLine(/"msg":"listening"/);
    const port = (JSON.parse(listening) as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;
  }
  return {
    proc,
    baseUrl,
    lines,
    waitForLine,
    exited: proc.exited,
    kill: (signal: NodeJS.Signals = "SIGTERM") => proc.kill(signal),
  };
}
