/**
 * Home: the day across Code, Mail, Calendar and Drive. Owns the overview that
 * merges every module's contributor, cross-app projects and saved views (in
 * `suite.sqlite`), the Otterware Assistant project that side chats use, and
 * Code's own contributor, read from the orchestration projections.
 */
import { SUITE_HOME_METHODS, SuiteHomeRpcGroup } from "@t3tools/contracts/suite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";

import * as SuiteDatabase from "../SuiteDatabase.ts";
import { defineSuiteServerModule } from "../SuiteModule.ts";
import * as CodeHomeActivity from "./CodeHomeActivity.ts";
import * as SuiteAssistantProject from "./SuiteAssistantProject.ts";
import * as SuiteHome from "./SuiteHome.ts";
import * as SuiteHomeStore from "./SuiteHomeStore.ts";
import * as SuiteHomeToolkit from "./SuiteHomeToolkit.ts";

const rpcHandlers = SuiteHomeRpcGroup.toLayer(
  Effect.gen(function* () {
    const home = yield* SuiteHome.SuiteHome;
    const store = yield* SuiteHomeStore.SuiteHomeStore;
    const assistant = yield* SuiteAssistantProject.SuiteAssistantProjectService;
    return SuiteHomeRpcGroup.of({
      [SUITE_HOME_METHODS.overview]: (input) => home.overview(input),
      [SUITE_HOME_METHODS.performAction]: (input) => home.performAction(input).pipe(Effect.as({})),
      [SUITE_HOME_METHODS.saveProject]: (input) => store.saveProject(input),
      [SUITE_HOME_METHODS.deleteProject]: ({ id }) => store.deleteProject(id).pipe(Effect.as({})),
      [SUITE_HOME_METHODS.saveView]: (input) => store.saveView(input),
      [SUITE_HOME_METHODS.deleteView]: ({ id }) => store.deleteView(id).pipe(Effect.as({})),
      [SUITE_HOME_METHODS.ensureAssistantProject]: () => assistant.ensure,
    });
  }),
).pipe(Layer.provide(SuiteHome.layer));

export const SuiteHomeModule = defineSuiteServerModule({
  id: "home",
  migrations: SuiteHomeStore.HOME_MIGRATIONS,
  layer: Layer.mergeAll(
    SuiteHomeStore.layer.pipe(Layer.provide(SuiteDatabase.layerSqlClient)),
    CodeHomeActivity.layer,
    SuiteAssistantProject.layer,
  ),
  rpcHandlers,
  mcpToolkit: McpServer.toolkit(SuiteHomeToolkit.SuiteHomeToolkit).pipe(
    Layer.provide(SuiteHomeToolkit.layerHandlers),
  ),
  agentInstructions: `## Otterware Home

\`suite_home_overview\` lists what needs the user across Code, Mail, Calendar and Drive, ranked, with today's events and running agents; use it for "what needs me today?" or "what's next?". Cross-app projects group a customer's or product's mail, events, files and Code projects: \`suite_list_projects\`, \`suite_get_project_overview\`; create or change them only when the user asks (\`suite_create_project\`, \`suite_update_project\`). A user message may carry an Otterware page context record (kind \`suite-page\`): it names the app page and the items the user was looking at; use the module tools to read them.`,
  homeContributor: Effect.map(
    CodeHomeActivity.CodeHomeActivity,
    (activity) => activity.contributor,
  ),
});
