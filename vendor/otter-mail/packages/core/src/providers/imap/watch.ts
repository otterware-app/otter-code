/**
 * Live mail for IMAP: IDLE on INBOX, on a connection of its own. What the
 * server reports (new mail, expunges, flag changes) calls `onChange`, a
 * second's worth at a time; so does every (re)connect, to catch up on what
 * happened meanwhile. IDLE is renewed every 25 minutes (servers drop it
 * after 30); a dropped connection is retried with backoff, and a server that
 * ends IDLE right away is asked again no sooner than every 30 seconds.
 * Servers without IDLE are left to the sync timer. A missing or refused
 * password ends the watch: retrying would only fail again.
 *
 * Back from sleep or offline (in the browser, also a tab shown again), the
 * connection is checked rather than replaced: ending IDLE shows whether the
 * server is still there, and only a dead one is reconnected, at once.
 */

import { logger } from "../../logger.js";
import { platform } from "../../platform.js";
import type { IdleSession, ImapClient } from "../../protocols/index.js";
import { isSignInFailure, openImap } from "./connection.js";

const RENEW_MS = 25 * 60_000;
const DEBOUNCE_MS = 1_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
/** The least time from one IDLE to the next, however soon the server ends them. */
const IDLE_GAP_MS = 30_000;
/** An IDLE that lasted this long shows the connection works: backoff starts over. */
const HEALTHY_MS = 60_000;

export function watchInbox(accountId: string, onChange: () => void): () => void {
  const stopped = new AbortController();
  let client: ImapClient | null = null;
  let session: IdleSession | null = null;
  let wake: (() => void) | null = null;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  /** Resumed: IDLE again (or reconnect) without waiting, and catch up. */
  let resumed = false;

  const changed = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (!stopped.signal.aborted) onChange();
    }, DEBOUNCE_MS);
  };

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const run = async () => {
    for (let attempt = 0; !stopped.signal.aborted; attempt++) {
      try {
        client = await openImap(accountId);
        if (!client.has("IDLE")) {
          logger.info("imap-watch", `${accountId}'s server can't IDLE; syncing on the timer`);
          await client.logout();
          return;
        }
        await client.select("INBOX");
        changed();
        while (!stopped.signal.aborted) {
          const started = Date.now();
          session = await client.idle(changed);
          const renew = setTimeout(() => void session?.stop(), RENEW_MS);
          try {
            await session.done;
          } finally {
            clearTimeout(renew);
            session = null;
          }
          const lasted = Date.now() - started;
          if (lasted >= HEALTHY_MS) attempt = 0;
          if (resumed) {
            // Still connected after all: IDLE again, and catch up.
            resumed = false;
            changed();
          } else if (!stopped.signal.aborted) await pause(Math.max(0, IDLE_GAP_MS - lasted));
        }
      } catch (err) {
        if (stopped.signal.aborted) break;
        client?.close();
        if (isSignInFailure(err)) {
          // The password is missing or was refused (and set aside): the sync
          // this triggers finds the mailbox signed out and stops the watch.
          logger.info("imap-watch", `IDLE for ${accountId} stopped: ${String(err)}`);
          changed();
          return;
        }
        const delay = resumed ? 0 : Math.min(RETRY_MIN_MS * 2 ** attempt, RETRY_MAX_MS);
        resumed = false;
        logger.info(
          "imap-watch",
          `IDLE for ${accountId} dropped (${String(err)}); again in ${delay / 1000}s`,
        );
        await pause(delay);
      }
    }
    // Stopped while connecting: that connection goes too.
    await client?.logout();
  };
  void run();

  const stopResume = platform().onResume(() => {
    resumed = true;
    // Idling: DONE answers if the connection lived; waiting to retry: now.
    if (session) void session.stop();
    else wake?.();
  });

  return () => {
    stopResume();
    stopped.abort();
    clearTimeout(debounce);
    wake?.();
    const idling = session;
    const open = client;
    void (async () => {
      await idling?.stop();
      await open?.logout();
    })();
  };
}
