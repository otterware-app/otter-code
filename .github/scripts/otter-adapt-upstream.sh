#!/usr/bin/env bash
# Adapts upstream files to the fork. Rerun this after every sync rebase and
# commit the result last in the fork stack (see OTTER.md), so upstream edits to
# these lines never cause rebase conflicts. Each edit is a no-op if upstream
# renames what it matches.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Blacksmith runners -> GitHub-hosted runners.
# macOS jobs use macos-15: GitHub's macos-26 image rejects electron-builder <26.16.1's
# keychain unlock (electron-userland/electron-builder#10066). Move to macos-26 once
# upstream pins electron-builder 26.16.1 or later.
find .github -name '*.yml' -print0 | xargs -0 sed -i.bak -E \
  -e 's/blacksmith-[0-9]+vcpu-ubuntu-2404/ubuntu-24.04/g' \
  -e 's/blacksmith-[0-9]+vcpu-macos-26/macos-15/g' \
  -e 's/blacksmith-[0-9]+vcpu-windows-2025/windows-2025/g'
find .github -name '*.yml.bak' -delete

# Upstream sizes release job timeouts for 8-vCPU Blacksmith runners; the 4-vCPU
# GitHub-hosted runners need about twice as long (the release test suite alone
# takes ~10 minutes there).
perl -pi -e 's/^(    timeout-minutes: )10$/${1}20/' .github/workflows/release.yml

# Otter Code ships macOS and Linux only: skip the Windows desktop jobs, let the
# release proceed without them, and stop expecting .exe assets.
perl -0pi -e '
  s/(\n  desktop_win_(?:x64|arm64):\n(?:    .*\n)*?    if: )\$\{\{.*?\}\}/$1\${{ false }}/g;
  s/needs\.desktop_win_(x64|arm64)\.result == \x27success\x27/needs.desktop_win_$1.result != \x27failure\x27/g;
  s/\n[ \t]*echo \x27release-assets\/\*\.exe\x27//g;
' .github/workflows/release.yml

# Keep Cloudflare hosting at the fork's deployment boundary. Upstream retains
# its Vercel implementation; Otter stages a Worker version and promotes it only
# after the desktop/CLI release exists.
python3 - <<'PY'
from pathlib import Path
import re

def fork_block(action):
    return f'''\n          if [[ "${{GITHUB_REPOSITORY}}" == "otterware-app/otter-code" ]]; then
            node scripts/otter/web-hosting.mjs {action}
            exit 0
          fi
'''

def adapt_job(text, name, action, entries):
    pattern = rf"(^  {name}:\n.*?)(?=^  [a-zA-Z0-9_]+:\n|\Z)"
    match = re.search(pattern, text, re.M | re.S)
    if not match:
        raise SystemExit(f"Missing upstream hosting job: {name}")
    job = match[0]
    # Replace the previous Otter-only Vercel promotion guard during migration.
    job = re.sub(r'\n          if \[\[ "\$\{GITHUB_REPOSITORY\}" == "otterware-app/otter-code" \]\]; then\n            node scripts/otter/promote-web.mjs\n            exit 0\n          fi\n', '', job)
    if f"node scripts/otter/web-hosting.mjs {action}\n" not in job:
        anchor = "          set -euo pipefail\n"
        if anchor not in job:
            raise SystemExit(f"Missing upstream hosting step: {name}")
        job = job.replace(anchor, anchor + fork_block(action), 1)
    for section, key, value in entries:
        if f"      {key}:" not in job:
            job = job.replace(f"    {section}:\n", f"    {section}:\n      {key}: {value}\n", 1)
    return text[:match.start()] + job + text[match.end():]

release_path = Path('.github/workflows/release.yml')
release = release_path.read_text()
release = adapt_job(release, 'build_web', 'stage', [
    ('env', 'CLOUDFLARE_API_TOKEN', '${{ secrets.CLOUDFLARE_API_TOKEN }}'),
    ('env', 'APP_VERSION', '${{ needs.preflight.outputs.version }}'),
    ('env', 'VITE_HOSTED_APP_CHANNEL', "${{ needs.preflight.outputs.release_channel == 'stable' && 'latest' || 'nightly' }}"),
    ('outputs', 'version_id', '${{ steps.deploy.outputs.version_id }}'),
])
release = adapt_job(release, 'deploy_web', 'promote', [
    ('env', 'CLOUDFLARE_API_TOKEN', '${{ secrets.CLOUDFLARE_API_TOKEN }}'),
    ('env', 'WEB_VERSION_ID', '${{ needs.build_web.outputs.version_id }}'),
])
release_path.write_text(release)
preview_path = Path('.github/workflows/web-preview.yml')
preview_path.write_text(adapt_job(preview_path.read_text(), 'deploy', 'stage-preview', [
    ('env', 'CLOUDFLARE_API_TOKEN', '${{ secrets.CLOUDFLARE_API_TOKEN }}'),
]))
PY

# Point agents at the fork guide from AGENTS.md, which every agent reads first.
perl -0pi -e '
  s/\A(# [^\n]*\n)/$1\n> **This is the Otter Code fork.** Read [OTTER.md](OTTER.md) first: it covers how the fork\n> stays in sync with upstream, its identities and infrastructure, releases, and moving machines.\n/
    unless /OTTER\.md/;
' AGENTS.md

# Otter Code publishes its CLI with an npm token (no npm trusted publisher exists
# for new packages), and tags each nightly as latest so plain `npx otter-code` works.
OTTER_NPM_AUTH_STEP='      - name: Configure npm token (Otter Code)
        env:
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: |
          if [ -n "$NPM_TOKEN" ]; then
            printf "//registry.npmjs.org/:_authToken=%s\n" "$NPM_TOKEN" >> ~/.npmrc
          fi

' OTTER_NPM_TAG_STEP='
      - name: Tag nightly as latest (Otter Code)
        if: needs.preflight.outputs.release_channel == '"'"'nightly'"'"'
        run: npm dist-tag add "otter-code@${{ needs.preflight.outputs.version }}" latest
' perl -0pi -e '
  s/(      - name: Build npm packages from CLI archives\n)/$ENV{OTTER_NPM_AUTH_STEP}$1/ unless /Configure npm token \(Otter Code\)/;
  s/(      - name: Publish CLI packages\n        run: [^\n]*\n)/$1$ENV{OTTER_NPM_TAG_STEP}/ unless /Tag nightly as latest \(Otter Code\)/;
' .github/workflows/release.yml
perl -0pi -e '
  s/(node scripts\/build-npm-platform-packages\.ts [^\n]*--output-dir npm-packages)\n/$1 --allow-missing\n/
    unless /--output-dir npm-packages --allow-missing/;
' .github/workflows/release.yml
