import { expect, it, vi } from "vite-plus/test";
import { createAccountSession } from "./session.ts";

const issuer = "https://accounts.otterware.app/v1/auth";
const resource = "https://relay.code.otterware.app";
const user = { id: "canonical-user", email: "person@example.test", name: "Person", image: null };
const savedSession = (expiresAt = 1) =>
  JSON.stringify({
    version: 1,
    accountsUrl: issuer,
    resource,
    clientId: "otter-code-web",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt,
    user,
  });
const tokens = {
  access_token: "new-access",
  refresh_token: "new-refresh",
  expires_in: 900,
  token_type: "Bearer",
};
function fixture(
  initial: string | null = savedSession(),
  transport: (request: Request) => Promise<Response> = async () => Response.json(tokens),
) {
  let saved = initial;
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
    transport(new Request(url, init)),
  );
  const storage = {
    read: async () => saved,
    write: vi.fn(async (value: string | null) => {
      saved = value;
    }),
  };
  const manager = createAccountSession({
    accountsUrl: issuer,
    resource,
    clientId: "otter-code-web",
    storage,
    fetch: fetcher,
    now: () => 100_000,
  });
  return { manager, storage, fetcher, saved: () => saved };
}
it("deduplicates refresh and saves the rotated credential before returning it", async () => {
  const f = fixture();
  await f.manager.load();
  expect(await Promise.all([f.manager.readToken(), f.manager.readToken()])).toEqual([
    "new-access",
    "new-access",
  ]);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  const body = new URLSearchParams(String(f.fetcher.mock.calls[0]![1]?.body));
  expect(Object.fromEntries(body)).toMatchObject({
    client_id: "otter-code-web",
    resource,
    grant_type: "refresh_token",
    refresh_token: "old-refresh",
  });
  expect(JSON.parse(f.saved()!)).toMatchObject({
    accessToken: "new-access",
    refreshToken: "new-refresh",
    user,
  });
});
it("reuses another tab's rotated token instead of replaying its refresh credential", async () => {
  const f = fixture();
  await f.manager.load();
  await f.storage.write(savedSession(900_000).replace("old-access", "another-tab-access"));
  expect(await f.manager.readToken()).toBe("another-tab-access");
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("clears a revoked grant and reports that sign-in is needed", async () => {
  const f = fixture(savedSession(), async () =>
    Response.json({ error: "invalid_grant" }, { status: 400 }),
  );
  await f.manager.load();
  await expect(f.manager.readToken()).rejects.toThrow("Sign in again");
  expect(f.manager.getSnapshot().user).toBeNull();
  expect(f.saved()).toBeNull();
});
it("preserves a session during a temporary account service outage", async () => {
  const f = fixture(savedSession(), async () => new Response(null, { status: 503 }));
  await f.manager.load();
  await expect(f.manager.readToken()).rejects.toThrow();
  expect(f.manager.getSnapshot().user).toEqual(user);
  expect(f.saved()).not.toBeNull();
});
it("cannot restore credentials when refresh finishes after sign-out", async () => {
  const pending = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const f = fixture(savedSession(), async (request) => {
    if (request.url.endsWith("/revoke")) return new Response(null);
    started.resolve();
    return pending.promise;
  });
  await f.manager.load();
  const refresh = f.manager.readToken();
  await started.promise;
  const logout = f.manager.signOut();
  pending.resolve(Response.json(tokens));
  await logout;
  expect(await refresh).toBeNull();
  const revocation = f.fetcher.mock.calls.find(([url]) => String(url).endsWith("/revoke"));
  expect(new URLSearchParams(String(revocation?.[1]?.body)).get("token")).toBe("new-refresh");
  expect(f.saved()).toBeNull();
  expect(f.manager.getSnapshot().user).toBeNull();
});
it("reloads sign-out from another tab and ignores credentials from a different issuer", async () => {
  const f = fixture(savedSession(900_000));
  await f.manager.load();
  await f.storage.write(null);
  await f.manager.load();
  expect(await f.manager.readToken()).toBeNull();
  await f.storage.write(savedSession().replace(issuer, "https://old.example/v1/auth"));
  await f.manager.load();
  expect(f.manager.getSnapshot()).toEqual({ loaded: true, user: null });
});
it("redeems PKCE and verifies the canonical identity before persisting sign-in", async () => {
  const f = fixture(null, async (request) =>
    request.url.endsWith("/code/session") ? Response.json(user) : Response.json(tokens),
  );
  await f.manager.load();
  await f.manager.signIn({
    code: "code",
    verifier: "verifier",
    redirectUri: "https://code.otterware.app/account/callback",
  });
  expect(f.manager.getSnapshot().user).toEqual(user);
  expect(f.fetcher.mock.calls[1]?.[1]?.headers).toEqual({ authorization: "Bearer new-access" });
  expect(JSON.parse(f.saved()!)).toMatchObject({ user, accountsUrl: issuer, resource });
});
it("does not persist credentials whose identity cannot be verified", async () => {
  const f = fixture(null, async (request) =>
    request.url.endsWith("/code/session")
      ? new Response(null, { status: 401 })
      : Response.json(tokens),
  );
  await f.manager.load();
  await expect(
    f.manager.signIn({
      code: "code",
      verifier: "verifier",
      redirectUri: "https://code.otterware.app/account/callback",
    }),
  ).rejects.toThrow();
  expect(f.saved()).toBeNull();
});

it("revokes a newly approved grant when sign-out overtakes sign-in", async () => {
  const identity = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const f = fixture(null, async (request) => {
    if (request.url.endsWith("/code/session")) {
      started.resolve();
      return identity.promise;
    }
    return Response.json(tokens);
  });
  await f.manager.load();
  const signingIn = f.manager.signIn({
    code: "code",
    verifier: "verifier",
    redirectUri: "https://code.otterware.app/account/callback",
  });
  await started.promise;
  await f.manager.signOut();
  identity.resolve(Response.json(user));
  await signingIn;
  expect(f.manager.getSnapshot().user).toBeNull();
  expect(f.saved()).toBeNull();
  const revocation = f.fetcher.mock.calls.find(([url]) => String(url).endsWith("/revoke"));
  expect(new URLSearchParams(String(revocation?.[1]?.body)).get("token")).toBe("new-refresh");
});
