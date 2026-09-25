import { net, protocol, type CustomScheme } from "electron";
import { pathToFileURL } from "node:url";

import type { NicegalServerClient } from "./backend/nicegal-server-client";
import type { ThumbnailReader } from "./backend/thumbnail-reader";

import { resolveProtocolAssetPath } from "./protocol-path";
import { APP_HOST, APP_SCHEME } from "./renderer-location";

const CUSTOM_SCHEMES: CustomScheme[] = [
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true,
    },
  },
  {
    scheme: "thumb",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: "original",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
];

export interface ProtocolServices {
  rendererDirectory: string;
  getCatalog: () => NicegalServerClient | null;
  getThumbnails: () => ThumbnailReader | null;
}

/** Must run during module initialization, before Electron emits `ready`. */
export function registerCustomSchemes(): void {
  protocol.registerSchemesAsPrivileged(CUSTOM_SCHEMES);
}

/** Install once before creating a window; service getters remain valid across backend restarts. */
export function installProtocolHandlers(services: ProtocolServices): void {
  protocol.handle(APP_SCHEME, (request) => handleAppRequest(request, services.rendererDirectory));
  protocol.handle("thumb", (request) => handleThumbnailRequest(request, services.getThumbnails));
  // `protocol.handle` cannot expose a seekable file response in Electron yet. Let Chromium's
  // native file handler serve the validated path so its media cache and range seeking work.
  protocol.registerFileProtocol("original", (request, callback) => {
    void resolveOriginalPath(request.url, services.getCatalog).then(
      (path) => callback(path ? { path } : { error: -6 }),
      (error: unknown) => {
        console.error("Original-media protocol request failed", error);
        callback({ error: -2 });
      },
    );
  });
}

async function handleAppRequest(request: Request, rendererDirectory: string): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.host !== APP_HOST) return notFound();
    const assetPath = resolveProtocolAssetPath(rendererDirectory, url.pathname);
    if (!assetPath) return notFound();
    return await net.fetch(pathToFileURL(assetPath).toString());
  } catch (error) {
    console.error("App protocol request failed", error);
    return notFound();
  }
}

function handleThumbnailRequest(
  request: Request,
  getThumbnails: () => ThumbnailReader | null,
): Response {
  try {
    const url = new URL(request.url);
    const assetId = url.pathname.slice(1);
    const size = Number(url.searchParams.get("size"));
    const generatorVersion = Number(url.searchParams.get("v"));
    const frameText = url.searchParams.get("frame");
    const frameTimestampMs = frameText === null ? null : Number(frameText);
    const modifiedNs = url.searchParams.get("mtime") ?? "";
    const sourceSize = url.searchParams.get("bytes") ?? "";
    if (
      url.hostname !== "asset" ||
      !/^\d+$/.test(assetId) ||
      !Number.isInteger(size) ||
      size < 1 ||
      size > 1024 ||
      !Number.isInteger(generatorVersion) ||
      generatorVersion < 1 ||
      (frameText !== null &&
        (!/^\d+$/.test(frameText) || !Number.isSafeInteger(frameTimestampMs))) ||
      !/^-?\d+$/.test(modifiedNs) ||
      !/^\d+$/.test(sourceSize)
    ) {
      return new Response("Invalid thumbnail URL", { status: 400 });
    }

    const reader = getThumbnails();
    if (!reader) return new Response("Thumbnail service is starting", { status: 503 });
    const thumbnail =
      frameTimestampMs === null
        ? reader.get(assetId, generatorVersion, modifiedNs, sourceSize, size)
        : generatorVersion === 3
          ? reader.getVideoSample(assetId, frameTimestampMs, modifiedNs, sourceSize, size)
          : null;
    if (!thumbnail) return new Response("Thumbnail not found", { status: 404 });
    return new Response(thumbnail.data as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": thumbnail.encoding,
        // A stale hit (source changed, fresh variant not backfilled yet) must stay cheaply
        // re-checkable. Otherwise the long-lived URL would keep serving stale bytes.
        "cache-control": thumbnail.stale
          ? "private, max-age=30, must-revalidate"
          : "private, max-age=31536000, immutable",
        "x-thumbnail-size-bucket": String(thumbnail.sizeBucket),
        "x-thumbnail-width": String(thumbnail.width),
        "x-thumbnail-height": String(thumbnail.height),
        "x-thumbnail-stale": thumbnail.stale ? "1" : "0",
      },
    });
  } catch (error) {
    console.error("Thumbnail protocol request failed", error);
    return new Response("Thumbnail request failed", { status: 500 });
  }
}

async function resolveOriginalPath(
  requestUrl: string,
  getCatalog: () => NicegalServerClient | null,
): Promise<string | null> {
  const url = new URL(requestUrl);
  const assetId = url.pathname.slice(1);
  const modifiedNs = url.searchParams.get("mtime") ?? "";
  const sourceSize = url.searchParams.get("bytes") ?? "";
  if (
    url.hostname !== "asset" ||
    !/^\d+$/.test(assetId) ||
    !/^-?\d+$/.test(modifiedNs) ||
    !/^\d+$/.test(sourceSize)
  ) {
    return null;
  }
  const reader = getCatalog();
  if (!reader) return null;
  const asset = (await reader.resolveAssets([assetId])).assets[0];
  if (!asset || asset.modifiedNs !== modifiedNs || String(asset.sourceSize) !== sourceSize) {
    return null;
  }
  return asset.path;
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
