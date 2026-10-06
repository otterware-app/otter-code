# Calendar engine

Otter Calendar renders several Google accounts in one grid and has to feel instant while doing it.
This page records what we evaluated before building it (September 2026), what we adopted, what we
built ourselves, and the constraints that follow. The research behind it measured bundle sizes with
esbuild, read the libraries' source, and went through their issue trackers; the numbers below come
from that work.

## Decision in one paragraph

We built our own engine: a small pure core in `packages/client-runtime/src/calendar` (day
bucketing, overlap layout, lane packing, week chunks, formatting) shared by web and mobile, React
views in `apps/web/src/components/calendar/engine`, one Pointer Events controller for every drag,
and zone and recurrence math in `packages/shared/src/calendar` that the server also uses. No
calendar or drag-and-drop library is a dependency. We copied FullCalendar v7's overlap algorithm
and drag architecture, Google Calendar's keyboard model and recurring-edit semantics, and Notion
Calendar's sidebar and side panel.

## Calendar libraries

| Library                                  | Version, license                                                 | Size (min+gz, measured)           | Why not                                                                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FullCalendar v7 (`@fullcalendar/react`)  | 7.1.0, MIT core (timeline/resource/print premium)                | 80 KB, 95 KB w/ Temporal polyfill | The only credible option. Layout is measure-then-position ([#8076], [#8088], [#8090] in v7), keeps its own event store we would mirror, whole-view re-render on drag ([#3003]), no React Native |
| Schedule-X                               | 4.9.1, MIT core; drawing events in the grid is premium (€479/yr) | 56 KB (Preact inside)             | Drag-to-create is paid; custom React events are one portal and one state update each; paging leak ([#1112])                                                                                     |
| react-big-calendar                       | 1.20.0, MIT                                                      | 78 KB                             | Class components, minimal memoization (maintainers, [#2255]); 1,000+ events in a month freeze > 5 s ([#2752]); O(n²) overlap algorithms                                                         |
| Toast UI Calendar                        | 2.1.3 (2022), MIT                                                | 86 KB                             | Repository archived                                                                                                                                                                             |
| EventCalendar (vkurko)                   | 5.15.0, MIT                                                      | 50 KB                             | Svelte 5, no React build. Good reading                                                                                                                                                          |
| ReUI event calendar, ilamy, Big Calendar | MIT shadcn-style code                                            | n/a                               | Reference code, not libraries. Big Calendar's week view mounts 672 drop targets; borrowed looks only                                                                                            |
| Planby                                   | proprietary license                                              | n/a                               | License                                                                                                                                                                                         |

[#8076]: https://github.com/fullcalendar/fullcalendar/issues/8076
[#8088]: https://github.com/fullcalendar/fullcalendar/issues/8088
[#8090]: https://github.com/fullcalendar/fullcalendar/issues/8090
[#3003]: https://github.com/fullcalendar/fullcalendar/issues/3003
[#1112]: https://github.com/schedule-x/schedule-x/issues/1112
[#2255]: https://github.com/jquense/react-big-calendar/issues/2255
[#2752]: https://github.com/jquense/react-big-calendar/issues/2752

Building won because no library runs on React Native (the mobile app shares the core), because a
fixed-geometry grid can be placed with arithmetic instead of measurement, and because the hard
parts are small: the overlap algorithm is about 150 lines. UX references: Notion Calendar (Cron)
for the sidebar, the right-hand details panel and ⌘K; Google Calendar for single-key shortcuts
(T, D/W/M/A/X, J/K, C, /, G) and the "This / This and following / All" prompt; Fantastical for
Option-drag to duplicate.

## Drag and drop

| Library                  | Version, license   | Size (gz) | React work per pointer move                           | Why not                                                                                                |
| ------------------------ | ------------------ | --------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@dnd-kit/core`          | 6.3.1, MIT         | 14.6 KB   | Re-renders the active item and every context consumer | Per-frame renders; pixel-delta snapping (`Math.ceil`); no create or resize                             |
| `@dnd-kit/react` / `dom` | 0.5.0, MIT         | 34 KB     | None (signals)                                        | Pre-1.0 with breaking releases in 2026; Safari scroll bugs; no create or resize                        |
| Pragmatic drag and drop  | 4.0.0, Apache-2.0  | ~4.7 KB   | None, but native previews are static bitmaps          | No live resize or snap feedback; touch needs long-press; keep for dropping files from other apps later |
| react-dnd                | 16.0.1 (2022), MIT | 13.7 KB   | Custom drag layers re-render per move                 | Unmaintained                                                                                           |
| `@use-gesture/react`     | 10.3.1 (2024), MIT | 9.1 KB    | None if handlers write refs                           | Dormant; captures on the event element, which remounts across columns                                  |

Every mature calendar (FullCalendar, react-big-calendar, Schedule-X) hand-writes its pointer
handling, and none of the libraries covers drag-to-create or edge resize. So the engine has one
controller per surface. The rules it follows, and that changes to it must keep:

- **Capture on the stable surface root**, never on the event element: an event that React moves to
  another day column would lose capture.
- **Measure once per gesture.** Column rects, the grid origin and minutes per pixel are cached at
  drag start; the scroll offset comes from a passive listener. Pointer position becomes
  `(lane, day, minute)` by arithmetic, snapped in minutes (15 by default), never by pixel delta.
- **No React renders during a gesture.** One ghost element per lane is written through refs inside
  `requestAnimationFrame`, and only when the snapped slot changes. React sees one commit, on drop.
- Movement threshold 4 px for mouse; long-press for touch drags (vertical scrolling stays native),
  immediate resize handles. Escape, `pointercancel`, `lostpointercapture` and blur cancel; the click
  after a drag is swallowed. Auto-scroll near the edges runs on its own frame loop and re-hit-tests
  every frame.
- Keyboard: focused events move with Alt+↑/↓ (15 minutes) and Alt+←/→ (a day) and resize with
  Alt+Shift+↑/↓; rapid presses coalesce into one change and one undo entry. The editor's date and
  time fields are the pointer alternative WCAG 2.5.7 requires.

## Layout

Time grid columns use the Google-style column packing FullCalendar v7 uses, without its
measurement: sort by start, then longer first; sweep into clusters of transitively overlapping
events; assign each event the lowest free column (greedy colouring is optimal for intervals);
then widen each event right until the first column holding an event it overlaps. Short events get
a minimum visual duration before packing so events that look overlapping pack as overlapping.
O(n log n + n·K·log n) per day with K columns. The output is fractions; vertical placement is CSS
(`calc(var(--hour-height) * …)`), so zooming hours changes one variable and lays out nothing.

The all-day lane and month week-rows use level packing on day spans, with the number of visible
levels derived from one `ResizeObserver` on the grid and the rest behind "+N more". Individual
events are never measured.

Layout is memoized per day on that day's bucket identity: navigating or dragging lays out only the
columns whose events changed. Timed events are placed by their wall-clock minutes in the viewer's
zone, so DST days (23 or 25 hours) render at the right hours.

The agenda uses `@legendapp/list`, already a dependency of web and mobile. The time grid and month
grid are not virtualized: a week or a month renders once. Columns and blocks carry
`contain: layout paint`, and nothing animates continuously (the now line moves once a minute).

## Time zones and recurrence

Instants are epoch milliseconds; civil dates are day numbers (days since 1970-01-01). All calendar
arithmetic happens on day numbers, so it never crosses a DST edge; a zone converts between the two
([`time.ts`](../../packages/shared/src/calendar/time.ts)). Offsets come from `Intl.DateTimeFormat`
and are cached per zone and UTC day, so converting an instant is a map lookup. Wall times in a
spring-forward gap resolve forward and ambiguous fall-back times resolve to the earlier instant,
matching Temporal's `compatible` mode and Google Calendar. All-day events are floating dates
(UTC midnight on the wire), never instants.

Alternatives we measured (Node 24, September 2026), with a 300-series benchmark: 300 endless
daily, weekly and monthly series in New York, Berlin and Kolkata, expanded over a six-week window
that crosses both DST changes:

| Option                                       | Result                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `rrule` (rrule.js 2.8, MIT)                  | 32 s; returns different instants depending on the host's zone, so unusable on users' machines       |
| `rrule-temporal` (MIT) + `temporal-polyfill` | 72 ms (10 ms with native Temporal on Node 26); drops occurrences whose wall time falls in a DST gap |
| `rschedule`, `ical.js`                       | Unmaintained since 2023; needs bundled zone definitions                                             |
| Ours (`recurrence.ts`)                       | **5.4 ms**, correct wall-clock times across both transitions                                        |

For zone conversion, a cached `Intl.DateTimeFormat.formatToParts` costs about 4.7 µs per instant
and an uncached one 77 µs; `@date-fns/tz` and Luxon sit on the same Intl calls, and Temporal is
native only in Chrome 144+, Firefox 139+, Electron and Node 26+, not in Node 24, Safari or Hermes
(the mobile runtime), where the polyfill adds about 20 KB gzip. Our per-zone, per-UTC-day offset
cache converts 100,000 instants in 6.8 ms (0.07 µs each). So the engine uses neither a Temporal
polyfill nor a date library.

[`recurrence.ts`](../../packages/shared/src/calendar/recurrence.ts) expands the RFC 5545 subset
Google produces (DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL, BYDAY with ordinals,
BYMONTHDAY, BYMONTH, BYSETPOS, WKST; EXDATE and RDATE). It evaluates rules on civil dates in the
event's own zone, so a 09:00 Berlin meeting stays at 09:00 Berlin across DST, and series without
COUNT jump straight to the requested window instead of iterating from their start. The series
start is always the first occurrence, as in Google Calendar; a wall time inside a DST gap moves
forward rather than disappearing.

## Server-side model

The environment owns the data ([overview](./overview.md)). It syncs each Google account with
`events.list(singleEvents=false, showDeleted=true)` and sync tokens, storing singles, recurring
masters and exceptions as Google returns them, and **materializes** occurrences into an instances
table over a horizon per calendar that grows when a client asks for weeks outside it. Clients
never expand recurrences, and a week query is an indexed range scan. Instances longer than a week
are flagged so short ones can use a start-time index. This is how Thunderbird's Google provider
and Android's calendar store work. `singleEvents=true` also works with sync tokens, but returns
every occurrence as a full event, never delivers occurrences of endless series that enter a fixed
window later, and loses the rule that "all" and "this and following" edits need.

Cancelled items that carry `recurringEventId` are cancelled occurrences and stay stored for the
life of the series; other cancelled items are deletions.

Clients subscribe to **week chunks**: seven UTC days starting on a Monday. A view subscribes to the
chunks covering its dates padded by a day (so every zone is covered), merges them by
`<calendarId>/<eventId>`, and prefetches the neighbouring period, so paging is instant and
revisited weeks come from memory. Hidden calendars are not sent; visibility lives on the server so
every device agrees. Changes arrive as diffs; a full resync replaces one calendar's instances in
the affected chunks.

Every mutation answers with the steps that undo it, computed by the server from the state before
the change. Clients apply changes optimistically, drop the overlay when the server's own update
arrives, roll back on failure, and keep undo steps on a stack; `calendar.applyChanges` runs them
and answers with the redo steps.

Recurring edits follow Google: "this" patches the instance id (`<seriesId>_<originalStart>`),
creating an exception; "all" patches the master, shifting it by the same delta when the time
changed; "this and following" splits the series (UNTIL on the original, a new series from the
edited occurrence), which is what Google's own UI does and what its API documentation asks for.

## Sync and Google sign-in

The sync loop runs every minute per account while clients are subscribed and every fifteen
minutes otherwise. A `410 Gone` drops the sync token and resyncs that calendar; `403
rateLimitExceeded`/`429` and `5xx` back off exponentially with jitter, honoring `Retry-After`.
Fields masks must name `nextSyncToken`, or Google silently omits it. Push notifications need a
public HTTPS webhook, which a local environment does not have, so polling is the model. Quotas
make that a budget: 600 requests per minute per user, and since May 2026 a billing threshold of
one million requests per day per OAuth client, which one-minute polling of every calendar would
reach at about 700 calendars on a shared client. Self-hosters use their own client; a hosted
client would need the T3 Connect relay as the public endpoint for push channels.

Sign-in is the installed-app flow for a Google "Desktop app" client: PKCE, `access_type=offline`,
`prompt=select_account consent` (so a second Google account can be added and a refresh token is
always returned), and a loopback redirect to `127.0.0.1`. Scopes are `calendar.events` and
`calendar.calendarlist.readonly` plus `openid email profile`: calendar scopes are sensitive but
not restricted, so an unverified client works for its owner. Calendar colors and visibility are
the app's own settings, which is why the calendar list is read-only. A client left in "Testing"
gets refresh tokens that expire after seven days; they surface as a signed-out account. The environment listens on that port itself, which completes sign-in when the
browser runs on the environment's machine. For a browser on another machine the redirect lands on
that machine's loopback, so the client carries it back: the desktop app catches it on the same
port and forwards the URL; other clients ask the user to paste the address. This is the
[provider sign-in rule](./providers.md) applied to Google. The out-of-band copy-code flow Google
deprecated is not used. Tokens live in the server's secret store, per account.
