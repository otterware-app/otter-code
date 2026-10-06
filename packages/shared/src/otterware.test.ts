import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cliReleaseChannelOf, newestCliReleaseVersion } from "./cliRelease.ts";
import { codexAuthHandoffUrl, readCodexAuthHandoff } from "./codexAuthHandoff.ts";
import { isOtterwareVersion, OTTERWARE_RELEASE_TAG_PREFIX } from "./otterware.ts";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("otterware", () => {
  it("recognises only Otterware build versions", () => {
    expect(isOtterwareVersion("0.0.46-otterware.20261006.12")).toBe(true);
    expect(isOtterwareVersion("0.0.46-nightly.20261006.343")).toBe(false);
    expect(isOtterwareVersion("0.0.46-preview.20261006.1")).toBe(false);
    expect(isOtterwareVersion("0.0.46")).toBe(false);
    expect(isOtterwareVersion(undefined)).toBe(false);
  });

  it("is never on an Otter Code nightly or preview train", () => {
    expect(cliReleaseChannelOf("0.0.46-otterware.20261006.12")).toBe("stable");
  });

  // The runtime installer only follows v<version> tags. Otterware's drafts are
  // tagged otterware-v<version>, so even a published one is never picked.
  it("never resolves an Otterware release as an Otter Code runtime", () => {
    const releases = [
      { tag_name: `${OTTERWARE_RELEASE_TAG_PREFIX}0.0.47-otterware.20261007.1`, draft: true },
      { tag_name: `${OTTERWARE_RELEASE_TAG_PREFIX}0.0.47-otterware.20261007.2`, draft: false },
      { tag_name: "v0.0.46-nightly.20261006.343", draft: false },
    ];
    expect(newestCliReleaseVersion(releases, "stable")).toBeUndefined();
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("0.0.46-nightly.20261006.343");
  });

  it("returns provider sign-ins to either desktop app", () => {
    for (const scheme of ["otterware", "otterware-dev", "ottercode", "ottercode-dev"]) {
      expect(providerAuthReturnUrl(`${scheme}://app/settings`)).toBe(`${scheme}://app/settings`);
    }
  });

  it("hands Codex sign-in to the Otterware desktop app", () => {
    const url = codexAuthHandoffUrl({
      authorizationUrl: `https://auth.openai.com/api/accounts/authorize?${new URLSearchParams({
        client_id: "dynamic_agent_client",
        response_type: "code",
        redirect_uri: "http://127.0.0.1:54213/auth/callback",
        state: "a".repeat(43),
        code_challenge_method: "S256",
        code_challenge: "b".repeat(43),
      })}`,
      returnUrl: "otterware://app/settings",
      environmentId: EnvironmentId.make("environment"),
      instanceId: ProviderInstanceId.make("codex"),
      flowId: "flow",
    });
    expect(new URL(url).protocol).toBe("otterware:");
    expect(readCodexAuthHandoff(url, false)?.returnUrl).toBe("otterware://app/settings");
    expect(readCodexAuthHandoff(url.replace(/^otterware:/, "ottercode:"), false)).toBeUndefined();
  });
});
