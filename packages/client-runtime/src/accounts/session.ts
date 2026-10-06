import { OtterAccountSession, OtterAccountUser } from "@t3tools/contracts/accounts";
import * as Schema from "effect/Schema";

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.Int.check(Schema.isGreaterThan(0)),
  token_type: Schema.Literal("Bearer"),
});
const decodeTokenResponse = Schema.decodeUnknownSync(TokenResponse);
const decodeUser = Schema.decodeUnknownSync(OtterAccountUser);
const decodeSession = Schema.decodeUnknownSync(Schema.fromJsonString(OtterAccountSession));

export class AccountRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(
      status === 401 || code === "invalid_grant"
        ? "Your Otter session has ended. Sign in again."
        : "Could not reach Otter Accounts. Please try again.",
    );
    this.status = status;
    this.code = code;
  }
}

/** Storage belongs to the surface: browser storage, Electron safeStorage or native Keychain. */
export interface AccountSessionStorage {
  readonly read: () => Promise<string | null>;
  readonly write: (value: string | null) => Promise<void>;
}

export function createAccountSession(input: {
  readonly accountsUrl: string;
  readonly resource: string;
  readonly clientId: string;
  readonly storage: AccountSessionStorage;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly withStorageLock?: <T>(operation: () => Promise<T>) => Promise<T>;
}) {
  let session: OtterAccountSession | null = null;
  let loaded = false;
  let generation = 0;
  let refreshing: Promise<string | null> | null = null;
  let rotated: { readonly generation: number; readonly token: string } | null = null;
  const listeners = new Set<() => void>();
  const now = input.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  const locked = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(() =>
      input.withStorageLock ? input.withStorageLock(operation) : operation(),
    );
    queue = next.catch(() => {});
    return next;
  };
  const restore = (saved: string | null) => {
    if (!saved) return null;
    try {
      const restored = decodeSession(saved);
      return restored.accountsUrl === input.accountsUrl &&
        restored.resource === input.resource &&
        restored.clientId === input.clientId
        ? restored
        : null;
    } catch {
      return null;
    }
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const snapshot = () => ({ loaded, user: session?.user ?? null });
  let current = snapshot();
  const publish = () => {
    current = snapshot();
    notify();
  };
  const request = async (path: string, options: RequestInit) => {
    const response = await input.fetch(`${input.accountsUrl.replace(/\/$/, "")}${path}`, {
      ...options,
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const data: unknown = await response.json().catch(() => null);
      const code =
        data && typeof data === "object" && "error" in data && typeof data.error === "string"
          ? data.error
          : "request_failed";
      throw new AccountRequestError(response.status, code);
    }
    return response;
  };
  const tokenRequest = async (body: Record<string, string>) =>
    decodeTokenResponse(
      await (
        await request("/oauth2/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: input.clientId,
            resource: input.resource,
            ...body,
          }),
        })
      ).json(),
    );
  const readUser = async (accessToken: string) =>
    decodeUser(
      await (
        await request("/code/session", {
          headers: { authorization: `Bearer ${accessToken}` },
        })
      ).json(),
    );
  const persist = async (next: OtterAccountSession | null, expectedGeneration: number) => {
    if (generation !== expectedGeneration) return false;
    await input.storage.write(next ? JSON.stringify(next) : null);
    if (generation !== expectedGeneration) return false;
    session = next;
    publish();
    return true;
  };
  const revoke = async (refreshToken: string) => {
    await request("/oauth2/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.clientId,
        token: refreshToken,
        token_type_hint: "refresh_token",
      }),
    });
  };
  const clear = async () => {
    generation += 1;
    session = null;
    refreshing = null;
    publish();
    await locked(() => input.storage.write(null));
  };
  const readToken = async (): Promise<string | null> => {
    if (!session) return null;
    if (session.expiresAt > now() + 60_000) return session.accessToken;
    if (refreshing) return refreshing;
    const expectedGeneration = generation;
    const operation = locked(async () => {
      if (generation !== expectedGeneration) return null;
      // Another browser tab may already have rotated or removed these credentials.
      const previous = restore(await input.storage.read());
      if (generation !== expectedGeneration) return null;
      if (!previous) {
        session = null;
        publish();
        return null;
      }
      if (previous.expiresAt > now() + 60_000) {
        session = previous;
        publish();
        return previous.accessToken;
      }
      try {
        const response = await tokenRequest({
          grant_type: "refresh_token",
          refresh_token: previous.refreshToken,
        });
        rotated = {
          generation: expectedGeneration,
          token: response.refresh_token ?? previous.refreshToken,
        };
        const next = {
          ...previous,
          accessToken: response.access_token,
          refreshToken: response.refresh_token ?? previous.refreshToken,
          expiresAt: now() + response.expires_in * 1_000,
        };
        return (await persist(next, expectedGeneration)) ? next.accessToken : null;
      } catch (error) {
        if (
          generation === expectedGeneration &&
          error instanceof AccountRequestError &&
          (error.status === 401 || error.code === "invalid_grant")
        ) {
          generation += 1;
          session = null;
          publish();
          await input.storage.write(null);
        }
        throw error;
      }
    });
    refreshing = operation;
    try {
      return await operation;
    } finally {
      if (refreshing === operation) refreshing = null;
    }
  };
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load: async () => {
      const expectedGeneration = generation;
      await locked(async () => {
        const restored = restore(await input.storage.read());
        if (generation !== expectedGeneration) return;
        generation += 1;
        session = restored;
        loaded = true;
        publish();
      });
    },
    signIn: async (authorization: {
      readonly code: string;
      readonly verifier: string;
      readonly redirectUri: string;
    }) => {
      const expectedGeneration = ++generation;
      const response = await tokenRequest({
        grant_type: "authorization_code",
        code: authorization.code,
        code_verifier: authorization.verifier,
        redirect_uri: authorization.redirectUri,
      });
      if (!response.refresh_token) throw new AccountRequestError(502, "missing_refresh_token");
      const refreshToken = response.refresh_token;
      try {
        const user = await readUser(response.access_token);
        const saved = await locked(() =>
          persist(
            {
              version: 1,
              accountsUrl: input.accountsUrl,
              resource: input.resource,
              clientId: input.clientId,
              accessToken: response.access_token,
              refreshToken,
              expiresAt: now() + response.expires_in * 1_000,
              user,
            },
            expectedGeneration,
          ),
        );
        if (!saved) await revoke(refreshToken);
      } catch (error) {
        await revoke(refreshToken).catch(() => {});
        throw error;
      }
    },
    readToken,
    validate: async () => {
      const token = await readToken();
      if (!token) return;
      const expectedGeneration = generation;
      try {
        await readUser(token);
      } catch (error) {
        if (
          generation === expectedGeneration &&
          session?.accessToken === token &&
          error instanceof AccountRequestError &&
          error.status === 401
        )
          await clear();
        throw error;
      }
    },
    signOut: async () => {
      const previous = session;
      const previousGeneration = generation;
      await clear();
      if (previous)
        await revoke(
          rotated && rotated.generation === previousGeneration
            ? rotated.token
            : previous.refreshToken,
        );
    },
  };
}
