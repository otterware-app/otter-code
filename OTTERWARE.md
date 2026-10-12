# Otterware

Otterware is Otter Code plus Mail, Calendar and Drive (and Home, the day view across them) in
one app. It is this repository on the `otterware` branch; everything in [OTTER.md](OTTER.md) and
[AGENTS.md](AGENTS.md) still applies. Upstream files are rebased daily, so suite code lives in its
own folders and touches upstream files only through the one-line hooks listed below.

## The shared-home rule

An Otterware server must run on a user's existing Otter Code data home (`~/.otter-code`,
`statev2.sqlite`) and plain Otter Code must keep working on it afterwards. So Otterware never
changes what plain Otter Code reads:

- No migrations or schema changes in `statev2.sqlite`, no new orchestration event types, no new
  keys in the server `settings.json`.
- Module data lives in `<stateDir>/suite.sqlite`
  ([`SuiteDatabase.ts`](apps/server/src/suite/SuiteDatabase.ts)). Its client has its own tag,
  `SuiteSqlClient`; module code written against a plain `SqlClient` gets it locally through
  `Layer.provide(SuiteDatabase.layerSqlClient)`, never globally.
- Migrations are namespaced per module (`suite_migrations(module, id)`) and run at startup before
  any module starts ([`SuiteMigrations.ts`](apps/server/src/suite/SuiteMigrations.ts)). Ids are
  per module; never renumber a shipped one.
- One writer per data home: Otterware holds an atomic directory lock from before database
  initialization until shutdown, and refuses to start while `server-runtime.json` names another
  live server that is listening ([`StateDirGuard.ts`](apps/server/src/suite/StateDirGuard.ts)).
  Two servers on one database would run agent work twice. Existing plain Otter Code releases
  do not participate in this lock: quit them before starting Otterware and keep them stopped
  while Otterware serves the home. The desktop app recognises the refusal
  and asks the user to quit the other app instead of restarting the backend in a loop.
- The desktop app keeps its own files (settings, connections, account session, logs) in
  `~/.otterware/userdata` (`OTTERWARE_HOME`), while its bundled backend uses the shared Otter Code
  home (`T3CODE_HOME`). See [`OtterwarePaths.ts`](apps/desktop/src/app/OtterwarePaths.ts).

## Adding a module

A module owns `apps/server/src/suite/<module>/`, `packages/contracts/src/suite/<module>.ts`,
`apps/web/src/suite/<module>/` and `apps/web/src/routes/<module>.tsx`, plus one line in each
registry:

| What                     | Registry                                                                                               | Line                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Wire contract (RPC)      | [`packages/contracts/src/suite/index.ts`](packages/contracts/src/suite/index.ts)                       | `SuiteMailContract,`                      |
| Server module            | [`apps/server/src/suite/modules.ts`](apps/server/src/suite/modules.ts)                                 | `MailModule,`                             |
| Web page and rail entry  | [`apps/web/src/suite/modules.ts`](apps/web/src/suite/modules.ts)                                       | an entry (Home/Mail/Calendar/Drive exist) |
| Agent tool display names | [`packages/shared/src/suite/mcpToolPresentation.ts`](packages/shared/src/suite/mcpToolPresentation.ts) | one entry per tool                        |

- **Contract.** `defineSuiteContract({ group, scopes })`; methods are named `suite.<module>.<name>`
  and every method declares its auth scope. The merged group joins `WsRpcGroup`, so every client
  gets a typed RPC.
- **Server module.** `defineSuiteServerModule({ id, migrations, layer, rpcHandlers, mcpToolkit,
agentInstructions, homeContributor })` ([`SuiteModule.ts`](apps/server/src/suite/SuiteModule.ts)).
  `layer` holds the services; `rpcHandlers` is `<Group>.toLayer(...)` and only reads services;
  `mcpToolkit` is `McpServer.toolkit(...)`, offered in every Code thread and gated on the `suite`
  MCP capability; `agentInstructions` is appended to every provider's runtime prompt;
  `homeContributor` feeds Home. The registry is type-checked: an RPC without a handler, or a
  handler needing a service nobody provides, fails `server.ts`'s typecheck. Background loops wait
  for server activation.
  `suiteToolkitRegistration` keeps suite/vendor handler layers while excluding the per-request
  `McpInvocationContext` from registration dependencies, like Code's MCP registration wrapper.
  Never provide an invocation context during startup: the authenticated transport supplies it
  separately for each caller, and each suite handler keeps its existing capability checks.
- **Web page.** The route renders `SuiteModuleLayout` (module sidebar, content, side chat slot)
  and publishes what the user is looking at with `useSuitePageContext(...)` for the side chat.
  `useSuiteCapabilities()` reports whether the environment runs the module; a plain Otter Code
  environment shows an empty state rather than an error.

[`core/SuiteCoreModule.ts`](apps/server/src/suite/core/SuiteCoreModule.ts) is the reference
module: `suite.capabilities` over RPC and as the `suite_capabilities` MCP tool.

## Embedded assistant threads

Module side chats use the upstream `ChatView` with two optional props: `compact` hides the
thread header, terminal and right panels and limits window shortcuts to the embedded composer;
`decorateOutgoingMessage` captures the current page at send time and adds a canonical context
reference and record to the existing send path. Timeline, composer, provider selection, work
logs, approvals, questions and draft promotion stay owned by Code. The timeline's unknown-kind
fallback recognizes `suite-page` chips. This open context kind needs no main-database migration
or orchestration event change and remains readable in plain Code. Keep these two seams when
rebasing; side-chat lifecycle and Home UI live under `apps/web/src/suite/`.

## Upstream hooks

These upstream lines are the whole integration; keep them when resolving rebase conflicts:
`server.ts` (state-dir guard, `SuiteServer.layer`), `ws.ts` (suite RPCs omitted from the upstream
handler object, `SuiteServer.layerRpcHandlers`), `auth/RpcAuthorization.ts`
(`SUITE_RPC_REQUIRED_SCOPES`), `mcp/McpHttpServer.ts` (`SuiteServer.layerMcpToolkits`),
`mcp/McpInvocationContext.ts` and `mcp/McpSessionRegistry.ts` (`suite` capability),
`packages/provider-core/src/server/runtimeInstructions.ts` (module instructions),
`observability/RpcInstrumentation.ts` (`SUITE_RPC_AGGREGATES` for module RPC labels), `packages/contracts/src/rpc.ts`
(`.merge(SuiteRpcGroup)`), `t3McpToolPresentation.ts`, and in the web app `SpaceRail.tsx`,
`mainAppLocation.ts`, `AppSidebarLayout.tsx`, `CommandPalette.tsx` and `_chat.index.tsx` (the
first load of `/` lands on Home), and `AppRoot.tsx` (`SuiteAccountProvider`).

The desktop's primary local suite reuses Code's Otter Accounts identity. Accounts exchanges
its OAuth authorization for a short-lived native credential; Mail adopts that credential and
Drive exchanges it for its own API and browser sessions. Those sessions remain bound to the
same canonical user and authorization, including refresh and revocation. Keep this bridge in
the suite adapters: do not replace Code's account provider or forward credentials to secondary
or remote environments. Calendar already uses the host identity; Google mailbox and calendar
permissions are separate provider connections. Signing out clears suite account sessions while
preserving those local provider connections.

Mail's Outlook provider uses its vendored Microsoft PKCE flow and token store. Configure the
optional public `OTTER_MAIL_MICROSOFT_CLIENT_ID` at build time (the release workflow reads the
repository variable) or on the server to enable it. For a remote server, the Mail frame lets
the user paste Microsoft's localhost callback address; the suite validates the pending state
and forwards it to Mail's IPv4 listener. Cancelling or leaving Mail ends the client handoff.
Microsoft mailbox permission remains separate from the shared Otter Accounts sign-in.

## Daily maintenance and previews

The app scheduler runs daily upstream maintenance at 07:00 UTC. Each run uses a clean isolated
worktree from `origin/otterware`, incorporates Otter Code's `origin/main`, and refreshes Mail,
Calendar and Drive through `scripts/otterware/sync-otter-{mail,calendar,drive}.ts`. It checks
Accounts compatibility and the module adapters, then validates before pushing only `otterware`.
Contract guards stop a sync when a watched upstream interface changes. Vendor code stays verbatim;
changes to its behavior belong in suite adapters or the Calendar manifest's explicit patch.

Check the pinned vendor trees with `sync-otter-calendar.ts --check`,
`sync-otter-mail.ts --check --ref $(cat vendor/otter-mail/UPSTREAM)` and
`sync-otter-drive.ts --check`. For a local Mail checkout, pass `--repo` explicitly. Only run
typechecks after integrating changes, sequentially; Mail's server worker has its own tsconfig.

## Branding and branch releases

The approved production kit lives in `assets/otterware/`: macOS uses its light ivory
`Otterware.icns` directly; Linux uses the app PNG, and web uses the kit's adaptive SVG
favicon plus fixed ICO and Apple touch icon (`head.html` choice, so no PNG-theme script).
The shared `OtterwareLogo` component preserves the kit SVG path with `currentColor`, charcoal
in light appearance and ivory in dark. Onboarding, the rail, welcome and About reuse it;
the native About panel inherits the packaged app icon. The old recoloring generator is retired.
Otter Code's own artwork under `assets/otter`, `otter-dev` and `otter-nightly` is unchanged.

Cut a build by tagging the desired branch commit and pushing only that tag:

```sh
# Legacy tags always publish the otterware channel, regardless of the source branch.
git tag otterware-build-20261012-1
git push origin otterware-build-20261012-1
# Other branch trains encode the sanitized channel, then --, then a unique build id.
git tag otterware-build-channel-feature-mail--20261012-1
git push origin otterware-build-channel-feature-mail--20261012-1
```

Tag names beginning `otterware-build-channel-` require that explicit separator. For manual
workflow dispatch, `channel` defaults to the selected branch; an input overrides it. Branch
names are lowercased, non-alphanumeric runs become `-`, and edge hyphens are removed (maximum
80 characters). Thus `feature/mail` maps to `feature-mail`: choose distinct names where
sanitization would collide. Tags do not infer branch ancestry.

`.github/workflows/otterware-release.yml` checks the integrated packages and Mail worker,
then builds Linux x64 and signed/notarized macOS arm64 artifacts. It publishes **only** to
[otterware-app/otterware-releases](https://github.com/otterware-app/otterware-releases), with
visible prereleases `otterware-v<core>-otterware.<yyyymmdd>.<run>` and rolling `channel-<channel>`
releases. Immutable version releases cannot be overwritten; rerunning an already published
version fails. Run artifacts are retained too. Source-repository drafts are redundant and
are no longer created. No npm, Cloudflare, relay, or Otter Code feed is published.

The existing release GitHub App must be installed on **otterware-app/otterware-releases** with
Contents write permission. Configure `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` in the
source repository; the workflow requests a token restricted to the releases repository and
fails with the installation fix if token creation fails. No personal token is used. Existing
`CSC_LINK`, `CSC_KEY_PASSWORD`, Apple API secrets and `APPLE_TEAM_ID` sign/notarize macOS.
A macOS channel build requires those secrets: an ad-hoc signed update cannot safely replace
a Developer ID installation.

Packaging bakes `OTTERWARE_UPDATE_CHANNEL` into a generic `app-update.yml` pointing at
`https://github.com/otterware-app/otterware-releases/releases/download/channel-<channel>/`.
Each feed has `latest-mac.yml` (zip + dmg), `latest-linux.yml` (AppImage + deb), blockmaps,
`SHA256SUMS`, and the Linux x64 server CLI tarball. Feed manifests point at immutable version
assets, allowing downloads to finish across feed replacements. Publishing uploads binaries
before manifests, removes stale rolling binaries, and refuses to rewind a channel to an older
version. Linux-only builds preserve the previous macOS feed.

The bottom-left Update button uses the existing Electron check/download/restart flow; startup
and periodic checks find the baked branch feed. It accepts only Otterware versions, keeps
prereleases enabled and downgrades off, and ignores Code's latest/nightly selector. Local
builds without a baked channel have no updates. Existing preview builds with no feed must
be reinstalled once from a channel build. Otter Code's feed and runtime installer remain on
`otterware-app/otter-code`; server self-update stays blocked for Otterware to preserve that boundary.

Fleet runtime installation and switching use `scripts/otterware/fleet-server.sh` (the deployed
copy is `otterware-fleet`):

```sh
otterware-fleet update                       # channel otterware
otterware-fleet update --channel feature-mail
```

`update` downloads mandatory SHA256SUMS from the channel, selects exactly one server archive
for this host, downloads that version from its immutable release, verifies the checksum and
executable version, installs it, then calls `use-otterware --version <selected-version>`.
The entire operation holds the home's fleet lock and retains the launcher's backup/rollback
path. It does not silently select another installed runtime. The release currently builds
only Linux x64 server archives; arm64 fleet hosts fail clearly until that artifact is added.
Before stopping and again before starting the service, fleet switches stop verified managed
SSH-launched servers for this home (TERM, then KILL after 10 seconds) and remove their launch
records. This covers older desktops launching a backend during the service handoff. Unmanaged
servers still block a switch; other homes and reused PIDs are never signalled. Test fixtures use
disposable homes and stub transports/services, never the live data home.

The server declares Zod 4 as a production dependency because its bundled Drive contracts import
it as a runtime external. Keep that version compatible with the vendored Drive package; Cursor's
separate Zod 3 dependency does not provide Drive's schema API.
The server build maps Drive's bare Zod import to a `createRequire` adapter, so the fleet
single-executable can load the same staged dependency without a file-backed ESM import.

## Agent file uploads and sharing

`drive_upload_file` accepts any file from an absolute server-local path, an HTTP(S) URL,
or base64 (up to 1 MiB). Local paths include workspace files and `<stateDir>/attachments/`.
If the file is on another machine you can reach (e.g. over SSH), copy it to a temporary
local path first, then upload that path; only ask the user to attach the file if you can't
reach it. Files stream through the API; large uploads use its requested multipart ranges.
URL downloads spool to a private temporary file and never receive the Drive token.
`folder` accepts an ID, slug or unique name; omitted means My Drive. Existing documents
require `documentRef` and the inspected `ifVersion`; conflicts stop without retries.
Drive's pinned API finalizes published versions only, so `publish=false` fails before writes.
Upload alone does not change sharing; shared-drive members already have access.

Use `drive_get_share_link` / `drive_get_folder_sharing` to inspect access. Only when asked,
use `drive_share_document` / `drive_share_folder` to grant/revoke emails or set `linkRole`
(`none`, `viewer`, `editor`). A link recipient must sign in to Drive. Folder access is
recursive; shared-drive email grants change membership, but drive roots cannot have links.
Notifications are disabled. Changes are separate API transactions: after an error inspect
access before making another change. Sharing requires a user login, not an API key.

## In-app browser passkeys

Electron 44.4.5's [Touch ID authenticator](https://github.com/electron/electron/blob/v44.4.5/docs/api/app.md#appconfigurewebauthnoptions-macos)
needs `app.configureWebAuthn` and a matching keychain signing entitlement. Its credentials
are device-bound and partition-specific, not existing iCloud passkeys. The native
`preview/Passkeys.ts` bridge needs Apple's [managed browser entitlement](https://developer.apple.com/documentation/authenticationservices/authenticating-people-by-using-passkeys-in-browser-apps)
and matching profile for arbitrary sites, plus packaged `t3codeWebAuthn.browserPasskeys`
metadata. The current packager emits neither that metadata nor custom passkey entitlements.
Electron's extension-origin WebAuthn validation also lacks Chrome's RP permission override;
a popup cannot use the page's native bridge. Adding a permission name or feature flag does
not solve those constraints. The account-selection handler already exists.

Failed explicit requests now offer **Continue in your browser** on macOS/Linux in Browser
pages and extension popups/options. Pages retain their committed URL; extensions use a
validated RP domain (Bitwarden opens its matching web vault). Cancel opens nothing;
autofill, aborted requests and successful credentials do not prompt. Browser login starts
a separate session and does not unlock the extension inside Otterware.

Mac verification: try an existing iCloud passkey on a site and Bitwarden's **Log in with
passkey**. On failure, verify Cancel stays in Otterware and Continue opens the site/vault
in Safari or Chrome, where Touch ID completes the login. Check no prompt for successful
credentials, autofill or aborted requests. Linux tests cannot verify Mac hardware/signing.
