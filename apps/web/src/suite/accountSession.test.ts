import { expect, it, vi } from "vite-plus/test";
import { createSuiteAccountSession, isLocalSuiteTarget } from "./accountSession";

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
