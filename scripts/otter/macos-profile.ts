// Ported from upstream 3e01c4bc57 and 454b94a13a. Otter's account/domain policy
// lives here so the upstream desktop packager can keep its signing flow.
// plist is CommonJS; Node cannot load its named exports from an ES module.
import Plist from "plist";
import * as Schema from "effect/Schema";

const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/u;

export interface MacPasskeySigningConfiguration {
  readonly appId: string;
  readonly teamId: string;
  readonly rpDomains: readonly string[];
  readonly provisioningProfilePath: string;
}

export const InvalidMacPasskeyRpDomainReason = Schema.Literals([
  "empty",
  "scheme-not-allowed",
  "parse-failed",
  "credentials-not-allowed",
  "port-not-allowed",
  "path-not-allowed",
  "query-not-allowed",
  "fragment-not-allowed",
  "hostname-mismatch",
]);
export type InvalidMacPasskeyRpDomainReason = typeof InvalidMacPasskeyRpDomainReason.Type;

export class InvalidMacPasskeyRpDomainError extends Schema.TaggedError<InvalidMacPasskeyRpDomainError>()(
  "InvalidMacPasskeyRpDomainError",
  {
    reason: InvalidMacPasskeyRpDomainReason,
    inputLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Invalid passkey RP domain (${this.reason}).`;
  }
}

export class InvalidAppleTeamIdError extends Schema.TaggedError<InvalidAppleTeamIdError>()(
  "InvalidAppleTeamIdError",
  {
    teamId: Schema.String,
  },
) {
  override get message(): string {
    return `T3CODE_APPLE_TEAM_ID '${this.teamId}' must be a 10-character Apple Developer Team ID.`;
  }
}

function normalizePasskeyRpDomain(value: string): string {
  const normalized = value.trim().toLowerCase();
  const inputLength = value.length;
  if (normalized.length === 0) {
    throw new InvalidMacPasskeyRpDomainError({ reason: "empty", inputLength });
  }
  if (/^[a-z][a-z\d+.-]*:\/\//u.test(normalized)) {
    throw new InvalidMacPasskeyRpDomainError({
      reason: "scheme-not-allowed",
      inputLength,
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(`https://${normalized}`);
  } catch (cause) {
    throw new InvalidMacPasskeyRpDomainError({ reason: "parse-failed", inputLength, cause });
  }

  let reason: InvalidMacPasskeyRpDomainReason | undefined;
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    reason = "credentials-not-allowed";
  } else if (parsed.port.length > 0) {
    reason = "port-not-allowed";
  } else if (parsed.pathname !== "/") {
    reason = "path-not-allowed";
  } else if (parsed.search.length > 0) {
    reason = "query-not-allowed";
  } else if (parsed.hash.length > 0) {
    reason = "fragment-not-allowed";
  } else if (parsed.host !== normalized) {
    reason = "hostname-mismatch";
  }
  if (reason) {
    throw new InvalidMacPasskeyRpDomainError({ reason, inputLength });
  }

  return parsed.hostname;
}

export function resolveMacPasskeySigningConfiguration(
  env: Readonly<Record<string, string | undefined>>,
  appId: string,
): MacPasskeySigningConfiguration | undefined {
  const provisioningProfilePath = env.T3CODE_MACOS_PROVISIONING_PROFILE?.trim() ?? "";
  // A profile is optional: keep existing Developer ID signing/notarization.
  if (provisioningProfilePath.length === 0) return undefined;

  const teamId = (env.T3CODE_APPLE_TEAM_ID ?? env.APPLE_TEAM_ID)?.trim().toUpperCase() ?? "";
  if (!APPLE_TEAM_ID_PATTERN.test(teamId)) {
    throw new InvalidAppleTeamIdError({ teamId });
  }

  // Otter Accounts uses no Clerk. Only explicitly configured domains are claimed.
  const configuredRpDomains = env.T3CODE_MACOS_PASSKEY_RP_DOMAINS?.trim();
  const rpDomains = configuredRpDomains
    ? configuredRpDomains.split(",").map(normalizePasskeyRpDomain)
    : [];
  return { appId, teamId, rpDomains: [...new Set(rpDomains)], provisioningProfilePath };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Passkey entitlements for the in-app browser. Each is granted only when the
 * provisioning profile authorizes it: macOS refuses to launch an app that
 * claims a restricted entitlement its embedded profile does not carry.
 */
export interface MacWebAuthnEntitlements {
  /** Keychain group for Electron's Touch ID passkeys. */
  readonly touchIdKeychainAccessGroup: string | undefined;
  /** Apple's managed browser entitlement, which allows passkeys for any site. */
  readonly browserPasskeys: boolean;
}

const BROWSER_PASSKEYS_ENTITLEMENT = "com.apple.developer.web-browser.public-key-credential";

const ProvisioningProfilePlist = Schema.Struct({
  Entitlements: Schema.Struct({
    "com.apple.application-identifier": Schema.optional(Schema.String),
    "com.apple.developer.team-identifier": Schema.optional(Schema.String),
    // Developer ID profiles grant a wildcard as the bare string "*", not a list.
    "com.apple.developer.associated-domains": Schema.optional(
      Schema.Union([Schema.String, Schema.Array(Schema.String)]),
    ),
    "keychain-access-groups": Schema.optional(Schema.Array(Schema.String)),
    [BROWSER_PASSKEYS_ENTITLEMENT]: Schema.optional(Schema.Boolean),
  }),
});
const isProvisioningProfilePlist = Schema.is(ProvisioningProfilePlist);

/**
 * Reads the Entitlements dict of the XML plist a provisioning profile wraps in
 * its CMS envelope. Anything unreadable grants nothing.
 */
const readProfileEntitlements = (provisioningProfile: string) => {
  const start = provisioningProfile.indexOf("<?xml");
  const end = provisioningProfile.indexOf("</plist>", start);
  if (start === -1 || end === -1) return undefined;
  try {
    const profile: unknown = Plist.parse(provisioningProfile.slice(start, end + "</plist>".length));
    return isProvisioningProfilePlist(profile) ? profile.Entitlements : undefined;
  } catch {
    return undefined;
  }
};

export function resolveMacWebAuthnEntitlements(
  provisioningProfile: string,
  configuration: Pick<MacPasskeySigningConfiguration, "appId" | "teamId">,
): MacWebAuthnEntitlements {
  const entitlements = readProfileEntitlements(provisioningProfile);
  const keychainAccessGroup = `${configuration.teamId}.${configuration.appId}.webauthn`;
  const keychainGroupAuthorized = (entitlements?.["keychain-access-groups"] ?? []).some((group) =>
    group.endsWith("*")
      ? keychainAccessGroup.startsWith(group.slice(0, -1))
      : group === keychainAccessGroup,
  );
  return {
    touchIdKeychainAccessGroup: keychainGroupAuthorized ? keychainAccessGroup : undefined,
    browserPasskeys: entitlements?.[BROWSER_PASSKEYS_ENTITLEMENT] === true,
  };
}

export function renderMacPasskeyEntitlements(
  configuration: MacPasskeySigningConfiguration,
  webAuthn: MacWebAuthnEntitlements,
  provisioningProfile: string,
): string {
  const grants = readProfileEntitlements(provisioningProfile);
  const appIdentifier = `${configuration.teamId}.${configuration.appId}`;
  const applicationIdentifier =
    grants?.["com.apple.application-identifier"] === appIdentifier
      ? `
    <key>com.apple.application-identifier</key>
    <string>${escapeXml(appIdentifier)}</string>`
      : "";
  const teamIdentifier =
    grants?.["com.apple.developer.team-identifier"] === configuration.teamId
      ? `
    <key>com.apple.developer.team-identifier</key>
    <string>${escapeXml(configuration.teamId)}</string>`
      : "";
  const associatedDomains = configuration.rpDomains
    .filter((domain) =>
      [grants?.["com.apple.developer.associated-domains"] ?? []]
        .flat()
        .some(
          (grant) =>
            grant === "*" ||
            grant === `webcredentials:${domain}` ||
            (grant.startsWith("webcredentials:*.") &&
              domain.endsWith(grant.slice("webcredentials:*".length))),
        ),
    )
    .map((domain) => `      <string>webcredentials:${escapeXml(domain)}</string>`)
    .join("\n");
  const associatedDomainsEntitlement =
    associatedDomains.length > 0
      ? `
    <key>com.apple.developer.associated-domains</key>
    <array>
${associatedDomains}
    </array>`
      : "";
  const keychainAccessGroups = webAuthn.touchIdKeychainAccessGroup
    ? `
    <key>keychain-access-groups</key>
    <array>
      <string>${escapeXml(webAuthn.touchIdKeychainAccessGroup)}</string>
    </array>`
    : "";
  const browserPasskeys = webAuthn.browserPasskeys
    ? `
    <key>${BROWSER_PASSKEYS_ENTITLEMENT}</key>
    <true/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>${applicationIdentifier}${teamIdentifier}${associatedDomainsEntitlement}${keychainAccessGroups}${browserPasskeys}
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
  </dict>
</plist>
`;
}
