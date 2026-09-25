export type Timeline = "modified" | "capture";

export interface BackendStatus {
  ready: boolean;
  error: string | null;
  /** A deliberate provider fallback may resume the user's indexing intent once ready. */
  restartReason?: "provider-fallback" | "runtime-change";
}

/** See `nicegal_core::runtime::ExecutionProvider`. */
export type ExecutionProviderId = "cpu" | "directml" | "openvino" | "webgpu" | "coreml";

export interface ImageModelStatus {
  activeModel: string;
  selectedModel: string;
  supportsTextQueries: boolean;
  restartRequired: boolean;
  models: {
    id: string;
    name: string;
    dimensions: number;
    license: string;
    url: string;
    available: boolean;
    supportsTextQueries: boolean;
  }[];
}

/** `GET`/`PUT /v1/runtime` — the ONNX Runtime provider nicegal-server is running with, and the
 * persisted choice for its next launch. They differ right after a change, since the server never
 * replaces its already-loaded runtime in place. */
export interface RuntimeStatus {
  availableExecutionProviders?: ExecutionProviderId[];
  imageModel: ImageModelStatus;
  activeExecutionProvider: string;
  activeRuntimeDistribution: string;
  onnxRuntimeBuildInfo: string;
  configuredExecutionProvider: string;
  restartRequired: boolean;
}

export interface GalleryAsset {
  id: string;
  path: string;
  displayName: string;
  /** File-system extension as written on disk, without its leading dot. */
  extension: string | null;
  modifiedNs: string;
  /** Source file creation time when the platform exposes one. */
  createdNs: string | null;
  captureNs: string | null;
  sourceSize: string;
  mediaKind: "image" | "video";
  mediaFormat: string;
  width: number | null;
  height: number | null;
  animated: boolean;
  frameCount: number | null;
  durationMs: number | null;
}

/** A folder in a library's tree: a configured root or a directory from a completed scan. */
export interface FolderEntry {
  path: string;
  /** Directory modification time at its latest completed scan, or null before one. */
  modifiedNs: string | null;
}

export interface AssetMetadata {
  asset: GalleryAsset;
  file: {
    sourceState: "current" | "changed" | "missing" | "unavailable";
    attributes: string[];
    exif: Array<{ label: string; value: string }>;
    video: Array<{ label: string; value: string }>;
    error: string | null;
  };
  ocrState: "indexed" | "stale" | "notIndexed";
  /** Recognized text for the current file fingerprint, or null until OCR has indexed it. */
  ocrText: string | null;
  imageIndexed: boolean;
  textState: "notIndexed" | "noText" | "embedded" | "pending";
  decodeFailed: boolean;
}

/** Canonical file details and OCR state from the Rust asset lookup API. Main-process OS
 * integrations resolve renderer-supplied IDs here rather than trusting renderer-supplied paths. */
export interface CatalogAssetDetails {
  id: string;
  path: string;
  displayName: string;
  folderPath: string | null;
  extension: string | null;
  modifiedNs: string;
  createdNs: string | null;
  captureNs: string | null;
  sourceSize: number;
  mediaKind: "image" | "video";
  mediaFormat: string;
  width: number | null;
  height: number | null;
  animated: boolean;
  frameCount: number | null;
  durationMs: number | null;
  indexState: "indexed" | "stale" | "notIndexed";
}

export interface ResolveAssetsResponse {
  assets: CatalogAssetDetails[];
  missingAssetIds: string[];
}

export interface NativeFileMenuRequest {
  assetIds: string[];
}

/** A session-only snapshot chosen through Electron's native file picker. It is never catalogued. */
export interface ExternalVisualReference {
  displayName: string;
  bytesBase64: string;
}

export interface SearchRequest {
  /** IPC-only generation, increasing within this renderer's lifetime. Supply with searchLane. */
  searchSession?: number;
  /** Independent requests in one session may run concurrently; each lane is latest-wins. */
  searchLane?: "literal" | "files" | "meaning" | "visual";
  query: string;
  type: "ocrSimple" | "ocrMatch" | "ocrGlob" | "vector" | "image" | "name" | "path";
  libraryId: LibraryId;
  folder?: string;
  /** Case-insensitive substring of the indexed full path. */
  pathContains?: string;
  limit?: number;
  before?: string;
  after?: string;
  /** Required by the backend whenever a time bound is present. */
  timeline?: Timeline;
  /** Structured CLIP components use POST /v1/search. `query` stays empty: sending it as well
   * would add the text a second time to the composite direction. */
  imageQuery?: ImageQuery;
}

export type ImageQueryComponent =
  | { text: string; weight: number }
  | { assetId: number; weight: number }
  | { externalImage: { bytesBase64: string }; weight: number };

export interface ImageQuery {
  components: ImageQueryComponent[];
}

/** OCR-text embedding coverage for one library — `GET /v1/text-embeddings`. Tells "nothing
 * matched" apart from "nothing has been text-embedded yet". */
export interface TextEmbeddingCoverage {
  indexed: number;
  embedded: number;
  pending: number;
  /**
   * Unix seconds of the newest indexed source file under the root, or null when nothing is
   * indexed. The backend has no wall-clock record of when indexing ran, so this is its stand-in;
   * an older server omits the field entirely, which reads as null here.
   */
  lastIndexedAt: number | null;
}

/** Current CLIP coverage for cataloged images and videos in one library. */
export interface ImageEmbeddingCoverage {
  total: number;
  indexed: number;
}

export interface SearchResult {
  assetId: string;
  snippet: string;
  /** Winning indexed video frame for a visual-search hit, in milliseconds. */
  timestampMs?: number;
  /**
   * Position in this mode's own final ranking, from 1 — already reranked server-side, so the
   * response array is in rank order. Absent from an older server, where response order is the
   * only ranking signal there is.
   */
  rank?: number;
  /** Cosine distance for OCR-vector and CLIP image hits; absent from literal OCR matches. */
  distance?: number;
  /**
   * The mode's own relevance score: FTS5 `bm25()` for `match` (lower is better) or matching-word
   * count for `glob` (higher is better). Not comparable across modes — use `rank` for ordering.
   */
  score?: number;
}

export interface SearchResponse {
  total: number;
  results: SearchResult[];
}

export type JobStatus = "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed";

export type JobPhase =
  | "queued"
  | "downloadingModels"
  | "loadingModels"
  | "scanning"
  | "cataloging"
  | "thumbnails"
  | "ocr"
  | "imageEmbedding"
  | "textEmbedding"
  | "cleanup"
  | "pruning"
  | "finished";

export interface JobProgress {
  discovered: number;
  /** Denominator of the CURRENT phase (null = phase progress is indeterminate). */
  total: number | null;
  /** Items completed within the CURRENT phase — pair with `total` for the within-phase bar. */
  phaseCompleted: number;
  /** Backend-measured average rate for this phase; null before any work completes.
   * OCR excludes skipped images, including results retained when resuming.
   * Optional while an older backend binary is in use. */
  itemsPerSecond?: number | null;
  processed: number;
  cataloged: number;
  thumbnailsGenerated: number;
  thumbnailFailures: number;
  pruneCandidates: number;
  embedded: number;
  indexed: number;
  skipped: number;
  failed: number;
  deleted: number;
  downloadedBytes: number;
  downloadTotalBytes: number;
  /** Current model file; absent for cache hits and while loading sessions. */
  download?: {
    modelId: string;
    filename: string;
    downloadedBytes: number;
    /** Zero while the remote size is unknown. */
    totalBytes: number;
  };
  modelsLoaded: number;
}

export interface JobItemError {
  path?: string;
  message: string;
}

export interface JobSnapshot {
  indexStages?: { ocr: boolean; image: boolean; text: boolean };
  jobId: string;
  /** The library a library job belongs to; absent for model preparation. */
  libraryId?: LibraryId;
  type:
    | "ocrModelLoad"
    | "modelPrepare"
    | "libraryScan"
    | "thumbnailGenerate"
    | "pruneMissing"
    | "libraryPurge";
  /** Per-folder progress of a `libraryScan`, in walk order. */
  folders?: ScanFolderProgress[];
  status: JobStatus;
  phase: JobPhase;
  progress: JobProgress;
  /** In-flight paths, including parallel workers; cleared on phase changes and completion. */
  activeAssetPaths?: string[];
  errors: JobItemError[];
  error?: string;
}

/** A backend library ID, from `GET /v1/libraries`. */
export type LibraryId = number;

/** Why a folder's latest scan did not finish. */
export type ScanOutcome = "unavailable" | "incomplete" | "cancelled" | "failed";

/** One included folder of a library — `GET /v1/libraries`. */
export interface LibraryFolder {
  path: string;
  /** An edit revealed more of this folder and no complete scan of it has finished since. */
  scanPending: boolean;
  /** Why the latest scan of this folder did not finish; cleared by the next complete scan. */
  scanOutcome?: ScanOutcome | null;
  /** Human-readable detail for `scanOutcome`. */
  scanError: string | null;
  /** Decimal Unix nanoseconds of the last complete scan. */
  lastScanCompletedNs: string | null;
}

/** A backend library: included folders minus excluded folders. It has no stored name. */
export interface Library {
  id: LibraryId;
  include: LibraryFolder[];
  exclude: string[];
  /** Search indexes `libraryScan` maintains for this library. */
  ocr: boolean;
  image: boolean;
}

/** The editable part of a library, as `POST`/`PUT /v1/libraries` accept it. */
export interface LibraryDefinition {
  include: string[];
  exclude: string[];
  ocr: boolean;
  image: boolean;
}

export interface CreateLibraryRequest extends LibraryDefinition {
  /** Makes creation idempotent, and lets an import keep a currently missing folder. */
  importKey?: string;
}

export type ScanFolderState =
  | "queued"
  | "scanning"
  | "scanned"
  | "completed"
  | "incomplete"
  | "unavailable"
  | "failed"
  | "cancelled";

export interface ScanFolderProgress {
  path: string;
  scanMode?: "full" | "fast";
  state: ScanFolderState;
  discovered: number;
  cataloged: number;
  failed: number;
  error: string | null;
}

/**
 * A scan of a library's folders. The backend never scans on its own; the frontend requests one
 * when a library is created, edited, or opened. When the worker is busy the backend queues it:
 * at most one scan waits, a request for the same library merges into it, and one for another
 * library replaces it. Video and OCR-model choices come from the backend's runtime settings.
 */
export interface LibraryScanJobRequest {
  type: "libraryScan";
  params: {
    libraryId: LibraryId;
    /** Fast checks directory mtimes, with a full walk when the backend decides one is due. */
    scanMode?: "full" | "fast";
    /** Walk only folders with `scanPending` set, including ones whose last scan failed. */
    pendingOnly?: boolean;
    /** Retry sources whose earlier decode failed. */
    retryFailed?: boolean;
    /** Debug cap applied to each folder's walk. */
    debugLimit?: number;
  };
}

/** `GET /v1/jobs`: the running job, and every retained or queued job. */
export interface JobListResponse {
  activeJobId: string | null;
  jobs: JobSnapshot[];
}

export interface OcrModelLoadTarget {
  modelId: string;
  revision?: string;
  filename?: string;
  configFilename?: string;
}

export interface OcrModelLoadJobRequest {
  type: "ocrModelLoad";
  params: {
    detection: OcrModelLoadTarget;
    recognition: OcrModelLoadTarget;
  };
}

export const DEFAULT_OCR_MODEL_LOAD_REQUEST: OcrModelLoadJobRequest = {
  type: "ocrModelLoad",
  params: {
    detection: {
      modelId: "PaddlePaddle/PP-OCRv6_small_det_onnx",
      revision: "main",
      filename: "inference.onnx",
      configFilename: "inference.yml",
    },
    recognition: {
      modelId: "PaddlePaddle/PP-OCRv6_small_rec_onnx",
      revision: "main",
      filename: "inference.onnx",
      configFilename: "inference.yml",
    },
  },
};

export interface OcrLoadedModel {
  modelId: string;
  revision: string;
  filename: string;
}

export interface OcrModelsResponse {
  loaded?: {
    detection: OcrLoadedModel;
    recognition: OcrLoadedModel;
    executionProvider: string;
  };
}

export interface SearchModelStatus {
  state: "notLoaded" | "preparing" | "ready" | "failed" | "unsupported";
  error: string | null;
}

export interface SearchModelsResponse {
  text: SearchModelStatus;
  clipImage: SearchModelStatus;
  clipText: SearchModelStatus;
}

export interface ThumbnailJobRequest {
  type: "thumbnailGenerate";
  params: {
    libraryId: LibraryId;
    buckets?: Array<128 | 256 | 512 | 1024>;
    force?: boolean;
    sweepStale?: boolean;
    timeline?: Timeline;
    range?: { fromNs?: string; toNs?: string };
  };
}

export interface PruneMissingJobRequest {
  type: "pruneMissing";
  params: {
    libraryId: LibraryId;
    dryRun: boolean;
  };
}

export interface LibraryPurgeJobRequest {
  type: "libraryPurge";
  params: {
    libraryId: LibraryId;
    /** When supplied, remove only indexed files in these former library folders. */
    folders?: string[];
  };
}

export type JobRequest =
  | { type: "modelPrepare"; params: Record<string, never> }
  | OcrModelLoadJobRequest
  | LibraryScanJobRequest
  | ThumbnailJobRequest
  | PruneMissingJobRequest
  | LibraryPurgeJobRequest;

/**
 * Synchronous on-demand thumbnail generation for a visible-tile batch — `POST /v1/thumbnails`,
 * distinct from the background `thumbnailGenerate` job. Generator version 1 no longer builds
 * thumbnails eagerly during `libraryScan`; the gallery calls this for whatever is actually on screen.
 */
export interface EnsureThumbnailsRequest {
  assetIds: string[];
  /** Physical pixels; 1 through 1024. Selects the smallest adequate fixed bucket. */
  requiredSize: number;
}

export interface EnsureThumbnailsResponse {
  assetIds: string[];
  requiredSize: number;
  sizeBucket: number;
  generatorVersion: number;
}

export interface BackendBridge {
  getBackendStatus(): Promise<BackendStatus>;
  /** Receives a fresh `BackendStatus` whenever the main process's view of it changes on its own —
   * today, only when the nicegal-server process exits unexpectedly. */
  onBackendStatusChanged(listener: (status: BackendStatus) => void): () => void;
  getRuntimeStatus(): Promise<RuntimeStatus>;
  setImageModel(model: string): Promise<RuntimeStatus>;
  setExecutionProvider(executionProvider: ExecutionProviderId): Promise<RuntimeStatus>;
  /** Saves whether scans index video frames; applies to scans queued afterwards. */
  setIndexVideos(indexVideos: boolean): Promise<void>;
  listLibraries(): Promise<Library[]>;
  createLibrary(request: CreateLibraryRequest): Promise<Library>;
  updateLibrary(libraryId: LibraryId, definition: LibraryDefinition): Promise<Library>;
  deleteLibrary(libraryId: LibraryId): Promise<void>;
  listAssets(options: { libraryId: LibraryId; timeline: Timeline }): Promise<GalleryAsset[]>;
  listFolders(libraryId: LibraryId): Promise<FolderEntry[]>;
  countAssets(libraryId: LibraryId): Promise<number>;
  getAssetMetadata(assetId: string): Promise<AssetMetadata>;
  getCatalogRevision(): Promise<string>;
  getOcrModels(): Promise<OcrModelsResponse>;
  getSearchModels(): Promise<SearchModelsResponse>;
  searchOcr(request: SearchRequest): Promise<SearchResponse>;
  /** Abort all current searches and close their session. The next session must be newer. */
  cancelSearch(): Promise<void>;
  getTextEmbeddingCoverage(libraryId: LibraryId): Promise<TextEmbeddingCoverage>;
  getImageEmbeddingCoverage(libraryId: LibraryId): Promise<ImageEmbeddingCoverage>;
  startJob(request: JobRequest): Promise<JobSnapshot>;
  listJobs(): Promise<JobListResponse>;
  cancelJob(jobId: string): Promise<JobSnapshot>;
  subscribeJob(
    jobId: string,
    listener: (snapshot: JobSnapshot) => void,
    onConnection?: (error: string | null) => void,
  ): () => void;
  ensureThumbnails(request: EnsureThumbnailsRequest): Promise<EnsureThumbnailsResponse>;
}

export interface NativeBridge {
  getAppInfo(): Promise<import("./diagnostics").AppInfo>;
  collectDiagnostics(): Promise<string | null>;
  openExternalUrl(url: string): Promise<void>;
  openLicenseInformation(): Promise<void>;
  /** `defaultPath` opens the picker inside a folder, e.g. an included folder when excluding. */
  chooseDirectory(defaultPath?: string): Promise<string | null>;
  chooseVisualSearchImage(): Promise<ExternalVisualReference | null>;
  onAddToVisualSearch(listener: (assetIds: string[], replace: boolean) => void): () => void;
  showFileContextMenu(request: NativeFileMenuRequest): Promise<void>;
  prepareFileDrag(request: NativeFileMenuRequest): Promise<string>;
  startFileDrag(token: string): Promise<void>;
}

export interface NicegalBridge {
  updates: import("./updates").UpdateBridge;
  backend: BackendBridge;
  native: NativeBridge;
}
