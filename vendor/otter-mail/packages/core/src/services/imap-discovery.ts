/**
 * Finds an address's IMAP and SMTP servers, the way Thunderbird does: known
 * providers first, then Mozilla's ISPDB, then the domain's own autoconfig
 * file, then its MX records: a custom domain hosted by a provider we know, or
 * else the mail server itself, when it answers IMAP with a certificate for its
 * own name (shared hosting like All-Inkl, where imap.<domain> would point at
 * the same machine but not match its certificate).
 * Null when nothing is found, and for Gmail and Outlook, which don't sign in
 * with a password.
 *
 * Core also runs in the web app's worker, so only sources that allow CORS
 * are asked there: the ISPDB and Cloudflare's DNS-over-HTTPS do; a domain's
 * own autoconfig host usually doesn't, so only the Mac app asks it.
 */

import type { ImapSettings, MailServer } from "@otter-mail/contracts/mail";

import { platform } from "../platform.js";

const FETCH_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;

type Preset = {
  domains: string[];
  /** MX hosts (or their parent domains) that mean a custom domain is hosted here. */
  mx?: string[];
  imap: MailServer;
  smtp: MailServer;
  /** The login is the part before the @ (else the whole address). */
  localPart?: boolean;
  /** The provider only takes app passwords from mail apps: where to make one. */
  appPasswords?: string;
};

const tls = (host: string, port = 993): MailServer => ({ host, port, security: "tls" });
const starttls = (host: string, port = 587): MailServer => ({ host, port, security: "starttls" });

const PRESETS: Preset[] = [
  {
    domains: ["icloud.com", "me.com", "mac.com"],
    mx: ["mail.icloud.com"],
    imap: tls("imap.mail.me.com"),
    smtp: starttls("smtp.mail.me.com"),
    appPasswords: "https://account.apple.com",
  },
  {
    domains: ["fastmail.com", "fastmail.fm", "fastmail.net", "fastmail.org", "messagingengine.com"],
    mx: ["messagingengine.com"],
    imap: tls("imap.fastmail.com"),
    smtp: tls("smtp.fastmail.com", 465),
    appPasswords: "https://app.fastmail.com/settings/security/apps",
  },
  {
    domains: ["yahoo.com", "ymail.com", "rocketmail.com", "yahoo.co.uk", "yahoo.fr", "yahoo.de"],
    mx: ["yahoodns.net"],
    imap: tls("imap.mail.yahoo.com"),
    smtp: tls("smtp.mail.yahoo.com", 465),
    appPasswords: "https://login.yahoo.com/account/security",
  },
  {
    domains: ["aol.com", "aim.com"],
    imap: tls("imap.aol.com"),
    smtp: tls("smtp.aol.com", 465),
    appPasswords: "https://login.aol.com/account/security",
  },
  {
    domains: ["gmx.net", "gmx.de", "gmx.at", "gmx.ch"],
    mx: ["gmx.net"],
    imap: tls("imap.gmx.net"),
    smtp: tls("mail.gmx.net", 465),
  },
  {
    domains: ["gmx.com", "gmx.us", "gmx.co.uk", "gmx.fr", "gmx.es"],
    mx: ["gmx.com"],
    imap: tls("imap.gmx.com"),
    smtp: tls("mail.gmx.com", 465),
  },
  {
    domains: ["web.de"],
    mx: ["web.de"],
    imap: tls("imap.web.de"),
    smtp: tls("smtp.web.de", 465),
    localPart: true,
  },
  {
    domains: ["zoho.com", "zohomail.com"],
    mx: ["zoho.com"],
    imap: tls("imap.zoho.com"),
    smtp: tls("smtp.zoho.com", 465),
    appPasswords: "https://accounts.zoho.com/home#security/app_password",
  },
  {
    domains: ["zoho.eu", "zohomail.eu"],
    mx: ["zoho.eu"],
    imap: tls("imap.zoho.eu"),
    smtp: tls("smtp.zoho.eu", 465),
    appPasswords: "https://accounts.zoho.eu/home#security/app_password",
  },
  {
    domains: ["posteo.de", "posteo.net", "posteo.at", "posteo.ch", "posteo.eu", "posteo.org"],
    mx: ["posteo.de"],
    imap: tls("posteo.de"),
    smtp: tls("posteo.de", 465),
  },
  {
    domains: ["mailbox.org"],
    mx: ["mailbox.org"],
    imap: tls("imap.mailbox.org"),
    smtp: tls("smtp.mailbox.org", 465),
  },
  {
    domains: ["yandex.com", "yandex.ru", "ya.ru", "yandex.by", "yandex.kz", "yandex.ua"],
    mx: ["yandex.net", "yandex.ru"],
    imap: tls("imap.yandex.com"),
    smtp: tls("smtp.yandex.com", 465),
    appPasswords: "https://id.yandex.com/security/app-passwords",
  },
  {
    domains: ["ionos.de"],
    mx: ["ionos.de", "kundenserver.de"],
    imap: tls("imap.ionos.de"),
    smtp: tls("smtp.ionos.de", 465),
  },
  {
    domains: ["ionos.com"],
    mx: ["ionos.com"],
    imap: tls("imap.ionos.com"),
    smtp: tls("smtp.ionos.com", 465),
  },
  {
    domains: ["ionos.co.uk"],
    mx: ["ionos.co.uk"],
    imap: tls("imap.ionos.co.uk"),
    smtp: tls("smtp.ionos.co.uk", 465),
  },
  { domains: [], mx: ["mail.ovh.net"], imap: tls("ssl0.ovh.net"), smtp: tls("ssl0.ovh.net", 465) },
  {
    domains: ["strato.de"],
    mx: ["rzone.de"],
    imap: tls("imap.strato.de"),
    smtp: tls("smtp.strato.de", 465),
  },
  {
    domains: ["orange.fr", "wanadoo.fr"],
    imap: tls("imap.orange.fr"),
    smtp: tls("smtp.orange.fr", 465),
  },
  {
    domains: ["free.fr"],
    imap: tls("imap.free.fr"),
    smtp: tls("smtp.free.fr", 465),
    localPart: true,
  },
  {
    domains: ["mail.ru", "inbox.ru", "list.ru", "bk.ru", "internet.ru"],
    mx: ["mail.ru"],
    imap: tls("imap.mail.ru"),
    smtp: tls("smtp.mail.ru", 465),
    appPasswords: "https://account.mail.ru/user/2-step-auth/passwords",
  },
  {
    domains: ["runbox.com"],
    mx: ["runbox.com"],
    imap: tls("mail.runbox.com"),
    smtp: tls("mail.runbox.com", 465),
  },
  {
    domains: ["migadu.com"],
    mx: ["migadu.com"],
    imap: tls("imap.migadu.com"),
    smtp: tls("smtp.migadu.com", 465),
  },
  {
    domains: ["purelymail.com"],
    mx: ["purelymail.com"],
    imap: tls("imap.purelymail.com"),
    smtp: tls("smtp.purelymail.com", 465),
  },
];

/** Mailboxes that sign in with Google or Microsoft rather than a password. */
const NOT_IMAP_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "outlook.fr",
  "hotmail.fr",
  "hotmail.co.uk",
  "live.fr",
]);
const NOT_IMAP_MX = ["google.com", "googlemail.com", "outlook.com"];

const endsWithDomain = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);

function fromPreset(preset: Preset, email: string): ImapSettings {
  return {
    username: preset.localPart ? email.split("@")[0]! : email,
    imap: preset.imap,
    smtp: preset.smtp,
  };
}

/** Where a known provider says to make an app password for this IMAP server, if it does. */
export function appPasswordUrl(imapHost: string): string | null {
  return PRESETS.find((preset) => preset.imap.host === imapHost)?.appPasswords ?? null;
}

// ── Autoconfig XML (Thunderbird's clientConfig) ─────────────────────────────

const tag = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "g"))].map((m) => m[1]!);

const unescape = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

type ConfigServer = MailServer & { username: string };

/** The servers of one type that take a password over TLS, implicit TLS first. */
function configServers(xml: string, element: string, type: string): ConfigServer[] {
  const blocks = xml.matchAll(
    new RegExp(`<${element}\\s+type="${type}"\\s*>([\\s\\S]*?)</${element}>`, "g"),
  );
  const servers: ConfigServer[] = [];
  for (const [, block] of blocks) {
    const [host] = tag(block!, "hostname");
    const port = Number(tag(block!, "port")[0]);
    const socket = tag(block!, "socketType")[0]?.toUpperCase();
    const auth = tag(block!, "authentication");
    const security = socket === "SSL" ? "tls" : socket === "STARTTLS" ? "starttls" : null;
    const password = auth.length === 0 || auth.some((a) => a.startsWith("password-"));
    if (!host || !port || !security || !password) continue;
    servers.push({
      host: unescape(host),
      port,
      security,
      username: unescape(tag(block!, "username")[0] ?? "%EMAILADDRESS%"),
    });
  }
  return servers.sort((a, b) => Number(b.security === "tls") - Number(a.security === "tls"));
}

const fillUsername = (template: string, email: string) =>
  template
    .replace(/%EMAILADDRESS%/g, email)
    .replace(/%EMAILLOCALPART%/g, email.split("@")[0]!)
    .replace(/%EMAILDOMAIN%/g, email.split("@")[1]!);

/** Reads a clientConfig document (config-v1.1.xml); null without a usable IMAP and SMTP server. */
export function parseAutoconfig(xml: string, email: string): ImapSettings | null {
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, "");
  const [imap] = configServers(withoutComments, "incomingServer", "imap");
  const [smtp] = configServers(withoutComments, "outgoingServer", "smtp");
  if (!imap || !smtp) return null;
  const server = ({ host, port, security }: MailServer): MailServer => ({ host, port, security });
  return { username: fillUsername(imap.username, email), imap: server(imap), smtp: server(smtp) };
}

// ── Lookups ─────────────────────────────────────────────────────────────────

async function fetchText(url: string, init?: RequestInit): Promise<string | null> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

async function autoconfig(domain: string, email: string): Promise<ImapSettings | null> {
  const ispdb = await fetchText(
    `https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`,
  );
  const fromIspdb = ispdb && parseAutoconfig(ispdb, email);
  if (fromIspdb) return fromIspdb;
  // The domain's own file: its host rarely allows CORS, so not from the browser.
  if (platform().kind === "web") return null;
  const own = await fetchText(
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
  );
  return own ? parseAutoconfig(own, email) : null;
}

/** The domain's MX hosts, most preferred first (Cloudflare's DNS-over-HTTPS, which allows CORS). */
export async function mxHosts(domain: string): Promise<string[]> {
  const json = await fetchText(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
    { headers: { accept: "application/dns-json" } },
  );
  if (!json) return [];
  try {
    const answers = (JSON.parse(json) as { Answer?: { type: number; data: string }[] }).Answer;
    return (answers ?? [])
      .filter((answer) => answer.type === 15)
      .map((answer) => answer.data.split(/\s+/))
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, host]) => (host ?? "").replace(/\.$/, "").toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Second levels of country domains that are suffixes themselves (co.uk, com.au, …). */
const SUFFIXES = new Set(["co", "com", "net", "org", "ac", "gov", "edu", "ne", "or"]);

/** mx1.mail.example.co.uk → example.co.uk, roughly. */
function baseDomain(host: string): string {
  const labels = host.split(".");
  const suffix = labels.at(-1)!.length === 2 && SUFFIXES.has(labels.at(-2)!);
  return labels.slice(suffix ? -3 : -2).join(".");
}

/** Whether the host completes a TLS handshake on IMAP's port, its certificate matching its name. */
export async function servesImap(host: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stream = await Promise.race([
      platform().connect(host, 993, { tls: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), PROBE_TIMEOUT_MS);
      }),
    ]);
    stream.close();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The mail server itself: IMAP on 993, SMTP on 465, both over TLS. */
const onServer = (host: string, email: string): ImapSettings => ({
  username: email,
  imap: tls(host),
  smtp: tls(host, 465),
});

export async function discoverImap(address: string): Promise<ImapSettings | null> {
  const email = address.trim();
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain || !domain.includes(".")) return null;
  if (NOT_IMAP_DOMAINS.has(domain)) return null;
  const preset = PRESETS.find((p) => p.domains.includes(domain));
  if (preset) return fromPreset(preset, email);

  const found = await autoconfig(domain, email);
  if (found) return found;

  const [mx] = await mxHosts(domain);
  if (!mx || NOT_IMAP_MX.some((d) => endsWithDomain(mx, d))) return null;
  const hoster = PRESETS.find((p) => p.mx?.some((d) => endsWithDomain(mx, d)));
  if (hoster) return fromPreset(hoster, email);
  const base = baseDomain(mx);
  const fromBase = base === domain ? null : await autoconfig(base, email);
  if (fromBase) return fromBase;
  return (await servesImap(mx)) ? onServer(mx, email) : null;
}
