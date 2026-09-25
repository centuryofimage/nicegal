import type {
  ExecutionProviderId,
  RuntimeStatus,
  ImageModelStatus,
  SearchModelsResponse,
} from "../../../shared/backend";

import { errorMessage } from "./errors";

/**
 * The ONNX Runtime execution provider nicegal-server is running with, and the switcher's
 * pending state while a change is in flight. One instance is shared by `App.svelte` so the
 * Indexing Options switcher and the status bar's provider segment never disagree.
 */
export class RuntimeController {
  status = $state<RuntimeStatus | null>(null);
  loading = $state(true);
  /** True while a `setExecutionProvider` call is in flight. The server persists the setting with
   * a fixed temp-file path, so two overlapping writes can race each other's rename — serialize
   * from this side rather than let a fast double-click reach the server at all. */
  saving = $state(false);
  error = $state<string | null>(null);
  models = $state<SearchModelsResponse | null>(null);
  modelError = $state<string | null>(null);
  get imageModel(): ImageModelStatus | null {
    return this.status?.imageModel ?? null;
  }
  get supportsImageTextQueries(): boolean {
    return this.imageModel?.supportsTextQueries ?? true;
  }
  imageModelSaving = $state(false);
  imageModelError = $state<string | null>(null);
  private statusGeneration = 0;
  private modelGeneration = 0;

  reset(): void {
    this.statusGeneration += 1;
    this.modelGeneration += 1;
    this.status = null;
    this.models = null;
    this.loading = true;
    this.error = null;
    this.modelError = null;
  }

  /** The provider shared by loaded indexing models, or the launch choice before any model loads. */
  get activeProvider(): string | null {
    return this.status?.loadedExecutionProvider ?? this.status?.activeExecutionProvider ?? null;
  }

  async refresh(): Promise<void> {
    // A read started during a provider write can return the old configuration and win the race.
    if (this.saving || this.imageModelSaving) return;
    const generation = ++this.statusGeneration;
    this.loading = true;
    this.error = null;
    try {
      const status = await window.nicegal.backend.getRuntimeStatus();
      if (generation === this.statusGeneration) this.status = status;
    } catch (error) {
      if (generation === this.statusGeneration) this.error = errorMessage(error);
    } finally {
      if (generation === this.statusGeneration) this.loading = false;
    }
  }

  /** Refresh the shared provider after a model load without toggling the settings loading state. */
  async refreshLoadedProvider(): Promise<void> {
    if (this.saving || this.imageModelSaving) return;
    const generation = ++this.statusGeneration;
    try {
      const status = await window.nicegal.backend.getRuntimeStatus();
      if (generation === this.statusGeneration && !this.saving && !this.imageModelSaving)
        this.status = status;
    } catch (error) {
      if (generation === this.statusGeneration) this.modelError = errorMessage(error);
    }
  }

  async refreshModels(): Promise<void> {
    const generation = ++this.modelGeneration;
    try {
      const models = await window.nicegal.backend.getSearchModels();
      if (generation !== this.modelGeneration) return;
      this.models = models;
      this.modelError = null;
      await this.refreshLoadedProvider();
    } catch (error) {
      if (generation === this.modelGeneration) this.modelError = errorMessage(error);
    }
  }

  async setImageModel(model: string): Promise<void> {
    if (this.imageModelSaving || this.saving) return;
    this.statusGeneration += 1;
    this.imageModelSaving = true;
    this.imageModelError = null;
    try {
      this.status = await window.nicegal.backend.setImageModel(model);
      await this.refreshModels();
    } catch (error) {
      this.imageModelError = errorMessage(error);
    } finally {
      this.imageModelSaving = false;
      this.loading = false;
    }
  }

  async setExecutionProvider(executionProvider: ExecutionProviderId): Promise<void> {
    if (this.saving || this.imageModelSaving) return;
    this.statusGeneration += 1;
    this.saving = true;
    this.error = null;
    try {
      this.status = await window.nicegal.backend.setExecutionProvider(executionProvider);
      await this.refreshModels();
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.saving = false;
      this.loading = false;
    }
  }
}
