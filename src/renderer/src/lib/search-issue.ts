import type { SearchModelsResponse } from "../../../shared/backend";

import { m } from "../../../shared/paraglide/messages.js";

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

type NamedModel = keyof SearchModelsResponse;

/** In reporting order: search models first, then the indexing models a rescan rebuilds. */
const modelNames: Record<NamedModel, () => string> = {
  text: () => m.search_issue_model_text(),
  clipImage: () => m.search_issue_model_image(),
  clipText: () => m.search_issue_model_picture(),
  textIndex: () => m.search_issue_model_text_index(),
  ocr: () => m.search_issue_model_text_recognition(),
};

export function searchIssue(runtime: {
  error?: string | null;
  imageModelError?: string | null;
  modelError?: string | null;
  models?: SearchModelsResponse | null;
}): SearchIssue | null {
  if (runtime.imageModelError)
    return {
      key: `model-switch:${runtime.imageModelError}`,
      label: m.search_issue_model_switch_failed_label(),
      guidance: m.search_issue_model_switch_failed_guidance(),
      detail: runtime.imageModelError,
      action: "settings",
    };
  if (runtime.error)
    return {
      key: `runtime:${runtime.error}`,
      label: m.search_issue_settings_problem_label(),
      guidance: m.search_issue_settings_problem_guidance(),
      detail: runtime.error,
      action: "settings",
    };
  if (runtime.modelError)
    return {
      key: `models:${runtime.modelError}`,
      label: m.search_issue_status_unavailable_label(),
      guidance: m.search_issue_status_unavailable_guidance(),
      detail: runtime.modelError,
      action: "retry",
    };
  const failed = runtime.models
    ? (Object.keys(modelNames) as NamedModel[]).find(
        (key) => runtime.models![key].state === "failed" && runtime.models![key].error,
      )
    : undefined;
  if (!failed) return null;
  const error = runtime.models![failed].error ?? "";
  return {
    key: `model:${failed}:${error}`,
    label: m.search_issue_model_failed_label(),
    guidance: m.search_issue_model_failed_guidance({ model: modelNames[failed]() }),
    detail: error,
    action: "rescan",
  };
}
