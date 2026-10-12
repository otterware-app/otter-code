/**
 * What `@t3tools/contracts` exports for Otterware Calendar (one line in `../../index.ts`): Otter
 * Calendar's vendored domain schemas, as its own code imports them, plus the suite method names
 * the vendored client state reads in place of `WS_METHODS` (a manifest rewrite).
 */
export * from "../../calendar.ts";
export { SUITE_CALENDAR_METHODS } from "../calendar.ts";
