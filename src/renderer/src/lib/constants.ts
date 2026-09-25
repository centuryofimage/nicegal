/** Legacy single-library root. Imported into backend libraries by `CatalogController`. */
export const LIBRARY_ROOT_STORAGE_KEY = "nicegal.libraryRoot.v1";

/** Retired root-based registry. Imported into backend libraries once and kept for rollback. */
export const LIBRARIES_STORAGE_KEY = "nicegal.libraries.v2";

/** Selected backend library ID and per-library view preferences (name, query, scroll). */
export const LIBRARY_VIEWS_STORAGE_KEY = "nicegal.libraries.v3";

/** The persisted gallery settings blob. */
export const SETTINGS_STORAGE_KEY = "nicegal.settings.v1";

/** Set after the first-start orientation splash has been dismissed. */
export const ONBOARDING_DISMISSED_STORAGE_KEY = "nicegal.onboardingDismissed.v1";

/** Pending resumable-job intent, retained across an interrupted indexing job. */
export const JOB_RESUME_STORAGE_KEY = "nicegal.jobResume.v1";
