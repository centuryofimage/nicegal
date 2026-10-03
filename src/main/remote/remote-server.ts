import type { Http2ServerRequest, Http2ServerResponse } from "node:http2";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { constants, createSecureServer } from "node:http2";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { extname } from "node:path";
import { Readable, pipeline } from "node:stream";

import type { NicegalServerClient } from "../backend/nicegal-server-client";
import type { ThumbnailReader } from "../backend/thumbnail-reader";

import { REMOTE_CLIENT_HEADER, type RemoteDevice } from "../../shared/remote";
import { remotableHandler, withIpcCode, type BridgeClient } from "../ipc";
import { resolveProtocolAssetPath } from "../protocol-path";
import { handleApiRequest, handleThumbnailRequest, resolveOriginalPath } from "../protocols";
import { guessBrowser, guessDeviceName, pairPage } from "./pair-page";

const COOKIE = "nicegal_device";
/** First byte of every TLS connection: a handshake record. */
const TLS_HANDSHAKE = 0x16;
/** A phone that locks its screen drops the event stream; keep its searches and job
 * subscriptions this long so unlocking resumes where it was. */
const CLIENT_GRACE_MS = 90_000;
const MAX_QUEUED_EVENTS = 200;
/** Visual search sends up to 16 images as base64 JSON. */
const MAX_RPC_BODY = 64 * 1024 * 1024;

export interface TlsIdentity {
  key: string;
  cert: string;
}

export interface RemoteServerHost {
  authenticate(token: string): RemoteDevice | null;
  /** Returns the new device's token, or an error to show on the pairing page. `address` is the
   * requesting IP, which wrong-code limits are counted against. */
  pair(code: string, name: string, address: string): { token: string } | { error: string };
  rendererDirectory: string;
  /** The app icon, for home-screen shortcuts. */
  iconPath: string;
  /** Vite's URL in development. Pages are proxied from it instead of the built bundle. */
  devRendererUrl: string | null;
  getCatalog: () => NicegalServerClient | null;
  getThumbnails: () => ThumbnailReader | null;
  /** A device opened or closed the gallery (its event stream). */
  onConnectionsChanged: () => void;
}

/** HTTP front for paired browsers: the renderer bundle, bridge calls, events, and media. */
/** Library and job changes go through validated, desktop-only IPC, never the raw backend API. */
const REMOTE_BLOCKED_API = /^\/api\/v1\/(libraries(\/|$)|jobs$)/;

export class RemoteServer {
  private readonly front: NetServer;
  private readonly sockets = new Set<Socket>();
  private readonly clients = new Map<string, RemoteClient>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  /**
   * With `tls`, one port serves HTTPS (HTTP/2 where the browser offers it) and answers plain HTTP
   * with a redirect, so an old `http://` bookmark still lands on the encrypted page. The first
   * byte of a connection tells them apart: every TLS connection opens with a handshake record.
   */
  constructor(
    private readonly host: RemoteServerHost,
    private readonly tls: TlsIdentity | null,
  ) {
    // HTTP/2 requests arrive through Node's compatibility API, which implements every HTTP/1
    // request and response member used here. Only `abandon` and `finished` tell them apart.
    const handle = (
      incoming: IncomingMessage | Http2ServerRequest,
      outgoing: ServerResponse | Http2ServerResponse,
    ): void => {
      const request = incoming as IncomingMessage;
      const response = outgoing as ServerResponse;
      void this.route(request, response).catch((error: unknown) => {
        console.error("Remote request failed", error);
        if (!response.headersSent) sendText(response, 500, "Request failed");
        else abandon(response);
      });
    };
    const plain = createServer(tls ? redirectToHttps : handle);
    const secure = tls ? createSecureServer({ ...tls, allowHTTP1: true }, handle) : null;
    this.front = createNetServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      socket.once("data", (first: Buffer) => {
        socket.pause();
        socket.unshift(first);
        (secure && first[0] === TLS_HANDSHAKE ? secure : plain).emit("connection", socket);
        process.nextTick(() => socket.resume());
      });
    });
  }

  get secure(): boolean {
    return this.tls !== null;
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.front.once("error", onError);
      this.front.listen(port, "0.0.0.0", () => {
        this.front.off("error", onError);
        this.heartbeat = setInterval(() => {
          for (const client of this.clients.values()) client.ping();
        }, 25_000);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    const closed = new Promise<void>((resolve) => this.front.close(() => resolve()));
    for (const socket of this.sockets) socket.destroy();
    await closed;
  }

  /** Browsers with an open event stream, i.e. the gallery showing on screen. Several tabs in one
   * browser count once. */
  connections(): Array<{ deviceId: string; browser: string }> {
    const seen = new Map<string, { deviceId: string; browser: string }>();
    for (const client of this.clients.values()) {
      if (!client.streaming) continue;
      seen.set(
        `${client.deviceId}
${client.browser}`,
        {
          deviceId: client.deviceId,
          browser: client.browser,
        },
      );
    }
    return [...seen.values()];
  }

  broadcast(channel: string, ...args: unknown[]): void {
    for (const client of this.clients.values()) client.send(channel, ...args);
  }

  /** Ends a removed device's sessions now rather than at its next request. */
  disconnectDevice(deviceId: string): void {
    for (const client of this.clients.values()) {
      if (client.deviceId === deviceId) client.close();
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://remote");
    const method = request.method ?? "GET";

    if (url.pathname === "/pair") return this.handlePair(request, response, method);
    // Browsers fetch these without cookies when adding the app to a home screen. Neither says
    // anything about the libraries.
    if (url.pathname === "/manifest.webmanifest" && method === "GET") return sendManifest(response);
    if (url.pathname === "/app-icon.png" && (method === "GET" || method === "HEAD"))
      return sendFile(request, response, this.host.iconPath, "public, max-age=86400");

    const device = this.deviceOf(request);
    if (!device) {
      if (method === "GET" && acceptsHtml(request)) return redirect(response, "/pair");
      return sendText(response, 401, "This device is not paired");
    }

    if (url.pathname === "/events" && method === "GET")
      return this.handleEvents(request, response, url, device);
    if (url.pathname.startsWith("/rpc/") && method === "POST")
      return this.handleRpc(request, response, url, device);
    if (url.pathname.startsWith("/thumb/") && method === "GET") {
      const target = `thumb://${url.pathname.slice("/thumb/".length)}${url.search}`;
      return sendResponse(
        response,
        handleThumbnailRequest(new Request(target), this.host.getThumbnails),
      );
    }
    if (url.pathname.startsWith("/api/v1/") && (method === "GET" || method === "POST")) {
      if (method === "POST" && REMOTE_BLOCKED_API.test(url.pathname)) {
        return sendText(response, 404, "Not found");
      }
      const body = method === "POST" ? await readBody(request, MAX_RPC_BODY) : undefined;
      const contentType = request.headers["content-type"];
      const forwarded = new Request(
        `api://server${url.pathname.slice("/api".length)}${url.search}`,
        {
          method,
          headers: contentType ? { "content-type": contentType } : {},
          body: body as unknown as BodyInit | undefined,
          signal: abortOnClose(response),
        },
      );
      return sendResponse(response, await handleApiRequest(forwarded, this.host.getCatalog, []));
    }
    if (url.pathname.startsWith("/original/") && (method === "GET" || method === "HEAD")) {
      const target = `original://${url.pathname.slice("/original/".length)}${url.search}`;
      const path = await resolveOriginalPath(target, this.host.getCatalog);
      if (!path) return sendText(response, 404, "Not found");
      return sendFile(request, response, path, "private, max-age=3600");
    }
    if (method === "GET" || method === "HEAD") {
      // A device paired before HTTPS was turned on holds a cookie without Secure. Loading the page
      // over HTTPS replaces it with one that plain HTTP can never carry.
      const token = readCookie(request, COOKIE);
      if (this.tls && token && acceptsHtml(request))
        response.setHeader("set-cookie", this.deviceCookie(token));
      return this.handleStatic(request, response, url);
    }
    return sendText(response, 405, "Method not allowed");
  }

  /** Secure once HTTPS is on, so the browser never sends it over plain HTTP. */
  private deviceCookie(token: string): string {
    const secure = this.tls ? "; Secure" : "";
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 400}${secure}`;
  }

  private ownOrigin(request: IncomingMessage): string | null {
    const host = headerValue(request, "host") ?? headerValue(request, ":authority");
    return host ? `${this.tls ? "https" : "http"}://${host}` : null;
  }

  private deviceOf(request: IncomingMessage): RemoteDevice | null {
    const token = readCookie(request, COOKIE);
    return token ? this.host.authenticate(token) : null;
  }

  private async handlePair(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
  ): Promise<void> {
    const defaultName = guessDeviceName(request.headers["user-agent"]);
    if (method === "GET") {
      if (this.deviceOf(request)) return redirect(response, "/");
      return sendHtml(response, 200, pairPage({ deviceName: defaultName }));
    }
    if (method !== "POST") return sendText(response, 405, "Method not allowed");
    // Browsers send Origin with every form POST. A foreign one is another page trying to burn
    // the pairing code's attempts.
    const origin = headerValue(request, "origin");
    if (origin !== null && origin !== this.ownOrigin(request))
      return sendText(response, 403, "Pairing must come from this page");
    const form = new URLSearchParams((await readBody(request, 4096)).toString("utf8"));
    const code = (form.get("code") ?? "").replace(/\D/g, "");
    const name = (form.get("name") ?? "").trim().slice(0, 60) || defaultName;
    const result = this.host.pair(code, name, clientAddress(request));
    if ("error" in result)
      return sendHtml(response, 403, pairPage({ deviceName: name, error: result.error }));
    response.writeHead(303, {
      location: "/",
      "set-cookie": this.deviceCookie(result.token),
      "cache-control": "no-store",
    });
    response.end();
  }

  private handleEvents(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    device: RemoteDevice,
  ): void {
    const client = this.clientFor(url.searchParams.get("client"), device);
    if (!client) return sendText(response, 400, "Invalid client");
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    response.write("retry: 2000\n\n");
    client.browser = guessBrowser(request.headers["user-agent"]);
    client.attach(response);
    request.once("close", () => client.detach(response));
  }

  private async handleRpc(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    device: RemoteDevice,
  ): Promise<void> {
    // A custom header cannot be sent cross-site without a CORS preflight, which is never
    // answered, so a paired device's cookie alone cannot be ridden by another page.
    const client = this.clientFor(headerValue(request, REMOTE_CLIENT_HEADER), device);
    if (!client) return sendText(response, 400, "Invalid client");
    const handler = remotableHandler(decodeURIComponent(url.pathname.slice("/rpc/".length)));
    if (!handler) return sendText(response, 404, "Unknown call");
    let args: unknown;
    try {
      args = JSON.parse((await readBody(request, MAX_RPC_BODY)).toString("utf8"));
    } catch {
      return sendText(response, 400, "Invalid call arguments");
    }
    if (!Array.isArray(args)) return sendText(response, 400, "Invalid call arguments");
    try {
      const value = await handler(client, ...args);
      sendJson(response, 200, { value: value ?? null });
    } catch (error) {
      const coded = withIpcCode(error);
      sendJson(response, 200, {
        error: {
          name: coded instanceof Error ? coded.name : "Error",
          message: coded instanceof Error ? coded.message : String(coded),
        },
      });
    }
  }

  private clientFor(id: string | null, device: RemoteDevice): RemoteClient | null {
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) return null;
    let client = this.clients.get(id);
    if (client && client.deviceId !== device.id) return null;
    if (!client || client.isClosed()) {
      client = new RemoteClient(
        id,
        device.id,
        () => this.clients.delete(id),
        () => this.host.onConnectionsChanged(),
      );
      this.clients.set(id, client);
    }
    return client;
  }

  private async handleStatic(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (this.host.devRendererUrl) {
      const upstream = await fetch(
        new URL(`${url.pathname}${url.search}`, this.host.devRendererUrl),
        {
          headers: { accept: request.headers.accept ?? "*/*" },
          method: request.method,
          signal: abortOnClose(response),
        },
      );
      const headers: OutgoingHttpHeaders = { "cache-control": "no-store" };
      const type = upstream.headers.get("content-type");
      if (type) headers["content-type"] = type;
      response.writeHead(upstream.status, headers);
      if (!upstream.body || request.method === "HEAD") return void response.end();
      pipeResponse(response, upstream.body);
      return;
    }
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const path = resolveProtocolAssetPath(this.host.rendererDirectory, pathname);
    if (!path) return sendText(response, 404, "Not found");
    const html = pathname.endsWith(".html");
    return sendFile(
      request,
      response,
      path,
      pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      html ? { "content-security-policy": REMOTE_CSP } : {},
    );
  }
}

/** The desktop policy with the custom schemes replaced by same-origin paths. */
const REMOTE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob:",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

class RemoteClient implements BridgeClient {
  readonly remote = true;
  private readonly streams = new Set<ServerResponse>();
  private queued: string[] = [];
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly closeListeners: Array<() => void> = [];
  browser = "Browser";

  readonly id: string;

  constructor(
    browserId: string,
    readonly deviceId: string,
    private readonly onClose: () => void,
    private readonly onStreamingChanged: () => void,
  ) {
    this.id = `${browserId}:${randomUUID()}`;
    // A client that makes calls but never opens its event stream still gets cleaned up.
    this.scheduleClose();
  }

  attach(stream: ServerResponse): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.streams.add(stream);
    for (const event of this.queued) stream.write(event);
    this.queued = [];
    if (this.streams.size === 1) this.onStreamingChanged();
  }

  get streaming(): boolean {
    return this.streams.size > 0;
  }

  detach(stream: ServerResponse): void {
    if (!this.streams.delete(stream)) return;
    if (!this.streams.size && !this.closed) {
      this.scheduleClose();
      this.onStreamingChanged();
    }
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.closed) return;
    const event = `data: ${JSON.stringify({ channel, args })}\n\n`;
    if (!this.streams.size) {
      // Latest state matters more than history while the phone is asleep.
      if (this.queued.length >= MAX_QUEUED_EVENTS) this.queued.shift();
      this.queued.push(event);
      return;
    }
    for (const stream of this.streams) stream.write(event);
  }

  ping(): void {
    for (const stream of this.streams) stream.write(": ping\n\n");
  }

  isClosed(): boolean {
    return this.closed;
  }

  onceClosed(listener: () => void): void {
    if (this.closed) listener();
    else this.closeListeners.push(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    const wasStreaming = this.streaming;
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    this.onClose();
    if (wasStreaming) this.onStreamingChanged();
    for (const listener of this.closeListeners.splice(0)) listener();
  }

  private scheduleClose(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.close(), CLIENT_GRACE_MS);
    this.closeTimer.unref();
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jfif": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
};

/** Streams a file with single-range support, which video seeking on phones depends on. */
async function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  cacheControl: string,
  extraHeaders: OutgoingHttpHeaders = {},
): Promise<void> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return sendText(response, 404, "Not found");
    size = info.size;
  } catch {
    return sendText(response, 404, "Not found");
  }
  const headers: OutgoingHttpHeaders = {
    "content-type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": cacheControl,
    ...extraHeaders,
  };
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(headerValue(request, "range") ?? "");
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end || start >= size) {
      response.writeHead(416, { "content-range": `bytes */${size}` });
      return void response.end();
    }
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["content-length"] = size === 0 ? 0 : end - start + 1;
  response.writeHead(status, headers);
  if (request.method === "HEAD" || size === 0) return void response.end();
  const stream = createReadStream(path, { start, end });
  stream.on("error", () => abandon(response));
  response.once("close", () => stream.destroy());
  stream.pipe(response);
}

function sendResponse(response: ServerResponse, source: Response): void {
  const headers: OutgoingHttpHeaders = {};
  source.headers.forEach((value, key) => {
    headers[key] = value;
  });
  response.writeHead(source.status, headers);
  if (!source.body) return void response.end();
  pipeResponse(response, source.body);
}

function pipeResponse(response: ServerResponse, body: Response["body"] & {}): void {
  pipeline(Readable.fromWeb(body as NodeReadableStream), response, (error) => {
    if (error && error.code !== "ERR_STREAM_PREMATURE_CLOSE" && error.name !== "AbortError")
      console.error("Remote response stream failed", error);
  });
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(text);
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  });
  response.end(html);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location, "cache-control": "no-store" });
  response.end();
}

function acceptsHtml(request: IncomingMessage): boolean {
  return (request.headers.accept ?? "").includes("text/html");
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

/** The peer's IP, with IPv4-mapped IPv6 addresses written as plain IPv4. */
function clientAddress(request: IncomingMessage): string {
  const address = request.socket.remoteAddress ?? "";
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function readCookie(request: IncomingMessage, name: string): string | null {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    request.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > limit) {
        reject(new Error("Request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

function abortOnClose(response: ServerResponse): AbortSignal {
  const abort = new AbortController();
  response.once("close", () => {
    if (!finished(response)) abort.abort();
  });
  return abort.signal;
}

/** Plain HTTP on an HTTPS port: send the browser to the same address over HTTPS. */
function redirectToHttps(request: IncomingMessage, response: ServerResponse): void {
  const host = request.headers.host;
  if (!host) return sendText(response, 400, "Missing host");
  response.writeHead(308, {
    location: `https://${host}${request.url ?? "/"}`,
    "cache-control": "no-store",
  });
  response.end();
}

/** Drops a response mid-body. On HTTP/2 only its stream is reset, not the shared connection. */
function abandon(response: ServerResponse): void {
  const http2 = (response as unknown as Partial<Http2ServerResponse>).stream;
  if (http2) http2.close(constants.NGHTTP2_CANCEL);
  else response.destroy();
}

function finished(response: ServerResponse): boolean {
  const http2 = response as unknown as Partial<Http2ServerResponse>;
  return http2.stream ? http2.finished === true : response.writableFinished;
}

/** Lets "Add to Home screen" open Nicegal on its own, without the browser's address bar. */
function sendManifest(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "application/manifest+json",
    "cache-control": "no-cache",
  });
  response.end(
    JSON.stringify({
      name: "Nicegal",
      short_name: "Nicegal",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#f0f1f2",
      theme_color: "#f0f1f2",
      icons: [{ src: "/app-icon.png", sizes: "1024x1024", type: "image/png", purpose: "any" }],
    }),
  );
}
