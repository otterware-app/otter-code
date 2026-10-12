/** Bound automatic recovery even if Drive keeps returning its login page after a successful sync. */
export function createDriveAccountRecovery(options: {
  readonly renew: () => Promise<void>;
  readonly reload: () => void;
  readonly trace: (event: string) => void;
  readonly now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let pending = false;
  let attempts = 0;
  let nextAttemptAt = 0;
  let failed = false;
  return {
    healthy: () => {
      if (pending) return;
      attempts = 0;
      nextAttemptAt = 0;
      failed = false;
    },
    recover: async () => {
      if (pending || failed || attempts >= 3 || now() < nextAttemptAt) return;
      pending = true;
      nextAttemptAt = now() + 60_000 * 2 ** attempts;
      attempts += 1;
      options.trace("self-heal triggered");
      try {
        await options.renew();
        options.reload();
      } catch {
        failed = true;
        options.trace("self-heal failed; automatic recovery stopped");
      } finally {
        pending = false;
      }
    },
  };
}
