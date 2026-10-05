import { appendFileSync, createWriteStream, type WriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";

/// Generations kept alongside the live file: `path`, `path.1`, `path.2`. One more rotation drops
/// whatever was in the oldest of those.
const KEPT_GENERATIONS = 3;

export class BackendLog {
  private readonly stream: WriteStream;
  private closed = false;

  /** Rotates any log left over from previous launches, then opens a fresh file at `path`. */
  static async open(path: string): Promise<BackendLog> {
    for (let generation = KEPT_GENERATIONS - 1; generation >= 1; generation -= 1) {
      const from = generation === 1 ? path : `${path}.${generation - 1}`;
      const to = `${path}.${generation}`;
      if (generation === KEPT_GENERATIONS - 1) {
        await rm(to, { force: true });
      }
      await rename(from, to).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return new BackendLog(path);
  }

  private constructor(private readonly path: string) {
    this.stream = createWriteStream(path, { flags: "a", encoding: "utf8" });
    this.stream.on("error", (error) => console.error("Backend log write failed", error));
    this.write("desktop", "log-opened", { path });
  }

  write(source: "desktop" | "server" | "job" | "http", event: string, data?: unknown): void {
    if (this.closed) return;
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), source, event, data })}\n`;
    this.stream.write(line);
    process.stdout.write(line);
  }

  /** The process may terminate immediately after an uncaught exception. */
  writeFatal(error: Error, origin: string): void {
    if (this.closed) return;
    try {
      appendFileSync(
        this.path,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          source: "desktop",
          event: "uncaught-exception",
          data: { origin, error: error.stack ?? error.message },
        })}\n`,
      );
    } catch {
      // Diagnostics must not replace the original fatal exception.
    }
  }

  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.stream.write("", (error) => (error ? reject(error) : resolve()));
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.write("desktop", "log-closed");
    this.closed = true;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.stream.end(resolve);
    return promise;
  }
}
