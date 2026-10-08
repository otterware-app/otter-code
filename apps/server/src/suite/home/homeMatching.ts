/**
 * Pure Home logic: which cross-app projects an item belongs to, how items rank,
 * and which items a saved view keeps. Contributors fill `facets` as far as they
 * can; everything here degrades to "no project" when a facet is missing.
 */
import type {
  SuiteHomeItem,
  SuiteHomeItemFacets,
  SuiteHomeItemModule,
  SuiteHomeModuleCounts,
  SuiteHomeRankedItem,
  SuiteHomeTodayEntry,
  SuiteProject,
  SuiteTodayEvent,
  SuiteViewFilter,
} from "@t3tools/contracts/suite";

/** What the matcher reads from an item or event. */
export interface MatchSubject {
  readonly module: SuiteHomeItemModule;
  readonly title: string;
  readonly facets?: SuiteHomeItemFacets | undefined;
}

const normalize = (value: string) => value.trim().toLowerCase();
const normalizeSlug = (value: string) => normalize(value).replace(/^\/+|\/+$/g, "");
const normalizeDomain = (value: string) => normalize(value).replace(/^@/, "");

const intersects = (
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string>,
  by: (value: string) => string = normalize,
) => {
  if (left === undefined || left.length === 0 || right.length === 0) return false;
  const wanted = new Set(right.map(by));
  return left.some((value) => wanted.has(by(value)));
};

const domainOf = (address: string) => {
  const at = address.lastIndexOf("@");
  return at < 0 ? null : normalizeDomain(address.slice(at + 1).replace(/>.*$/, ""));
};

/** Whether `subject` belongs to `project`: any one rule is enough. */
export function projectMatches(project: SuiteProject, subject: MatchSubject): boolean {
  const { rules } = project;
  const facets = subject.facets ?? {};
  if (
    facets.codeProjectId !== undefined &&
    intersects([facets.codeProjectId], rules.code.projectIds)
  ) {
    return true;
  }
  if (intersects(facets.senders, rules.mail.senders)) return true;
  if (rules.mail.domains.length > 0 && facets.senders !== undefined) {
    const domains = rules.mail.domains.map(normalizeDomain).filter((domain) => domain.length > 0);
    for (const sender of facets.senders) {
      const domain = domainOf(sender);
      if (
        domain !== null &&
        domains.some((wanted) => domain === wanted || domain.endsWith(`.${wanted}`))
      ) {
        return true;
      }
    }
  }
  if (intersects(facets.labels, rules.mail.labels)) return true;
  if (intersects(facets.mailProjectIds, rules.mail.projectIds)) return true;
  if (
    facets.calendarId !== undefined &&
    intersects([facets.calendarId], rules.calendar.calendarIds)
  ) {
    return true;
  }
  if (subject.module === "calendar" && rules.calendar.keywords.length > 0) {
    const title = normalize(subject.title);
    if (
      rules.calendar.keywords
        .map(normalize)
        .some((keyword) => keyword.length > 0 && title.includes(keyword))
    ) {
      return true;
    }
  }
  if (intersects(facets.folderIds, rules.drive.folderIds)) return true;
  if (intersects(facets.folderSlugs, rules.drive.folderSlugs, normalizeSlug)) return true;
  return false;
}

export function matchProjectIds(
  projects: ReadonlyArray<SuiteProject>,
  subject: MatchSubject,
): Array<string> {
  return projects.filter((project) => projectMatches(project, subject)).map(({ id }) => id);
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Contributor priority plus small boosts: +10 when someone is blocked on the
 * user, and up to +10 for freshness (decaying over a day). Old items keep their
 * contributor priority, so a stale approval still outranks a fresh FYI.
 */
export function scoreItem(item: SuiteHomeItem, nowMs: number): number {
  const occurredMs = Date.parse(item.occurredAt);
  const ageHours = Number.isNaN(occurredMs) ? Infinity : Math.max(0, nowMs - occurredMs) / HOUR_MS;
  const freshness = ageHours < 1 ? 10 : ageHours < 6 ? 6 : ageHours < 24 ? 3 : 0;
  return item.priority + (item.waitingOnYou === true ? 10 : 0) + freshness;
}

const MODULE_ORDER: Record<SuiteHomeItemModule, number> = {
  code: 0,
  mail: 1,
  calendar: 2,
  drive: 3,
};

/** Merges every contributor's items into one ranked list, highest score first. */
export function rankItems(
  items: ReadonlyArray<SuiteHomeItem>,
  projects: ReadonlyArray<SuiteProject>,
  nowMs: number,
): Array<SuiteHomeRankedItem> {
  const seen = new Set<string>();
  const ranked: Array<SuiteHomeRankedItem> = [];
  for (const item of items) {
    const key = `${item.module}\u0000${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const projectIds = matchProjectIds(projects, item);
    const { projectKey: _oldProjectKey, ...unranked } = item;
    ranked.push({
      ...unranked,
      ...(projectIds[0] === undefined ? {} : { projectKey: projectIds[0] }),
      projectIds,
      score: scoreItem(item, nowMs),
    });
  }
  return ranked.toSorted(
    (left, right) =>
      right.score - left.score ||
      right.occurredAt.localeCompare(left.occurredAt) ||
      MODULE_ORDER[left.module] - MODULE_ORDER[right.module] ||
      left.id.localeCompare(right.id),
  );
}

export function todayEntries(
  events: ReadonlyArray<SuiteTodayEvent>,
  projects: ReadonlyArray<SuiteProject>,
): Array<SuiteHomeTodayEntry> {
  return events
    .map((event) => ({
      ...event,
      projectIds: matchProjectIds(projects, { module: "calendar", ...event }),
    }))
    .toSorted(
      (left, right) =>
        Number(right.allDay) - Number(left.allDay) || left.startsAt.localeCompare(right.startsAt),
    );
}

/** The current time, and the start of the server's local day for "today". */
export interface HomeClock {
  readonly nowMs: number;
  readonly todayStartMs: number;
}

const timeRangeStartMs = (range: SuiteViewFilter["timeRange"], clock: HomeClock) =>
  range === "today"
    ? clock.todayStartMs
    : range === "7d"
      ? clock.nowMs - 7 * 24 * HOUR_MS
      : range === "30d"
        ? clock.nowMs - 30 * 24 * HOUR_MS
        : null;

/** Keeps the items a saved view selects. Empty lists in the filter mean "any". */
export function filterItems<T extends SuiteHomeRankedItem>(
  items: ReadonlyArray<T>,
  filter: SuiteViewFilter,
  clock: HomeClock,
): Array<T> {
  const since = timeRangeStartMs(filter.timeRange, clock);
  const kinds = new Set(filter.kinds.map(normalize));
  return items.filter((item) => {
    if (filter.modules.length > 0 && !filter.modules.includes(item.module)) return false;
    if (
      filter.projectIds.length > 0 &&
      !item.projectIds.some((id) => filter.projectIds.includes(id))
    ) {
      return false;
    }
    if (kinds.size > 0 && !kinds.has(normalize(item.kind))) return false;
    if (filter.waitingOnMe && item.waitingOnYou !== true) return false;
    if (since !== null) {
      const occurredMs = Date.parse(item.occurredAt);
      if (Number.isNaN(occurredMs) || occurredMs < since) return false;
    }
    return true;
  });
}

/**
 * A project's pulse: matched needs-you items per module, plus today's matched
 * events for calendar and the active threads of its linked Code projects for
 * code (a project with linked code is busy even when nothing needs the user).
 */
export function projectCounts(
  project: SuiteProject,
  items: ReadonlyArray<SuiteHomeRankedItem>,
  today: ReadonlyArray<SuiteHomeTodayEntry>,
  activeThreadsByCodeProject: ReadonlyMap<string, number>,
): SuiteHomeModuleCounts {
  const counts = { code: 0, mail: 0, calendar: 0, drive: 0 };
  const codeItemThreads = new Set<string>();
  for (const item of items) {
    if (!item.projectIds.includes(project.id)) continue;
    if (item.module === "code") {
      codeItemThreads.add(item.facets?.threadId ?? item.id);
      continue;
    }
    counts[item.module] += 1;
  }
  counts.calendar += today.filter((event) => event.projectIds.includes(project.id)).length;
  const activeThreads = project.rules.code.projectIds.reduce(
    (sum, codeProjectId) => sum + (activeThreadsByCodeProject.get(codeProjectId) ?? 0),
    0,
  );
  counts.code = Math.max(activeThreads, codeItemThreads.size);
  return counts;
}
