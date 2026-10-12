#!/usr/bin/env bash
# Only this repository is writable; no source-repo drafts or Code feed updates.
set -euo pipefail
assets="${1:?assets directory required}"
repo=otterware-app/otterware-releases
: "${VERSION:?}" "${CHANNEL:?}" "${SOURCE_SHA:?}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-otterware\.[0-9]{8}\.[0-9]+$ ]]
[[ "$CHANNEL" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]
tag="otterware-v$VERSION"
rolling="channel-$CHANNEL"
notes="$(mktemp)"
feed="$(mktemp -d)"
trap 'rm -f "$notes"; rm -rf "$feed"' EXIT
cat > "$notes" <<EOF
Otterware $VERSION for channel $CHANNEL.
Source: $SOURCE_SHA in $GITHUB_REPOSITORY.
Build: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID.
EOF
# An existing immutable tag is an error: reruns must not replace released builds.
gh release create "$tag" "$assets"/* --repo "$repo" --prerelease --latest=false \
  --title "Otterware $VERSION ($CHANNEL)" --notes-file "$notes"

# Pin manifest downloads to the immutable release. Replacing a rolling feed can
# never strand a client that already read its previous manifest.
python3 - "$assets" "$feed" "$repo" "$tag" <<'PY'
from pathlib import Path
import sys,re
assets,feed,repo,tag=sys.argv[1:]
for source in Path(assets).glob('latest*.yml'):
    def pin(match):
        return match[1] + 'https://github.com/' + repo + '/releases/download/' + tag + '/' + match[2]
    text=re.sub(r'(?m)^(\s*(?:- )?(?:url|path):\s*)([^\s]+)[ \t]*$', pin, source.read_text())
    (Path(feed)/source.name).write_text(text)
PY
if gh release view "$rolling" --repo "$repo" >/dev/null 2>&1; then
  # Do not let an older queued build rewind a branch channel.
  gh release download "$rolling" --repo "$repo" --pattern SHA256SUMS --dir "$feed"
  previous="$(sed -n 's/.*  t3-\(.*\)-linux-x64.tar.gz$/\1/p' "$feed/SHA256SUMS")"
  [[ "$previous" =~ ^[0-9]+\.[0-9]+\.[0-9]+-otterware\.[0-9]{8}\.[0-9]+$ ]]
  newest="$(printf '%s\n%s\n' "$VERSION" "$previous" | sort -V | tail -n 1)"
  if [[ "$newest" != "$VERSION" || "$previous" == "$VERSION" ]]; then
    echo "Immutable build published; channel already follows $previous, leaving it unchanged."
    exit 0
  fi
else
  # The releases-only repo has its own commits: never use the source repo SHA as target.
  gh release create "$rolling" --repo "$repo" --prerelease --latest=false \
    --title "Otterware channel $CHANNEL" --notes-file "$notes"
fi
# The rolling manifests have different bytes from the immutable originals.
# Hash the pinned manifests while preserving all other asset checksums.
python3 - "$assets" "$feed" <<'PY_SUMS'
from pathlib import Path
import hashlib,sys
assets,feed=map(Path,sys.argv[1:])
lines=[]
for asset in sorted(assets.iterdir()):
    if asset.name == 'SHA256SUMS': continue
    source=feed/asset.name if (feed/asset.name).is_file() else asset
    lines.append(hashlib.sha256(source.read_bytes()).hexdigest()+'  '+asset.name+'\n')
(feed/'SHA256SUMS').write_text(''.join(lines))
PY_SUMS
# Upload binaries before the feed, then replace manifests last. A Linux-only
# run retains the last mac feed, whose URLs still target its immutable release.
for asset in "$assets"/*; do
  [[ "$asset" == *.yml || "$asset" == */SHA256SUMS ]] && continue
  gh release upload "$rolling" "$asset" --repo "$repo" --clobber
done
gh release upload "$rolling" "$feed/SHA256SUMS" --repo "$repo" --clobber
gh release upload "$rolling" "$feed"/latest*.yml --repo "$repo" --clobber
gh release edit "$rolling" --repo "$repo" --notes-file "$notes"
# Old binaries are still reachable through immutable releases. Keep the rolling
# release bounded; preserve metadata for platforms this build did not produce.
while IFS= read -r old; do
  [[ "$old" == *.yml || "$old" == SHA256SUMS || -f "$assets/$old" ]] && continue
  gh release delete-asset "$rolling" "$old" --repo "$repo" --yes
done < <(gh release view "$rolling" --repo "$repo" --json assets --jq '.assets[].name')
