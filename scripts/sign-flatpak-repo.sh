#!/usr/bin/env bash
set -euo pipefail
source_repo=${1:?Source repository required}
site=${2:?Destination directory required}
key_id=${3:?Signing fingerprint required}
export GNUPGHOME=$(mktemp -d)
trap 'rm -rf "$GNUPGHOME"' EXIT
printf 'allow-preset-passphrase\n' > "$GNUPGHOME/gpg-agent.conf"
# Receive the private key through stdin, never through a file in the checkout.
gpg --batch --import
if [ -n "${FLATPAK_GPG_PASSPHRASE:-}" ]; then
    preset_passphrase="$(gpgconf --list-dirs libexecdir)/gpg-preset-passphrase"
    while IFS= read -r keygrip; do
        printf '%s' "$FLATPAK_GPG_PASSPHRASE" | \
            "$preset_passphrase" --preset "$keygrip"
    done < <(gpg --batch --with-colons --with-keygrip --list-secret-keys "$key_id" | \
        awk -F: '$1 == "grp" { print $10 }')
fi
bash "$(dirname -- "${BASH_SOURCE[0]}")/publish-flatpak-repo.sh" "$source_repo" "$site" "$key_id"
