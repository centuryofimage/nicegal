import type { TLSSocket } from "node:tls";

import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:http2";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-remote-server-tests",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [
    {
      name: "mock-electron",
      enforce: "pre",
      resolveId: (id) => (id === "electron" ? "\0mock-electron" : undefined),
      load: (id) =>
        id === "\0mock-electron"
          ? "export const ipcMain = { handle() {} }; export const protocol = {}; export const net = {};"
          : undefined,
    },
  ],
  ssr: { noExternal: ["electron"] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { handleRemotableIpc, handleTrustedIpc } = await vite.ssrLoadModule("/src/main/ipc.ts");
const { RemoteAccess } = await vite.ssrLoadModule("/src/main/remote/remote-access.ts");

const CLIENT = "11111111-2222-4333-8444-555555555555";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

test("remote access pairs, authenticates, serves calls, events and media, and revokes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nicegal-remote-"));
  after(() => rm(directory, { recursive: true, force: true }));
  const port = await freePort();
  await writeFile(join(directory, "remote-access.json"), JSON.stringify({ port, devices: [] }));
  const renderer = join(directory, "renderer");
  await mkdir(renderer);
  await writeFile(join(renderer, "index.html"), "<!doctype html><title>test</title>");
  const media = join(directory, "clip.mp4");
  await writeFile(media, Buffer.from("0123456789"));

  handleRemotableIpc(
    "test:echo",
    () => true,
    (_client: unknown, value: unknown) => ({ value }),
  );
  handleRemotableIpc(
    "test:fail",
    () => true,
    () => {
      throw Object.assign(new Error("Image model not ready"), { code: "models_not_ready" });
    },
  );
  handleTrustedIpc(
    "test:window-only",
    () => true,
    () => "secret",
  );

  const access = new RemoteAccess(
    join(directory, "remote-access.json"),
    {
      rendererDirectory: renderer,
      iconPath: join(renderer, "index.html"),
      devRendererUrl: null,
      getThumbnails: () => null,
      getCatalog: () => ({
        resolveAssets: async (ids: string[]) => ({
          assets: ids[0] === "5" ? [{ id: "5", path: media, modifiedNs: "1", sourceSize: 10 }] : [],
        }),
      }),
    },
    () => {},
    { available: false, get: () => false, set: () => {} },
  );
  after(() => access.stop());
  assert.equal((await access.setEnabled(true)).running, true);

  const base = `http://127.0.0.1:${port}`;
  const rpc = (channel: string, args: unknown[], init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}/rpc/${channel}`, {
      method: "POST",
      body: JSON.stringify(args),
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
  const pair = (code: string): Promise<Response> =>
    fetch(`${base}/pair`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, name: "Test phone" }),
    });

  // Unpaired: pages redirect to pairing, calls are refused, no code is active yet.
  const home = await fetch(base, { redirect: "manual", headers: { accept: "text/html" } });
  assert.equal(home.status, 303);
  assert.equal(home.headers.get("location"), "/pair");
  assert.equal(
    (await rpc("test:echo", [1], { headers: { "x-nicegal-client": CLIENT } })).status,
    401,
  );
  assert.equal((await pair("123456")).status, 403);

  // Five wrong guesses void the code, so the right one no longer works either.
  let code = access.renewPairingCode().pairingCode;
  const wrong = code === "000000" ? "111111" : "000000";
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await pair(wrong)).status, 403);
  assert.equal(access.status().pairingCode, null);
  assert.equal((await pair(code)).status, 403);

  // A fresh code pairs one device and is then spent.
  code = access.renewPairingCode().pairingCode;
  const paired = await pair(code);
  assert.equal(paired.status, 303);
  const cookie = paired.headers.get("set-cookie")!.split(";")[0];
  assert.match(cookie, /^nicegal_device=[\w-]{43}$/);
  assert.equal((await pair(code)).status, 403);
  assert.deepEqual(
    access.status().devices.map((device: { name: string }) => device.name),
    ["Test phone"],
  );

  // Calls need the client header, reach only remotable handlers, and keep error codes.
  const headers = { cookie, "x-nicegal-client": CLIENT };
  assert.equal((await rpc("test:echo", [1], { headers: { cookie } })).status, 400);
  assert.deepEqual(await (await rpc("test:echo", [42], { headers })).json(), {
    value: { value: 42 },
  });
  assert.equal((await rpc("test:window-only", [], { headers })).status, 404);
  const failed = (await (await rpc("test:fail", [], { headers })).json()) as {
    error: { message: string };
  };
  assert.match(failed.error.message, /nicegal-error:.*models_not_ready/);

  // The renderer bundle carries the remote content security policy.
  const page = await fetch(base, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'self'/);

  // Originals stream with byte ranges; a stale or unknown asset is not found.
  const range = await fetch(`${base}/original/asset/5?mtime=1&bytes=10`, {
    headers: { cookie, range: "bytes=2-5" },
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(range.headers.get("content-type"), "video/mp4");
  assert.equal(await range.text(), "2345");
  const stale = await fetch(`${base}/original/asset/5?mtime=2&bytes=10`, { headers: { cookie } });
  assert.equal(stale.status, 404);

  // Broadcasts reach an open event stream.
  const events = new AbortController();
  const stream = await fetch(`${base}/events?client=${CLIENT}`, {
    headers: { cookie },
    signal: events.signal,
  });
  assert.equal(stream.headers.get("content-type"), "text/event-stream");
  assert.deepEqual(
    access
      .status()
      .connected.map((connection: { name: string; browser: string }) => [
        connection.name,
        connection.browser,
      ]),
    [["Test phone", "Browser"]],
  );
  const reader = stream.body!.getReader();
  access.broadcast("test:event", { n: 1 });
  let received = "";
  while (!received.includes("test:event")) {
    const { value, done } = await reader.read();
    if (done) break;
    received += new TextDecoder().decode(value);
  }
  assert.match(received, /data: {"channel":"test:event","args":\[{"n":1}\]}/);
  events.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(access.status().connected, []);

  // Removing the device signs it out at once.
  access.removeDevice(access.status().devices[0].id);
  assert.equal((await rpc("test:echo", [1], { headers })).status, 401);

  // Turning remote access off closes the port.
  assert.equal((await access.setEnabled(false)).running, false);
  await assert.rejects(fetch(base));
});

test("HTTPS serves HTTP/2, redirects plain HTTP, and keeps its certificate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nicegal-remote-tls-"));
  after(() => rm(directory, { recursive: true, force: true }));
  const port = await freePort();
  await writeFile(
    join(directory, "remote-access.json"),
    JSON.stringify({ port, https: true, devices: [] }),
  );
  const renderer = join(directory, "renderer");
  await mkdir(renderer);
  await writeFile(join(renderer, "index.html"), "<!doctype html><title>test</title>");
  const access = new RemoteAccess(
    join(directory, "remote-access.json"),
    {
      rendererDirectory: renderer,
      devRendererUrl: null,
      getThumbnails: () => null,
      getCatalog: () => null,
    },
    () => {},
    { available: false, get: () => false, set: () => {} },
  );
  after(() => access.stop());

  const status = await access.setEnabled(true);
  assert.equal(status.running, true);
  assert.ok(status.urls.every((url: string) => url.startsWith("https://")));
  assert.match(status.certificateFingerprint ?? "", /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

  // Plain HTTP on the same port is sent to HTTPS.
  const plain = await fetch(`http://127.0.0.1:${port}/pair?x=1`, { redirect: "manual" });
  assert.equal(plain.status, 308);
  assert.equal(plain.headers.get("location"), `https://127.0.0.1:${port}/pair?x=1`);

  // Browsers get HTTP/2, and the served certificate is the one Settings shows.
  const session = connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
  after(() => session.close());
  const served = await new Promise<string>((resolve) =>
    session.once("connect", () =>
      resolve(
        new X509Certificate((session.socket as TLSSocket).getPeerX509Certificate()!.raw)
          .fingerprint256,
      ),
    ),
  );
  assert.equal(served, status.certificateFingerprint);
  const pairStatus = await new Promise<number>((resolve, reject) => {
    const stream = session.request({ ":path": "/pair" });
    stream.once("response", (headers) => resolve(Number(headers[":status"])));
    stream.once("error", reject);
    stream.resume();
  });
  assert.equal(pairStatus, 200);

  // A device paired over HTTPS gets a cookie plain HTTP can never carry.
  const code = access.renewPairingCode().pairingCode;
  const cookie = await new Promise<string>((resolve, reject) => {
    const stream = session.request({
      ":path": "/pair",
      ":method": "POST",
      "content-type": "application/x-www-form-urlencoded",
    });
    stream.once("response", (headers) => resolve(String(headers["set-cookie"])));
    stream.once("error", reject);
    stream.end(new URLSearchParams({ code, name: "Secure phone" }).toString());
    stream.resume();
  });
  assert.match(cookie, /; Secure$/);

  // Turning HTTPS off and on again reuses the certificate, so browsers do not warn again.
  await access.setHttps(false);
  assert.equal(access.status().urls[0]?.startsWith("http://"), true);
  assert.equal((await access.setHttps(true)).certificateFingerprint, status.certificateFingerprint);
});
