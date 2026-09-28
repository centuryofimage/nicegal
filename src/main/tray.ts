import { app, Menu, nativeImage, Tray, type BrowserWindow } from "electron";

/** Launch argument the login item passes, so a sign-in start stays in the tray. */
export const HIDDEN_LAUNCH_ARG = "--hidden";

export interface TrayOptions {
  minimizeToTray: boolean;
  closeToTray: boolean;
}

/**
 * Lets the window hide to the notification area while Nicegal keeps serving paired devices. The
 * icon exists only while a tray option is on or the window is hidden, so it never strands a
 * hidden window without a way back.
 */
export class TrayController {
  private tray: Tray | null = null;
  private options: TrayOptions = { minimizeToTray: false, closeToTray: false };

  constructor(
    private readonly iconPath: string,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly isQuitting: () => boolean,
  ) {}

  /** Wires one window's minimize and close. Call for each window created. */
  attach(window: BrowserWindow): void {
    window.on("minimize", () => {
      if (this.options.minimizeToTray) this.hide(window);
    });
    window.on("close", (event) => {
      if (!this.options.closeToTray || this.isQuitting()) return;
      event.preventDefault();
      this.hide(window);
    });
  }

  setOptions(options: TrayOptions): void {
    this.options = options;
    this.sync();
  }

  /** Starts hidden, e.g. when opened at sign-in. */
  hide(window: BrowserWindow): void {
    window.hide();
    this.sync();
  }

  show(): void {
    const window = this.getWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    this.sync();
  }

  private sync(): void {
    const window = this.getWindow();
    const needed =
      this.options.minimizeToTray ||
      this.options.closeToTray ||
      (window !== null && !window.isVisible());
    if (needed && !this.tray) {
      const icon = nativeImage.createFromPath(this.iconPath).resize({ width: 16, height: 16 });
      this.tray = new Tray(icon);
      this.tray.setToolTip("Nicegal");
      this.tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Open Nicegal", click: () => this.show() },
          { type: "separator" },
          { label: "Quit", click: () => app.quit() },
        ]),
      );
      this.tray.on("click", () => this.show());
    } else if (!needed && this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}
