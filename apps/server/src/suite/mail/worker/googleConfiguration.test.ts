import { expect, it } from "@effect/vitest";
import { googleConfiguration } from "./googleConfiguration.ts";

it("reports build and runtime availability without returning credentials", () => {
  expect(googleConfiguration({ clientId: "public", clientSecret: "" }, {})).toEqual({
    configured: false,
    hasBuildClientSecret: false,
    hasClientSecret: false,
  });
  expect(
    googleConfiguration({ clientId: "public", clientSecret: "" }, { clientSecret: "runtime" }),
  ).toEqual({ configured: true, hasBuildClientSecret: false, hasClientSecret: true });
  expect(googleConfiguration({ clientId: "public", clientSecret: "build" }, {})).toEqual({
    configured: true,
    hasBuildClientSecret: true,
    hasClientSecret: true,
  });
});
