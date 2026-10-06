// @effect-diagnostics globalDate:off -- Fixtures build ISO times relative to a fixed clock.
import { describe, expect, it } from "@effect/vitest";
import {
  SuiteProjectRules,
  type SuiteHomeItem,
  type SuiteProject,
  type SuiteViewFilter,
} from "@t3tools/contracts/suite";
import * as Schema from "effect/Schema";

import {
  filterItems,
  matchProjectIds,
  projectCounts,
  rankItems,
  scoreItem,
  todayEntries,
} from "./homeMatching.ts";

const decodeRules = Schema.decodeUnknownSync(SuiteProjectRules);
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

const project = (id: string, rules: unknown): SuiteProject => ({
  id,
  name: id,
  color: "blue",
  rules: decodeRules(rules),
  createdAt: hoursAgo(100),
  updatedAt: hoursAgo(100),
});

const item = (overrides: Partial<SuiteHomeItem> & Pick<SuiteHomeItem, "id">): SuiteHomeItem => ({
  module: "mail",
  kind: "reply-needed",
  title: "A message",
  occurredAt: hoursAgo(2),
  priority: 50,
  actions: [],
  target: { route: "/mail" },
  ...overrides,
});

const acme = project("acme", {
  code: { projectIds: ["code-acme"] },
  mail: { domains: ["@Acme.com"], labels: ["Customers/Acme"] },
  calendar: { keywords: ["Acme"] },
  drive: { folderSlugs: ["/clients/acme/"] },
});
const otter = project("otter", {
  mail: { senders: ["Sebastian@otter.dev"], projectIds: ["mail-proj-1"] },
  calendar: { calendarIds: ["cal-otter"] },
  drive: { folderIds: ["folder-otter"] },
});

describe("matchProjectIds", () => {
  it("files an item under every project one of its facets matches", () => {
    expect(
      matchProjectIds([acme, otter], item({ id: "1", facets: { codeProjectId: "code-acme" } })),
    ).toEqual(["acme"]);
    expect(
      matchProjectIds(
        [acme, otter],
        item({ id: "2", facets: { senders: ["eva@support.acme.com", "sebastian@OTTER.dev"] } }),
      ),
    ).toEqual(["acme", "otter"]);
    expect(
      matchProjectIds([acme, otter], item({ id: "3", facets: { labels: ["customers/acme"] } })),
    ).toEqual(["acme"]);
    expect(
      matchProjectIds(
        [acme, otter],
        item({ id: "4", facets: { mailProjectIds: ["mail-proj-1"] } }),
      ),
    ).toEqual(["otter"]);
    expect(
      matchProjectIds(
        [acme, otter],
        item({ id: "5", module: "drive", facets: { folderSlugs: ["clients/acme"] } }),
      ),
    ).toEqual(["acme"]);
    expect(
      matchProjectIds(
        [acme, otter],
        item({ id: "6", module: "drive", facets: { folderIds: ["x", "folder-otter"] } }),
      ),
    ).toEqual(["otter"]);
  });

  it("does not treat a domain as a suffix of another domain", () => {
    expect(
      matchProjectIds([acme], item({ id: "1", facets: { senders: ["mallory@notacme.com"] } })),
    ).toEqual([]);
  });

  it("matches title keywords only for calendar items", () => {
    expect(matchProjectIds([acme], item({ id: "1", title: "Acme renewal" }))).toEqual([]);
    expect(
      matchProjectIds([acme], item({ id: "2", module: "calendar", title: "Weekly ACME sync" })),
    ).toEqual(["acme"]);
  });

  it("files nothing for an item without facets (modules that do not fill them yet)", () => {
    expect(matchProjectIds([acme, otter], item({ id: "1" }))).toEqual([]);
  });
});

describe("rankItems", () => {
  it("assigns the first matched project key and preserves every match", () => {
    const ranked = rankItems(
      [
        item({
          id: "both",
          projectKey: "old",
          facets: { senders: ["a@acme.com", "sebastian@otter.dev"] },
        }),
        item({ id: "none", projectKey: "old" }),
      ],
      [acme, otter],
      NOW,
    );
    expect(ranked.find((entry) => entry.id === "both")?.projectKey).toBe("acme");
    expect(ranked.find((entry) => entry.id === "both")?.projectIds).toEqual(["acme", "otter"]);
    expect(ranked.find((entry) => entry.id === "none")?.projectKey).toBeUndefined();
  });

  it("orders by priority, then boosts blocked and fresh items", () => {
    const ranked = rankItems(
      [
        item({ id: "fyi", priority: 20, occurredAt: hoursAgo(0.1) }),
        item({ id: "reply", priority: 80, occurredAt: hoursAgo(30) }),
        item({ id: "approval", module: "code", priority: 80, waitingOnYou: true }),
        item({ id: "reply", priority: 80, occurredAt: hoursAgo(30) }),
      ],
      [],
      NOW,
    );
    expect(ranked.map((entry) => entry.id)).toEqual(["approval", "reply", "fyi"]);
    expect(ranked[0]!.score).toBe(80 + 10 + 6);
    expect(scoreItem(item({ id: "old", priority: 40, occurredAt: hoursAgo(48) }), NOW)).toBe(40);
  });

  it("keeps items with the same id from different modules", () => {
    const ranked = rankItems([item({ id: "1" }), item({ id: "1", module: "drive" })], [], NOW);
    expect(ranked).toHaveLength(2);
  });
});

describe("filterItems", () => {
  const ranked = rankItems(
    [
      item({ id: "mail-acme", facets: { senders: ["a@acme.com"] }, occurredAt: hoursAgo(1) }),
      item({ id: "code-wait", module: "code", kind: "agent-approval", waitingOnYou: true }),
      item({ id: "drive-old", module: "drive", kind: "edited", occurredAt: hoursAgo(24 * 10) }),
    ],
    [acme],
    NOW,
  );
  const clock = { nowMs: NOW, todayStartMs: Date.parse("2026-10-06T00:00:00.000Z") };
  const filter = (overrides: Partial<SuiteViewFilter>): SuiteViewFilter => ({
    modules: [],
    projectIds: [],
    kinds: [],
    timeRange: "any",
    waitingOnMe: false,
    ...overrides,
  });
  const ids = (selected: ReadonlyArray<{ readonly id: string }>) => selected.map(({ id }) => id);

  it("keeps everything for an empty filter", () => {
    expect(ids(filterItems(ranked, filter({}), clock))).toHaveLength(3);
  });

  it("narrows by module, project, kind, waiting and time", () => {
    expect(ids(filterItems(ranked, filter({ modules: ["drive", "code"] }), clock))).toEqual([
      "code-wait",
      "drive-old",
    ]);
    expect(ids(filterItems(ranked, filter({ projectIds: ["acme"] }), clock))).toEqual([
      "mail-acme",
    ]);
    expect(ids(filterItems(ranked, filter({ kinds: ["AGENT-APPROVAL"] }), clock))).toEqual([
      "code-wait",
    ]);
    expect(ids(filterItems(ranked, filter({ waitingOnMe: true }), clock))).toEqual(["code-wait"]);
    expect(ids(filterItems(ranked, filter({ timeRange: "7d" }), clock))).not.toContain("drive-old");
    expect(ids(filterItems(ranked, filter({ timeRange: "today" }), clock))).toHaveLength(2);
  });
});

describe("projectCounts", () => {
  it("counts matched items per module, today's events, and active linked threads", () => {
    const ranked = rankItems(
      [
        item({ id: "m1", facets: { senders: ["a@acme.com"] } }),
        item({ id: "m2", facets: { senders: ["b@acme.com"] } }),
        item({ id: "m3" }),
        item({
          id: "c1",
          module: "code",
          facets: { codeProjectId: "code-acme", threadId: "t1" },
        }),
      ],
      [acme],
      NOW,
    );
    const today = todayEntries(
      [
        {
          id: "e1",
          title: "Acme weekly",
          startsAt: hoursAgo(-1),
          endsAt: hoursAgo(-2),
          allDay: false,
          target: { route: "/calendar" },
        },
      ],
      [acme],
    );
    expect(projectCounts(acme, ranked, today, new Map([["code-acme", 4]]))).toEqual({
      code: 4,
      mail: 2,
      calendar: 1,
      drive: 0,
    });
  });
});
