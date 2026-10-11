export interface UpdateStatus {
  phase: "disabled" | "idle" | "checking" | "downloading" | "ready" | "available" | "error";
  version: string | null;
  /** Bullet points from that version's release notes, as plain text. */
  notes: string[];
}

export interface UpdatePreferences {
  enabled: boolean;
  mode: "automatic" | "notify" | "none";
}

export interface UpdateBridge {
  getPreferences(): Promise<UpdatePreferences>;
  setEnabled(enabled: boolean): Promise<UpdatePreferences>;
  getStatus(): Promise<UpdateStatus>;
  onStatusChanged(listener: (status: UpdateStatus) => void): () => void;
  openReleaseNotes(): Promise<void>;
  restartAndInstall(): Promise<void>;
}
