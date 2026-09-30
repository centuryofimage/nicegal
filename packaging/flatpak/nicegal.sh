#!/bin/sh
set -eu
# Flatpak supplies private XDG directories. Keep multi-GB model downloads persistent,
# without exposing the host's Hugging Face cache or depending on a writable home.
export HF_HOME="${HF_HOME:-$XDG_CACHE_HOME/huggingface}"
export GTK_USE_PORTAL=1
unset APPIMAGE APPDIR
platform=x11
if [ -n "${WAYLAND_DISPLAY:-}" ] && [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]; then
    platform=wayland
fi
exec zypak-wrapper /app/nicegal/nicegal --ozone-platform="$platform" --xdg-portal-required-version=1 "$@"
