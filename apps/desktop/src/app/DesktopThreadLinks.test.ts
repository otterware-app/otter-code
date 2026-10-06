import { describe, expect, it } from "vite-plus/test";

import { threadPathFromDeepLink } from "./DesktopThreadLinks.ts";

describe("threadPathFromDeepLink", () => {
  it("reads a thread link for this app's scheme", () => {
    expect(threadPathFromDeepLink("otterware://app/env-1/linear-session%3Aabc", "otterware")).toBe(
      "/env-1/linear-session%3Aabc",
    );
  });

  it("ignores unrelated callbacks, other schemes, and other paths", () => {
    for (const url of [
      "otterware://app/",
      "otterware://app/?code=1",
      "otterware-dev://app/env-1/thread-1",
      "otterware://other/env-1/thread-1",
      "otterware://app/env-1/thread-1/extra",
      "/Applications/Otter Code.app",
      "--inspect",
    ]) {
      expect(threadPathFromDeepLink(url, "otterware"), url).toBeNull();
    }
  });
});
