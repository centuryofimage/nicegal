import { type WebContents } from "electron";
import { isAbsolute } from "node:path";

import type {
  BackendStatus,
  CreateLibraryRequest,
  EnsureThumbnailsRequest,
  ExecutionProviderId,
  JobRequest,
  JobSnapshot,
  LibraryDefinition,
  LibraryId,
  LibraryPurgeJobRequest,
  LibraryScanJobRequest,
  OcrModelLoadTarget,
  SearchRequest,
  ThumbnailJobRequest,
  Timeline,
  RuntimeStatus,
} from "../../shared/backend";
import type { NicegalServerClient } from "./nicegal-server-client";

import { IPC_CHANNELS } from "../../shared/ipc-channels";
import { handleTrustedIpc, type IpcSenderValidator } from "../ipc";

interface BackendIpcContext {
  status: BackendStatus;
  client: NicegalServerClient | null;
  isTrustedSender: IpcSenderValidator;
  restartForRuntimeChange: () => Promise<void>;
  restartFailedBackend: () => Promise<void>;
}

interface JobSubscription {
  listeners: Set<WebContents>;
  abort: AbortController;
}

interface SenderSearches {
  session: number;
  closed: boolean;
  lanes: Map<NonNullable<SearchRequest["searchLane"]> | "legacy", AbortController>;
}

function abortSearches(searches: SenderSearches | undefined): void {
  if (!searches) return;
  for (const abort of searches.lanes.values()) abort.abort();
  searches.lanes.clear();
  searches.closed = true;
}

export function registerBackendIpc(context: BackendIpcContext): void {
  const subscriptions = new Map<string, JobSubscription>();
  const searchRequests = new Map<number, SenderSearches>();
  // Senders that already have a one-shot "destroyed" cleanup hook registered — see
  // `ensureSenderTracked`. Prevents accumulating one listener per subscribeJob/search call.
  const trackedSenders = new Set<WebContents>();

  const requireBackend = (): NicegalServerClient => {
    if (!context.client) {
      throw new Error(context.status.error ?? "nicegal-server is not ready");
    }
    return context.client;
  };

  const removeSubscription = (jobId: string, sender: WebContents): void => {
    const subscription = subscriptions.get(jobId);
    if (!subscription) return;
    subscription.listeners.delete(sender);
    if (subscription.listeners.size === 0) {
      subscription.abort.abort();
      subscriptions.delete(jobId);
    }
  };

  const removeSender = (sender: WebContents): void => {
    for (const [jobId] of subscriptions) removeSubscription(jobId, sender);
    abortSearches(searchRequests.get(sender.id));
    searchRequests.delete(sender.id);
  };

  // Registers the destroyed-cleanup hook for `sender` exactly once, no matter how many times
  // (or from which handler — search, subscribeJob, ...) it is called for that sender.
  const ensureSenderTracked = (sender: WebContents): void => {
    if (trackedSenders.has(sender)) return;
    trackedSenders.add(sender);
    sender.once("destroyed", () => {
      trackedSenders.delete(sender);
      removeSender(sender);
    });
  };

  handleTrustedIpc(IPC_CHANNELS.backend.status, context.isTrustedSender, () => context.status);
  handleTrustedIpc(IPC_CHANNELS.backend.restartServer, context.isTrustedSender, () =>
    context.restartFailedBackend(),
  );
  let changingRuntime = false;
  let startingJobs = 0;
  const changeRuntime = async (
    update: (client: NicegalServerClient) => Promise<RuntimeStatus>,
  ): Promise<RuntimeStatus> => {
    if (changingRuntime) throw new Error("Search settings change already in progress");
    if (startingJobs > 0) throw new Error("A job is starting; try again when it finishes");
    changingRuntime = true;
    try {
      const status = await update(requireBackend());
      if (status.restartRequired) await context.restartForRuntimeChange();
      return await requireBackend().getRuntimeStatus();
    } finally {
      changingRuntime = false;
    }
  };
  handleTrustedIpc(
    IPC_CHANNELS.backend.setImageModel,
    context.isTrustedSender,
    async (_event, model: unknown) => {
      if (typeof model !== "string" || model.length > 200) throw new Error("Invalid image model");
      return changeRuntime((client) => client.setImageModel(model));
    },
  );
  handleTrustedIpc(IPC_CHANNELS.backend.getRuntimeStatus, context.isTrustedSender, () =>
    requireBackend().getRuntimeStatus(),
  );
  handleTrustedIpc(
    IPC_CHANNELS.backend.setExecutionProvider,
    context.isTrustedSender,
    (_event, value: unknown) => {
      const provider = validateExecutionProvider(value);
      return changeRuntime((client) => client.setExecutionProvider(provider));
    },
  );
  handleTrustedIpc(IPC_CHANNELS.backend.listLibraries, context.isTrustedSender, () =>
    requireBackend().listLibraries(),
  );
  handleTrustedIpc(
    IPC_CHANNELS.backend.createLibrary,
    context.isTrustedSender,
    (_event, value: unknown) => requireBackend().createLibrary(validateCreateLibrary(value)),
  );
  handleTrustedIpc(
    IPC_CHANNELS.backend.updateLibrary,
    context.isTrustedSender,
    (_event, libraryId: unknown, definition: unknown) =>
      requireBackend().updateLibrary(
        validateLibraryId(libraryId),
        validateLibraryDefinition(definition),
      ),
  );
  handleTrustedIpc(
    IPC_CHANNELS.backend.deleteLibrary,
    context.isTrustedSender,
    (_event, libraryId: unknown) => requireBackend().deleteLibrary(validateLibraryId(libraryId)),
  );
  handleTrustedIpc(
    IPC_CHANNELS.backend.listAssets,
    context.isTrustedSender,
    (_event, value: unknown) => {
      const { libraryId, timeline } = validateListAssetsRequest(value);
      return requireBackend().listAssets(libraryId, timeline);
    },
  );
  handleTrustedIpc(
    IPC_CHANNELS.backend.listFolders,
    context.isTrustedSender,
    (_event, value: unknown) => requireBackend().listFolders(validateLibraryId(value)),
  );
  handleTrustedIpc(
    IPC_CHANNELS.backend.assetMetadata,
    context.isTrustedSender,
    (_event, value: unknown) => {
      if (
        typeof value !== "string" ||
        !/^[1-9]\d*$/.test(value) ||
        !Number.isSafeInteger(Number(value))
      ) {
        throw new TypeError("Asset ID must be a safe positive decimal string");
      }
      return requireBackend().getAssetMetadata(value);
    },
  );
  handleTrustedIpc(IPC_CHANNELS.backend.catalogRevision, context.isTrustedSender, () =>
    requireBackend().getRevision(),
  );
  handleTrustedIpc(
    IPC_CHANNELS.backend.countAssets,
    context.isTrustedSender,
    (_event, value: unknown) => requireBackend().countAssets(validateLibraryId(value)),
  );
  handleTrustedIpc(
    IPC_CHANNELS.backend.getImageEmbeddingCoverage,
    context.isTrustedSender,
    (_event, value: unknown) => {
      return requireBackend().getImageEmbeddingCoverage(validateLibraryId(value));
    },
  );
  handleTrustedIpc(
    IPC_CHANNELS.backend.getTextEmbeddingCoverage,
    context.isTrustedSender,
    (_event, value: unknown) => {
      return requireBackend().getTextEmbeddingCoverage(validateLibraryId(value));
    },
  );
  handleTrustedIpc(IPC_CHANNELS.backend.getOcrModels, context.isTrustedSender, () =>
    requireBackend().getOcrModels(),
  );
  handleTrustedIpc(IPC_CHANNELS.backend.getSearchModels, context.isTrustedSender, () =>
    requireBackend().getSearchModels(),
  );
  handleTrustedIpc(IPC_CHANNELS.backend.search, context.isTrustedSender, async (event, value) => {
    const request = validateSearchRequest(value);
    ensureSenderTracked(event.sender);
    let searches = searchRequests.get(event.sender.id);
    if (!searches) {
      searches = { session: -1, closed: true, lanes: new Map() };
      searchRequests.set(event.sender.id, searches);
    }
    const { searchSession, searchLane, ...backendRequest } = request;
    if (searchSession === undefined) {
      abortSearches(searches);
    } else {
      if (
        searchSession < searches.session ||
        (searchSession === searches.session && searches.closed)
      ) {
        throw new DOMException("Search session was superseded", "AbortError");
      }
      if (searchSession > searches.session) {
        abortSearches(searches);
        searches.session = searchSession;
        searches.closed = false;
      }
    }
    const lane = searchLane ?? "legacy";
    searches.lanes.get(lane)?.abort();
    const abort = new AbortController();
    searches.lanes.set(lane, abort);
    try {
      const response = await requireBackend().search(backendRequest, abort.signal);
      abort.signal.throwIfAborted();
      return response;
    } finally {
      if (searches.lanes.get(lane) === abort) searches.lanes.delete(lane);
    }
  });
  handleTrustedIpc(IPC_CHANNELS.backend.cancelSearch, context.isTrustedSender, (event) => {
    abortSearches(searchRequests.get(event.sender.id));
  });
  // Deliberately not cancelled by a later call, unlike search: an in-flight ensure represents
  // real generation work already committed toward SQLite, so aborting it would only throw away
  // completed work and force a retry. The renderer's own flush loop already serializes its calls;
  // see the "flushing" guard in VirtualGallery.svelte.
  handleTrustedIpc(
    IPC_CHANNELS.backend.ensureThumbnails,
    context.isTrustedSender,
    async (_event, value) => {
      const request = validateEnsureThumbnailsRequest(value);
      return requireBackend().ensureThumbnails(request);
    },
  );
  handleTrustedIpc(
    IPC_CHANNELS.backend.startJob,
    context.isTrustedSender,
    async (_event, value) => {
      if (changingRuntime) throw new Error("Search settings change already in progress");
      startingJobs += 1;
      try {
        return await requireBackend().startJob(validateJobRequest(value));
      } finally {
        startingJobs -= 1;
      }
    },
  );
  handleTrustedIpc(IPC_CHANNELS.backend.listJobs, context.isTrustedSender, () =>
    requireBackend().listJobs(),
  );
  handleTrustedIpc(IPC_CHANNELS.backend.cancelJob, context.isTrustedSender, (_event, value) => {
    return requireBackend().cancelJob(validateJobId(value));
  });
  handleTrustedIpc(IPC_CHANNELS.backend.subscribeJob, context.isTrustedSender, (event, value) => {
    const jobId = validateJobId(value);
    const client = requireBackend();
    let subscription = subscriptions.get(jobId);
    if (!subscription) {
      // Captured by name in the closures below (instead of re-reading the mutable outer
      // `subscription` binding) so each invocation's watch loop only ever acts on — and only
      // ever tears down — the exact subscription object it created. Without this, an aborted
      // watch whose promise settles late can delete a *newer* subscription that has since taken
      // its place at the same jobId key, orphaning the new watch's snapshots (see finding notes).
      const created: JobSubscription = {
        listeners: new Set<WebContents>(),
        abort: new AbortController(),
      };
      subscription = created;
      subscriptions.set(jobId, created);
      void client
        .watchJob(
          jobId,
          (snapshot: JobSnapshot) => {
            if (subscriptions.get(jobId) !== created) return;
            for (const listener of created.listeners) {
              if (!listener.isDestroyed()) {
                listener.send(IPC_CHANNELS.backend.jobSnapshot, { jobId, snapshot });
              }
            }
          },
          created.abort.signal,
          (error) => {
            if (subscriptions.get(jobId) !== created) return;
            for (const listener of created.listeners) {
              if (!listener.isDestroyed())
                listener.send(IPC_CHANNELS.backend.jobConnection, { jobId, error });
            }
          },
        )
        .catch((error: unknown) => {
          if (!created.abort.signal.aborted) {
            console.error(`Job ${jobId} subscription failed`, error);
          }
        })
        .finally(() => {
          if (subscriptions.get(jobId) === created) subscriptions.delete(jobId);
        });
    }
    subscription.listeners.add(event.sender);
    ensureSenderTracked(event.sender);
  });
  handleTrustedIpc(IPC_CHANNELS.backend.unsubscribeJob, context.isTrustedSender, (event, value) => {
    removeSubscription(validateJobId(value), event.sender);
  });
}

function validateTimeline(value: unknown): Timeline {
  if (value !== "modified" && value !== "capture") throw new TypeError("Invalid timeline");
  return value;
}

function validateListAssetsRequest(value: unknown): {
  libraryId: LibraryId;
  timeline: Timeline;
} {
  if (!value || typeof value !== "object") throw new TypeError("Invalid asset listing request");
  const request = value as { libraryId?: unknown; timeline?: unknown };
  return {
    libraryId: validateLibraryId(request.libraryId),
    timeline: validateTimeline(request.timeline),
  };
}

function validateLibraryId(value: unknown): LibraryId {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new TypeError("Invalid library ID");
  return value;
}

function validateFolderList(value: unknown, allowEmpty: boolean): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.length > 1_000 ||
    !value.every((path) => typeof path === "string" && path.length <= 32_767 && isAbsolute(path))
  )
    throw new TypeError("Library folders must be absolute paths");
  return value as string[];
}

function validateLibraryDefinition(value: unknown): LibraryDefinition {
  const { videos, ...definition } = validateLibraryFields(value, []);
  if (videos === undefined) throw new TypeError("Invalid library search options");
  return { ...definition, videos };
}

function validateCreateLibrary(value: unknown): CreateLibraryRequest {
  return validateLibraryFields(value, ["importKey"]);
}

/** Shared by update and create. `videos` is optional here; the backend defaults it on create. */
function validateLibraryFields(
  value: unknown,
  extraFields: readonly string[],
): CreateLibraryRequest {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, ["include", "exclude", "ocr", "image", "videos", ...extraFields])
  )
    throw new TypeError("Invalid library definition");
  const { ocr, image, videos, importKey } = value;
  if (
    typeof ocr !== "boolean" ||
    typeof image !== "boolean" ||
    (videos !== undefined && typeof videos !== "boolean")
  )
    throw new TypeError("Invalid library search options");
  if (importKey !== undefined && (typeof importKey !== "string" || importKey.length > 32_800))
    throw new TypeError("Invalid library import key");
  return {
    include: validateFolderList(value.include, false),
    exclude: validateFolderList(value.exclude, true),
    ocr,
    image,
    ...(videos === undefined ? {} : { videos }),
    ...(importKey === undefined ? {} : { importKey }),
  };
}

function validateExecutionProvider(value: unknown): ExecutionProviderId {
  if (
    value !== "cpu" &&
    value !== "directml" &&
    value !== "openvino" &&
    value !== "cuda" &&
    value !== "webgpu" &&
    value !== "coreml"
  ) {
    throw new TypeError("Invalid execution provider");
  }
  return value;
}

function validateJobId(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new TypeError("Invalid job ID");
  return value;
}

function validateSearchRequest(value: unknown): SearchRequest {
  if (!value || typeof value !== "object") throw new TypeError("Invalid search request");
  const request = value as Partial<SearchRequest>;
  if (
    (request.searchSession === undefined) !== (request.searchLane === undefined) ||
    (request.searchSession !== undefined &&
      (!Number.isSafeInteger(request.searchSession) || request.searchSession < 0)) ||
    (request.searchLane !== undefined &&
      request.searchLane !== "literal" &&
      request.searchLane !== "files" &&
      request.searchLane !== "meaning" &&
      request.searchLane !== "visual")
  ) {
    throw new TypeError("Invalid search session or lane");
  }
  if (
    typeof request.query !== "string" ||
    request.query.length > 10_000 ||
    (request.type !== "ocrSimple" &&
      request.type !== "ocrMatch" &&
      request.type !== "ocrGlob" &&
      request.type !== "name" &&
      request.type !== "path" &&
      request.type !== "vector" &&
      request.type !== "image") ||
    typeof request.libraryId !== "number" ||
    !Number.isSafeInteger(request.libraryId) ||
    request.libraryId < 1 ||
    (request.folder !== undefined &&
      (typeof request.folder !== "string" || request.folder.length > 4096)) ||
    (request.pathContains !== undefined &&
      (typeof request.pathContains !== "string" || request.pathContains.length > 4096)) ||
    (request.limit !== undefined &&
      (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 250_000))
  ) {
    throw new TypeError("Invalid search request");
  }
  if (request.imageQuery !== undefined && !validateImageQuery(request.imageQuery)) {
    throw new TypeError("Invalid image query");
  }
  if (request.imageQuery !== undefined && request.type !== "image") {
    throw new TypeError("Image components require image search");
  }
  if (request.imageQuery === undefined && !request.query.trim()) {
    throw new TypeError("Search query is required");
  }
  return request as SearchRequest;
}

function validateImageQuery(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !Array.isArray(value.components) ||
    !value.components.length ||
    value.components.length > 16
  )
    return false;
  let imageBytes = 0;
  return value.components.every((component) => {
    if (
      !isRecord(component) ||
      typeof component.weight !== "number" ||
      !Number.isFinite(component.weight) ||
      component.weight === 0 ||
      Math.abs(component.weight) > 100
    )
      return false;
    const sources =
      Number("text" in component) +
      Number("assetId" in component) +
      Number("externalImage" in component);
    if (sources !== 1) return false;
    if (typeof component.text === "string")
      return (
        component.text.trim().length > 0 && new TextEncoder().encode(component.text).length <= 4096
      );
    if (typeof component.assetId === "number")
      return Number.isSafeInteger(component.assetId) && component.assetId > 0;
    if (
      !isRecord(component.externalImage) ||
      typeof component.externalImage.bytesBase64 !== "string"
    )
      return false;
    const bytes = component.externalImage.bytesBase64.length;
    imageBytes += bytes;
    return bytes > 0 && bytes <= 22_369_624 && imageBytes <= 44_739_248;
  });
}

function validateEnsureThumbnailsRequest(value: unknown): EnsureThumbnailsRequest {
  if (!value || typeof value !== "object") throw new TypeError("Invalid ensure-thumbnails request");
  const request = value as Partial<EnsureThumbnailsRequest>;
  if (
    !Array.isArray(request.assetIds) ||
    request.assetIds.length === 0 ||
    request.assetIds.length > 500 ||
    !request.assetIds.every((id) => typeof id === "string" && /^\d+$/.test(id)) ||
    typeof request.requiredSize !== "number" ||
    !Number.isInteger(request.requiredSize) ||
    request.requiredSize < 1 ||
    request.requiredSize > 1024
  ) {
    throw new TypeError("Invalid ensure-thumbnails request");
  }
  return request as EnsureThumbnailsRequest;
}

// Uniformly strict across every job type: validates that `value` is `{ type, params }` with no
// extra top-level keys, that `params` is a record, and that `params` itself carries only the
// given whitelist of keys. Returns the whitelisted-shape params record for the branch to pick
// apart and rebuild explicitly — nothing from `params` should ever be spread through as-is.
function requireJobParams(
  value: Record<string, unknown>,
  paramFields: readonly string[],
  errorMessage: string,
): Record<string, unknown> {
  const params = (value as { params?: unknown }).params;
  if (
    !hasOnlyFields(value, ["type", "params"]) ||
    !isRecord(params) ||
    !hasOnlyFields(params, paramFields)
  ) {
    throw new TypeError(errorMessage);
  }
  return params;
}

function validateJobRequest(value: unknown): JobRequest {
  if (!isRecord(value)) throw new TypeError("Invalid job request");
  const request = value as { type?: unknown; params?: unknown };
  if (request.type === "modelPrepare") {
    requireJobParams(value, [], "Invalid model preparation job");
    return { type: "modelPrepare", params: {} };
  }
  if (request.type === "libraryScan") {
    const params = requireJobParams(
      value,
      ["libraryId", "scanMode", "pendingOnly", "retryFailed", "debugLimit"],
      "Invalid library scan job",
    );
    if (
      (params.scanMode !== undefined && params.scanMode !== "full" && params.scanMode !== "fast") ||
      (params.pendingOnly !== undefined && typeof params.pendingOnly !== "boolean") ||
      (params.retryFailed !== undefined && typeof params.retryFailed !== "boolean") ||
      (params.debugLimit !== undefined &&
        (typeof params.debugLimit !== "number" ||
          !Number.isSafeInteger(params.debugLimit) ||
          params.debugLimit <= 0))
    ) {
      throw new TypeError("Invalid library scan job");
    }
    const job: LibraryScanJobRequest = {
      type: "libraryScan",
      params: {
        libraryId: validateLibraryId(params.libraryId),
        ...(params.scanMode === undefined ? {} : { scanMode: params.scanMode as "full" | "fast" }),
        ...(params.pendingOnly === undefined ? {} : { pendingOnly: params.pendingOnly as boolean }),
        ...(params.retryFailed === undefined ? {} : { retryFailed: params.retryFailed as boolean }),
        ...(params.debugLimit === undefined ? {} : { debugLimit: params.debugLimit as number }),
      },
    };
    return job;
  }
  if (request.type === "ocrModelLoad") {
    const params = requireJobParams(
      value,
      ["detection", "recognition"],
      "Invalid OCR model load job",
    );
    return {
      type: "ocrModelLoad",
      params: {
        detection: validateOcrModelLoadTarget(params.detection),
        recognition: validateOcrModelLoadTarget(params.recognition),
      },
    };
  }
  if (request.type === "pruneMissing") {
    const params = requireJobParams(
      value,
      ["libraryId", "dryRun"],
      "Invalid missing-file prune job",
    );
    if (typeof params.dryRun !== "boolean") {
      throw new TypeError("Invalid missing-file prune job");
    }
    return {
      type: "pruneMissing",
      params: { libraryId: validateLibraryId(params.libraryId), dryRun: params.dryRun },
    };
  }
  if (request.type === "libraryPurge") {
    const params = requireJobParams(value, ["libraryId", "folders"], "Invalid library purge job");
    const job: LibraryPurgeJobRequest = {
      type: "libraryPurge",
      params: {
        libraryId: validateLibraryId(params.libraryId),
        // Folders removed from or excluded by an edit; omitted to purge the whole library.
        ...(params.folders === undefined
          ? {}
          : { folders: validateFolderList(params.folders, false) }),
      },
    };
    return job;
  }
  if (request.type === "thumbnailGenerate") {
    const params = requireJobParams(
      value,
      ["libraryId", "buckets", "force", "sweepStale", "timeline", "range"],
      "Invalid thumbnail generation job",
    );
    if (!isThumbnailGenerateParams(params)) throw new TypeError("Invalid thumbnail generation job");
    const job: ThumbnailJobRequest = {
      type: "thumbnailGenerate",
      params: {
        ...params,
        libraryId: validateLibraryId(params.libraryId),
      },
    };
    return job;
  }
  throw new TypeError("Unsupported job type");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}

function validateOcrModelLoadTarget(value: unknown): OcrModelLoadTarget {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, ["modelId", "revision", "filename", "configFilename"]) ||
    typeof value.modelId !== "string" ||
    value.modelId.length === 0 ||
    (value.revision !== undefined && typeof value.revision !== "string") ||
    (value.filename !== undefined && typeof value.filename !== "string") ||
    (value.configFilename !== undefined && typeof value.configFilename !== "string")
  ) {
    throw new TypeError("Invalid OCR model load job");
  }
  return {
    modelId: value.modelId,
    ...(value.revision === undefined ? {} : { revision: value.revision }),
    ...(value.filename === undefined ? {} : { filename: value.filename }),
    ...(value.configFilename === undefined ? {} : { configFilename: value.configFilename }),
  };
}

function isThumbnailGenerateParams(value: unknown): value is ThumbnailJobRequest["params"] {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, ["libraryId", "buckets", "force", "sweepStale", "timeline", "range"]) ||
    (value.buckets !== undefined &&
      (!Array.isArray(value.buckets) ||
        !value.buckets.every(
          (bucket) => bucket === 128 || bucket === 256 || bucket === 512 || bucket === 1024,
        ))) ||
    (value.force !== undefined && typeof value.force !== "boolean") ||
    (value.sweepStale !== undefined && typeof value.sweepStale !== "boolean") ||
    (value.timeline !== undefined && value.timeline !== "modified" && value.timeline !== "capture")
  ) {
    return false;
  }
  return isTimelineRange(value.range);
}

function isTimelineRange(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      hasOnlyFields(value, ["fromNs", "toNs"]) &&
      (value.fromNs === undefined || typeof value.fromNs === "string") &&
      (value.toNs === undefined || typeof value.toNs === "string"))
  );
}
