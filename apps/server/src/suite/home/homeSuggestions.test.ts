// @effect-diagnostics globalDate:off -- Fixtures build ISO times relative to a fixed clock.
import { describe, expect, it } from "@effect/vitest";
import {
  SuiteProjectRules,
  type SuiteHomeItem,
  type SuiteHomeItemModule,
  type SuiteProject,
  type SuiteTodayEvent,
} from "@t3tools/contracts/suite";
import * as Schema from "effect/Schema";

import { rankItems, todayEntries } from "./homeMatching.ts";
import { suggestNext, type SuggestionInput } from "./homeSuggestions.ts";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

const acme: SuiteProject = {
  id: "acme",
  name: "Acme",
  color: "orange",
  rules: Schema.decodeUnknownSync(SuiteProjectRules)({
    code: { projectIds: ["code-acme"] },
    mail: { domains: ["acme.com"] },
  }),
  createdAt: at(-100),
  updatedAt: at(-100),
};

const mail = (id: string, title: string, sender: string): SuiteHomeItem => ({
  id,
  module: "mail",
  kind: "reply-needed",
  title,
  occurredAt: at(-1),
  priority: 80,
  actions: [],
  target: { route: "/mail" },
  facets: { senders: [sender] },
});

const event = (id: string, startsIn: number, facets?: SuiteTodayEvent["facets"]) =>
  ({
    id,
    title: `Event ${id}`,
    startsAt: at(startsIn),
    endsAt: at(startsIn + 1),
    allDay: false,
    target: { route: "/calendar" },
    ...(facets ? { facets } : {}),
  }) satisfies SuiteTodayEvent;

const input = (overrides: {
  readonly items?: ReadonlyArray<SuiteHomeItem>;
  readonly events?: ReadonlyArray<SuiteTodayEvent>;
  readonly modules?: ReadonlyArray<SuiteHomeItemModule>;
  readonly merged?: SuggestionInput["mergedPullRequests"];
}): SuggestionInput => ({
  items: rankItems(overrides.items ?? [], [acme], NOW),
  today: todayEntries(overrides.events ?? [], [acme]),
  projects: [acme],
  mergedPullRequests: overrides.merged ?? [],
  modules: new Set(overrides.modules ?? ["code", "mail", "calendar", "drive"]),
  nowMs: NOW,
});

describe("suggestNext", () => {
  it("suggests a code thread for an email reporting a bug, in the project's code project", () => {
    const [suggestion, ...rest] = suggestNext(
      input({
        items: [
          mail("m1", "RSVP button does nothing on iOS: bug?", "eva@acme.com"),
          mail("m2", "Lunch on Friday?", "sam@example.com"),
        ],
      }),
    );
    expect(rest).toEqual([]);
    expect(suggestion).toMatchObject({
      rule: "mail-bug-to-code",
      from: "mail",
      to: "code",
      action: { label: "Start thread", codeProjectId: "code-acme" },
      projectIds: ["acme"],
    });
    expect(suggestion!.action.prompt).toContain("Home item m1");
  });

  it("suggests notes for upcoming meetings without a linked doc, only with Drive", () => {
    const events = [
      event("soon", 0.5),
      event("documented", 1, { driveFileIds: ["doc-1"] }),
      event("past", -2),
      event("tomorrow-ish", 30),
    ];
    expect(suggestNext(input({ events })).map((entry) => entry.id)).toEqual([
      "event-notes-to-drive:soon",
    ]);
    expect(suggestNext(input({ events, modules: ["code", "calendar"] }))).toEqual([]);
  });

  it("suggests a reply when a merged PR's project has an open email", () => {
    const merged = [
      {
        threadId: "t1",
        threadTitle: "Fix RSVP",
        codeProjectId: "code-acme",
        repository: "otter/otter-mail",
        number: 31,
        title: "Fix RSVP on iOS",
        url: "https://github.com/otter/otter-mail/pull/31",
        mergedAt: at(-3),
      },
    ];
    const suggestions = suggestNext(
      input({ items: [mail("m1", "Any update?", "eva@acme.com")], merged }),
    );
    expect(suggestions.map((entry) => entry.rule)).toEqual(["merged-pr-reply"]);
    expect(suggestions[0]!.title).toBe("PR #31 shipped: let eva@acme.com know?");
    expect(suggestNext(input({ items: [], merged }))).toEqual([]);
  });
});
