import { describe, expect, it } from "vite-plus/test";
import { parseAccountCallback } from "./callback";
const state = (origin: string) => JSON.stringify({ nonce: "a".repeat(43), origin });
describe("account callback destinations", () => {
  it("automatically returns only to Code's hosted suite origins", () => {
    expect(parseAccountCallback(state("https://code.otterware.app"))).toEqual({
      origin: "https://code.otterware.app",
      trusted: true,
    });
    for (const origin of [
      "https://drive.otterware.app",
      "https://code.otterware.app.evil.test",
      "https://custom.example",
      "http://localhost:3000",
      "https://server.tailnet.ts.net",
    ]) {
      expect(parseAccountCallback(state(origin))).toEqual({ origin, trusted: false });
    }
  });
  it("rejects destinations that are not exact HTTP origins and malformed requests", () => {
    for (const origin of [
      "javascript:alert(1)",
      "https://user:pass@example.test",
      "https://example.test/path",
      "https://example.test/?q=1",
      "null",
    ])
      expect(() => parseAccountCallback(state(origin))).toThrow();
    expect(() =>
      parseAccountCallback(JSON.stringify({ origin: "https://code.otterware.app" })),
    ).toThrow();
    expect(() =>
      parseAccountCallback(
        JSON.stringify({ origin: "https://code.otterware.app", nonce: "short" }),
      ),
    ).toThrow();
  });
});
