import type { ExternalVisualReference } from "../../../shared/backend";
import type { OcrSearchController } from "./ocr-search.svelte";

import { m } from "../../../shared/paraglide/messages.js";
import { visualFileBase64 } from "./visual-file";

const MEBIBYTE = 1024 * 1024;
const VISUAL_FILE_LIMIT_BYTES = 16 * MEBIBYTE;

/** Image imports belong to the visual-search session that requested them.
 * Clearing or changing scope while a picker/read is pending discards the late result. */
export async function addDroppedVisualFiles(
  ocrSearch: OcrSearchController,
  files: File[],
): Promise<void> {
  const session = ocrSearch.visualSessionRevision;
  const accepted: ExternalVisualReference[] = [];
  for (const file of files.slice(0, 16)) {
    if (file.size > VISUAL_FILE_LIMIT_BYTES) {
      ocrSearch.error = m.visual_search_file_too_large({
        name: file.name,
        limit: VISUAL_FILE_LIMIT_BYTES / MEBIBYTE,
      });
      continue;
    }
    let bytesBase64: string;
    try {
      bytesBase64 = await visualFileBase64(file);
    } catch (error: unknown) {
      if (session === ocrSearch.visualSessionRevision) {
        ocrSearch.error = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    if (session !== ocrSearch.visualSessionRevision) return;
    accepted.push({ displayName: file.name, bytesBase64 });
  }
  if (accepted.length && session === ocrSearch.visualSessionRevision)
    ocrSearch.addExternalReferences(accepted);
}

export async function chooseVisualFile(ocrSearch: OcrSearchController): Promise<void> {
  const session = ocrSearch.visualSessionRevision;
  try {
    const reference = await window.nicegal.native.chooseVisualSearchImage();
    if (reference && session === ocrSearch.visualSessionRevision) {
      ocrSearch.addExternalReferences([reference]);
    }
  } catch (error: unknown) {
    if (session === ocrSearch.visualSessionRevision) {
      ocrSearch.error = error instanceof Error ? error.message : String(error);
    }
  }
}
