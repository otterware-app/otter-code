import { expect, it } from "vite-plus/test";
import { consumeBrowserAuthorization, saveBrowserAuthorization } from "./browserAuthorization";
function fixture() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  } as Storage;
}
const request = {
  state: "state",
  verifier: "private-pkce",
  expiresAt: 1000,
  returnTo: "/settings/connections",
};
it("binds a callback to the same tab and consumes PKCE once", () => {
  const storage = fixture();
  saveBrowserAuthorization(storage, request);
  expect(() => consumeBrowserAuthorization(storage, "other", 100)).toThrow();
  expect(consumeBrowserAuthorization(storage, "state", 100)).toEqual(request);
  expect(consumeBrowserAuthorization(storage, "state", 100)).toBeNull();
});
it("rejects expired requests and external return destinations", () => {
  const storage = fixture();
  saveBrowserAuthorization(storage, request);
  expect(() => consumeBrowserAuthorization(storage, "state", 1001)).toThrow();
  saveBrowserAuthorization(storage, { ...request, returnTo: "//evil.test" });
  expect(() => consumeBrowserAuthorization(storage, "state", 100)).toThrow();
});
