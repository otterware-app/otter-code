import { isSupportFailure, supportError, type SupportError } from "@otter-mail/shared/support";

const errors: SupportError[] = [];

/** Only classified summaries are retained, even before the user opens a report. */
export function recordSupportError(
  level: string,
  scope: string,
  message: string,
  data?: unknown,
): void {
  if (!isSupportFailure(level, message)) return;
  let detail = "";
  try {
    detail = data instanceof Error ? (data.stack ?? data.message) : (JSON.stringify(data) ?? "");
  } catch {
    /* A logger must never break the operation it describes. */
  }
  const error = supportError(new Date().toISOString(), scope, `${message} ${detail}`);
  if (error) errors.push(error);
  if (errors.length > 50) errors.shift();
}

export const recentSupportErrors = (): SupportError[] => [...errors];
