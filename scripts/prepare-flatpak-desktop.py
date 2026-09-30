"""Use the same desktop metadata as electron-builder, with Flatpak's launcher/ID."""

import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
config = json.loads((root / "build/linux-desktop.json").read_text(encoding="utf-8"))
entries: dict[str, str] = config["linux"]["desktop"]["entry"]
desktop = "[Desktop Entry]\n" + "".join(f"{key}={value}\n" for key, value in entries.items())
desktop += "Exec=nicegal %U\nIcon=io.github.centuryofimage.nicegal\n"
destination = root / "dist/io.github.centuryofimage.nicegal.desktop"
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(desktop, encoding="utf-8", newline="\n")
