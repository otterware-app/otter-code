/** Reuses one Code authorization for native suite services. No credentials go to remote environments. */
import { OtterAccountUser } from "@t3tools/contracts/accounts";
import * as Schema from "effect/Schema";

const Credential = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.Number,
  user: OtterAccountUser,
});

const decodeCredential = Schema.decodeUnknownSync(Credential);

export function isLocalSuiteTarget(desktop: boolean, baseUrl: string | null): boolean {
  if (!desktop || !baseUrl) return false;
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function createSuiteAccountSession(options: {
  readonly accountsUrl: string;
  readonly fetch: typeof fetch;
  readonly apply: (token: string | null) => Promise<void>;
}) {
  let credential: typeof Credential.Type | null = null;
  let generation = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.catch(() => undefined).then(run);
    tail = next;
    return next;
  };
  return {
    ensure: (accessToken: string, userId: string | null) => {
      const current = generation;
      return serialize(async () => {
        if (current !== generation) throw new Error("The Otter account changed. Try again.");
        if (
          credential &&
          credential.user.id === userId &&
          credential.expiresAt > Date.now() + 120_000
        )
          return;
        const response = await options.fetch(`${options.accountsUrl}/suite/session`, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: "{}",
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok)
          throw new Error("Could not reuse your Otter sign-in. Please sign in again.");
        const next = decodeCredential(await response.json());
        if (next.expiresAt <= Date.now() || (userId !== null && next.user.id !== userId))
          throw new Error("Accounts returned a different or expired Otter session.");
        if (current !== generation) throw new Error("The Otter account changed. Try again.");
        if (credential?.token !== next.token) {
          await options.apply(next.token);
          if (current !== generation) return;
        }
        credential = next;
      });
    },
    clear: () => {
      generation += 1;
      credential = null;
      return serialize(() => options.apply(null));
    },
  };
}
