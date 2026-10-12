import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  makeStateDirInUseScanner,
  parseStateDirInUseLine,
  STATE_DIR_IN_USE_MARKER,
} from "./OtterwareStateDirInUse.ts";

const line = `${STATE_DIR_IN_USE_MARKER} {"pid":4242,"stateDir":"/home/u/.otter-code/userdata"}`;
const expected = { pid: 4242, stateDir: "/home/u/.otter-code/userdata" };

describe("parseStateDirInUseLine", () => {
  it("parses the marker line", () => {
    assert.deepEqual(parseStateDirInUseLine(line), Option.some(expected));
    assert.deepEqual(parseStateDirInUseLine(`  ${line}\r`), Option.some(expected));
  });

  it("ignores other output and malformed payloads", () => {
    assert.isTrue(Option.isNone(parseStateDirInUseLine("server listening on 3773")));
    assert.isTrue(Option.isNone(parseStateDirInUseLine(`error: ${line}`)));
    assert.isTrue(Option.isNone(parseStateDirInUseLine(`${STATE_DIR_IN_USE_MARKER} not-json`)));
    assert.isTrue(
      Option.isNone(
        parseStateDirInUseLine(`${STATE_DIR_IN_USE_MARKER} {"pid":"1","stateDir":"/x"}`),
      ),
    );
    assert.isTrue(Option.isNone(parseStateDirInUseLine(`${STATE_DIR_IN_USE_MARKER}X {}`)));
  });
});

describe("makeStateDirInUseScanner", () => {
  const encoder = new TextEncoder();

  it("finds a marker split across chunks", () => {
    const scanner = makeStateDirInUseScanner();
    scanner.push(encoder.encode(`boot\n${line.slice(0, 20)}`));
    scanner.push(encoder.encode(`${line.slice(20)}\nexiting\n`));
    assert.deepEqual(scanner.finish(), Option.some(expected));
  });

  it("finds a trailing marker without a newline", () => {
    const scanner = makeStateDirInUseScanner();
    scanner.push(encoder.encode(line));
    assert.deepEqual(scanner.finish(), Option.some(expected));
  });

  it("reports nothing for ordinary crashes", () => {
    const scanner = makeStateDirInUseScanner();
    scanner.push(encoder.encode("Error: boom\n    at main\n"));
    assert.isTrue(Option.isNone(scanner.finish()));
  });
});
