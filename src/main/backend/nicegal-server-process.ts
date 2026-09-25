import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";

import type { BackendLog } from "./backend-log";

interface ReadinessMessage {
  apiVersion: number;
  endpoint: string;
}

/** Exit code the server uses to ask for a clean respawn after silently downgrading its execution
 * provider (an initial DirectML indexing-model load falls back to CPU in-process; the server then persists
 * OpenVINO and exits with this code instead of running degraded for the rest of the session). Not
 * a crash — see `handleUnexpectedExit` in `main/index.ts`. Must match
 * `nicegal-server/src/api/mod.rs`'s `RESTART_EXIT_CODE`. */
export const RESTART_EXIT_CODE = 75;

export interface NicegalServerLaunchOptions {
  executable: string;
  workingDirectory: string;
  assetDatabase: string;
  ocrDatabase: string;
  thumbnailDatabase: string;
}

export interface NicegalServerConnection {
  endpoint: string;
  token: string;
}

export class NicegalServerProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private diagnostic = "";
  /** Set once `stop()` starts tearing the process down, so its `exit` handler can tell a
   * deliberate shutdown from a crash. */
  private stopping = false;

  constructor(
    private readonly log?: BackendLog,
    /** Fired when the child exits without `stop()` having been called for it — a crash, not a
     * deliberate shutdown. */
    private readonly onUnexpectedExit?: (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => void,
  ) {}

  async start(options: NicegalServerLaunchOptions): Promise<NicegalServerConnection> {
    if (this.child) throw new Error("nicegal-server is already running");

    this.stopping = false;
    this.diagnostic = "";
    const token = randomBytes(32).toString("hex");
    const child = spawn(
      options.executable,
      [
        "--asset-database",
        options.assetDatabase,
        "--ocr-database",
        options.ocrDatabase,
        "--thumbnail-database",
        options.thumbnailDatabase,
      ],
      {
        cwd: options.workingDirectory,
        env: { ...process.env, NO_COLOR: "1", NICEGAL_RPC_TOKEN: token },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child = child;
    this.log?.write("desktop", "server-spawned", {
      executable: options.executable,
      assetDatabase: options.assetDatabase,
      ocrDatabase: options.ocrDatabase,
      thumbnailDatabase: options.thumbnailDatabase,
    });
    // The server writes its own rotated, structured log straight to its state directory now
    // (see `nicegal_core::logging`), so this side only needs enough of stderr to diagnose a failed
    // launch.
    const stderrLines = createInterface({ input: child.stderr });
    stderrLines.on("line", (line: string) => {
      this.diagnostic = `${this.diagnostic}${line}\n`.slice(-64 * 1024);
      this.log?.write("server", "stderr", { line });
    });
    child.on("exit", (code, signal) => {
      this.log?.write("desktop", "server-exited", { code, signal });
      if (this.child === child && !this.stopping) {
        this.child = null;
        this.onUnexpectedExit?.(code, signal);
      }
    });

    try {
      const readiness = await withTimeout(this.readReadiness(child), 10_000, "server readiness");
      if (readiness.apiVersion !== 1) {
        throw new Error(`Unsupported nicegal-server API version ${readiness.apiVersion}`);
      }
      const endpoint = new URL(readiness.endpoint);
      if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1") {
        throw new Error(`Invalid nicegal-server endpoint ${readiness.endpoint}`);
      }
      this.log?.write("desktop", "server-ready", {
        apiVersion: readiness.apiVersion,
        endpoint: endpoint.origin,
      });
      return { endpoint: endpoint.origin, token };
    } catch (error) {
      this.log?.write("desktop", "server-start-failed", { error: String(error) });
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.stopping = true;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    this.log?.write("desktop", "server-stop-requested");
    const gracefulExit = once(child, "exit");
    if (!child.stdin.writableEnded) child.stdin.end();
    try {
      await withTimeout(gracefulExit, 10_000, "server shutdown");
    } catch {
      if (child.exitCode === null && child.signalCode === null) {
        this.log?.write("desktop", "server-force-termination");
        const forcedExit = once(child, "exit");
        child.kill();
        await withTimeout(forcedExit, 5_000, "forced server shutdown");
      }
    }
  }

  getDiagnostic(): string {
    return stripVTControlCharacters(this.diagnostic).trim();
  }

  private readReadiness(child: ChildProcessWithoutNullStreams): Promise<ReadinessMessage> {
    const { promise, resolve, reject } = Promise.withResolvers<ReadinessMessage>();
    const lines = createInterface({ input: child.stdout });
    const cleanup = (): void => {
      child.off("error", onError);
      child.off("exit", onExit);
      lines.close();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(
        new Error(
          `nicegal-server exited before readiness: code=${code} signal=${signal}${this.diagnostic ? `\n${this.diagnostic}` : ""}`,
        ),
      );
    };
    child.once("error", onError);
    child.once("exit", onExit);
    lines.once("line", (line: string) => {
      cleanup();
      try {
        const value = JSON.parse(line) as Partial<ReadinessMessage>;
        if (typeof value.apiVersion !== "number" || typeof value.endpoint !== "string") {
          throw new Error("missing apiVersion or endpoint");
        }
        resolve({ apiVersion: value.apiVersion, endpoint: value.endpoint });
      } catch (error) {
        reject(new Error(`Invalid nicegal-server readiness message: ${line}`, { cause: error }));
      }
    });
    return promise;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  operation: string,
): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => reject(new Error(`${operation} timed out after ${milliseconds}ms`)),
    milliseconds,
  );
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
