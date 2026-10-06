# Otter Code

Otter Code is a fork of [T3 Code](https://github.com/pingdotgg/t3code) with its own name, app IDs,
relay, and release channel. Everything in `AGENTS.md` still applies. This file covers what is
different and how to keep the fork aligned with upstream.

## How the fork stays in sync

- **Upstream is `pingdotgg/t3code`'s `main`.** Julius's orchestration V2 PR #2829 merged on
  2026-10-02. Do not fetch its PR head or use the former V2 branch for new syncs.
- `upstream-base` records the exact upstream `main` commit used by the fork. It must be an
  ancestor of Otter's `main`. Everything after it is Otter-owned work.
- Keep a linear stack: one commit per fork feature, then one squash commit per past sync. The
  current stack is:
  1. `chore(otter): brand fork as Otter Code`: names, IDs, domains, icons, relay values, this file,
     and `scripts/otter/`.
  2. `ci(otter): release Otter Code`: release gating and `.github/scripts/otter-adapt-upstream.sh`.
  3. `feat(otter): Linear integration`: linked issues, the Linear agent app, and issue sync.
  4. `feat(otter): scoped diff review`: commit scopes, file navigation, Viewed marks, and file counts.
  5. `feat(otter): code intelligence`: file and diff editor language services, settings, and runtime setup.
  6. `chore(otter): adapt upstream files (generated)`: output of the adaptation script, after the
     features. Never edit it by hand. Every sync drops and regenerates it so runner labels, skipped
     Windows jobs, and the pointer in `AGENTS.md` do not conflict with upstream edits.
  7. `chore(otter): changes before the <date> sync (#N)`, oldest first: everything committed to
     `main` between two syncs, squashed by that sync's PR. Keep each one as its own commit; never
     fold them into each other or into the features.
- **Changing the fork:** commit directly to `main`. The next sync squashes those commits into one
  new sync commit. Never merge upstream into Otter's `main`.

### Preparing a sync

Work in a clean worktree on a dedicated sync branch. Configure the remotes once:

```sh
git remote set-url origin https://github.com/otterware-app/otter-code.git
git remote add -t main --no-tags upstream https://github.com/pingdotgg/t3code.git
```

If `upstream` already exists, verify its URL instead of adding it again. Then:

```sh
git fetch origin main upstream-base
git fetch upstream main
old_main=$(git rev-parse origin/main)
old_base=$(git rev-parse origin/upstream-base)
new_base=$(git rev-parse upstream/main)
sync_date=$(date +%F)
git merge-base --is-ancestor "$old_base" "$old_main"
git merge-base --is-ancestor "$old_base" "$new_base"
last_sync=$(git log -1 --format=%H --grep='^chore(otter): changes before the .* sync' "$old_main")
git branch "backup/otter-before-$sync_date" "$old_main"
# Commits since the last sync wait here; they become this sync's squash commit.
git branch "otter/sync-$sync_date" "$old_main"
git switch -c "otter/stack-$sync_date" "$last_sync"
git rebase -i --onto "$new_base" "$old_base"
```

In the rebase todo, drop the generated adaptation commit; it is regenerated below and goes back
between the features and the sync commits. Resolve conflicts using upstream's current behavior and
retain only the additional Otter functionality; drop fork changes upstream now covers. Fold fixes
that upstream changes require into the owning commit with `git commit --fixup` and
`git rebase -i --autosquash "$new_base"`.

If upstream added relay migrations, its snapshot chain and the fork's can branch from the same
parent. Fold a merge migration into the Linear commit, recording both heads as parents without
changing the schema:

```sh
cd infra/relay
pnpm exec drizzle-kit generate --custom --name otter_upstream_merge \
  --dialect postgresql --schema ./src/persistence/schema.ts --out ./migrations/postgres
```

From the repository root, regenerate the adaptation commit on the last feature commit, then
replay the sync commits on top of it:

```sh
sync_commits=$(git rev-list --reverse --grep='^chore(otter): changes before the .* sync' "$new_base"..HEAD)
git switch --detach "$(git rev-parse "$(echo "$sync_commits" | head -1)^")"
.github/scripts/otter-adapt-upstream.sh
git add -u
git diff --cached --quiet || git commit -m "chore(otter): adapt upstream files (generated)"
git cherry-pick $sync_commits
git branch -f "otter/stack-$sync_date" HEAD && git switch "otter/stack-$sync_date"
git merge-base --is-ancestor "$new_base" HEAD
git rev-list --left-right --count "$new_base"...HEAD
git log --oneline "$new_base"..HEAD
git diff --check "$new_base"..HEAD
```

The count should show zero upstream-only commits, and on Otter's side only the features, the
generated adaptation, and the sync commits. Then move the waiting commits onto the new stack:

```sh
git rebase --onto "otter/stack-$sync_date" "$last_sync" "otter/sync-$sync_date"
```

Run focused tests and typechecks for conflicted code and the preserved features before publishing.

### Publishing a prepared sync

A sync rewrites Otter's shared history. Preserve the old `main` as a remote backup, then update
`main` and `upstream-base` together with explicit leases. If another writer moved either ref, stop
and prepare against the new state instead of overriding it:

```sh
git push origin "$old_main:refs/heads/backup/otter-before-$sync_date"
git push --atomic origin \
  --force-with-lease="refs/heads/main:$old_main" \
  --force-with-lease="refs/heads/upstream-base:$old_base" \
  "otter/stack-$sync_date:refs/heads/main" "$new_base:refs/heads/upstream-base"
git push origin "otter/sync-$sync_date"
gh pr create --base main --head "otter/sync-$sync_date" \
  --title "chore(otter): changes before the $sync_date sync"
gh pr merge --squash
```

The PR's branch is already rebased onto the new `main`, so its squash commit carries only the
fork's own changes. Never merge a branch that still contains the old base. Existing worktrees and feature branches
still point at the old stack: rebase only their own work onto the new `origin/main`, using their
previous base explicitly. Do not automatically rebase or reset other active worktrees.

Publish a nightly with `gh workflow run release.yml -f channel=nightly`. Scheduled nightlies only
release commits ahead of the last nightly tag, and a rebased `main` has diverged from it.

**Keep the diff small:** prefer repository variables and secrets over code, and new files over
edits to upstream files. Leave internal names (`@t3tools/*`, `T3CODE_*`, code identifiers) alone.
`scripts/otter/rebrand-ui-text.sh` renames client UI text; it runs only by hand, and its exclusions
list text that must keep matching what the server or agents emit.

## Identities and infrastructure

| What                 | Value                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------- |
| App and bundle ID    | `dev.otterware.code` (`.dev`, `.preview`; iOS extensions `.widgets`, `.sharing`)        |
| URL scheme           | `ottercode` (`ottercode-dev`, `ottercode-preview`)                                      |
| Data home            | `~/.otter-code` (never `~/.t3`, so it can sit beside an installed T3 Code)              |
| Background service   | `otter-code.service` (systemd user unit), `dev.otterware.code.service` (launchd)        |
| Releases and updates | GitHub Releases of `otterware-app/otter-code`, nightly channel                          |
| Relay                | `https://relay.otterware.dev` (Cloudflare Worker, deployed from `infra/relay`)          |
| Tunnels              | `prod-<digest>.otterware.dev`, one per linked machine                                   |
| Hosted web app       | `https://code.otterware.dev` (Vercel project `otter-code-web`)                          |
| Sign-in              | Clerk at `clerk.otterware.dev`                                                          |
| Apple                | Team `YNJ5WLH965`, App Store app `6815697255`                                           |
| Mobile builds        | EAS project `@clary-so/otter-code`                                                      |
| CLI on npm           | `otter-code` (command `otter-code`), platform builds `@otterware/otter-code-<platform>` |

Secrets live in the repository's Actions secrets and its `production` environment.

## Releases

- **Desktop and server runtimes:** `release.yml` (T3's pipeline) builds macOS arm64/x64 and Linux
  x64/arm64 on GitHub-hosted runners and publishes a nightly GitHub Release that installed apps
  offer in their update dialog. Windows, AUR, marketing, and Discord are skipped.
  Start one by hand with `gh workflow run release.yml -f channel=nightly`.
- **CLI on npm:** the same run publishes `otter-code` and its `@otterware/otter-code-<platform>`
  packages with the `NPM_TOKEN` secret (an npm account that is a member of the `otterware` org),
  tagged `nightly` and also `latest`, so `npx otter-code` and `npm i -g otter-code` get the newest
  build. The token is needed because new packages have no npm trusted publisher yet.
- **Relay:** `Deploy T3 Connect relay` runs on every push to `main`. The relay adopts the
  existing `otterware.dev` zone and a PlanetScale database with a retain policy. Never run
  `alchemy destroy` against `prod`. Its PlanetScale service token (`PLANETSCALE_API_TOKEN*`)
  needs `delete_production_branch_password` and `delete_branch_password` on the database.
  Alchemy runs migrations as a temporary role and deletes it with `postgres` as successor, which
  hands the new tables to `postgres`. Without those accesses the deletion fails with only a
  warning, the tables stay owned by the expired role, and a later `ALTER TABLE` migration fails
  with `must be owner of table`.
- **iOS** is built and uploaded locally, not in CI:

  ```sh
  cd apps/mobile
  pnpm dlx eas-cli@latest build --platform ios --profile production --local --non-interactive \
    --output ../../../otter-code-builds/otter-code-ios.ipa </dev/null
  xcrun altool --upload-app -f ../../../otter-code-builds/otter-code-ios.ipa -t ios \
    --apiKey <key id> --apiIssuer <issuer id>   # key from API_PRIVATE_KEYS_DIR
  ```

  Use a **release** Xcode; App Store Connect rejects beta toolchains (error 90534). Public build
  config (`T3CODE_CLERK_*`, `T3CODE_RELAY_URL`) is stored as EAS environment variables. Don't put
  it in a gitignored `.env.local`: EAS builds from a clean copy of the repo, and the runtime
  fingerprints would not match.

## Moving a machine from T3 Code

`scripts/otter/migrate-from-t3.sh` copies a T3 Code home (V2 preview or T3 Nightly) into
`~/.otter-code`. Threads, projects, settings, secrets, attachments, and the environment ID
come along, so saved connections to that machine keep matching. It never modifies the
source. Run it with `--dry-run` first.

- **Desktop:** quit both apps first (the script refuses while a database is open), then:

  ```sh
  scripts/otter/migrate-from-t3.sh --from ~/.t3/orchestrator-preview-2829
  open -a "Otter Code"
  ```

- **Server with a systemd unit:** install the Otter Code runtime into the new home, then let the
  script stop the old unit, copy, install `otter-code.service`, and restore the old unit if
  anything fails:

  ```sh
  curl -fsSL https://raw.githubusercontent.com/otterware-app/otter-code/main/scripts/install.sh \
    | T3CODE_HOME=~/.otter-code T3CODE_CHANNEL=nightly sh
  scripts/otter/migrate-from-t3.sh --from ~/.t3/orchestrator-preview-2829 \
    --stop-unit t3code-pr2829.service --wait-idle 10 --install-service
  ```

  The installer links the command as `otter-code`, so it never replaces an installed T3 Code's
  `t3`. The script refuses to touch T3 Nightly's `t3code.service`.

Deliberately not copied:

- Desktop client files encrypted with the old app's Keychain key (`connection-catalog.json`,
  `clerk-tokens.json`, `cloud-auth-token.json`). Otter Code can't read them, and its window
  would stay empty.
- The stored T3 Connect link (`secrets/cloud-*`), which points at T3's relay and account.

## T3 Connect

- **Desktop:** Settings → Connections → T3 Connect.
- **Stale link:** if a machine says it is "already linked to a different cloud account", clear the
  old link with `t3 connect logout --base-dir ~/.otter-code`. On the desktop, run the CLI through
  the app binary with `ELECTRON_RUN_AS_NODE=1` and `Contents/Resources/app.asar/apps/server/dist/bin.mjs`.
- **SSH-only hosts:** the desktop has no Connect switch for SSH environments, and Clerk's device
  grant is not enabled, so link from the host over an SSH session that forwards the loopback
  OAuth callback:

  ```sh
  ssh -tt -L 34338:127.0.0.1:34338 <host> \
    'T=$(ls -d ~/.otter-code/runtime/versions/*/t3 | sort -V | tail -1);
     env -u SSH_CONNECTION -u SSH_TTY -u SSH_CLIENT "$T" connect --base-dir ~/.otter-code'
  ```

  Open the printed `code.otterware.dev/connect` link on the local machine, approve it, then
  restart `otter-code.service` on the host so it brings the link up.

- **Relay reaching tunnels:** the relay Worker needs the `global_fetch_strictly_public`
  compatibility flag (`infra/relay/src/worker.ts`), because tunnels share the relay's zone.
  Without it, the relay's calls to a tunnel fail with Cloudflare 530 and phones report
  `endpoint_request_failed`.

## Linear agent app

Delegating Linear issues to Otter needs one Linear OAuth app owned by Otter, configured on the relay.
Without it the relay reports Linear as unavailable and clients hide the section.

- Create the app at `linear.app/settings/api/applications/new` with distribution **public**, callback
  URL `https://relay.otterware.dev/v1/linear/oauth/callback`, webhooks on, webhook URL
  `https://relay.otterware.dev/v1/linear/webhook`, and the **Agent session events**, **Issues**,
  **Comments**, and **OAuth app revoked** categories. Issues and Comments are what make linked
  issues update right away; without them, machines fall back to polling.
- Store the client ID as the `LINEAR_CLIENT_ID` repository variable, and the client secret and webhook
  signing secret as the `LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET` secrets in the `production`
  environment. `HOSTED_APP_URL` is optional and defaults to `https://code.otterware.dev`.
- The relay generates its own keys for sealing Linear tokens and signing OAuth state. Rotating them
  forces every workspace to reinstall and every user to relink.

## Other traps

- **Electron as Node:** agent shells inside Otter Code can inherit `ELECTRON_RUN_AS_NODE=1`, and
  `open` passes it on, so an app launched from such a shell runs as plain Node and exits. Launch
  it with `env -u ELECTRON_RUN_AS_NODE open -a "Otter Code"`.
- **macOS runners:** macOS jobs run on `macos-15`. On GitHub's `macos-26` image, electron-builder
  below 26.16.1 fails to unlock its signing keychain. Move to `macos-26` in the generated script
  once upstream pins 26.16.1 or later.
