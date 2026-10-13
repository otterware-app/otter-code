// @effect-diagnostics nodeBuiltinImport:off - Tests read a synthetic profile fixture, never signing secrets.
import * as NodeFS from "node:fs";
import Plist from "plist";
import { assert, it } from "@effect/vitest";

import {
  InvalidAppleTeamIdError,
  InvalidMacPasskeyRpDomainError,
  renderMacPasskeyEntitlements,
  resolveMacPasskeySigningConfiguration,
  resolveMacWebAuthnEntitlements,
} from "./macos-profile.ts";

const appId = "dev.otterware.code";
const teamId = "YNJ5WLH965";
const configuration = { appId, teamId, rpDomains: [], provisioningProfilePath: "/tmp/profile" };
const fixture = NodeFS.readFileSync(
  new URL("./fixtures/macos-profile.plist", import.meta.url),
  "utf8",
);
// Like upstream's tests, include a CMS envelope around the XML payload.
const profile = (entitlements: string, outside = "") =>
  `0\x82\x1f\x9a\x06\t*\x86H<?xml version="1.0"?><plist version="1.0"><dict>${outside}<key>Entitlements</key><dict>${entitlements}</dict></dict></plist>\x00\x01`;
const render = (payload: string, rpDomains: readonly string[] = []) =>
  Plist.parse(
    renderMacPasskeyEntitlements(
      { ...configuration, rpDomains },
      resolveMacWebAuthnEntitlements(payload, configuration),
      payload,
    ),
  ) as Record<string, unknown>;

it("claims only the used grants from today's profile and retains hardened-runtime entitlements", () => {
  assert.deepStrictEqual(render(fixture), {
    "com.apple.application-identifier": `${teamId}.${appId}`,
    "com.apple.developer.team-identifier": teamId,
    "keychain-access-groups": [`${teamId}.${appId}.webauthn`],
    "com.apple.security.cs.allow-jit": true,
    "com.apple.security.cs.allow-unsigned-executable-memory": true,
    "com.apple.security.cs.disable-library-validation": true,
  });
  assert.deepStrictEqual(resolveMacWebAuthnEntitlements(fixture, configuration), {
    touchIdKeychainAccessGroup: `${teamId}.${appId}.webauthn`,
    browserPasskeys: false,
  });
});

it("enables the managed browser capability only after the profile grants it", () => {
  const approved = fixture.replace(
    "<key>Entitlements</key>\n    <dict>",
    "<key>Entitlements</key>\n    <dict><key>com.apple.developer.web-browser.public-key-credential</key><true/>",
  );
  assert.deepStrictEqual(render(approved), {
    ...render(fixture),
    "com.apple.developer.web-browser.public-key-credential": true,
  });
  assert.isTrue(resolveMacWebAuthnEntitlements(approved, configuration).browserPasskeys);
});

it("does not infer Associated Domains from Clerk keys or the Otter Accounts issuer", () => {
  const resolved = resolveMacPasskeySigningConfiguration(
    {
      APPLE_TEAM_ID: teamId.toLowerCase(),
      T3CODE_MACOS_PROVISIONING_PROFILE: " /tmp/profile ",
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_invalid",
      T3CODE_ACCOUNTS_URL: "https://accounts.otterware.app",
    },
    appId,
  );
  assert.deepStrictEqual(resolved, configuration);
});

it("preserves profile-free signing even without a team ID or domain configuration", () => {
  assert.isUndefined(resolveMacPasskeySigningConfiguration({}, appId));
  assert.isUndefined(
    resolveMacPasskeySigningConfiguration(
      {
        T3CODE_MACOS_PROVISIONING_PROFILE: " ",
        T3CODE_MACOS_PASSKEY_RP_DOMAINS: "bad://domain",
      },
      appId,
    ),
  );
});

it("claims only explicitly configured Associated Domains that the profile authorizes", () => {
  assert.deepStrictEqual(render(fixture, ["accounts.otterware.app"]), {
    ...render(fixture),
    "com.apple.developer.associated-domains": ["webcredentials:accounts.otterware.app"],
  });
  const restricted = profile(`<key>com.apple.developer.associated-domains</key><array>
    <string>webcredentials:accounts.otterware.app</string>
    <string>webcredentials:*.example.com</string>
  </array>`);
  const selected = render(restricted, [
    "accounts.otterware.app",
    "login.example.com",
    "example.com",
    "other.com",
  ]);
  assert.deepPropertyVal(selected, "com.apple.developer.associated-domains", [
    "webcredentials:accounts.otterware.app",
    "webcredentials:login.example.com",
  ]);
  assert.notProperty(
    render(profile(""), ["accounts.otterware.app"]),
    "com.apple.developer.associated-domains",
  );
});

it("normalizes and deduplicates explicit domains, and rejects unsafe values", () => {
  const env = { T3CODE_APPLE_TEAM_ID: teamId, T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/profile" };
  assert.deepStrictEqual(
    resolveMacPasskeySigningConfiguration(
      {
        ...env,
        T3CODE_MACOS_PASSKEY_RP_DOMAINS: " Accounts.Otterware.app,accounts.otterware.app ",
      },
      appId,
    )?.rpDomains,
    ["accounts.otterware.app"],
  );
  for (const value of [
    "https://example.com",
    "example.com:8443",
    "user:password@example.com",
    "example.com/path",
    "example.com?token=secret",
    "example.com#fragment",
    "example.com,",
  ]) {
    assert.throws(
      () =>
        resolveMacPasskeySigningConfiguration(
          {
            ...env,
            T3CODE_MACOS_PASSKEY_RP_DOMAINS: value,
          },
          appId,
        ),
      InvalidMacPasskeyRpDomainError,
    );
  }
  assert.throws(
    () =>
      resolveMacPasskeySigningConfiguration(
        {
          ...env,
          T3CODE_APPLE_TEAM_ID: "wrong",
        },
        appId,
      ),
    InvalidAppleTeamIdError,
  );
});

it("ignores comments, unrelated keys, false capabilities, and unreadable profiles", () => {
  const groups = "<key>keychain-access-groups</key><array><string>YNJ5WLH965.*</string></array>";
  const browser = "<key>com.apple.developer.web-browser.public-key-credential</key><true/>";
  for (const payload of [
    "",
    "unreadable",
    profile(""),
    profile(`<!-- ${groups}${browser} -->`),
    profile(
      "<key>com.apple.developer.web-browser.public-key-credential</key><false/>",
      groups + browser,
    ),
  ]) {
    assert.deepStrictEqual(resolveMacWebAuthnEntitlements(payload, configuration), {
      touchIdKeychainAccessGroup: undefined,
      browserPasskeys: false,
    });
    assert.deepStrictEqual(render(payload), {
      "com.apple.security.cs.allow-jit": true,
      "com.apple.security.cs.allow-unsigned-executable-memory": true,
      "com.apple.security.cs.disable-library-validation": true,
    });
  }
});

it("accepts an exact keychain grant and rejects another team's grant", () => {
  assert.equal(
    resolveMacWebAuthnEntitlements(
      profile(
        `<key>keychain-access-groups</key><array><string>${teamId}.${appId}.webauthn</string></array>`,
      ),
      configuration,
    ).touchIdKeychainAccessGroup,
    `${teamId}.${appId}.webauthn`,
  );
  assert.isUndefined(
    resolveMacWebAuthnEntitlements(
      profile("<key>keychain-access-groups</key><array><string>OTHERTEAM1.*</string></array>"),
      configuration,
    ).touchIdKeychainAccessGroup,
  );
});

it("derives the Otterware keychain group from its own app ID", () => {
  const suite = { ...configuration, appId: "dev.otterware.suite" };
  assert.equal(
    resolveMacWebAuthnEntitlements(fixture, suite).touchIdKeychainAccessGroup,
    "YNJ5WLH965.dev.otterware.suite.webauthn",
  );
});
