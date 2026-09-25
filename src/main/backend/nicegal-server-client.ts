import { setTimeout as delay } from "node:timers/promises";

import type {
  TextEmbeddingCoverage,
  ImageEmbeddingCoverage,
  GalleryAsset,
  AssetMetadata,
  CreateLibraryRequest,
  Library,
  LibraryDefinition,
  LibraryId,
  Timeline,
  EnsureThumbnailsRequest,
  EnsureThumbnailsResponse,
  ExecutionProviderId,
  JobListResponse,
  JobRequest,
  JobSnapshot,
  OcrModelsResponse,
  SearchModelsResponse,
  ResolveAssetsResponse,
  RuntimeStatus,
  SearchRequest,
  SearchResponse,
} from "../../shared/backend";
import type { BackendLog } from "./backend-log";

const TERMINAL_STATUSES: Partial<Record<JobSnapshot["status"], true>> = {
  cancelled: true,
  completed: true,
  failed: true,
};

export class NicegalServerClient {
  private readonly jobLogState = new Map<
    string,
    { timestamp: number; phase: JobSnapshot["phase"]; status: JobSnapshot["status"] }
  >();

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly log?: BackendLog,
  ) {}

  async listLibraries(): Promise<Library[]> {
    return this.requestJson<Library[]>("/v1/libraries", { method: "GET" });
  }

  async createLibrary(request: CreateLibraryRequest): Promise<Library> {
    return this.requestJson<Library>("/v1/libraries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  async updateLibrary(libraryId: LibraryId, definition: LibraryDefinition): Promise<Library> {
    return this.requestJson<Library>(`/v1/libraries/${libraryId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(definition),
    });
  }

  async deleteLibrary(libraryId: LibraryId): Promise<void> {
    await this.request(`/v1/libraries/${libraryId}`, { method: "DELETE" });
  }

  async listAssets(libraryId: LibraryId, timeline: Timeline): Promise<GalleryAsset[]> {
    const url = new URL("/v1/catalog", this.endpoint);
    url.searchParams.set("libraryId", String(libraryId));
    url.searchParams.set("timeline", timeline);
    return this.requestJson<GalleryAsset[]>(url, { method: "GET" });
  }

  async listFolders(libraryId: LibraryId): Promise<string[]> {
    const url = new URL("/v1/catalog/folders", this.endpoint);
    url.searchParams.set("libraryId", String(libraryId));
    return this.requestJson<string[]>(url, { method: "GET" });
  }

  async countAssets(libraryId: LibraryId): Promise<number> {
    const url = new URL("/v1/catalog/count", this.endpoint);
    url.searchParams.set("libraryId", String(libraryId));
    return this.requestJson<number>(url, { method: "GET" });
  }

  async getRevision(): Promise<string> {
    return this.requestJson<string>("/v1/catalog/revision", { method: "GET" });
  }

  async getAssetMetadata(assetId: string): Promise<AssetMetadata> {
    const url = new URL("/v1/catalog/metadata", this.endpoint);
    url.searchParams.set("assetId", assetId);
    return this.requestJson<AssetMetadata>(url, { method: "GET" });
  }

  async health(): Promise<void> {
    await this.request("/v1/health", { method: "GET" });
  }

  async getOcrModels(): Promise<OcrModelsResponse> {
    return this.requestJson<OcrModelsResponse>("/v1/ocr/models", { method: "GET" });
  }

  async getSearchModels(): Promise<SearchModelsResponse> {
    return this.requestJson<SearchModelsResponse>("/v1/models", { method: "GET" });
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    return this.requestJson<RuntimeStatus>("/v1/runtime", { method: "GET" });
  }

  async setImageModel(model: string): Promise<RuntimeStatus> {
    return this.requestJson<RuntimeStatus>("/v1/runtime", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageModel: model }),
    });
  }

  async setExecutionProvider(executionProvider: ExecutionProviderId): Promise<RuntimeStatus> {
    return this.requestJson<RuntimeStatus>("/v1/runtime", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionProvider }),
    });
  }

  async setIndexVideos(indexVideos: boolean): Promise<void> {
    await this.request("/v1/runtime", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ indexVideos }),
    });
  }

  async getImageEmbeddingCoverage(libraryId: LibraryId): Promise<ImageEmbeddingCoverage> {
    const url = new URL("/v1/image-embeddings", this.endpoint);
    url.searchParams.set("libraryId", String(libraryId));
    const response = await this.request(url, { method: "GET" });
    const value = (await response.json()) as Partial<ImageEmbeddingCoverage>;
    if (!isCount(value.total) || !isCount(value.indexed) || value.indexed > value.total) {
      throw new Error("nicegal-server returned invalid image embedding coverage");
    }
    return { total: value.total, indexed: value.indexed };
  }

  async getTextEmbeddingCoverage(libraryId: LibraryId): Promise<TextEmbeddingCoverage> {
    const url = new URL("/v1/text-embeddings", this.endpoint);
    url.searchParams.set("libraryId", String(libraryId));
    const response = await this.request(url, { method: "GET" });
    const value = (await response.json()) as Partial<TextEmbeddingCoverage>;
    if (!isCount(value.indexed) || !isCount(value.embedded) || !isCount(value.pending)) {
      throw new Error("nicegal-server returned invalid text embedding coverage");
    }
    return {
      indexed: value.indexed,
      embedded: value.embedded,
      pending: value.pending,
      // Absent on a server that predates the field, and null when nothing in the library is
      // indexed yet. Both mean "no date to show", so both collapse to null here.
      lastIndexedAt: isCount(value.lastIndexedAt) ? value.lastIndexedAt : null,
    };
  }

  async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    if (request.imageQuery) return this.searchCompositeImage(request, signal);
    const url = new URL("/v1/search", this.endpoint);
    url.searchParams.set("q", request.query);
    url.searchParams.set("type", request.type);
    url.searchParams.set("libraryId", String(request.libraryId));
    if (request.folder !== undefined) url.searchParams.set("folder", request.folder);
    if (request.pathContains !== undefined)
      url.searchParams.set("pathContains", request.pathContains);
    url.searchParams.set("limit", String(request.limit ?? 100_000));
    if (request.before !== undefined) url.searchParams.set("before", request.before);
    if (request.after !== undefined) url.searchParams.set("after", request.after);
    if (request.timeline !== undefined) url.searchParams.set("timeline", request.timeline);
    let response: Response;
    try {
      response = await this.request(url, { method: "GET", signal });
    } catch (error) {
      if (error instanceof NicegalServerError) {
        throw new Error(
          error.code === "query_syntax" ? `Query syntax — ${error.message}` : error.message,
        );
      }
      throw error;
    }
    const value = (await response.json()) as SearchResponse;
    return {
      total: value.total,
      results: value.results.map((result) => ({
        assetId: String(result.assetId),
        timestampMs: result.timestampMs,
        snippet: result.snippet,
        rank: result.rank,
        distance: result.distance,
        score: result.score,
      })),
    };
  }

  private async searchCompositeImage(
    request: SearchRequest,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    const response = await this.request("/v1/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        libraryId: request.libraryId,
        ...(request.folder === undefined ? {} : { folder: request.folder }),
        ...(request.pathContains === undefined ? {} : { pathContains: request.pathContains }),
        limit: request.limit ?? 100_000,
        ...(request.before === undefined ? {} : { before: request.before }),
        ...(request.after === undefined ? {} : { after: request.after }),
        ...(request.timeline === undefined ? {} : { timeline: request.timeline }),
        queries: [{ key: "visual", type: "image", imageQuery: request.imageQuery }],
      }),
      signal,
    });
    const value = (await response.json()) as {
      queries?: Array<{ key?: string; total?: number; results?: SearchResponse["results"] }>;
    };
    const visual = value.queries?.find((query) => query.key === "visual");
    if (!visual || typeof visual.total !== "number" || !Array.isArray(visual.results)) {
      throw new Error("nicegal-server returned an invalid visual search response");
    }
    return {
      total: visual.total,
      results: visual.results.map((result) => ({
        assetId: String(result.assetId),
        timestampMs: result.timestampMs,
        snippet: result.snippet ?? "",
        rank: result.rank,
        distance: result.distance,
        score: result.score,
      })),
    };
  }

  /**
   * `POST /v1/thumbnails` — synchronously ensures variants for a visible-tile batch, resolving
   * only once every requested current variant is committed to `thumbnails.db`. Distinct from the
   * `thumbnailGenerate` background job: no job slot, no progress polling, just await-and-read.
   *
   * Unlike nanosecond timestamps elsewhere in this API, `assetId` is a plain JSON integer on the
   * wire (auto-increment SQLite row ids stay well under Number.MAX_SAFE_INTEGER) — the server
   * rejects decimal strings here with a 422. Convert at this boundary so the rest of the app can
   * keep treating ids as strings, as it does everywhere else.
   */
  async ensureThumbnails(
    request: EnsureThumbnailsRequest,
    signal?: AbortSignal,
  ): Promise<EnsureThumbnailsResponse> {
    const response = await this.request("/v1/thumbnails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assetIds: request.assetIds.map((id) => Number(id)),
        requiredSize: request.requiredSize,
      }),
      signal,
    });
    const value = (await response.json()) as { assetIds: number[] } & Omit<
      EnsureThumbnailsResponse,
      "assetIds"
    >;
    return { ...value, assetIds: value.assetIds.map(String) };
  }

  /** Resolves a bounded ID batch through the Rust catalog API. This is the shared path boundary
   * for OS integrations such as context-menu actions and external file dragging. */
  async resolveAssets(assetIds: readonly string[]): Promise<ResolveAssetsResponse> {
    const wireAssetIds = assetIds.map((id) => {
      const value = Number(id);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError("Asset IDs must be safe positive integers");
      }
      return value;
    });
    const response = await this.request("/v1/assets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetIds: wireAssetIds }),
    });
    const value = (await response.json()) as {
      assets: Array<{
        assetId: number;
        path: string;
        displayName: string;
        folderPath: string | null;
        extension: string | null;
        sourceModifiedNs: string;
        sourceCreatedNs: string | null;
        exifTakenNs: string | null;
        sourceSize: number;
        mediaKind: "image" | "video";
        mediaFormat: string;
        width: number | null;
        height: number | null;
        isAnimated: boolean;
        frameCount: number | null;
        durationMs: number | null;
        indexState: "indexed" | "stale" | "notIndexed";
      }>;
      missingAssetIds: number[];
    };
    return {
      assets: value.assets.map((asset) => ({
        id: String(asset.assetId),
        path: asset.path,
        displayName: asset.displayName,
        folderPath: asset.folderPath,
        extension: asset.extension,
        modifiedNs: asset.sourceModifiedNs,
        createdNs: asset.sourceCreatedNs,
        captureNs: asset.exifTakenNs,
        sourceSize: asset.sourceSize,
        mediaKind: asset.mediaKind,
        mediaFormat: asset.mediaFormat,
        width: asset.width,
        height: asset.height,
        animated: asset.isAnimated,
        frameCount: asset.frameCount,
        durationMs: asset.durationMs,
        indexState: asset.indexState,
      })),
      missingAssetIds: value.missingAssetIds.map(String),
    };
  }

  async startJob(request: JobRequest): Promise<JobSnapshot> {
    try {
      const response = await this.request("/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const snapshot = (await response.json()) as JobSnapshot;
      this.log?.write("job", "started", {
        jobId: snapshot.jobId,
        type: snapshot.type,
        params: request.params,
      });
      this.logJobSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      if (!(error instanceof NicegalServerError)) throw error;
      if (error.code !== "job_busy") throw error;

      const activeJob = await this.getActiveJob().catch(() => null);
      if (!activeJob) throw error;
      this.log?.write("job", "attached", {
        jobId: activeJob.jobId,
        requestedType: request.type,
        activeType: activeJob.type,
        params: request.params,
      });
      this.logJobSnapshot(activeJob);
      return activeJob;
    }
  }

  async getJob(jobId: string): Promise<JobSnapshot> {
    const response = await this.request(`/v1/jobs/${encodeURIComponent(jobId)}`, { method: "GET" });
    return (await response.json()) as JobSnapshot;
  }

  async cancelJob(jobId: string): Promise<JobSnapshot> {
    const response = await this.request(`/v1/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    });
    return (await response.json()) as JobSnapshot;
  }

  async listJobs(): Promise<JobListResponse> {
    return this.requestJson<JobListResponse>("/v1/jobs", { method: "GET" });
  }

  private async getActiveJob(): Promise<JobSnapshot | null> {
    const { activeJobId, jobs } = await this.listJobs();
    if (!activeJobId) return null;
    const activeJob = jobs.find((snapshot) => snapshot.jobId === activeJobId);
    return activeJob && !TERMINAL_STATUSES[activeJob.status] ? activeJob : null;
  }

  async watchJob(
    jobId: string,
    onSnapshot: (snapshot: JobSnapshot) => void,
    signal: AbortSignal,
    onConnection: (error: string | null) => void = () => {},
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        const terminal = await this.consumeJobEvents(
          jobId,
          (snapshot) => {
            onConnection(null);
            onSnapshot(snapshot);
          },
          signal,
        );
        if (terminal || signal.aborted) return;
      } catch (error) {
        if (signal.aborted) return;
        let snapshot: JobSnapshot;
        try {
          snapshot = await this.getJob(jobId);
          onConnection(null);
        } catch (readError) {
          onConnection(readError instanceof Error ? readError.message : String(readError));
          await delay(1000, undefined, { signal }).catch(() => undefined);
          continue;
        }
        this.logJobSnapshot(snapshot);
        onSnapshot(snapshot);
        if (TERMINAL_STATUSES[snapshot.status]) return;
        this.log?.write("job", "event-stream-reconnecting", {
          jobId,
          error: error instanceof Error ? error.message : String(error),
        });
        console.warn("nicegal-server job event stream disconnected; reconnecting", error);
      }
      await delay(500, undefined, { signal }).catch(() => undefined);
    }
  }

  private async consumeJobEvents(
    jobId: string,
    onSnapshot: (snapshot: JobSnapshot) => void,
    signal: AbortSignal,
  ): Promise<boolean> {
    const response = await this.request(`/v1/jobs/${encodeURIComponent(jobId)}/events`, {
      method: "GET",
      signal,
    });
    if (!response.body) throw new Error("nicegal-server job event response has no body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const chunk = await reader.read();
        // Normalize after appending: CR and LF may arrive in separate fetch chunks.
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        buffer = buffer.replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const snapshot = parseSnapshotEvent(block);
          if (snapshot) {
            this.logJobSnapshot(snapshot);
            onSnapshot(snapshot);
            if (TERMINAL_STATUSES[snapshot.status]) return true;
          }
          boundary = buffer.indexOf("\n\n");
        }
        if (chunk.done) return false;
      }
      return false;
    } finally {
      reader.releaseLock();
    }
  }

  private async requestJson<T>(input: string | URL, init: RequestInit): Promise<T> {
    const response = await this.request(input, init);
    return (await response.json()) as T;
  }

  private async request(input: string | URL, init: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? new URL(input, this.endpoint) : input;
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    const startedAt = Date.now();
    this.log?.write("http", "request-started", { method, path: url.pathname });
    let response: Response;
    try {
      response = await fetch(url, { ...init, headers });
    } catch (error) {
      this.log?.write(
        "http",
        init.signal?.aborted ? "request-cancelled" : "request-transport-failed",
        {
          method,
          path: url.pathname,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      throw error;
    }
    if (!response.ok) {
      const detail = await response.text();
      this.log?.write("http", "request-failed", {
        method,
        path: url.pathname,
        status: response.status,
        durationMs: Date.now() - startedAt,
        detail: detail.slice(0, 4_096),
      });
      const apiError = parseErrorResponse(detail);
      if (apiError) {
        throw new NicegalServerError(apiError.code, apiError.message, response.status);
      }
      throw new Error(
        `nicegal-server ${method} ${url.pathname} failed (${response.status}): ${detail}`,
      );
    }
    this.log?.write("http", "request-completed", {
      method,
      path: url.pathname,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return response;
  }

  private logJobSnapshot(snapshot: JobSnapshot): void {
    const previous = this.jobLogState.get(snapshot.jobId);
    const timestamp = Date.now();
    if (
      previous &&
      previous.phase === snapshot.phase &&
      previous.status === snapshot.status &&
      timestamp - previous.timestamp < 1_000
    ) {
      return;
    }
    this.jobLogState.set(snapshot.jobId, {
      timestamp,
      phase: snapshot.phase,
      status: snapshot.status,
    });
    this.log?.write("job", "snapshot", snapshot);
    if (TERMINAL_STATUSES[snapshot.status]) this.jobLogState.delete(snapshot.jobId);
  }
}

class NicegalServerError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NicegalServerError";
  }
}

function parseErrorResponse(detail: string): { code: string | undefined; message: string } | null {
  let body: unknown;
  try {
    body = JSON.parse(detail) as unknown;
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;

  const envelope = body as Record<string, unknown>;
  const error = "error" in envelope ? envelope.error : envelope;
  if (typeof error === "string") return { code: undefined, message: error };
  if (!error || typeof error !== "object") return null;

  const value = error as Record<string, unknown>;
  if (typeof value.message !== "string") return null;
  return {
    code: typeof value.code === "string" ? value.code : undefined,
    message: value.message,
  };
}

function parseSnapshotEvent(block: string): JobSnapshot | null {
  const lines = block.split("\n");
  const event = lines
    .find((line) => line.startsWith("event:"))
    ?.slice(6)
    .trim();
  if (event && event !== "snapshot") return null;
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return data ? (JSON.parse(data) as JobSnapshot) : null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
