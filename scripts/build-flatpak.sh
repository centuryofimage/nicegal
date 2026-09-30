#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"
version=${1:?Usage: scripts/build-flatpak.sh VERSION}
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid version' >&2; exit 1; }
test -x dist/linux-unpacked/nicegal
test -x dist/linux-unpacked/resources/nicegal-server/nicegal-server
python3 scripts/prepare-flatpak-desktop.py
# Run inside the packaging container, with a persistent /var/lib/flatpak mount.
flatpak remote-add --system --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --system --noninteractive -y flathub \
    org.freedesktop.Platform//26.08 org.freedesktop.Sdk//26.08 org.electronjs.Electron2.BaseApp//26.08
flatpak-builder --force-clean --disable-rofiles-fuse --disable-download --repo=dist/flatpak-repo \
    dist/flatpak-build packaging/flatpak/io.github.centuryofimage.nicegal.yml
python3 scripts/check-flatpak-runtime.py dist/flatpak-build
flatpak build-update-repo --generate-static-deltas dist/flatpak-repo
# Keep repository objects and history for hosting and future incremental exports.
tar -cf dist/flatpak-repo.tar -C dist flatpak-repo
flatpak build-bundle --runtime-repo=https://flathub.org/repo/flathub.flatpakrepo \
    dist/flatpak-repo "dist/nicegal-$version-linux-x86_64.flatpak" io.github.centuryofimage.nicegal
