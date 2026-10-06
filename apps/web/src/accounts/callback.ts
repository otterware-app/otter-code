import { OTTER_CODE_WEB_URL } from "@t3tools/shared/otterAccounts";

/** Remote servers require explicit approval on the hosted origin before receiving an account grant. */
export function parseAccountCallback(state: string) {
  const data: unknown = JSON.parse(state);
  if (
    !data ||
    typeof data !== "object" ||
    !("origin" in data) ||
    !("nonce" in data) ||
    typeof data.origin !== "string" ||
    typeof data.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(data.nonce)
  )
    throw new Error("invalid_request");
  const origin = new URL(data.origin);
  if (
    origin.origin !== data.origin ||
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password
  )
    throw new Error("invalid_origin");
  return {
    origin: origin.origin,
    trusted: [
      OTTER_CODE_WEB_URL,
      "https://latest.code.otterware.app",
      "https://nightly.code.otterware.app",
    ].includes(origin.origin),
  };
}
