#!/usr/bin/env bash
set -euo pipefail
source_repo=${1:?Source OSTree repository required}
site=${2:?Destination site directory required}
key_id=${3:?Signing key ID required}
app_id=io.github.centuryofimage.nicegal
url=https://centuryofimage.github.io/nicegal-flatpak
mkdir -p "$site/repo"
if [ ! -f "$site/repo/config" ]; then
    ostree --repo="$site/repo" init --mode=archive-z2
fi
# Import into the existing repository so the previous release remains a parent.
flatpak build-commit-from --src-repo="$source_repo" --gpg-sign="$key_id" \
    --update-appstream "$site/repo" "app/$app_id/x86_64/master"
gpg --batch --export "$key_id" > "$site/nicegal.gpg"
test -s "$site/nicegal.gpg"
flatpak build-update-repo --gpg-sign="$key_id" --gpg-import="$site/nicegal.gpg" \
    --title=Nicegal --default-branch=master --generate-static-deltas "$site/repo"
public_key=$(base64 --wrap=0 "$site/nicegal.gpg")
cat > "$site/nicegal.flatpakrepo" <<EOF
[Flatpak Repo]
Title=Nicegal
Url=$url/repo
Homepage=https://github.com/centuryofimage/nicegal
Description=Nicegal desktop gallery releases
GPGKey=$public_key
EOF
cat > "$site/nicegal.flatpakref" <<EOF
[Flatpak Ref]
Title=Nicegal
Name=$app_id
Branch=master
Url=$url/repo
SuggestRemoteName=nicegal
Homepage=https://github.com/centuryofimage/nicegal
RuntimeRepo=https://flathub.org/repo/flathub.flatpakrepo
IsRuntime=false
GPGKey=$public_key
EOF
touch "$site/.nojekyll"
cat > "$site/.gitignore" <<'EOF'
/repo/.lock
/repo/tmp/
/repo/state/
EOF
cat > "$site/index.html" <<'EOF'
<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Nicegal Flatpak</title>
<h1>Nicegal Flatpak</h1>
<p><a href="nicegal.flatpakref">Install Nicegal</a> (experimental).</p>
<p>This registers the Nicegal repository for future Flatpak updates.</p>
<pre>flatpak install --user https://centuryofimage.github.io/nicegal-flatpak/nicegal.flatpakref</pre>
<p><a href="https://github.com/centuryofimage/nicegal">Source and release notes</a></p>
</html>
EOF
