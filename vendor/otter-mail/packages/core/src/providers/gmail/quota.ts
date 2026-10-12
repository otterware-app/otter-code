/**
 * Gmail's per-user quota, shared by everything the app does with an account.
 *
 * Every Gmail call costs quota units against a per-user limit of 6,000 a
 * minute (Gmail's 403 "Quota exceeded … Units per minute per user"; the
 * Cloud console won't raise it). Google publishes a cost per method (since
 * May 2026: messages.get 20, threads.get 40, send 100, …), but a full-format
 * fetch is charged about 2.5 times that: measured on a quiet minute, 313
 * metadata fetches went through, 118 full ones, 61 full threads.
 *
 * Pacing by those costs keeps big syncs just under the limit instead of
 * tripping it over and over (which stalls everything behind a cooldown).
 * What the table doesn't know (other devices on the same account, costs that
 * move) Gmail tells: after a refusal the minute's budget comes down to what
 * was spent, and climbs back slowly while Gmail stays quiet.
 *
 * Every request draws from one token bucket per account, in four tiers:
 *
 *  - foreground work (what the user just did) takes units as soon as they're
 *    there and goes ahead of anything waiting;
 *  - sync work (new mail: the history feed) only spends above a reserve kept
 *    for the user;
 *  - backfill work (filling or re-reading the whole mailbox) only spends
 *    above a larger reserve, and never while sync work is waiting;
 *  - prefetch work (downloading bodies for offline reading) keeps the largest
 *    reserve and waits for both.
 *
 * Background tiers pause entirely for a while after Gmail reports the quota
 * exhausted. Work is tagged by running it inside `inTier`; anything else
 * counts as foreground.
 */

import { platform, type AsyncContext } from "../../platform.js";
import type { Lane } from "../provider.js";

/** Gmail's per-minute limit for this project, per user. */
const UNITS_PER_MINUTE_LIMIT = 6_000;
/**
 * What a minute may spend (a full minute of refill plus one full burst): it
 * starts below the limit, where a big sync settled on a real mailbox (Gmail
 * counts a little more than the table), and never goes past MAX_BUDGET.
 */
const START_BUDGET = UNITS_PER_MINUTE_LIMIT * 0.8;
const MAX_BUDGET = UNITS_PER_MINUTE_LIMIT * 0.95;
/** Burst capacity of the bucket: a page of messages the user opens at once. */
const CAPACITY = 600;
/** After a refusal the budget never drops below this, and climbs back this much a minute. */
const MIN_BUDGET = UNITS_PER_MINUTE_LIMIT * 0.2;
const RECOVERY_PER_MINUTE = UNITS_PER_MINUTE_LIMIT * 0.01;
/** Units each tier leaves in the bucket for the ones ahead of it (the user's next action first). */
const RESERVE: Record<Lane, number> = { sync: 100, backfill: 200, prefetch: 300 };
/** Background tiers, most urgent first: each yields to those before it. */
const TIERS: Lane[] = ["sync", "backfill", "prefetch"];
/** How long background work stands down after a quota error: Gmail's window is a minute. */
const COOLDOWN_MS = 60_000;

type Bucket = {
  tokens: number;
  updatedAt: number;
  /** Units a minute this account may spend, as Gmail has shown it. */
  budget: number;
  /** Background work waits until then after a quota error. */
  cooldownUntil: number;
  /** Foreground requests waiting for units; background yields to them. */
  foregroundWaiting: number;
  /** Background requests waiting for units, per tier; later tiers yield to them. */
  waiting: Record<Lane, number>;
};

const buckets = new Map<string, Bucket>();
/** What each account spent, recently: [time, units], for the log when Gmail pushes back. */
const spent = new Map<string, [number, number][]>();

/** Units a minute the account may spend right now (lower after Gmail refused). */
export function budgetOf(accountId: string): number {
  return Math.round(bucketFor(accountId).budget);
}

/** Units this device spent on the account in the last minute. */
export function spentLastMinute(accountId: string): number {
  const recent = (spent.get(accountId) ?? []).filter(([at]) => at > Date.now() - 60_000);
  spent.set(accountId, recent);
  return recent.reduce((sum, [, units]) => sum + units, 0);
}

function record(accountId: string, units: number): void {
  const list = spent.get(accountId) ?? [];
  list.push([Date.now(), units]);
  if (list.length > 2000) list.splice(0, list.length - 1000);
  spent.set(accountId, list);
}
let tierContext: AsyncContext<Lane> | null = null;
/** Which tier the running work belongs to (AsyncLocalStorage on the desktop). */
const tier = (): AsyncContext<Lane> => (tierContext ??= platform().asyncContext<Lane>());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bucketFor(accountId: string): Bucket {
  let bucket = buckets.get(accountId);
  if (!bucket) {
    bucket = {
      tokens: CAPACITY,
      updatedAt: Date.now(),
      budget: START_BUDGET,
      cooldownUntil: 0,
      foregroundWaiting: 0,
      waiting: { sync: 0, backfill: 0, prefetch: 0 },
    };
    buckets.set(accountId, bucket);
  }
  const now = Date.now();
  const elapsed = now - bucket.updatedAt;
  bucket.budget = Math.min(MAX_BUDGET, bucket.budget + (elapsed / 60_000) * RECOVERY_PER_MINUTE);
  bucket.tokens = Math.min(CAPACITY, bucket.tokens + (elapsed / 1000) * unitsPerSecond(bucket));
  bucket.updatedAt = now;
  return bucket;
}

/** The sustained refill: a minute of it plus one full burst stays within the budget. */
function unitsPerSecond(bucket: Bucket): number {
  return Math.max(1, (bucket.budget - CAPACITY) / 60);
}

/** Runs `fn` as background work of `lane`: it yields quota to the user and to more urgent lanes. */
export function inTier<T>(lane: Lane, fn: () => Promise<T>): Promise<T> {
  return tier().run(lane, fn);
}

/** True for background work (anything the user isn't waiting on). */
export function isBackgroundWork(): boolean {
  return tier().get() !== undefined;
}

/** Background work is standing down after a quota error (prefetch checks this to pause). */
export function isCoolingDown(accountId: string): boolean {
  return Date.now() < bucketFor(accountId).cooldownUntil;
}

/** Waits until `units` can be spent on this account, then spends them. */
export async function acquireQuota(accountId: string, units: number): Promise<void> {
  const current = tier().get();
  if (current === undefined) {
    let bucket = bucketFor(accountId);
    if (bucket.tokens >= units) {
      bucket.tokens -= units;
      record(accountId, units);
      return;
    }
    bucket.foregroundWaiting += 1;
    try {
      while (bucket.tokens < units) {
        await sleep(((units - bucket.tokens) / unitsPerSecond(bucket)) * 1000);
        bucket = bucketFor(accountId);
      }
      bucket.tokens -= units;
      record(accountId, units);
    } finally {
      bucket.foregroundWaiting -= 1;
    }
    return;
  }

  const ahead = TIERS.slice(0, TIERS.indexOf(current));
  const counted = bucketFor(accountId);
  counted.waiting[current] += 1;
  try {
    for (;;) {
      const bucket = bucketFor(accountId);
      const now = Date.now();
      if (now < bucket.cooldownUntil) {
        await sleep(bucket.cooldownUntil - now);
        continue;
      }
      const needed = units + RESERVE[current];
      const yielding =
        bucket.foregroundWaiting > 0 || ahead.some((lane) => bucket.waiting[lane] > 0);
      if (!yielding && bucket.tokens >= needed) {
        bucket.tokens -= units;
        record(accountId, units);
        return;
      }
      await sleep(Math.max(50, ((needed - bucket.tokens) / unitsPerSecond(bucket)) * 1000));
    }
  } finally {
    counted.waiting[current] -= 1;
  }
}

/**
 * Gmail said the quota is exhausted: drain the bucket so everyone slows down,
 * bring the minute's budget down to what it let through, and keep background
 * work away for `retryAfterMs` (at least COOLDOWN_MS). Refusals of requests
 * already in flight are the same event: false for those.
 */
export function reportQuotaExceeded(accountId: string, retryAfterMs: number): boolean {
  const bucket = bucketFor(accountId);
  bucket.tokens = 0;
  const now = Date.now();
  if (now < bucket.cooldownUntil) return false;
  // What this device spent is what the minute allows (others share it); a
  // refusal after spending little (a restart, another device) only trims.
  const used = spentLastMinute(accountId);
  const allowed = used > bucket.budget * 0.3 ? used * 0.9 : bucket.budget * 0.8;
  bucket.budget = Math.max(MIN_BUDGET, Math.min(bucket.budget, allowed));
  bucket.cooldownUntil = now + Math.max(retryAfterMs, COOLDOWN_MS);
  return true;
}

/** Quota units of one Gmail REST call (developers.google.com/workspace/gmail/api/reference/quota). */
export function quotaCost(method: string, path: string): number {
  const p = path.split("?")[0]!;
  const write = method !== "GET";
  if (p === "/profile") return 1;
  if (p.startsWith("/labels")) return write ? 5 : 1;
  if (p.startsWith("/settings/sendAs")) return method === "GET" ? 1 : 100;
  if (p.startsWith("/history")) return 2;
  if (p === "/watch" || p === "/messages/send" || p === "/drafts/send") return 100;
  if (p === "/stop" || /^\/messages\/batch(Delete|Modify)$/.test(p)) return 50;
  if (p === "/messages") return write ? 25 : 5; // list; insert/import
  if (p === "/threads") return 10; // list
  if (p === "/drafts") return write ? 10 : 5; // create; list
  const [, kind, , action] = p.split("/"); // /messages/{id}/trash → messages, {id}, trash
  // A full-format get is charged about 2.5 times the published cost (measured).
  const full = /[?&]format=full\b/.test(path);
  if (kind === "messages") {
    if (action === "attachments" || action === "trash") return 20;
    if (action === "modify" || action === "untrash") return 5;
    if (method === "DELETE") return 10;
    return full ? 50 : 20; // get
  }
  if (kind === "threads") {
    if (action === "trash") return 20;
    if (action === "modify" || action === "untrash") return 10;
    if (method === "DELETE") return 20;
    return full ? 100 : 40; // get
  }
  if (kind === "drafts") return method === "PUT" ? 15 : method === "DELETE" ? 10 : 20;
  return 20;
}
