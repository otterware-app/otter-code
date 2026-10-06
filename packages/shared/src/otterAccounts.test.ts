import { expect, it } from "vite-plus/test";
import { createAccountAuthorization } from "./otterAccounts.ts";
it("generates the RFC 7636 S256 challenge without requiring a secure-context digest API", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const entropy = new Uint8Array(Buffer.from(verifier, "base64url"));
  const crypto = {
    getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
      if (!array) throw new Error("missing entropy buffer");
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(entropy);
      return array;
    },
  };
  expect(await createAccountAuthorization(crypto)).toEqual({
    verifier,
    challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    state: verifier,
  });
});
