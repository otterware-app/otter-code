import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { sealText, unsealText } from "./seal.ts";

describe("Mail's sealed secrets", () => {
  const key = NodeCrypto.randomBytes(32);

  it("unseals what it sealed, differently each time", () => {
    const first = sealText(key, "refresh-token ✓");
    expect(unsealText(key, first)).toBe("refresh-token ✓");
    expect(sealText(key, "refresh-token ✓")).not.toBe(first);
  });

  it("refuses another server's key and tampered secrets", () => {
    const sealed = sealText(key, "secret");
    expect(() => unsealText(NodeCrypto.randomBytes(32), sealed)).toThrow();
    const bytes = Buffer.from(sealed.slice(3), "base64");
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    expect(() => unsealText(key, `v1:${bytes.toString("base64")}`)).toThrow();
    expect(() => unsealText(key, "plain text")).toThrow("Unknown sealed secret format.");
  });
});
