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
`provider/RuntimeInstructions.ts` (module instructions), `packages/contracts/src/rpc.ts`
(`.merge(SuiteRpcGroup)`), `t3McpToolPresentation.ts`, and in the web app `SpaceRail.tsx`,
`mainAppLocation.ts`, `AppSidebarLayout.tsx`, `CommandPalette.tsx` and `_chat.index.tsx` (the
first load of `/` lands on Home).

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

Push a tag named `otterware-build-*` from the desired branch commit to run
`.github/workflows/otterware-release.yml`. It typechecks the integrated packages and Mail worker,
verifies module integration and shared-home compatibility, then builds Linux x64 and macOS arm64
artifacts and a draft release. It does not publish an Otter Code update or switch a running server.
Fleet runtime installation and switching use `scripts/otterware/fleet-server.sh`; mutations are
serialized, and switching uses the existing launcher's backup and rollback path.

The server declares Zod 4 as a production dependency because its bundled Drive contracts import
it as a runtime external. Keep that version compatible with the vendored Drive package; Cursor's
separate Zod 3 dependency does not provide Drive's schema API.
