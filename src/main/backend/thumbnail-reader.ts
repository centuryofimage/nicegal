import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface ThumbnailRecord {
  encoding: string;
  data: Uint8Array;
  sizeBucket: number;
  width: number;
  height: number;
  /** True when this came from the fingerprint-ignoring fallback: the source changed since this
   * variant was generated, and a fresh one has not been backfilled yet. */
  stale: boolean;
}

interface ThumbnailRow {
  size_bucket: bigint;
  width: bigint;
  height: bigint;
  encoding: string;
  data: Uint8Array;
}

const THUMBNAIL_SCHEMA_VERSION = 4n;
// Keep in sync with nicegal-core's video::SAMPLING_VERSION.
const VIDEO_SAMPLING_VERSION = 4n;

export class ThumbnailReader {
  private readonly database: DatabaseSync;
  private readonly lookup: StatementSync;
  private readonly staleLookup: StatementSync;
  private readonly sampleLookup: StatementSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path, { readOnly: true });
    const versionQuery = this.database.prepare("PRAGMA user_version");
    versionQuery.setReadBigInts(true);
    const version = versionQuery.get() as { user_version: bigint };
    if (version.user_version !== THUMBNAIL_SCHEMA_VERSION) {
      this.database.close();
      throw new Error(
        `Unsupported thumbnail schema version ${version.user_version}; expected ${THUMBNAIL_SCHEMA_VERSION}`,
      );
    }

    this.lookup = this.database.prepare(`
      SELECT size_bucket, width, height, encoding, data
      FROM thumbnails
      WHERE asset_id = $assetId
        AND generator_version = $generatorVersion
        AND source_modified_ns = $sourceModifiedNs
        AND source_size = $sourceSize
      ORDER BY CASE WHEN size_bucket >= $requestedSize THEN 0 ELSE 1 END,
               CASE WHEN size_bucket >= $requestedSize THEN size_bucket END ASC,
               CASE WHEN size_bucket < $requestedSize THEN size_bucket END DESC
      LIMIT 1
    `);
    this.lookup.setReadBigInts(true);

    // Fingerprint-ignoring fallback: used only when the strict lookup above misses because the
    // source file changed since this asset's thumbnails were generated. Returning a stale variant
    // rather than a 404/blank tile while a backfill catches up is deliberate. The primary key is
    // (asset_id, size_bucket, generator_version) with no fingerprint component, so at most one row
    // exists per bucket regardless of how stale it is.
    this.staleLookup = this.database.prepare(`
      SELECT size_bucket, width, height, encoding, data
      FROM thumbnails
      WHERE asset_id = $assetId
        AND generator_version = $generatorVersion
      ORDER BY CASE WHEN size_bucket >= $requestedSize THEN 0 ELSE 1 END,
               CASE WHEN size_bucket >= $requestedSize THEN size_bucket END ASC,
               CASE WHEN size_bucket < $requestedSize THEN size_bucket END DESC
      LIMIT 1
    `);
    this.staleLookup.setReadBigInts(true);

    this.sampleLookup = this.database.prepare(`
      SELECT size_bucket, width, height, encoding, data
      FROM video_thumbnails
      WHERE asset_id = $assetId
        AND timestamp_ms = $timestampMs
        AND sampling_version = $samplingVersion
        AND source_modified_ns = $sourceModifiedNs
        AND source_size = $sourceSize
      ORDER BY CASE WHEN size_bucket >= $requestedSize THEN 0 ELSE 1 END,
               CASE WHEN size_bucket >= $requestedSize THEN size_bucket END ASC,
               CASE WHEN size_bucket < $requestedSize THEN size_bucket END DESC
      LIMIT 1
    `);
    this.sampleLookup.setReadBigInts(true);
  }

  get(
    assetId: string,
    generatorVersion: number,
    sourceModifiedNs: string,
    sourceSize: string,
    requestedSize: number,
  ): ThumbnailRecord | null {
    const params = {
      $assetId: BigInt(assetId),
      $generatorVersion: BigInt(generatorVersion),
      $requestedSize: BigInt(requestedSize),
    };
    const strictRow = this.lookup.get({
      ...params,
      $sourceModifiedNs: BigInt(sourceModifiedNs),
      $sourceSize: BigInt(sourceSize),
    }) as unknown as ThumbnailRow | undefined;
    if (strictRow) return toRecord(strictRow, false);

    const staleRow = this.staleLookup.get(params) as unknown as ThumbnailRow | undefined;
    return staleRow ? toRecord(staleRow, true) : null;
  }

  /** Return the exact frame scored by visual search; never substitute a different timestamp. */
  getVideoSample(
    assetId: string,
    timestampMs: number,
    sourceModifiedNs: string,
    sourceSize: string,
    requestedSize: number,
  ): ThumbnailRecord | null {
    const row = this.sampleLookup.get({
      $assetId: BigInt(assetId),
      $timestampMs: BigInt(timestampMs),
      $samplingVersion: VIDEO_SAMPLING_VERSION,
      $sourceModifiedNs: BigInt(sourceModifiedNs),
      $sourceSize: BigInt(sourceSize),
      $requestedSize: BigInt(requestedSize),
    }) as unknown as ThumbnailRow | undefined;
    return row ? toRecord(row, false) : null;
  }

  close(): void {
    this.database.close();
  }
}

function toRecord(row: ThumbnailRow, stale: boolean): ThumbnailRecord {
  return {
    encoding: row.encoding,
    data: row.data,
    sizeBucket: Number(row.size_bucket),
    width: Number(row.width),
    height: Number(row.height),
    stale,
  };
}
