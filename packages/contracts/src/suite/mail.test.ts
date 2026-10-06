import { describe, expect, it } from "vite-plus/test";

import { decodeMailBytes, encodeMailBytes } from "./mail.ts";

describe("Mail bytes over JSON", () => {
  it("round-trips bytes nested anywhere through JSON", () => {
    const value = {
      name: "report.pdf",
      files: [{ bytes: new Uint8Array([0, 1, 254, 255]) }, { bytes: new Uint8Array(0) }],
      count: 2,
      none: null,
    };
    const wire = JSON.parse(JSON.stringify(encodeMailBytes(value)));
    expect(wire.files[0].bytes).toEqual({ $bytes: "AAH+/w==" });
    const back = decodeMailBytes(wire) as typeof value;
    expect(back.files[0]!.bytes).toBeInstanceOf(Uint8Array);
    expect([...back.files[0]!.bytes]).toEqual([0, 1, 254, 255]);
    expect(back.files[1]!.bytes.length).toBe(0);
    expect(back).toMatchObject({ name: "report.pdf", count: 2, none: null });
  });

  it("encodes large attachments without overflowing the call stack", () => {
    const big = new Uint8Array(3 * 1024 * 1024).fill(7);
    const back = decodeMailBytes(encodeMailBytes(big)) as Uint8Array;
    expect(back.length).toBe(big.length);
    expect(back[back.length - 1]).toBe(7);
  });

  it("leaves objects that merely have a $bytes key among others alone", () => {
    expect(decodeMailBytes({ $bytes: "AA==", other: 1 })).toEqual({ $bytes: "AA==", other: 1 });
  });
});
