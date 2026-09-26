import type { SearchModelsResponse } from "../../../shared/backend";

/**
 * A search setup failure worth a persistent status-bar warning. The status bar shows `label`; the
 * search problem dialog shows `guidance`, `detail` and the recovery `action`.
 */
export interface SearchIssue {
  /** Changes when the failure changes, so a dismissed warning comes back for a new one. */
  key: string;
  label: string;
  guidance: string;
  /** Technical text for copying. */
  detail: string;
  /** `rescan` prepares the models again; `settings` opens Settings > Search; `retry` rereads status. */
  action: "rescan" | "settings" | "retry";
}

const modelNames: Record<keyof SearchModelsResponse, string> = {
  text: "Related text",
  clipImage: "Image search",
  clipText: "Picture description",
};

export function searchIssue(runtime: {
  error?: string | null;
  modelError?: string | null;
  models?: SearchModelsResponse | null;
}): SearchIssue | null {
  if (runtime.error)
    return {
      key: `runtime:${runtime.error}`,
      label: "Search settings problem",
      guidance: "Search settings couldn't be read or changed. Open Search settings and try again.",
      detail: runtime.error,
      action: "settings",
    };
  if (runtime.modelError)
    return {
      key: `models:${runtime.modelError}`,
      label: "Search status unavailable",
      guidance: "Nicegal couldn't check whether search is ready. Try again.",
      detail: runtime.modelError,
      action: "retry",
    };
  const failed = runtime.models
    ? (Object.keys(modelNames) as (keyof SearchModelsResponse)[]).find(
        (key) => runtime.models![key].state === "failed" && runtime.models![key].error,
      )
    : undefined;
  if (!failed) return null;
  const error = runtime.models![failed].error ?? "";
  return {
    key: `model:${failed}:${error}`,
    label: "Search model failed",
    guidance: `The ${modelNames[failed].toLowerCase()} model couldn't be prepared. Rescan the library to try again, or choose another model or execution provider in Search settings.`,
    detail: error,
    action: "rescan",
  };
}
