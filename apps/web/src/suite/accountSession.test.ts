import { createAccountSession } from "@t3tools/client-runtime/accounts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  createSuiteAccountSession,
  isLocalSuiteTarget,
  shouldClearSuiteAccount,
} from "./accountSession";

const user = { id: "same-otter-user", email: "user@example.com", name: "User", image: null };
const credential = () => ({ token: "native-token", user, expiresAt: Date.now() + 900_000 });
it("only shares account credentials with the laptop's local suite", () => {
  expect(isLocalSuiteTarget(true, "http://127.0.0.1:4242")).toBe(true);
  expect(isLocalSuiteTarget(true, "http://localhost:4242")).toBe(true);
  expect(isLocalSuiteTarget(false, "http://localhost:4242")).toBe(false);
  expect(isLocalSuiteTarget(true, "https://fleet.otterware.app")).toBe(false);
});
it("reuses one verified identity until refresh and clears every surface on sign-out", async () => {
  const fetcher = vi.fn(async () => Response.json(credential()));
  const apply = vi.fn(async () => {});
  const session = createSuiteAccountSession({
    accountsUrl: "https://accounts.test/v1/auth",
    fetch: fetcher,
    apply,
  });
  await session.ensure("code-token", user.id);
  await session.ensure("code-token", user.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledExactlyOnceWith("native-token");
  await session.clear();
  expect(apply).toHaveBeenLastCalledWith(null);
});
it("refuses a different canonical identity", async () => {
  const apply = vi.fn(async () => {});
  const session = createSuiteAccountSession({
    accountsUrl: "https://accounts.test/v1/auth",
    fetch: vi.fn(async () => Response.json(credential())),
    apply,
  });
  await expect(session.ensure("code-token", "different-user")).rejects.toThrow(
    "different or expired",
  );
  expect(apply).not.toHaveBeenCalled();
});
it("discards an exchange that finishes after sign-out", async () => {
  let respond!: (response: Response) => void;
  let begun!: () => void;
  const requested = new Promise<void>((resolve) => {
    begun = resolve;
  });
  const fetcher = vi.fn(() => {
    begun();
    return new Promise<Response>((resolve) => {
      respond = resolve;
    });
  });
  const apply = vi.fn(async () => {});
  const session = createSuiteAccountSession({
    accountsUrl: "https://accounts.test/v1/auth",
    fetch: fetcher,
    apply,
  });
  const exchange = session.ensure("code-token", user.id);
  await requested;
  const clear = session.clear();
  respond(Response.json(credential()));
  await expect(exchange).rejects.toThrow("account changed");
  await clear;
  expect(apply).toHaveBeenCalledExactlyOnceWith(null);
});

it("does not clear a persisted Drive account on initial auth discovery", () => {
  expect(shouldClearSuiteAccount(undefined, "user-a")).toBe(false);
  expect(shouldClearSuiteAccount(undefined, null)).toBe(false);
  expect(shouldClearSuiteAccount("user-a", "user-a")).toBe(false);
  expect(shouldClearSuiteAccount("user-a", null)).toBe(true);
  expect(shouldClearSuiteAccount("user-a", "user-b")).toBe(true);
  expect(shouldClearSuiteAccount(null, "user-a")).toBe(false);
});

afterEach(() => vi.useRealTimers());
it("starts renewal five minutes early and retries until Accounts replaces its cached credential", async () => {
  vi.useFakeTimers();
  const first = credential();
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(first),
  );
  const apply = vi.fn(async () => {});
  const session = createSuiteAccountSession({
    accountsUrl: "https://accounts.test/v1/auth",
    fetch: fetcher,
    apply,
  });
  await session.ensure("old-code", user.id);
  vi.advanceTimersByTime(599_999);
  await session.ensure("fresh-code", user.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(session.accessTokenValidityMs()).toBe(360_000);
  await session.ensure("fresh-code", user.id);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[1]![1]?.headers).toEqual({
    authorization: "Bearer fresh-code",
    "content-type": "application/json",
  });
  // Accounts keeps the old suite credential until it has at most 60s left.
  vi.advanceTimersByTime(240_000);
  expect(session.accessTokenValidityMs()).toBe(900_000);
  fetcher.mockImplementation(async () =>
    Response.json({ ...credential(), token: "renewed-suite" }),
  );
  await session.ensure("fresh-code", user.id);
  expect(apply).toHaveBeenLastCalledWith("renewed-suite");
  expect(session.accessTokenValidityMs()).toBe(360_000);
});
it("reapplies the same credential to heal Drive/Mail and never clears on a transient exchange failure", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json(credential()));
  const apply = vi.fn(async () => {});
  const session = createSuiteAccountSession({
    accountsUrl: "https://accounts.test/v1/auth",
    fetch: fetcher,
    apply,
  });
  await session.ensure("code", user.id);
  await session.ensure("code", user.id, true);
  expect(apply).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(session.ensure("code", user.id, true)).rejects.toThrow();
  expect(apply).not.toHaveBeenCalledWith(null);
  await session.ensure("code", user.id);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("mints a full-lifetime suite credential with a fresh access token despite Accounts' cached-session window", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const accountsUrl = "https://accounts.test/v1/auth";
  const resource = "https://relay.test";
  let accessExpiry = Date.now() + 900_000;
  let savedSuite = credential();
  let stored: string | null = JSON.stringify({
    version: 1,
    accountsUrl,
    resource,
    clientId: "desktop",
    user,
    accessToken: "original-access",
    refreshToken: "refresh",
    expiresAt: accessExpiry,
  });
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/oauth2/token")) {
      accessExpiry = Date.now() + 900_000;
      return Response.json({
        access_token: `access-${Date.now()}`,
        expires_in: 900,
        token_type: "Bearer",
      });
    }
    if (savedSuite.expiresAt <= Date.now() + 60_000)
      savedSuite = { ...credential(), token: `suite-${Date.now()}`, expiresAt: accessExpiry };
    return Response.json(savedSuite);
  });
  const account = createAccountSession({
    accountsUrl,
    resource,
    clientId: "desktop",
    fetch: fetcher,
    storage: {
      read: async () => stored,
      write: async (value) => {
        stored = value;
      },
    },
  });
  await account.load();
  const suite = createSuiteAccountSession({
    accountsUrl,
    fetch: fetcher,
    apply: vi.fn(async () => {}),
  });
  const renew = async () =>
    suite.ensure(
      (await account.readToken({ minValidityMs: suite.accessTokenValidityMs() }))!,
      user.id,
    );
  await renew();
  vi.advanceTimersByTime(600_000);
  await renew();
  expect(savedSuite.expiresAt - Date.now()).toBe(300_000);
  vi.advanceTimersByTime(240_000);
  await renew();
  expect(savedSuite.expiresAt - Date.now()).toBe(900_000);
});
