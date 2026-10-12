import { describe, expect, it } from "vite-plus/test";

import { resolveServerSelfUpdateCapability } from "./selfUpdate.ts";

describe("Otterware server self-update", () => {
  it("never offers a boot-service update to an Otterware server", () => {
    expect(
      resolveServerSelfUpdateCapability({
        desktopManaged: false,
        launcherManaged: true,
        serverVersion: "0.0.47-otterware.20261007.3",
      }),
    ).toBeNull();
  });

  it("leaves Otter Code servers updatable", () => {
    expect(
      resolveServerSelfUpdateCapability({
        desktopManaged: false,
        launcherManaged: true,
        serverVersion: "0.0.46-nightly.20261006.343",
      }),
    ).toBe("boot-service");
  });
});
